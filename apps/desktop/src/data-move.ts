/**
 * WP480：把工坊数据搬到另一个文件夹（桌面壳主导）。
 *
 * 顺序（每一步失败都回到旧位置照常启动，说一句人话原因）：
 *
 * 1. **暂停**：正在输出的停在安全点、后台与定时挂起（与「重启并更新」同一条路，落盘在数据目录里，
 *    新位置起来后读回、接着做）；
 * 2. **备份**：服务进程还开着时让它做一份与升级闸同款的备份（`VACUUM INTO` 的一致性快照 + 清单哈希）。
 *    备份做不成就不搬——这时候服务进程还没停，什么都没动；
 * 3. **停服务**：服务进程与本机连接器都停干净，之后到搬完前没有任何写入；
 * 4. **复制 + 逐文件校验**：每个文件边抄边算哈希，抄完再把新文件读一遍，大小与哈希都对上才算；
 * 5. **用新位置起服务 → 健康检查**：起不来就停掉、回旧位置起；
 * 6. **记下新位置**（指针文件，最后一步才写——写之前崩了，下次启动还是旧位置）；
 * 7. **旧目录改名留 7 天**。
 *
 * 搬家进行中在 `<userData>/data-move.json` 留一张单子：中途崩了 / 断电，下次启动按它收拾
 * （`recoverInterruptedMove`）。
 *
 * 本机加密密钥（safeStorage 的 `secrets.bin`）在 `userData` 里，**不随数据搬**——
 * 数据目录里的密文换了地方，用的还是同一把钥匙（`wp480-data-move.test.ts` 钉住）。
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  commitDataDir,
  currentDataDir,
  DATA_MOVE_JOURNAL,
  readPointer,
  retireOldDir,
  samePath,
} from './data-location.js'

// ── 复制 + 校验 ──────────────────────────────────────────────────────

interface Entry {
  rel: string
  kind: 'dir' | 'file' | 'link'
  size: number
}

async function listTree(root: string): Promise<Entry[]> {
  const out: Entry[] = []
  const walk = async (rel: string): Promise<void> => {
    const names = await readdir(rel === '' ? root : join(root, rel))
    names.sort()
    for (const name of names) {
      const r = rel === '' ? name : join(rel, name)
      const st = await lstat(join(root, r))
      if (st.isSymbolicLink()) out.push({ rel: r, kind: 'link', size: 0 })
      else if (st.isDirectory()) {
        out.push({ rel: r, kind: 'dir', size: 0 })
        await walk(r)
      } else if (st.isFile()) out.push({ rel: r, kind: 'file', size: st.size })
      // 套接字 / 管道这类特殊文件不搬（数据目录里不该有；有也是运行时的残留）
    }
  }
  await walk('')
  return out
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

export interface CopyProgress {
  copied_bytes: number
  total_bytes: number
  files_done: number
  files_total: number
  phase: 'copy' | 'verify'
}

export type CopyErrorCode = 'no_space' | 'not_writable' | 'verify_failed' | 'copy_failed'

export class DataMoveError extends Error {
  readonly code: DataMoveFailure
  constructor(code: DataMoveFailure, message: string) {
    super(message)
    this.name = 'DataMoveError'
    this.code = code
  }
}

function copyErrorCode(err: unknown): CopyErrorCode {
  if (err instanceof DataMoveError && err.code === 'verify_failed') return 'verify_failed'
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'no_space'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'not_writable'
  return 'copy_failed'
}

export interface CopyTreeOptions {
  onProgress?: (p: CopyProgress) => void
  /** 测试注入：抄每个文件之前叫一下（扔错 = 模拟中途失败）。 */
  beforeFile?: (rel: string) => void | Promise<void>
  /** 测试注入：抄完、核对之前叫一下（可以去改坏新文件，看核对拦不拦得住）。 */
  beforeVerify?: (to: string) => void | Promise<void>
}

export interface CopyReport {
  files: number
  bytes: number
  links: number
}

/**
 * 把 `from` 整个抄到 `to`（`to` 不存在或是空的），每个文件抄完再读一遍核对大小与哈希。
 * 失败抛 {@link DataMoveError}（`no_space` / `not_writable` / `verify_failed` / `copy_failed`）；
 * 抄了一半的东西由调用方清（它知道 `to` 是不是自己建的）。
 */
