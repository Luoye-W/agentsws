/**
 * WP219（docs/90 §3–§4）：**内容包**——清单、哈希、ed25519 签名与验签。
 *
 * 一个内容包 = 一份清单 `content-manifest.json` + 它的签名 `content-manifest.json.sig` + 一堆按
 * sha256 命名的文件（`blobs/<sha256>`）。清单里每个条目列出自己的文件（路径、sha256、大小）。
 *
 * 三条硬规矩（用户端照这个收）：
 * 1. **签名对清单的原始字节**：先验签、再解析——不存在「解析后再序列化」对不上的问题；
 * 2. **任一条目任一文件哈希不对，整包拒收**（不挑着收）；
 * 3. **最低软件版本不满足**：整包级不满足整包不收；条目级不满足只跳过那一条。
 *
 * 私钥只在发版流水线里（GitHub secret `CONTENT_SIGNING_KEY`），这里的 `sign*` 只给打包脚本与测试用；
 * 测试的密钥对一律现生成、不入库。
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  CONTENT_FILE_BASENAMES,
  CONTENT_FILE_EXTENSIONS,
  CONTENT_ITEM_KINDS,
  CONTENT_MANIFEST_SCHEMA,
  CONTENT_MAX_FILE_BYTES,
  CONTENT_MAX_ITEM_BYTES,
  type ContentChannel,
  type ContentFileEntry,
  type ContentItem,
  type ContentManifest,
  type ContentPublicKey,
} from '@agentsws/contracts'

// ---------- 拒收原因 ----------

export type ContentRejectReason =
  | 'no_keys'
  | 'bad_signature'
  | 'unknown_key'
  | 'bad_manifest'
  | 'schema'
  | 'channel'
  | 'old_serial'
  | 'app_too_old'
  | 'bad_hash'
  | 'bad_path'
  | 'too_large'
  | 'missing_file'
  | 'fetch_failed'

/** 每个原因的一句人话（界面上照抄；技术细节进 tooltip）。 */
export const CONTENT_REJECT_TEXT: Readonly<Record<ContentRejectReason, string>> = {
  no_keys: '这个版本还没装验签钥匙，内容更新先关着。',
  bad_signature: '这次的更新包签名对不上，没收，照旧用现在这一版。',
  unknown_key: '这次的更新包不是用我们认得的钥匙签的，没收。',
  bad_manifest: '更新包的清单读不懂，没收。',
  schema: '更新包是更新的格式，要先更新软件才收得下。',
  channel: '更新包的渠道对不上，没收。',
  old_serial: '收到的是一份旧的更新包，没理它。',
  app_too_old: '这批内容要更新的软件版本才收得下，先更新软件。',
  bad_hash: '有个文件下载下来和清单对不上，整包没收，照旧用现在这一版。',
  bad_path: '更新包里有不该有的文件（只许技能这类说明文字），整包没收。',
  too_large: '更新包里有文件大得不正常，整包没收。',
  missing_file: '更新包缺文件，整包没收。',
  fetch_failed: '这次没连上更新源，过几个小时再试。',
}

export class ContentPackError extends Error {
  readonly reason: ContentRejectReason
  readonly detail: string | undefined
  constructor(reason: ContentRejectReason, detail?: string) {
    super(`${CONTENT_REJECT_TEXT[reason]}${detail === undefined ? '' : `（${detail}）`}`)
    this.name = 'ContentPackError'
    this.reason = reason
    this.detail = detail
  }
}

