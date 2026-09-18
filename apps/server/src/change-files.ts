/**
 * WP95（36 §11，`docs/upstream/sidebar-compare.md` #11）：**变更审阅——逐文件 diff**。
 *
 * 这是那份对照表里唯一一条"现在就缺、而且缺得明显"的：建站职责跑完一轮，
 * 人看得见"要不要发布"（`publish_theme` 那张卡），看不见"这一轮到底改了哪几个
 * liquid 的哪几行"。这个文件把后半句补上。
 *
 * **形借官方，体是我们自己的。** 官方那一侧（`dsh-workspace-changes`）的体不借，
 * 三条实测理由写在 `sidebar-compare.md` §4：① 它的摘要活到 Session 销毁为止，
 * 而我们一次运行一棵树、结束即 dispose（17 §5.1）；② 它没有仓库时只记"文件工具改的"，
 * 而 WP89 的主题改动**全是 shell**；③ 它挂在 `tools/pre-execute` 前面，等于把每次
 * 工具调用的延迟绑到一条 git 队列上。
 *
 * **能直接借的是它那三条约束**，这个文件逐条落：
 *
 * | 约束 | 这里怎么做 |
 * |---|---|
 * | 私有 index，仓库的 index / objects / worktree / refs 一个都不动 | 把 `.git/index` 抄一份到临时文件，`GIT_INDEX_FILE` 指着那一份跑（于是 `add -N` 认得出没跟踪的新文件，而仓库那一份一个字节没变） |
 * | 环境清洗 + 超时 + 输出有界 | {@link PASSTHROUGH_ENV} 白名单 + `GIT_CONFIG_COUNT=0` / `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0`，每条命令带超时，每个文件与总量各有上限 |
 * | 行对比超时降级成粗粒度 | 单个文件的 `git diff` 超 {@link FILE_DIFF_TIMEOUT_MS} 就只留增删行数、标 `coarse`，**不把界面卡住** |
 *
 * **只读。** 这里不 `add`（真加）、不 `commit`、不 `checkout`、不写工作树。
 * 面板里也不改文件——要改回去走撤回或反向变更（15 §7），那条路上有审批。
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChangeFileDiff, ChangeFilesView, StagedChange } from '@agentsws/contracts'
import { PASSTHROUGH_ENV } from './shopify-theme.js'

/** git 的"空树"对象：还没有第一个 commit 时拿它当基线。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** 一条 git 命令最多跑多久。 */
export const GIT_TIMEOUT_MS = 5_000
/** 单个文件的 diff 最多跑多久；超了降级成粗粒度（官方那条 `diffTimeoutMs` 的同一件事）。 */
export const FILE_DIFF_TIMEOUT_MS = 1_500
/** 最多列多少个文件。 */
export const MAX_FILES = 200
/** 单个文件的 diff 正文上限（字节）。 */
export const MAX_FILE_DIFF_BYTES = 64 * 1024
/** 所有文件加起来的 diff 正文上限（字节）。 */
export const MAX_TOTAL_DIFF_BYTES = 512 * 1024

/** 跑一条 git 的结果；`timedOut` 单列出来是因为它要降级而不是报错。 */
interface GitResult {
  ok: boolean
  stdout: string
  timedOut: boolean
}

/**
 * 清洗过的子进程环境。
 *
 * 除了 {@link PASSTHROUGH_ENV} 那几个跑得起 git 必需的，本进程的环境一律不传——
 * `AGENTSWS_SECRETS_KEY`、模型 key、连接器令牌都不该让一个子进程看见（13 §4）。
 * 后面那三个是官方借来的：不读用户的 gitconfig、不弹交互式凭据提示、不抢可选锁。
 */
function gitEnv(indexFile: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  env.GIT_CONFIG_COUNT = '0'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  if (indexFile !== undefined) env.GIT_INDEX_FILE = indexFile
  return env
}

/** 跑一条 `git …`（测试注入假 git）。 */
export type RunGit = (
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<GitResult>

const defaultRunGit: RunGit = (args, opts) =>
  new Promise((resolve) => {
    execFile('git', [...args], { ...opts, encoding: 'utf8' }, (err, stdout) => {
      const killed = (err as { killed?: boolean } | null)?.killed === true
      const signal = (err as { signal?: string } | null)?.signal
      resolve({
        ok: err === null,
        stdout: stdout ?? '',
        timedOut: killed || signal === 'SIGTERM',
      })
    })
  })

/** `A` / `M` / `D` / `R100` → 我们那四个词。 */
function statusOf(code: string): ChangeFileDiff['status'] {
  const head = code[0]
  if (head === 'A') return 'added'
  if (head === 'D') return 'deleted'
  if (head === 'R') return 'renamed'
  return 'modified'
}

export interface ChangeFilesOptions {
  /** 数据目录（主题工作副本在 `<data>/themes/<workspace>/<store>/`，见 `dsh-adapter/src/shell.ts`）。 */
  dataDir: string
  runGit?: RunGit
}

/**
 * 这条变更对着哪家店的主题副本。
 *
 * 三级兜底，第一条命中就停：
 * 1. `after.store`（有人显式写了）；
 * 2. `after.command` 里的 `--store <x>`（`publish_theme` 的 `after` 带着 Agent 打算跑的那条命令）；
 * 3. 这个工作区底下只有一家店的副本时就是它——单店是绝大多数用户的常态，
 *    为这一档多问一次"哪家店"是没必要的摩擦；多于一家就不猜（猜错了人看的是别家店的 diff）。
 */
export function storeOfChange(change: StagedChange, dataDir: string): string | undefined {
  const after = change.after
  const record =
    after !== null && typeof after === 'object' ? (after as Record<string, unknown>) : {}
  if (typeof record.store === 'string' && record.store !== '') return record.store
  if (typeof record.command === 'string') {
    const m = /--store[= ]([^\s]+)/.exec(record.command)
    if (m?.[1] !== undefined) return m[1]
  }
  const dir = join(dataDir, 'themes', segment(change.workspace_id))
  if (!existsSync(dir)) return undefined
  const stores = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())
  return stores.length === 1 ? stores[0] : undefined
}