export async function copyTree(
  from: string,
  to: string,
  options: CopyTreeOptions = {},
): Promise<CopyReport> {
  try {
    const entries = await listTree(from)
    const files = entries.filter((e) => e.kind === 'file')
    const total = files.reduce((n, e) => n + e.size, 0)
    const progress: CopyProgress = {
      copied_bytes: 0,
      total_bytes: total,
      files_done: 0,
      files_total: files.length,
      phase: 'copy',
    }
    let lastEmit = 0
    const emit = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < 150) return
      lastEmit = now
      options.onProgress?.({ ...progress })
    }
    emit(true)
    await mkdir(to, { recursive: true })
    const hashes = new Map<string, string>()
    let links = 0
    for (const entry of entries) {
      const src = join(from, entry.rel)
      const dst = join(to, entry.rel)
      if (entry.kind === 'dir') {
        await mkdir(dst, { recursive: true })
        continue
      }
      if (entry.kind === 'link') {
        const target = await readlink(src)
        try {
          await symlink(target, dst)
        } catch {
          // Windows 上建符号链接要权限：退回抄它指向的那个文件（指向目录的就跳过——
          // 数据目录里的链接只出现在本机连接器的 node_modules/.bin 里）
          const st = await stat(src).catch(() => undefined)
          if (st?.isFile() === true) {
            await pipeline(createReadStream(src), createWriteStream(dst))
          }
        }
        links += 1
        continue
      }
      await options.beforeFile?.(entry.rel)
      const h = createHash('sha256')
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          h.update(chunk)
          progress.copied_bytes += chunk.length
          emit()
          done(null, chunk)
        },
      })
      await pipeline(createReadStream(src), tap, createWriteStream(dst))
      hashes.set(entry.rel, h.digest('hex'))
      const st = await stat(src)
      await utimes(dst, st.atime, st.mtime).catch(() => undefined)
      progress.files_done += 1
      emit()
    }
    await options.beforeVerify?.(to)
    // 核对：新文件逐个再读一遍——大小、哈希都要和抄的时候那一份对上
    progress.phase = 'verify'
    progress.files_done = 0
    emit(true)
    for (const entry of files) {
      const dst = join(to, entry.rel)
      const st = await stat(dst).catch(() => undefined)
      if (st === undefined || st.size !== entry.size)
        throw new DataMoveError('verify_failed', `大小对不上：${entry.rel}`)
      if ((await hashFile(dst)) !== hashes.get(entry.rel))
        throw new DataMoveError('verify_failed', `内容对不上：${entry.rel}`)
      progress.files_done += 1
      emit()
    }
    emit(true)
    return { files: files.length, bytes: total, links }
  } catch (err) {
    if (err instanceof DataMoveError) throw err
    throw new DataMoveError(copyErrorCode(err), String(err))
  }
}

// ── 进度与结果（经桥送到设置页） ─────────────────────────────────────

export type DataMoveStep =
  | 'pause'
  | 'backup'
  | 'stop'
  | 'copy'
  | 'verify'
  | 'start'
  | 'check'
  | 'finish'

export type DataMoveFailure =
  /** 备份没做成（什么都没动，服务一直开着）。 */
  | 'backup_failed'
  /** 新位置空间不够（抄到一半满了）。 */
  | 'no_space'
  /** 新位置写不进去。 */
  | 'not_writable'
  /** 抄过去的文件核对不上。 */
  | 'verify_failed'
  /** 抄的时候出了别的错（文件读不了、盘拔了……）。 */
  | 'copy_failed'
  /** 用新位置起不来 / 健康检查没过。 */
  | 'start_failed'
  /** 已经有一次在搬了。 */
  | 'busy'
  | 'unknown'

export type DataMoveStatus =
  | { state: 'idle' }
  | {
      state: 'running'
      step: DataMoveStep
      to: string
      copied_bytes: number
      total_bytes: number
      files_done: number
      files_total: number
      started_at: string
    }
  | {
      state: 'done'
      to: string
      from: string
      /** 旧目录改名后在哪、留到什么时候。 */
      old?: { path: string; until: string }
      at: string
    }
  | {
      state: 'failed'
      code: DataMoveFailure
      step: DataMoveStep
      /** 回到了哪（总是原来的位置）。 */
      back_to: string
      /** 旧位置起没起来（`false` = 连旧位置都没起来，要人看一眼）。 */
      recovered: boolean
      at: string
    }

// ── 搬家单（崩了下次启动收拾） ───────────────────────────────────────

export interface MoveJournal {
  from: string
  to: string
  /** `to` 是不是这次新建的（是才会在失败时整个删掉）。 */
  created_target: boolean
  step: DataMoveStep
  started_at: string
}

export function journalPath(userData: string): string {
  return join(userData, DATA_MOVE_JOURNAL)
}

