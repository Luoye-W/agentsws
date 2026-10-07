/**
 * WP245（Luoye 10-07 Windows 真机：「能不能像 Claude 一样把终端集成进来，自动装、自动跑」）：
 * **工作台在后台替用户跑平台 CLI 登记过的那几条命令**——用户不开终端、不装 Node、不敲命令。
 *
 * 不是通用终端（Fable 定）：这里只认 `PLATFORM_KITS` 那一行登记过的三类动作——
 *
 * | 动作 | 跑什么（参数在这里拼死，不接受任意字符串） |
 * |---|---|
 * | `install` | `<我们的 node> <npm-cli.js> install --prefix <数据目录>/tools/<cli id> <spec.npm>@<spec.npm_tag>` |
 * | `login` | `<我们的 node> <私有安装的入口> ...spec.login_args`（没有私有安装就用系统里那一份） |
 * | `version` | 由 `platform-cli.ts` 的检测来跑（`spec.version_args`） |
 *
 * 五条纪律：
 *
 * 1. **装进应用自己的数据目录**：不写全局、不要管理员、不改 PATH；npm 缓存也放在 `<tools>/npm-cache`。
 * 2. **用我们自己的 node 起**（服务进程的 `process.execPath`，安装包里捆绑的那一份）：不经 `npm.cmd` /
 *    `shopify.cmd` 壳，Windows 中文用户名路径也只是一个参数。
 * 3. **登录永远是用户本人在 Shopify 的网页上完成**：我们只把 CLI 打印的登录网址交给工作台去打开，
 *    密码不经过这里；CLI 存的会话文件我们不读。进程正常结束 = 登好了，按品牌记一笔时间。
 * 4. **子进程环境走白名单**（`PASSTHROUGH_ENV` + 平台那一行的关遥测变量）；安装另放行代理与源地址。
 * 5. 输出先抹一遍（{@link scrubCliOutput}）再进「详情」，不进事件；事件里只有 CLI id / 动作 / 结果码。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, posix, win32 } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { PlatformCliJobView } from '@agentsws/api'
import type { PlatformCliSpec } from '@agentsws/contracts'
import { netCauseOf } from '@agentsws/model-gateway'
import { killTree } from './kill-tree.js'
import { type NpmRegistryChoice, withRegistry } from './npm-registry.js'
import { ensureNpmCli, NpmRuntimeError } from './npm-runtime.js'
import { probeEnv } from './platform-cli.js'
import { type CliSession, cliSessionEnv } from './platform-cli-session.js'
import { scrubCliOutput } from './shopify-theme.js'
import { cliSpawnSpec, envValue } from './win-cli.js'

/** 替用户跑的两类动作（`version` 走检测那条路）。 */
export type CliAction = 'install' | 'login'

export type CliJobView = PlatformCliJobView
export type CliJobPhase = PlatformCliJobView['phase']
/** 失败的种类（界面按它说人话；`detail` 是 `ENOTFOUND` 这种码）。 */
export type CliJobErrorCode = NonNullable<PlatformCliJobView['error']>['code']

/** 一个跑着的子进程（测试换成假的；默认是真 `spawn`）。 */
export interface ToolProcess {
  onLine(cb: (line: string) => void): void
  write(text: string): void
  kill(): void
  /** 退出码；起不来是 -1。 */
  done: Promise<number>
}

export type SpawnTool = (
  command: string,
  args: readonly string[],
  opts: { env: Record<string, string>; cwd: string },
) => ToolProcess

export function cleanLine(raw: string): string {
  return scrubCliOutput(stripVTControlCharacters(raw).replace(/\r/g, '')).trimEnd()
}

export function defaultSpawnTool(): SpawnTool {
  return (command, args, opts) => {
    // Windows：系统里那份 `shopify.cmd` 经 cmd.exe 起（win-cli.ts）；我们自己的 node.exe 直接起
    const spec = cliSpawnSpec(command, args, { env: opts.env })
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(spec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    })
    const listeners: ((line: string) => void)[] = []
    const emit = (line: string): void => {
      for (const cb of listeners) cb(line)
    }
    const feed = (): { push: (chunk: Buffer) => void; flush: () => void } => {
      let buffer = ''
      return {
        push: (chunk) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split(/\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) emit(line)
        },
        flush: () => {
          if (buffer !== '') emit(buffer)
          buffer = ''
        },
      }
    }
    const out = feed()
    const err = feed()
    child.stdout?.on('data', out.push)
    child.stderr?.on('data', err.push)
    child.stdin?.on('error', () => undefined)
    return {
      onLine: (cb) => listeners.push(cb),
      write: (text) => {
        child.stdin?.write(text)
      },
      kill: () => killTree(child),
      done: new Promise<number>((resolve) => {
        child.on('close', (code) => {
          out.flush()
          err.flush()
          resolve(code ?? 1)
        })
        child.on('error', () => resolve(-1))
      }),
    }
  }
}