/** 与 `dsh-adapter/src/shell.ts` 的 `segment()` 同一条规则（目录名归一）。 */
function segment(value: string): string {
  const mapped = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|-+$/g, '')
  return mapped === '' ? 'x' : mapped
}

/**
 * 一条变更改了哪几个文件。
 *
 * 取不到**不是错误**：Agent 没在副本目录里 `git init` 过、副本被清过、
 * 这台机器上根本没有这家店的副本——都是常态。这时候回 `available: false` 加一句人话，
 * 界面照实说，而不是弹一个 500。
 */
export async function changeFiles(
  change: StagedChange,
  options: ChangeFilesOptions,
): Promise<ChangeFilesView> {
  const base: ChangeFilesView = {
    change_id: change.id,
    kind: change.kind,
    available: false,
    files: [],
    truncated: false,
  }
  const store = storeOfChange(change, options.dataDir)
  if (store === undefined)
    return { ...base, detail: '这条变更找不到对应的主题工作副本（这台机器上没有，或者有好几家店）' }
  const root = join(options.dataDir, 'themes', segment(change.workspace_id), segment(store))
  if (!existsSync(join(root, '.git')))
    return { ...base, store, detail: '这份主题副本不是 git 仓库，比不出改了哪几行' }

  const run = options.runGit ?? defaultRunGit
  // 私有 index：抄一份 `.git/index` 出来，仓库那一份一个字节不动
  const tmp = mkdtempSync(join(tmpdir(), 'agentsws-diff-'))
  const indexFile = join(tmp, 'index')
  try {
    const original = join(root, '.git', 'index')
    if (existsSync(original)) copyFileSync(original, indexFile)
    const env = gitEnv(indexFile)
    const git = (args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> =>
      run(args, { cwd: root, env, timeout, maxBuffer: MAX_TOTAL_DIFF_BYTES * 2 })

    // 没跟踪的新文件也要算进来（主题里加一个 section 就是新文件）。
    // `-N` 只写 intent，而且写的是**私有 index**，所以这一步仍然是只读的。
    await git(['--no-optional-locks', 'add', '-N', '--ignore-errors', '--', '.'])

    const head = await git(['--no-optional-locks', 'rev-parse', '--verify', '--quiet', 'HEAD'])
    const against = head.ok && head.stdout.trim() !== '' ? head.stdout.trim() : EMPTY_TREE

    const numstat = await git(['--no-optional-locks', 'diff', '-M', '--numstat', against])
    if (numstat.timedOut) return { ...base, store, detail: '比对超时了（这份副本太大）' }
    if (!numstat.ok) return { ...base, store, detail: 'git 没跑成，比不出改了哪几行' }
    const names = await git(['--no-optional-locks', 'diff', '-M', '--name-status', against])

    /** `path` → status（`--name-status` 那一份）。 */
    const statuses = new Map<string, ChangeFileDiff['status']>()
    for (const line of names.stdout.split('\n')) {
      const parts = line.split('\t')
      const code = parts[0]
      const path = parts[parts.length - 1]
      if (code === undefined || path === undefined || code === '') continue
      statuses.set(path, statusOf(code))
    }

    const rows = numstat.stdout.split('\n').filter((l) => l.trim() !== '')
    const truncated = rows.length > MAX_FILES
    const files: ChangeFileDiff[] = []
    let total = 0
    for (const line of rows.slice(0, MAX_FILES)) {
      const [add, del, ...rest] = line.split('\t')
      const raw = rest.join('\t')
      if (raw === '') continue
      // 改名在 numstat 里是 `old => new`（或带大括号的那种）；只认最后那一段当新路径
      const arrow = raw.includes(' => ')
      const path = arrow ? (raw.split(' => ').pop() as string).replace(/[{}]/g, '') : raw
      const old_path = arrow ? (raw.split(' => ')[0] as string).replace(/[{}]/g, '') : undefined
      // numstat 里二进制文件那两格是 `-`
      const binary = add === '-' || del === '-'
      const entry: ChangeFileDiff = {
        path,
        status: statuses.get(path) ?? (arrow ? 'renamed' : 'modified'),
        ...(old_path === undefined ? {} : { old_path }),
        additions: binary ? 0 : Number.parseInt(add ?? '0', 10) || 0,
        deletions: binary ? 0 : Number.parseInt(del ?? '0', 10) || 0,
        diff: '',
        truncated: false,
        coarse: false,
        binary,
      }
      if (binary || total >= MAX_TOTAL_DIFF_BYTES) {
        entry.truncated = !binary
        files.push(entry)
        continue
      }
      const one = await git(
        ['--no-optional-locks', 'diff', '-M', '--no-color', against, '--', path],
        FILE_DIFF_TIMEOUT_MS,
      )
      if (one.timedOut || !one.ok) {
        // 官方那条降级：不给行对比，只说"这个文件整个换了"，界面照实标出来
        entry.coarse = true
        files.push(entry)
        continue
      }
      const text = one.stdout
      entry.diff = text.length > MAX_FILE_DIFF_BYTES ? text.slice(0, MAX_FILE_DIFF_BYTES) : text
      entry.truncated = text.length > MAX_FILE_DIFF_BYTES
      total += entry.diff.length
      files.push(entry)
    }
    return { change_id: change.id, kind: change.kind, available: true, store, files, truncated }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
