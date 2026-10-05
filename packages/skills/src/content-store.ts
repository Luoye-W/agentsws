/**
 * WP219（docs/90 §6.2）：用户端的**内容存放处**——按 sha256 存文件、按品牌记「用的是哪一版」。
 *
 * ```
 * <root>/
 *   blobs/<sha256>                      下载下来、验过哈希的文件（内容寻址，不会被改）
 *   trees/<条目摘要>/<名字>/…            按条目摊开的目录（只读；读技能时就从这里读）
 *   state.json                          全局：见过的最大序号、最后一份收下的清单、上次查的时间与结果
 *   workspaces/<品牌>/state.json        这个品牌：自动 / 每次问我、每个条目的当前版与保留的上一版
 * ```
 *
 * **原子替换**：换版只改那个品牌的 `state.json`——先写临时文件、再 `rename` 过去（同一文件系统上是原子的）；
 * 新版的文件早在验完哈希之后就摊好了，所以任何时刻断电，要么是旧版、要么是新版，没有半截。
 * **保留旧版一份**：换版时把当前那一版挪进 `previous`；退回 = 把它挪回来（没有就是退回随软件带的那一版）。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ContentFileEntry,
  type ContentItem,
  type ContentManifest,
  type ContentUpdateMode,
  DEFAULT_CONTENT_UPDATE_MODE,
  type LocalizedText,
} from '@agentsws/contracts'
import { ContentPackError, contentPathProblem, sha256Hex } from './content-pack.js'

export interface AppliedContent {
  version: string
  /** 条目摘要（= `trees/` 下的目录名）。 */
  sha256: string
  files: ContentFileEntry[]
  applied_at: string
  serial: number
  /** 自动更新的，还是人点的。 */
  by: 'auto' | 'person'
  upstream_published_at: string
  title: LocalizedText
}

export interface WorkspaceContentItemState {
  current?: AppliedContent
  previous?: AppliedContent
  /** 退回过的那一版：不再自动提这一版（更高的版本照常提）。 */
  skipped_version?: string
}

export interface WorkspaceContentState {
  mode: ContentUpdateMode
  items: Record<string, WorkspaceContentItemState>
  /** 冲突已选过的键（`contentConflictKey`）。 */
  resolved_conflicts: string[]
}

export interface GlobalContentState {
  max_serial: number
  manifest?: ContentManifest
  last_checked_at?: string
  last_error?: { reason: string; text: string; at: string }
}

const EMPTY_WS = (): WorkspaceContentState => ({
  mode: DEFAULT_CONTENT_UPDATE_MODE,
  items: {},
  resolved_conflicts: [],
})

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function readJson<T>(path: string, fallback: () => T): T {
  if (!existsSync(path)) return fallback()
  try {
    return { ...fallback(), ...(JSON.parse(readFileSync(path, 'utf8')) as T) }
  } catch {
    // 读不懂（被人手改坏了）：当没有。换版只走原子写，正常不会出现半截文件
    return fallback()
  }
}

export class ContentStore {
  readonly root: string
  constructor(root: string) {
    this.root = root
  }

  // ---------- 文件 ----------

