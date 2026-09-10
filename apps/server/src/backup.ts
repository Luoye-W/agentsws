/**
 * 导出 / 导入一个工作区（40 §1.3「双向搬家」、33 §1；备份也走同一条路）。
 *
 * 33 说了"双向搬家"，40 §1.3 把它列成第一个洞：一个公司要么想换台机器、要么想从
 * 单机档搬到公司 NAS、要么只是想每天存一份——这三件事是同一件事，都缺同一个东西。
 *
 * 五条纪律：
 *
 * 1. **一致性快照，不是 `cp`**。每个库都开着 WAL，直接拷 `.db` 会拿到一个少了半截
 *    事务的文件。这里每个 SQLite 文件都走 `VACUUM INTO`——SQLite 自己保证那一份是
 *    一个完整的、已检查点的库；不需要停服务，也不需要跨库事务。
 * 2. **清单带哈希**。`manifest.json` 里有版本、包清单、每个文件的 sha256、
 *    以及事件链的头尾。导入先核对哈希再落地：一个字节对不上就不导，
 *    免得把一个坏包铺到新机器上再去查是哪儿坏的。
 * 3. **凭据只导密文**。秘密库（`secrets.sqlite`）里本来就是 AES-256-GCM 的密文，
 *    主体密钥环（`data.db` 的 `_subject_keys`）在有根密钥时是**包裹后**的密钥。
 *    根密钥与秘密库密钥来自环境变量，**不进包**——包丢了也解不开。
 *    清单里如实记 `keyring.plain`：没设根密钥时主体密钥是裸的，这件事要说出来。
 * 4. **导入必验链**。落地之后用 `verifyChain` 逐条重算哈希，再把每条事件读一遍
 *    （读的那一步会走 upcaster 链，等于顺手验了版本能不能升到当前形状）。
 * 5. **恢复先对账再放开出站**（15 §5.8）。导入完不直接开工：调用方拿到报告后
 *    挂上 outbound 急停、跑 WP34 的对账，对完才放开。这一步由调用方接
 *    （`afterImport`），因为 backup 这一层不该认识服务进程。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { Clock, Iso8601, WorkspaceId } from '@agentsws/contracts'
import { SqliteEventLog } from '@agentsws/kernel'
import type BetterSqlite3 from 'better-sqlite3'

/** 包格式版本。改了形状就 +1，导入端照它决定认不认。 */
export const BACKUP_FORMAT = 1
/** 清单文件名。 */
export const MANIFEST = 'manifest.json'
/** 每天留几份（`AGENTSWS_BACKUP_KEEP`）。 */
export const DEFAULT_BACKUP_KEEP = 7
/** 备份目录的环境变量（策略层还没有这个字段，见交付报告）。 */
export const BACKUP_DIR_ENV = 'AGENTSWS_BACKUP_DIR'
export const BACKUP_KEEP_ENV = 'AGENTSWS_BACKUP_KEEP'