// ── 私有安装在哪、怎么起 ────────────────────────────────────────────────

/** 这个 CLI 的私有安装目录：`<tools>/<cli id>`。 */
export function privateCliDir(
  toolsDir: string,
  spec: Pick<PlatformCliSpec, 'id'>,
  platform: string = process.platform,
): string {
  return pathFor(platform).join(toolsDir, spec.id)
}

/** 按平台拼路径（Windows 的路径在 mac 上的单测里也拼得对）。 */
const pathFor = (platform: string): typeof posix => (platform === 'win32' ? win32 : posix)

/**
 * 私有安装的入口脚本（`node_modules/<npm>/package.json` 里 `bin[spec.bin]` 指的那个文件）；
 * 没装 / 装坏了回 undefined。
 */
export function privateCliEntry(
  toolsDir: string,
  spec: Pick<PlatformCliSpec, 'id' | 'npm' | 'bin'>,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  platform: string = process.platform,
): string | undefined {
  const { join } = pathFor(platform)
  const pkgDir = join(
    privateCliDir(toolsDir, spec, platform),
    'node_modules',
    ...spec.npm.split('/'),
  )
  const pkgFile = join(pkgDir, 'package.json')
  if (!exists(pkgFile)) return undefined
  try {
    const pkg = JSON.parse(read(pkgFile)) as { bin?: string | Record<string, string> }
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[spec.bin]
    if (rel === undefined || rel === '') return undefined
    const entry = join(pkgDir, rel)
    return exists(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** 怎么起这个 CLI：私有安装 → `node <入口>`；没有 → 系统里的 `spec.bin`。 */
export interface CliInvocation {
  command: string
  prefix: string[]
  source: 'app' | 'system'
}

export function cliInvocation(
  toolsDir: string | undefined,
  nodeExec: string,
  spec: Pick<PlatformCliSpec, 'id' | 'npm' | 'bin'>,
  exists?: (path: string) => boolean,
  read?: (path: string) => string,
  platform?: string,
): CliInvocation {
  const entry =
    toolsDir === undefined ? undefined : privateCliEntry(toolsDir, spec, exists, read, platform)
  return entry === undefined
    ? { command: spec.bin, prefix: [], source: 'system' }
    : { command: nodeExec, prefix: [entry], source: 'app' }
}

/** 服务进程是不是跑在 Electron 自带的 Node 上（那时 execPath 不是一个叫 node 的文件）。 */
const onElectron = (): boolean => typeof process.versions.electron === 'string'

/** 安装 / 登录时多放行的几个（代理、证书与下载源：国内网络常要；不是我们的秘密）。 */
export const INSTALL_EXTRA_ENV: readonly string[] = [
  'ComSpec',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
]

/**
 * 替用户跑命令时的子进程环境：白名单 + 关遥测；PATH 最前面放我们的 node 所在目录
 * （CLI 自己再起 `node` 时用的也是它）。登录**不能**带 `CI`——CLI 一看到 CI 就拒绝交互登录。
 */
export function runEnv(
  spec: Pick<PlatformCliSpec, 'telemetry_off_env'>,
  env: NodeJS.ProcessEnv,
  opts: { nodeExec: string; action: CliAction | 'version'; toolsDir?: string },
): Record<string, string> {
  const out = probeEnv(spec, env)
  if (opts.action === 'login') delete out.CI
  const path = envValue(env, 'PATH') ?? ''
  // nodeExec 是一个带目录的路径才往 PATH 里放（`node` 这种裸名就是 PATH 上那个）
  const nodeDir = /[\\/]/.test(opts.nodeExec) && !onElectron() ? dirname(opts.nodeExec) : undefined
  out.PATH = nodeDir === undefined ? path : path === '' ? nodeDir : `${nodeDir}${delimiter}${path}`
  if (onElectron()) out.ELECTRON_RUN_AS_NODE = '1'
  // 代理与证书：安装要连 npm 源，登录要连平台的账号服务（CLI 自己认这几个变量）
  if (opts.action !== 'version')
    for (const key of INSTALL_EXTRA_ENV) {
      const value = env[key]
      if (typeof value === 'string' && value !== '') out[key] = value
    }
  if (opts.action === 'install') {
    out.npm_config_update_notifier = 'false'
    out.npm_config_fund = 'false'
    out.npm_config_audit = 'false'
    if (opts.toolsDir !== undefined) out.npm_config_cache = join(opts.toolsDir, 'npm-cache')
  }
  return out
}

// ── 读输出 ──────────────────────────────────────────────────────────────

/** 网络层的错误码（npm 打出来的 `npm error code X` / fetch 的 cause.code）。 */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ERR_SOCKET_TIMEOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'E407',
  'E500',
  'E502',
  'E503',
  'E504',
])

/** 一个错误码属于哪一类。 */
export function classifyErrorCode(code: string | undefined): CliJobErrorCode {
  if (code === undefined) return 'failed'
  if (NETWORK_CODES.has(code)) return 'network'
  if (code === 'ENOSPC') return 'disk_full'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'permission'
  return 'failed'
}

/** npm 的错误行：`npm error code ENOTFOUND`（npm 10）/ `npm ERR! code ENOTFOUND`（老版本）。 */
export function npmErrorCode(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const m = /^npm (?:error|ERR!) code (\S+)/.exec(line)
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/** npm `--loglevel=http` 下每取回一个包打一行 `npm http fetch GET 200 <url>`。 */
export function isNpmFetchLine(line: string): boolean {
  return /^npm http fetch GET 200 /.test(line)
}

/** 登录输出里的那几样：网址、确认码、CLI 自己开没开浏览器、要不要按一个键。 */
export function parseLoginLine(line: string): {
  url?: string
  code?: string
  opened?: boolean
  pressKey?: boolean
} {
  const out: { url?: string; code?: string; opened?: boolean; pressKey?: boolean } = {}
  const url = /(https:\/\/[^\s"'<>]+)/.exec(line)?.[1]?.replace(/[).,;]+$/, '')
  if (url !== undefined) out.url = url
  const code = /verification code:?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i.exec(line)?.[1]
  if (code !== undefined) out.code = code
  if (/^\s*Opened link/i.test(line)) out.opened = true
  if (/press any key/i.test(line)) out.pressKey = true
  return out
}

/** 找 / 下 npm 失败是哪一类（WP242：从 cause 链挖出 `ENOTFOUND` 之类）。 */
export function npmFetchFailure(err: unknown): { code: CliJobErrorCode; detail?: string } {
  const cause = netCauseOf(err)
  const kind = classifyErrorCode(cause.code)
  const code: CliJobErrorCode =
    err instanceof NpmRuntimeError && err.code === 'network'
      ? kind === 'failed'
        ? 'network'
        : kind
      : err instanceof NpmRuntimeError && err.code === 'disk'
        ? kind === 'failed'
          ? 'permission'
          : kind
        : 'failed'
  return { code, ...(cause.code === undefined ? {} : { detail: cause.code }) }
}

/** 登录失败是哪一类（看输出尾巴）。 */
export function loginFailure(lines: readonly string[]): CliJobErrorCode {
  const text = lines.join('\n')
  if (/access denied/i.test(text)) return 'denied'
  if (/expired/i.test(text)) return 'expired'
  for (const code of NETWORK_CODES) if (text.includes(code)) return 'network'
  if (/network|fetch failed|getaddrinfo/i.test(text)) return 'network'
  return 'failed'
}

// ── 跑 ──────────────────────────────────────────────────────────────────

/**
 * 登录参数：`login_args` + `<login_alias_flag> <本品牌别名>`（Shopify CLI 4.x 非交互登录必须带 `--alias`）。
 * 没给品牌会话时用一个固定别名兜底——不带就是 Fable 10-07 真机上那一句「Flag not specified: --alias」。
 */
export function loginArgs(
  spec: Pick<PlatformCliSpec, 'login_args' | 'login_alias_flag'>,
  session: CliSession | undefined,
): string[] {
  const base = [...(spec.login_args ?? [])]
  if (spec.login_alias_flag === undefined) return base
  return [...base, spec.login_alias_flag, session?.alias ?? 'agentsws']
}

export class CliRunnerError extends Error {
  constructor(
    readonly code: 'conflict' | 'not_installed' | 'not_supported' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'CliRunnerError'
  }
}

export interface PlatformCliRunnerOptions {
  now: () => string
  /** 应用自己的工具目录（`<data>/tools`）；没有数据目录（内存档）= 不能装。 */
  toolsDir: string | undefined
  /** 我们自己的 node（默认 `process.execPath`）。 */
  nodeExec?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnTool
  /**
   * 找 / 下 npm（默认 {@link ensureNpmCli}）。`onDownload` 时界面进「下载中」；`registry` 是这一次
   * 用的源（WP254：用户点过「换国内源再试」就是 npmmirror）。
   */
  npmCli?: (onDownload: () => void, registry?: string) => Promise<string>
  /**
   * WP254（决策 100 / 123）：这一次装用哪个源（每台机记的那一份，见 `npm-registry.ts`）。
   * 不给 = 只看环境里的 `npm_config_registry`（WP245 的老样子）。
   */
  registry?: () => NpmRegistryChoice
  fetchImpl?: typeof fetch
  installTimeoutMs?: number
  loginTimeoutMs?: number
  /** 「详情」留几行输出。 */
  logLines?: number
}

export interface StartContext {
  /** 登录进程正常结束（品牌那一笔「登好了」由调用方记）。 */
  onLoginOk?: () => void
  /** 任何一次结束（装好 / 失败 / 取消）：调用方清检测缓存、记事件。 */
  onFinished?: (job: CliJobView) => void
  /**
   * WP253：这次登录是哪个品牌的会话（`platform-cli-session.ts`）。`alias` 跟在 `login_alias_flag` 后面；
   * `home` 给了就把 CLI 的配置目录指过去（一个品牌一份会话）。不给 = 老行为。
   */
  session?: CliSession
}

export interface PlatformCliRunner {
  /** 开始一件事。同一个 CLI 正有一件在跑 → `conflict`。 */
  start(spec: PlatformCliSpec, action: CliAction, ctx?: StartContext): CliJobView
  /** 这个 CLI 最近一件事（跑着的或刚结束的）；没跑过 = undefined。 */
  job(cliId: string): CliJobView | undefined
  /** 停掉正在跑的那件（没在跑就原样回）。 */
  cancel(cliId: string): CliJobView | undefined
  /** 现在怎么起这个 CLI（检测与主题命令共用）。 */
  invocation(spec: PlatformCliSpec): CliInvocation
  /** 服务进程收尾：跑着的全部停掉。 */
  dispose(): void
  readonly nodeExec: string
  readonly toolsDir: string | undefined
}

interface JobEntry {
  view: CliJobView
  proc?: ToolProcess | undefined
  cancelled: boolean
}

const RUNNING = new Set<CliJobPhase>(['preparing', 'downloading', 'installing', 'waiting_browser'])

export function isJobRunning(job: CliJobView | undefined): boolean {
  return job !== undefined && RUNNING.has(job.phase)
}

export function createPlatformCliRunner(options: PlatformCliRunnerOptions): PlatformCliRunner {
  const nodeExec = options.nodeExec ?? process.execPath
  const env = options.env ?? process.env
  const spawnTool = options.spawn ?? defaultSpawnTool()
  const keep = options.logLines ?? 80
  const jobs = new Map<string, JobEntry>()
  const toolsDir = options.toolsDir
  const envRegistry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  /** 这一次的源：注入的那一份（每台机记的）优先；没注入只看环境变量。 */
  const chooseRegistry = (): NpmRegistryChoice =>
    options.registry?.() ??
    (envRegistry === undefined || envRegistry === ''
      ? { source: 'official' }
      : { source: 'custom', url: envRegistry })
  const npmCli =
    options.npmCli ??
    ((onDownload: () => void, registry?: string) => {
      if (toolsDir === undefined) throw new CliRunnerError('unavailable', '没有数据目录，装不了')
      return ensureNpmCli({
        nodeExec,
        toolsDir,
        onDownload,
        ...(registry === undefined || registry === '' ? {} : { registry }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
    })

  const snapshot = (view: CliJobView): CliJobView => ({ ...view, log: [...view.log] })

  const finish = (
    entry: { view: CliJobView },
    phase: 'done' | 'failed' | 'cancelled',
    ctx: StartContext,
    error?: CliJobView['error'],
  ): void => {
    if (!RUNNING.has(entry.view.phase)) return
    entry.view.phase = phase
    entry.view.finished_at = options.now()
    if (error !== undefined) entry.view.error = error
    try {
      ctx.onFinished?.(snapshot(entry.view))
    } catch {
      // 记事件 / 清缓存失败不影响结果
    }
  }

  /** 起一个进程，接上输出、超时与取消；回退出码（超时 / 取消回 undefined）。 */
  const runProcess = async (
    entry: JobEntry,
    command: string,
    args: string[],
    childEnv: Record<string, string>,
    cwd: string,
    timeoutMs: number,
    onLine: (line: string, proc: ToolProcess) => void,
  ): Promise<number | 'timeout' | 'cancelled'> => {
    const proc = spawnTool(command, args, { env: childEnv, cwd })
    entry.proc = proc
    proc.onLine((raw) => {
      const line = cleanLine(raw)
      if (line === '') return
      entry.view.log.push(line)
      if (entry.view.log.length > keep) entry.view.log.splice(0, entry.view.log.length - keep)
      onLine(line, proc)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    timer.unref?.()
    const code = await proc.done
    clearTimeout(timer)
    entry.proc = undefined
    if (entry.cancelled) return 'cancelled'
    if (timedOut) return 'timeout'
    return code
  }

  const install = async (
    spec: PlatformCliSpec,
    entry: JobEntry,
    ctx: StartContext,
  ): Promise<void> => {
    if (toolsDir === undefined) {
      finish(entry, 'failed', ctx, { code: 'failed', detail: 'no data dir' })
      return
    }
    // WP254：这一次用哪个源，记在任务上（失败行据此决定给不给「换国内源再试」）
    const choice = chooseRegistry()
    entry.view.registry = choice.source
    let cli: string
    try {
      cli = await npmCli(() => {
        if (entry.view.phase === 'preparing') entry.view.phase = 'downloading'
      }, choice.url)
    } catch (err) {
      const { code, detail } = npmFetchFailure(err)
      entry.view.log.push(cleanLine(err instanceof Error ? err.message : String(err)))
      finish(entry, 'failed', ctx, { code, ...(detail === undefined ? {} : { detail }) })
      return
    }
    if (entry.cancelled) {
      finish(entry, 'cancelled', ctx)
      return
    }
    const dir = privateCliDir(toolsDir, spec)
    try {
      mkdirSync(dir, { recursive: true })
      const pkg = join(dir, 'package.json')
      // 有一份 package.json，npm 才不会往上找到别人的项目
      if (!existsSync(pkg))
        writeFileSync(
          pkg,
          `${JSON.stringify({ name: `agentsws-tool-${spec.id}`, private: true }, null, 2)}\n`,
        )
    } catch (err) {
      const code = classifyErrorCode((err as NodeJS.ErrnoException).code)
      finish(entry, 'failed', ctx, { code: code === 'failed' ? 'permission' : code })
      return
    }
    entry.view.phase = 'installing'
    entry.view.fetched = 0
    const target = `${spec.npm}@${spec.npm_tag ?? 'latest'}`
    const args = [
      cli,
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--omit=dev',
      '--loglevel=http',
      target,
    ]
    const result = await runProcess(
      entry,
      nodeExec,
      args,
      withRegistry(runEnv(spec, env, { nodeExec, action: 'install', toolsDir }), choice),
      dir,
      options.installTimeoutMs ?? 10 * 60 * 1000,
      (line) => {
        if (isNpmFetchLine(line)) entry.view.fetched = (entry.view.fetched ?? 0) + 1
      },
    )
    if (result === 'cancelled') return finish(entry, 'cancelled', ctx)
    if (result === 'timeout') return finish(entry, 'failed', ctx, { code: 'timeout' })
    if (result !== 0) {
      const npmCode = npmErrorCode(entry.view.log)
      return finish(entry, 'failed', ctx, {
        code: classifyErrorCode(npmCode),
        detail: npmCode ?? `exit ${result}`,
      })
    }
    if (privateCliEntry(toolsDir, spec) === undefined)
      return finish(entry, 'failed', ctx, { code: 'failed', detail: 'entry missing' })
    finish(entry, 'done', ctx)
  }

  const login = async (
    spec: PlatformCliSpec,
    entry: JobEntry,
    ctx: StartContext,
    how: CliInvocation,
  ): Promise<void> => {
    entry.view.phase = 'waiting_browser'
    let pressed = false
    const session = ctx.session
    // 重新登录：这个品牌原来那份会话先挪成 `.prev`（空配置才不会撞上 CLI 的「选哪个账号」提问）
    const home = session?.home
    const prev = home === undefined ? undefined : `${home}.prev`
    if (home !== undefined && prev !== undefined) {
      if (existsSync(prev)) rmSync(prev, { recursive: true, force: true })
      if (existsSync(home)) renameSync(home, prev)
      mkdirSync(home, { recursive: true })
    }
    const result = await runProcess(
      entry,
      how.command,
      [...how.prefix, ...loginArgs(spec, session)],
      {
        ...runEnv(spec, env, { nodeExec, action: 'login' }),
        ...(home === undefined ? {} : cliSessionEnv(home)),
      },
      // 登录不在乎目录；工具目录还没建过（用的是系统里那份）就在用户主目录里起
      toolsDir !== undefined && existsSync(toolsDir) ? toolsDir : homedir(),
      options.loginTimeoutMs ?? 15 * 60 * 1000,
      (line, proc) => {
        const hit = parseLoginLine(line)
        if (hit.url !== undefined && entry.view.login_url === undefined)
          entry.view.login_url = hit.url
        if (hit.code !== undefined) entry.view.user_code = hit.code
        if (hit.opened === true) entry.view.browser_opened = true
        // 老版本 CLI：「按任意键打开浏览器」——替用户按一下（浏览器由它开或由工作台开）
        if (hit.pressKey === true && !pressed) {
          pressed = true
          proc.write('\n')
        }
      },
    )
    // 没登成：挪回原来那份（原来登着的品牌不因为一次失败的重登变成没登录）
    const restore = (): void => {
      if (home === undefined || prev === undefined || !existsSync(prev)) return
      rmSync(home, { recursive: true, force: true })
      renameSync(prev, home)
    }
    if (result === 'cancelled') {
      restore()
      return finish(entry, 'cancelled', ctx)
    }
    if (result === 'timeout') {
      restore()
      return finish(entry, 'failed', ctx, { code: 'timeout' })
    }
    if (result !== 0) {
      restore()
      return finish(entry, 'failed', ctx, { code: loginFailure(entry.view.log) })
    }
    if (prev !== undefined && existsSync(prev)) rmSync(prev, { recursive: true, force: true })
    try {
      ctx.onLoginOk?.()
    } catch {
      // 记「登好了」失败：卡上还是没登录，用户再点一次
    }
    finish(entry, 'done', ctx)
  }

  const invocation = (spec: PlatformCliSpec): CliInvocation =>
    cliInvocation(toolsDir, nodeExec, spec)

  return {
    nodeExec,
    toolsDir,
    invocation,
    dispose: () => {
      for (const entry of jobs.values()) {
        if (!RUNNING.has(entry.view.phase)) continue
        entry.cancelled = true
        entry.proc?.kill()
      }
    },
    job: (id) => {
      const entry = jobs.get(id)
      return entry === undefined ? undefined : snapshot(entry.view)
    },
    cancel: (id) => {
      const entry = jobs.get(id)
      if (entry === undefined) return undefined
      if (RUNNING.has(entry.view.phase)) {
        entry.cancelled = true
        entry.proc?.kill()
      }
      return snapshot(entry.view)
    },
    start: (spec, action, ctx = {}) => {
      if (isJobRunning(jobs.get(spec.id)?.view))
        throw new CliRunnerError('conflict', '上一件还没做完')
      let how: CliInvocation | undefined
      if (action === 'login') {
        if (spec.login_args === undefined || spec.login_args.length === 0)
          throw new CliRunnerError('not_supported', '这个 CLI 不支持一键登录')
        how = invocation(spec)
      } else if (toolsDir === undefined) {
        throw new CliRunnerError('unavailable', '没有数据目录，装不了')
      }
      const command =
        action === 'install'
          ? `npm install --prefix "${privateCliDir(toolsDir ?? '', spec)}" ${spec.npm}@${spec.npm_tag ?? 'latest'}`
          : [
              how?.source === 'app' ? `${spec.bin} (${how.prefix[0]})` : spec.bin,
              ...loginArgs(spec, ctx.session),
            ].join(' ')
      const entry = {
        view: {
          action,
          phase: 'preparing' as CliJobPhase,
          started_at: options.now(),
          command,
          log: [],
        } satisfies CliJobView as CliJobView,
        cancelled: false,
      }
      jobs.set(spec.id, entry)
      const work =
        action === 'install'
          ? install(spec, entry, ctx)
          : login(spec, entry, ctx, how ?? invocation(spec))
      void work.catch((err: unknown) => {
        entry.view.log.push(cleanLine(err instanceof Error ? err.message : String(err)))
        finish(entry, 'failed', ctx, { code: 'failed' })
      })
      return snapshot(entry.view)
    },
  }
}