  #blob(sha: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new ContentPackError('bad_hash', sha)
    return join(this.root, 'blobs', sha)
  }

  hasBlob(sha: string): boolean {
    return existsSync(this.#blob(sha))
  }

  /** 存一个文件：哈希先对上才落盘（对不上抛 `bad_hash`，什么都不写）。 */
  putBlob(sha: string, bytes: Uint8Array): void {
    if (sha256Hex(bytes) !== sha) throw new ContentPackError('bad_hash', sha)
    const path = this.#blob(sha)
    if (existsSync(path)) return
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, bytes)
    renameSync(tmp, path)
  }

  readBlob(sha: string): Buffer | undefined {
    const path = this.#blob(sha)
    if (!existsSync(path)) return undefined
    const b = readFileSync(path)
    // 落盘之后被改过（磁盘坏了 / 有人动过）：当它不存在，下次重新下
    return sha256Hex(b) === sha ? b : undefined
  }

  /** 条目摊开的父目录：`readBundledSkill(name, treeDir(sha))` 就能读到。 */
  treeDir(itemSha: string): string {
    if (!/^[0-9a-f]{64}$/.test(itemSha)) throw new ContentPackError('bad_hash', itemSha)
    return join(this.root, 'trees', itemSha)
  }

  /** 按清单把条目摊开成目录（已摊开就直接回）。文件必须都已存进 `blobs/`。 */
  ensureTree(item: Pick<ContentItem, 'name' | 'sha256' | 'files'>): string {
    const dir = this.treeDir(item.sha256)
    if (existsSync(join(dir, '.complete'))) return dir
    const tmp = `${dir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    for (const f of item.files) {
      const problem = contentPathProblem(f.path)
      if (problem !== undefined) throw new ContentPackError('bad_path', `${f.path}：${problem}`)
      const bytes = this.readBlob(f.sha256)
      if (bytes === undefined) throw new ContentPackError('missing_file', f.path)
      const target = join(tmp, item.name, ...f.path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    writeFileSync(join(tmp, '.complete'), item.sha256)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(tmp, dir)
    return dir
  }

  /** 读条目里的一个文件（文字）。 */
  readItemText(entry: Pick<AppliedContent, 'files'>, path: string): string | undefined {
    const f = entry.files.find((x) => x.path === path)
    if (f === undefined) return undefined
    return this.readBlob(f.sha256)?.toString('utf8')
  }

  // ---------- 状态 ----------

  readGlobal(): GlobalContentState {
    return readJson<GlobalContentState>(join(this.root, 'state.json'), () => ({ max_serial: 0 }))
  }

  writeGlobal(state: GlobalContentState): void {
    atomicWriteJson(join(this.root, 'state.json'), state)
  }

  #wsPath(ws: string): string {
    return join(this.root, 'workspaces', encodeURIComponent(ws), 'state.json')
  }

  readWorkspace(ws: string): WorkspaceContentState {
    return readJson(this.#wsPath(ws), EMPTY_WS)
  }

  writeWorkspace(ws: string, state: WorkspaceContentState): void {
    atomicWriteJson(this.#wsPath(ws), state)
  }

  /** 换版：当前那一版挪进 `previous`，新版成为当前（一次原子写）。回换之前的当前版。 */
  apply(ws: string, itemId: string, next: AppliedContent): AppliedContent | undefined {
    const state = this.readWorkspace(ws)
    const cur = state.items[itemId] ?? {}
    const { skipped_version: _drop, ...rest } = cur
    state.items[itemId] = {
      ...rest,
      current: next,
      ...(cur.current === undefined ? {} : { previous: cur.current }),
    }
    this.writeWorkspace(ws, state)
    return cur.current
  }

  /**
   * 退回上一版：`previous` 挪回当前（没有就回到随软件带的那一版），退下来的这一版记成
   * `skipped_version`（不再自动提它）。回退下来的那一版；没什么可退就回 `undefined`。
   */
  rollback(
    ws: string,
    itemId: string,
  ): { dropped: AppliedContent; restored?: AppliedContent } | undefined {
    const state = this.readWorkspace(ws)
    const cur = state.items[itemId]
    if (cur?.current === undefined) return undefined
    const dropped = cur.current
    state.items[itemId] = {
      ...(cur.previous === undefined ? {} : { current: cur.previous }),
      skipped_version: dropped.version,
    }
    this.writeWorkspace(ws, state)
    return { dropped, ...(cur.previous === undefined ? {} : { restored: cur.previous }) }
  }

  /** 软件自带的那一版已经追上（或更新）：这个品牌的覆盖不要了。 */
  clear(ws: string, itemId: string): void {
    const state = this.readWorkspace(ws)
    if (state.items[itemId] === undefined) return
    delete state.items[itemId]
    this.writeWorkspace(ws, state)
  }

  /** 记过状态的品牌（启动时按它们把更新过的基础层装回去）。 */
  workspaces(): string[] {
    const dir = join(this.root, 'workspaces')
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => decodeURIComponent(d.name))
  }
}