// ---------- 哈希 ----------

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 条目摘要：按路径排序的 `path\tsha256\n` 拼起来的 sha256（与文件先后顺序无关）。 */
export function contentItemDigest(
  files: readonly Pick<ContentFileEntry, 'path' | 'sha256'>[],
): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\t${f.sha256}\n`)
  return sha256Hex(lines.join(''))
}

// ---------- 分界线：内容包里只许声明式文件 ----------

const SHA = /^[0-9a-f]{64}$/

/** 路径对不对（`undefined` = 对；否则回原因）。 */
export function contentPathProblem(path: string): string | undefined {
  if (path === '' || path.length > 240) return '路径为空或太长'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return '不许绝对路径'
  if (path.includes('\\')) return '不许反斜杠'
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return '不许 . / .. / 空段'
  if (parts.some((p) => p.startsWith('.'))) return '不许隐藏文件'
  if (parts.some((p) => p === 'scripts' || p === 'node_modules' || p === 'hooks'))
    return '不许 scripts / hooks / node_modules 目录'
  const base = parts[parts.length - 1] ?? ''
  if (CONTENT_FILE_BASENAMES.includes(base)) return undefined
  const dot = base.lastIndexOf('.')
  const ext = dot < 0 ? '' : base.slice(dot).toLowerCase()
  if (!CONTENT_FILE_EXTENSIONS.includes(ext)) return `不许 ${ext === '' ? '无后缀' : ext} 文件`
  if (base === 'package.json') return '不许 package.json'
  return undefined
}

/**
 * 读一个条目目录的全部文件（打包用）：逐个过分界线，过不了就抛 `bad_path`；符号链接不跟。
 */
export function readContentDir(dir: string): {
  files: ContentFileEntry[]
  bytes: Map<string, Buffer>
} {
  if (!existsSync(dir)) throw new ContentPackError('missing_file', dir)
  const bytes = new Map<string, Buffer>()
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name)
      const rel = relative(dir, full).split(sep).join('/')
      if (lstatSync(full).isSymbolicLink())
        throw new ContentPackError('bad_path', `${rel}：符号链接`)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      const problem = contentPathProblem(rel)
      if (problem !== undefined) throw new ContentPackError('bad_path', `${rel}：${problem}`)
      bytes.set(rel, readFileSync(full))
    }
  }
  walk(dir)
  const files = [...bytes.entries()]
    .map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  return { files, bytes }
}

// ---------- 版本号 ----------

/**
 * 软件版本比大小（`0.2.0` / `0.2.0-beta.3`）：主版本逐段比数字；同主版本时正式版大于预发布；
 * 预发布按点切开逐段比（数字比数字、否则按字符串）。
 */
export function compareAppVersion(a: string, b: string): number {
  const split = (v: string): [number[], string[] | undefined] => {
    const [main, ...pre] = v.trim().replace(/^v/, '').split('-')
    const nums = (main ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0)
    return [nums, pre.length === 0 ? undefined : pre.join('-').split('.')]
  }
  const [ma, pa] = split(a)
  const [mb, pb] = split(b)
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const d = (ma[i] ?? 0) - (mb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (pa === undefined && pb === undefined) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x < y ? -1 : x > y ? 1 : 0
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// ---------- 钥匙与签名 ----------

/** 32 字节原始公钥 → `key_id`（sha256 前 16 个十六进制字符）。 */
export function contentKeyId(publicKeyRaw: Uint8Array): string {
  return sha256Hex(publicKeyRaw).slice(0, 16)
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function publicKeyObject(raw: Buffer): ReturnType<typeof createPublicKey> {
  if (raw.length !== 32) throw new ContentPackError('unknown_key', '公钥不是 32 字节')
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

/** 从私钥（PKCS#8 PEM）算出公钥条目（打包脚本把 `key_id` 写进清单用）。 */
export function contentPublicKeyOf(privateKeyPem: string): ContentPublicKey {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: 'der',
    type: 'spki',
  })
  const raw = Buffer.from(der).subarray(SPKI_ED25519_PREFIX.length)
  return { key_id: contentKeyId(raw), public_key: raw.toString('base64') }
}

/** 对清单原始字节签名（只在发版流水线 / 测试里调）。回 base64。 */
export function signContentManifest(manifestBytes: Uint8Array, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('内容包只用 ed25519 钥匙签')
  return sign(null, manifestBytes, key).toString('base64')
}

/** 验签：签名对得上内置钥匙里的哪一把就回它的 `key_id`；都对不上抛。 */
export function verifyContentSignature(
  manifestBytes: Uint8Array,
  signatureB64: string,
  keys: readonly ContentPublicKey[],
): string {
  if (keys.length === 0) throw new ContentPackError('no_keys')
  const sig = Buffer.from(signatureB64.trim(), 'base64')
  if (sig.length !== 64) throw new ContentPackError('bad_signature', '签名长度不对')
  for (const k of keys) {
    let ok = false
    try {
      ok = verify(null, manifestBytes, publicKeyObject(Buffer.from(k.public_key, 'base64')), sig)
    } catch {
      ok = false
    }
    if (ok) return k.key_id
  }
  throw new ContentPackError('bad_signature')
}

// ---------- 用户端：验一份清单 ----------

export interface VerifyManifestOptions {
  keys: readonly ContentPublicKey[]
  /** 这台机器上的软件版本。 */
  appVersion: string
  channel: ContentChannel
  /** 见过的最大序号：清单序号不比它大就当旧包（防回放）。同号重查不算旧（`allowSame`）。 */
  minSerial?: number
  allowSame?: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

function checkItemShape(raw: unknown, i: number): ContentItem {
  const bad = (why: string): never => {
    throw new ContentPackError('bad_manifest', `第 ${i + 1} 条：${why}`)
  }
  if (!isObj(raw)) return bad('不是对象')
  const { id, kind, name, version, files, sha256 } = raw
  if (!isStr(id) || !/^[a-z]+:[a-z0-9][a-z0-9.-]*$/.test(id)) return bad('id 不对')
  if (!isStr(kind) || !(CONTENT_ITEM_KINDS as readonly string[]).includes(kind))
    return bad('kind 不对')
  if (!isStr(name) || id !== `${kind}:${name}`) return bad('id 与 kind:name 不一致')
  if (!isStr(version)) return bad('没有版本')
  if (!isStr(sha256) || !SHA.test(sha256)) return bad('条目摘要不对')
  if (!isObj(raw.title) || !isObj(raw.summary) || !isObj(raw.upstream) || !isObj(raw.review))
    return bad('缺 title / summary / upstream / review')
  if (!Array.isArray(files) || files.length === 0) return bad('没有文件')
  let total = 0
  const seen = new Set<string>()
  for (const f of files) {
    if (!isObj(f) || !isStr(f.path) || !isStr(f.sha256) || typeof f.size !== 'number')
      return bad('文件条目不对')
    const problem = contentPathProblem(f.path)
    if (problem !== undefined) throw new ContentPackError('bad_path', `${id}/${f.path}：${problem}`)
    if (!SHA.test(f.sha256)) return bad(`${f.path} 的 sha256 不对`)
    if (seen.has(f.path)) return bad(`${f.path} 重复`)
    seen.add(f.path)
    if (f.size < 0 || f.size > CONTENT_MAX_FILE_BYTES)
      throw new ContentPackError('too_large', `${id}/${f.path}`)
    total += f.size
  }
  if (total > CONTENT_MAX_ITEM_BYTES) throw new ContentPackError('too_large', id)
  if (contentItemDigest(files as ContentFileEntry[]) !== sha256)
    throw new ContentPackError('bad_hash', `${id} 的条目摘要与文件列表对不上`)
  return raw as unknown as ContentItem
}

/**
 * 先验签、再解析、再查格式 / 渠道 / 序号 / 最低版本。任何一条不过都抛 {@link ContentPackError}。
 * 过了回清单——此时文件还没下，文件哈希由 {@link verifyContentItemFiles} 逐个查。
 */
export function verifyContentManifest(
  manifestBytes: Uint8Array,
  signatureB64: string,
  options: VerifyManifestOptions,
): ContentManifest {
  const keyId = verifyContentSignature(manifestBytes, signatureB64, options.keys)
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  } catch {
    throw new ContentPackError('bad_manifest', '不是 JSON')
  }
  if (!isObj(raw)) throw new ContentPackError('bad_manifest', '不是对象')
  if (raw.schema !== CONTENT_MANIFEST_SCHEMA)
    throw new ContentPackError('schema', String(raw.schema))
  if (raw.key_id !== keyId)
    throw new ContentPackError('unknown_key', '清单写的钥匙与签名的钥匙不一致')
  if (raw.channel !== options.channel) throw new ContentPackError('channel', String(raw.channel))
  if (typeof raw.serial !== 'number' || !Number.isInteger(raw.serial) || raw.serial < 1)
    throw new ContentPackError('bad_manifest', 'serial 不对')
  const min = options.minSerial ?? 0
  if (raw.serial < min || (raw.serial === min && options.allowSame !== true))
    throw new ContentPackError('old_serial', `${raw.serial} ≤ ${min}`)
  if (!isStr(raw.min_app_version)) throw new ContentPackError('bad_manifest', '缺 min_app_version')
  if (compareAppVersion(options.appVersion, raw.min_app_version) < 0)
    throw new ContentPackError(
      'app_too_old',
      `要 ${raw.min_app_version}，这台是 ${options.appVersion}`,
    )
  if (!Array.isArray(raw.items)) throw new ContentPackError('bad_manifest', '没有 items')
  const items = raw.items.map(checkItemShape)
  const ids = new Set<string>()
  for (const it of items) {
    if (ids.has(it.id)) throw new ContentPackError('bad_manifest', `${it.id} 重复`)
    ids.add(it.id)
  }
  return raw as unknown as ContentManifest
}

/** 条目自己的最低版本满不满足（不满足只跳过这一条）。 */
export function contentItemFitsApp(item: ContentItem, appVersion: string): boolean {
  return (
    item.min_app_version === undefined || compareAppVersion(appVersion, item.min_app_version) >= 0
  )
}

/**
 * 逐个查一个条目的文件：`read(sha)` 回下载下来的字节（没有回 `undefined`）。
 * 有一个对不上就抛（调用方据此**整包**拒收）。
 */
export function verifyContentItemFiles(
  item: ContentItem,
  read: (sha256: string) => Uint8Array | undefined,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const f of item.files) {
    const b = read(f.sha256)
    if (b === undefined) throw new ContentPackError('missing_file', `${item.id}/${f.path}`)
    if (b.length !== f.size || sha256Hex(b) !== f.sha256)
      throw new ContentPackError('bad_hash', `${item.id}/${f.path}`)
    out.set(f.path, Buffer.from(b))
  }
  return out
}

// ---------- 打包（发版流水线 / 测试） ----------

export type ContentItemMeta = Omit<ContentItem, 'files' | 'sha256'>

export interface BuildContentPackInput {
  channel: ContentChannel
  serial: number
  created_at: string
  min_app_version: string
  items: { meta: ContentItemMeta; dir: string }[]
  privateKeyPem: string
}

export interface BuiltContentPack {
  manifest: ContentManifest
  /** 清单原始字节（签的就是它；上传时原样上传，不许再格式化）。 */
  manifestBytes: Buffer
  signature: string
  /** sha256 → 字节。 */
  blobs: Map<string, Buffer>
}

/** 把若干条目目录打成一个签好的内容包（不落盘，调用方决定写哪）。 */
export function buildContentPack(input: BuildContentPackInput): BuiltContentPack {
  if (input.items.length === 0) throw new Error('内容包至少要有一个条目')
  const blobs = new Map<string, Buffer>()
  const items: ContentItem[] = input.items.map(({ meta, dir }) => {
    const { files, bytes } = readContentDir(dir)
    if (files.length === 0) throw new ContentPackError('missing_file', `${meta.id} 是空目录`)
    for (const f of files) {
      if (f.size > CONTENT_MAX_FILE_BYTES)
        throw new ContentPackError('too_large', `${meta.id}/${f.path}`)
      blobs.set(f.sha256, bytes.get(f.path) as Buffer)
    }
    return { ...meta, files, sha256: contentItemDigest(files) }
  })
  const key = contentPublicKeyOf(input.privateKeyPem)
  const manifest: ContentManifest = {
    schema: CONTENT_MANIFEST_SCHEMA,
    channel: input.channel,
    serial: input.serial,
    created_at: input.created_at,
    min_app_version: input.min_app_version,
    key_id: key.key_id,
    items,
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  // 自检：打出来的包用同一把钥匙验得过（验不过就是打包脚本自己坏了）
  verifyContentManifest(manifestBytes, signContentManifest(manifestBytes, input.privateKeyPem), {
    keys: [key],
    appVersion: input.min_app_version,
    channel: input.channel,
  })
  return {
    manifest,
    manifestBytes,
    signature: signContentManifest(manifestBytes, input.privateKeyPem),
    blobs,
  }
}