export function readJournal(userData: string): MoveJournal | undefined {
  try {
    const raw = JSON.parse(readFileSync(journalPath(userData), 'utf8')) as Partial<MoveJournal>
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return undefined
    return {
      from: raw.from,
      to: raw.to,
      created_target: raw.created_target === true,
      step: (raw.step ?? 'copy') as DataMoveStep,
      started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
    }
  } catch {
    return undefined
  }
}

async function writeJournal(userData: string, journal: MoveJournal): Promise<void> {
  const file = journalPath(userData)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(journal, null, 2)}\n`)
  await rename(tmp, file)
}

function clearJournal(userData: string): void {
  rmSync(journalPath(userData), { force: true })
}

export interface RecoveryOutcome {
  /** 做了什么（日志用）。 */
  action: 'none' | 'dropped_partial_copy' | 'kept_new_retired_old'
  journal?: MoveJournal
}

/**
 * 启动时（起服务之前）叫：上次搬家没走完就收拾。指针是唯一真源——
 *
 * - 指针还指着旧位置（新位置的指针没写成）：新位置那一份不算数，是这次建的就删掉；
 * - 指针已经指到新位置（崩在最后改名那一步）：旧目录照常改名留 7 天。
 */
export function recoverInterruptedMove(input: { userData: string; now: string }): RecoveryOutcome {
  const journal = readJournal(input.userData)
  if (journal === undefined) {
    clearJournal(input.userData)
    return { action: 'none' }
  }
  const current = currentDataDir(input.userData)
  if (samePath(current, journal.to) && !samePath(journal.from, journal.to)) {
    if (existsSync(journal.from)) {
      const already = readPointer(input.userData).retired.some((r) =>
        samePath(r.from, journal.from),
      )
      if (!already) retireOldDir({ userData: input.userData, dir: journal.from, now: input.now })
    }
    clearJournal(input.userData)
    return { action: 'kept_new_retired_old', journal }
  }
  if (journal.created_target && !samePath(journal.to, current) && existsSync(journal.to))
    rmSync(journal.to, { recursive: true, force: true })
  clearJournal(input.userData)
  return { action: 'dropped_partial_copy', journal }
}

// ── 整个流程 ─────────────────────────────────────────────────────────

export interface DataMoveDeps {
  userData: string
  from: string
  to: string
  now: () => string
  /** 暂停正在做的（尽力而为：问不到服务进程就跳过）。 */
  pause: () => Promise<void>
  /** 搬不成、服务一直没停时把暂停放开。 */
  resume: () => Promise<void>
  /** 做一份升级闸同款备份；做不成就扔。 */
  backup: () => Promise<void>
  /** 停服务进程与本机连接器，等它们真的退出。 */
  stopServices: () => Promise<void>
  /** 用这个目录起服务（壳把 `AGENTSWS_DB_DIR` 换成它再起）。 */
  startServices: (dir: string) => Promise<void>
  /** 等服务健康；回是否健康。 */
  waitHealthy: () => Promise<boolean>
  onStatus: (status: DataMoveStatus) => void
  log?: (message: string, fields?: Record<string, unknown>) => void
  copy?: (from: string, to: string, options: CopyTreeOptions) => Promise<CopyReport>
  copyOptions?: Omit<CopyTreeOptions, 'onProgress'>
}

/**
 * 跑一次搬家。回最后的状态（`done` / `failed`），过程中经 `onStatus` 一步一步报。
 * 任何一步失败都回到 `from` 照常启动；`from` 自始至终不动（成功后才改名留 7 天）。
 */
export async function runDataMove(deps: DataMoveDeps): Promise<DataMoveStatus> {
  const log = deps.log ?? (() => undefined)
  const started_at = deps.now()
  const running = {
    state: 'running' as const,
    to: deps.to,
    copied_bytes: 0,
    total_bytes: 0,
    files_done: 0,
    files_total: 0,
    started_at,
  }
  let step: DataMoveStep = 'pause'
  const report = (next: DataMoveStep, extra: Partial<typeof running> = {}): void => {
    step = next
    Object.assign(running, extra)
    deps.onStatus({ ...running, step })
  }
  const fail = (code: DataMoveFailure, recovered: boolean): DataMoveStatus => {
    const status: DataMoveStatus = {
      state: 'failed',
      code,
      step,
      back_to: deps.from,
      recovered,
      at: deps.now(),
    }
    log('搬数据没成，已回到原来的位置', { code, step, recovered })
    deps.onStatus(status)
    return status
  }
  /** 回旧位置起服务；回起没起来。 */
  const backToOld = async (): Promise<boolean> => {
    try {
      await deps.startServices(deps.from)
      return await deps.waitHealthy()
    } catch (err) {
      log('回旧位置起服务也没成', { error: String(err) })
      return false
    }
  }

  // ① 暂停
  report('pause')
  await deps.pause().catch((err: unknown) => {
    log('暂停没成（照样往下搬：服务进程停下来之前没有写入的风险更大）', { error: String(err) })
  })

  // ② 备份——这时服务还开着；不成就什么都不动
  report('backup')
  try {
    await deps.backup()
  } catch (err) {
    log('搬之前的备份没做成，不搬了', { error: String(err) })
    await deps.resume().catch(() => undefined)
    return fail('backup_failed', true)
  }

  // ③ 停服务（从这里起到搬完，没有任何写入）
  report('stop')
  try {
    await deps.stopServices()
  } catch (err) {
    // 停不干净（进程卡住）就不抄：一边抄一边还有人写，抄出来的不是一份完整的
    log('服务进程没停干净，不搬了', { error: String(err) })
    return fail('unknown', await backToOld())
  }

  const created_target = !existsSync(deps.to)
  const journal: MoveJournal = {
    from: deps.from,
    to: deps.to,
    created_target,
    step: 'copy',
    started_at,
  }
  await writeJournal(deps.userData, journal)
  const dropCopy = (): void => {
    try {
      if (created_target) rmSync(deps.to, { recursive: true, force: true })
      else for (const name of readdirSafe(deps.to)) rmSync(join(deps.to, name), { recursive: true })
    } catch (err) {
      log('清掉新位置抄了一半的东西没成', { error: String(err) })
    }
  }

  // ④ 复制 + 核对
  report('copy')
  try {
    await (deps.copy ?? copyTree)(deps.from, deps.to, {
      ...deps.copyOptions,
      onProgress: (p) => {
        report(p.phase === 'verify' ? 'verify' : 'copy', {
          copied_bytes: p.copied_bytes,
          total_bytes: p.total_bytes,
          files_done: p.files_done,
          files_total: p.files_total,
        })
      },
    })
  } catch (err) {
    const code: DataMoveFailure =
      err instanceof DataMoveError ? (err.code as DataMoveFailure) : 'copy_failed'
    log('抄数据没成', { code, error: String(err) })
    dropCopy()
    clearJournal(deps.userData)
    return fail(code, await backToOld())
  }

  // ⑤ 用新位置起服务
  await writeJournal(deps.userData, { ...journal, step: 'start' })
  report('start')
  let healthy = false
  try {
    await deps.startServices(deps.to)
    report('check')
    healthy = await deps.waitHealthy()
  } catch (err) {
    log('用新位置起服务没成', { error: String(err) })
  }
  if (!healthy) {
    await deps.stopServices().catch(() => undefined)
    dropCopy()
    clearJournal(deps.userData)
    return fail('start_failed', await backToOld())
  }

  // ⑥ 记下新位置（最后一步才写：之前任何时候崩了，下次启动都还是旧位置）
  report('finish')
  commitDataDir({ userData: deps.userData, dir: deps.to, now: deps.now() })
  await writeJournal(deps.userData, { ...journal, step: 'finish' })

  // ⑦ 旧目录改名留 7 天
  let old: { path: string; until: string } | undefined
  try {
    const entry = retireOldDir({ userData: deps.userData, dir: deps.from, now: deps.now() })
    old = { path: entry.path, until: entry.until }
  } catch (err) {
    log('旧目录改名没成（数据已经在新位置，旧的原地留着）', { error: String(err) })
  }
  clearJournal(deps.userData)
  const done: DataMoveStatus = {
    state: 'done',
    from: deps.from,
    to: deps.to,
    ...(old === undefined ? {} : { old }),
    at: deps.now(),
  }
  log('数据已搬到新位置', { to: deps.to, ...(old === undefined ? {} : { old: old.path }) })
  deps.onStatus(done)
  return done
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 搬家期间托盘 / 急停兜底 / 轮换密钥这些地方还会去 `start()` / `restart()` 服务进程——那会用旧目录
 * 起一个进程、在抄的时候往旧目录里写。包一层：搬家时这两个动作只记一行日志、不执行；
 * 搬家流程自己用里面那个没包过的。
 */
export function holdDuringMove<T extends { start(): void; restart(): void }>(
  inner: T,
  moving: () => boolean,
  log: (what: 'start' | 'restart') => void = () => undefined,
): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'start' || prop === 'restart')
        return () => {
          if (moving()) {
            log(prop)
            return
          }
          target[prop]()
        }
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
}