export class BackupError extends Error {
  readonly code: 'invalid_input' | 'not_found' | 'conflict' | 'corrupt'
  constructor(code: BackupError['code'], message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

/** 包里的一个文件。 */
export interface BackupFileEntry {
  name: string
  bytes: number
  sha256: string
  /** `sqlite` = 走过 `VACUUM INTO` 的一致性快照；`raw` = 原样拷贝的小文件。 */
  kind: 'sqlite' | 'raw'
}

export interface BackupManifest {
  format: number
  workspace_id: WorkspaceId
  created_at: Iso8601
  /** 发行版版本（package.json 的 version；对不上只是提示，不拦） */
  release: string
  /** 事件信封的 schema 版本（21 §5 upcaster 链的终点） */
  event_schema_version: number
  /** 包清单：这一份里有哪些模块的库 */
  packages: string[]
  files: BackupFileEntry[]
  /** 事件链的头尾（21 §1）：导入端核对它，能一眼看出是不是同一条链 */
  chain: { count: number; first_id?: string; last_id?: string; last_hash?: string }
  /**
   * 主体密钥环（21 §4）。`plain > 0` = 这台机器没设 `AGENTSWS_DATA_KEY`，
   * 主体密钥是裸着落盘的——包本身就等于明文，得当秘密保管。
   */
  keyring: { subjects: number; wrapped: number; plain: number }
  /** 秘密库：只有密文与字段名，**没有明文凭据**（见 secret-store.ts）。 */
  secrets: { records: number; encrypted: true }
}

export interface ExportInput {
  /** 从哪个数据目录导（`AGENTSWS_DATA_DIR`）。 */
  dataDir: string
  workspace_id: WorkspaceId
  /** 导到哪：一个目录，或一个以 `.zip` 结尾的文件。 */
  out: string
  clock: Clock
  release?: string
}

export interface ExportResult {
  /** 落在哪（目录或 zip 文件的绝对路径）。 */
  out: string
  format: 'dir' | 'zip'
  bytes: number
  manifest: BackupManifest
}

export interface ImportInput {
  /** 包：一个目录，或一个 `.zip`。 */
  pkg: string
  /** 导到哪个数据目录。非空目录要显式 `force`。 */
  dataDir: string
  force?: boolean
  /**
   * 落地之后做什么（15 §5.8：挂 outbound 急停 + 跑对账）。
   * backup 这一层不认识服务进程，所以这一步注入进来。
   */
  afterImport?: (dataDir: string) => Promise<{ reconcile: string; pending: number } | undefined>
}

export interface ImportResult {
  dataDir: string
  manifest: BackupManifest
  /** 每个文件的哈希都对上了 */
  files_verified: number
  /** 21 §1 链式校验 */
  chain: { ok: boolean; events: number; broken_at?: string; reason?: string }
  /** 15 §5.8：恢复之后的对账结论（没接 `afterImport` 就没有这一项） */
  reconcile?: { reconcile: string; pending: number }
}

// ── 数据目录里有什么 ───────────────────────────────────────────────────

const SQLITE_EXT = ['.db', '.sqlite']
/** 不是库、但同样是真源的一部分（连接状态、模型配置）。 */
const RAW_FILES = ['connections.json', 'connect-adapter.json', 'models.json']

const isSqlite = (name: string): boolean => SQLITE_EXT.some((e) => name.endsWith(e))

/** 数据目录里该进包的那些文件（WAL / SHM 边角不进：`VACUUM INTO` 已经把它们并进去了）。 */
export function backupFiles(dataDir: string): { sqlite: string[]; raw: string[] } {
  const all = existsSync(dataDir) ? readdirSync(dataDir) : []
  return {
    sqlite: all.filter(isSqlite).sort(),
    raw: all.filter((f) => RAW_FILES.includes(f)).sort(),
  }
}

const openDb = (path: string, readonly = true): BetterSqlite3.Database => {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  return new Database(path, readonly ? { readonly: true } : {})
}

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

const tableExists = (db: BetterSqlite3.Database, name: string): boolean =>
  (
    db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) as { n: number }
  ).n > 0

// ── 导出 ───────────────────────────────────────────────────────────────

export function exportWorkspace(input: ExportInput): ExportResult {
  const dataDir = resolve(input.dataDir)
  if (!existsSync(dataDir)) throw new BackupError('not_found', `没有这个数据目录：${dataDir}`)
  const wantsZip = input.out.endsWith('.zip')
  const out = resolve(input.out)
  const stage = wantsZip ? mkdtempSync(join(tmpdir(), 'agentsws-export-')) : out
  mkdirSync(stage, { recursive: true })

  const { sqlite, raw } = backupFiles(dataDir)
  const files: BackupFileEntry[] = []

  for (const name of sqlite) {
    const target = join(stage, name)
    rmSync(target, { force: true })
    const db = openDb(join(dataDir, name))
    try {
      // 一致性快照：SQLite 自己保证这一份是完整且已检查点的（WAL 里的东西都并进去了）
      db.prepare('VACUUM INTO ?').run(target)
    } finally {
      db.close()
    }
    files.push({
      name,
      bytes: statSync(target).size,
      sha256: sha256File(target),
      kind: 'sqlite',
    })
  }

  for (const name of raw) {
    const target = join(stage, name)
    writeFileSync(target, readFileSync(join(dataDir, name)))
    files.push({ name, bytes: statSync(target).size, sha256: sha256File(target), kind: 'raw' })
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    workspace_id: input.workspace_id,
    created_at: input.clock.now(),
    release: input.release ?? '0.0.0',
    event_schema_version: 1,
    packages: files.map((f) => f.name.replace(/\.(db|sqlite|json)$/, '')).sort(),
    files,
    chain: chainOf(stage, input.workspace_id),
    keyring: keyringOf(stage),
    secrets: secretsOf(stage),
  }
  writeFileSync(join(stage, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)

  if (!wantsZip) {
    const bytes = files.reduce((n, f) => n + f.bytes, 0) + statSync(join(stage, MANIFEST)).size
    return { out, format: 'dir', bytes, manifest }
  }
  mkdirSync(resolve(out, '..'), { recursive: true })
  zipDir(stage, out)
  rmSync(stage, { recursive: true, force: true })
  return { out, format: 'zip', bytes: statSync(out).size, manifest }
}

/** 事件链的头尾（`hash` 是列不是信封字段，所以直接读那一列）。 */
function chainOf(dir: string, workspace_id: WorkspaceId): BackupManifest['chain'] {
  const path = join(dir, 'events.db')
  if (!existsSync(path)) return { count: 0 }
  const db = openDb(path)
  try {
    if (!tableExists(db, 'events')) return { count: 0 }
    const count = (
      db.prepare('SELECT count(*) AS n FROM events WHERE workspace_id = ?').get(workspace_id) as {
        n: number
      }
    ).n
    if (count === 0) return { count: 0 }
    const first = db
      .prepare('SELECT id FROM events WHERE workspace_id = ? ORDER BY id ASC LIMIT 1')
      .get(workspace_id) as { id: string }
    const last = db
      .prepare('SELECT id, hash FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1')
      .get(workspace_id) as { id: string; hash: string }
    return { count, first_id: first.id, last_id: last.id, last_hash: last.hash }
  } finally {
    db.close()
  }
}

function keyringOf(dir: string): BackupManifest['keyring'] {
  const path = join(dir, 'data.db')
  if (!existsSync(path)) return { subjects: 0, wrapped: 0, plain: 0 }
  const db = openDb(path)
  try {
    if (!tableExists(db, '_subject_keys')) return { subjects: 0, wrapped: 0, plain: 0 }
    const rows = db
      .prepare('SELECT wrapped, key IS NULL AS destroyed FROM _subject_keys')
      .all() as { wrapped: number; destroyed: number }[]
    const live = rows.filter((r) => r.destroyed === 0)
    const wrapped = live.filter((r) => r.wrapped === 1).length
    return { subjects: live.length, wrapped, plain: live.length - wrapped }
  } finally {
    db.close()
  }
}

function secretsOf(dir: string): BackupManifest['secrets'] {
  const path = join(dir, 'secrets.sqlite')
  if (!existsSync(path)) return { records: 0, encrypted: true }
  const db = openDb(path)
  try {
    if (!tableExists(db, 'secrets')) return { records: 0, encrypted: true }
    const n = (db.prepare('SELECT count(*) AS n FROM secrets').get() as { n: number }).n
    return { records: n, encrypted: true }
  } finally {
    db.close()
  }
}

// ── 导入 ───────────────────────────────────────────────────────────────

export async function importWorkspace(input: ImportInput): Promise<ImportResult> {
  const pkg = resolve(input.pkg)
  if (!existsSync(pkg)) throw new BackupError('not_found', `没有这个包：${pkg}`)
  const temp = pkg.endsWith('.zip') ? mkdtempSync(join(tmpdir(), 'agentsws-import-')) : undefined
  const dir = temp === undefined ? pkg : (unzipTo(pkg, temp), temp)

  try {
    const manifestPath = join(dir, MANIFEST)
    if (!existsSync(manifestPath))
      throw new BackupError('invalid_input', `包里没有 ${MANIFEST}，这不是一个导出包`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
    if (manifest.format !== BACKUP_FORMAT)
      throw new BackupError(
        'conflict',
        `包格式是 ${String(manifest.format)}，这台机器认的是 ${BACKUP_FORMAT}`,
      )

    // ② 先核对每一个字节，再落地：坏包不铺到新机器上
    for (const f of manifest.files) {
      const path = join(dir, f.name)
      if (!existsSync(path)) throw new BackupError('corrupt', `包里少了 ${f.name}`)
      const actual = sha256File(path)
      if (actual !== f.sha256)
        throw new BackupError(
          'corrupt',
          `${f.name} 的哈希对不上（清单 ${f.sha256}，实际 ${actual}）`,
        )
    }

    const dataDir = resolve(input.dataDir)
    mkdirSync(dataDir, { recursive: true })
    const existing = readdirSync(dataDir)
    if (existing.length > 0 && input.force !== true)
      throw new BackupError(
        'conflict',
        `${dataDir} 不是空的（${existing.length} 个文件）。换一个空目录，或者显式覆盖。`,
      )
    for (const f of manifest.files)
      writeFileSync(join(dataDir, f.name), readFileSync(join(dir, f.name)))

    // ④ 落地之后验链：逐条重算哈希 + 把每条读一遍（读那一步走 upcaster 链，
    //    等于顺手验了旧版事件能不能升到当前形状）
    const chain = verifyImported(dataDir, manifest.workspace_id)

    const reconcile = await input.afterImport?.(dataDir)
    return {
      dataDir,
      manifest,
      files_verified: manifest.files.length,
      chain,
      ...(reconcile === undefined ? {} : { reconcile }),
    }
  } finally {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true })
  }
}

function verifyImported(dataDir: string, workspace_id: WorkspaceId): ImportResult['chain'] {
  const path = join(dataDir, 'events.db')
  if (!existsSync(path)) return { ok: true, events: 0 }
  const log = new SqliteEventLog({
    dbPath: path,
    clock: { now: () => new Date(0).toISOString() },
    random: () => 0,
  })
  try {
    const verdict = log.verifyChain(workspace_id)
    if (!verdict.ok)
      return {
        ok: false,
        events: 0,
        ...(verdict.broken_at === undefined ? {} : { broken_at: verdict.broken_at }),
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      }
    // upcast 走一遍：缺迁移器的话这里就抛，不会等到第一次读业务数据才炸
    const events = log.readSync({ workspace_id }).length
    return { ok: true, events }
  } finally {
    log.close()
  }
}

// ── 每天一份（25 调度器的消费者）─────────────────────────────────────

export interface BackupRunInput {
  dataDir: string
  workspace_id: WorkspaceId
  /** 备份放哪；缺省 `<dataDir>/backups`。 */
  outDir: string
  clock: Clock
  /** 留最近几份；超出的按时间从旧到新删。 */
  keep?: number
  release?: string
}

export interface BackupRunResult {
  out: string
  bytes: number
  kept: number
  pruned: string[]
  events: number
}

/** 备份文件名：`agentsws-<workspace>-<YYYYMMDDTHHMMSS>.zip`（按名字排序就是按时间排序）。 */
export function backupName(workspace_id: WorkspaceId, at: Iso8601): string {
  const stamp = at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `agentsws-${workspace_id}-${stamp}.zip`
}

/** 跑一次备份：导出成一个 zip，再把超出保留份数的旧包删掉。 */
export function runBackup(input: BackupRunInput): BackupRunResult {
  const outDir = resolve(input.outDir)
  mkdirSync(outDir, { recursive: true })
  const at = input.clock.now()
  const out = join(outDir, backupName(input.workspace_id, at))
  const result = exportWorkspace({
    dataDir: input.dataDir,
    workspace_id: input.workspace_id,
    out,
    clock: input.clock,
    ...(input.release === undefined ? {} : { release: input.release }),
  })
  const keep = Math.max(1, input.keep ?? DEFAULT_BACKUP_KEEP)
  const mine = readdirSync(outDir)
    .filter((f) => f.startsWith(`agentsws-${input.workspace_id}-`) && f.endsWith('.zip'))
    .sort()
  const pruned = mine.slice(0, Math.max(0, mine.length - keep))
  for (const f of pruned) rmSync(join(outDir, f), { force: true })
  return {
    out: result.out,
    bytes: result.bytes,
    kept: mine.length - pruned.length,
    pruned,
    events: result.manifest.chain.count,
  }
}

/** 备份目录：环境变量优先，其次 `<dataDir>/backups`（策略层字段见交付报告）。 */
export function backupDirOf(env: Record<string, string | undefined>, dataDir: string): string {
  const configured = env[BACKUP_DIR_ENV]?.trim()
  return configured === undefined || configured === '' ? join(dataDir, 'backups') : configured
}

export function backupKeepOf(env: Record<string, string | undefined>): number {
  const raw = Number.parseInt(env[BACKUP_KEEP_ENV] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKUP_KEEP
}

// ── 最小 ZIP（不引依赖）───────────────────────────────────────────────
//
// 只要 store / deflate 两种方法就够装一个导出包，所以自己写：加一个 zip 库
// 换来的只有一个 tar.gz 与 zip 的口味差别，而这个包要能在没有 Node 的机器上
// 双击打开——所以选 zip，代价是这 80 行。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  data: Buffer
  compressed: Buffer
  method: number
  crc: number
  offset: number
}

/** 把一个目录（不递归子目录——导出包本来就是平的）打成 zip。 */
export function zipDir(dir: string, out: string): void {
  const names = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort()
  const entries: ZipEntry[] = []
  const chunks: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const data = readFileSync(join(dir, name))
    const deflated = deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const compressed = useDeflate ? deflated : data
    const entry: ZipEntry = {
      name,
      data,
      compressed,
      method: useDeflate ? 8 : 0,
      crc: crc32(data),
      offset,
    }
    entries.push(entry)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, entry.compressed)
    offset += local.length + nameBuf.length + entry.compressed.length
  }
  const centralStart = offset
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(entry.offset, 42)
    chunks.push(central, nameBuf)
    offset += central.length + nameBuf.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)
  writeFileSync(out, Buffer.concat(chunks))
}

/** 解一个由 {@link zipDir} 打出来的包（平结构、store / deflate 两种方法）。 */
export function unzipTo(zip: string, dir: string): string[] {
  const buf = readFileSync(zip)
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  mkdirSync(dir, { recursive: true })
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50)
      throw new BackupError('corrupt', 'zip 中央目录坏了')
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    // 路径穿越：包里的名字只允许是一个平的文件名
    if (name.includes('/') || name.includes('\\') || name.startsWith('.'))
      throw new BackupError('corrupt', `包里有不该出现的路径：${name}`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (crc32(data) !== crc) throw new BackupError('corrupt', `${name} 的 CRC 对不上`)
    writeFileSync(join(dir, basename(name)), data)
    out.push(name)
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new BackupError('corrupt', '不是一个 zip 包（找不到中央目录结尾）')
}

/** 一个文件的头几个字节（测试断言「凭据文件里没有明文」时用来看清是不是 SQLite）。 */
export function head(path: string, n = 16): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, 0)
    return buf
  } finally {
    closeSync(fd)
  }
}
