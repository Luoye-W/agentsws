/**
 * WP247（Luoye 10-07 定 85）：**本机 OpenConnector runtime**——不打进安装包、不要 Docker；
 * 用户第一次点「连接店铺 / 数据后台」时按需下载，用安装包自带的 Node 跑，作为工作台的后台服务随应用启停。
 *
 * 这里只放**服务进程与桌面壳都要认的那几样**（两边各写一份就是两个真源）：
 *
 * | 东西 | 谁写 | 谁读 |
 * |---|---|---|
 * | 钉死的版本 {@link OPEN_CONNECTOR_PIN} + 锁文件（`open-connector-lock.json`） | 我们的代码（升级走 docs/42） | 服务进程的安装器 |
 * | 目录布局 {@link localRuntimeLayout} | — | 两边 |
 * | `current.json`（装好了哪一版、上一版是哪个） | 服务进程（下载装好之后） | 桌面壳（据此起哪一版） |
 * | `control.json`（要不要跑、第几次「重启」） | 服务进程（设置 · 诊断里的按钮） | 桌面壳 |
 * | `supervisor.json`（监督者现在的状态） | 桌面壳 | 服务进程（界面上的「启动中 / 出错」） |
 * | 宿主脚本 {@link HOST_SCRIPT} 与它的环境变量 {@link hostEnv} | 桌面壳每次起之前写一遍 | 子进程 |
 *
 * 08 §5 的风险 2「`OOMOL_CONNECT_*` 这些名字收在 connect-adapter 里」——宿主脚本认的变量名也只在这一处。
 * 本模块只用 `node:path`，不碰文件系统、不 import 上游 SDK：桌面壳主进程可以直接 import（`./local-runtime`）。
 */
import { join } from 'node:path'

/**
 * 钉死的那一版（**不跟 latest**）。升级走 docs/42：改这里的 `version` / `integrity`，
 * 再用 `node scripts/open-connector-lock.mjs` 重出锁文件——两样必须一起改（有测试对着查）。
 *
 * 选 npm 包而不是官方单文件发行物（评估见 WP247 报告 §2）：同一版本下 npm 包 + 锁文件
 * 实测下载约 27 MB（318 个包，每个都按锁文件里的 sha512 校验），单文件发行物每个平台 180–204 MB 且不压缩。
 */
export const OPEN_CONNECTOR_PIN = {
  package: '@oomol-lab/open-connector',
  version: '1.8.0',
  /** registry 上 `dist.integrity` 逐字抄来；锁文件里那一条必须与它相同。 */
  integrity:
    'sha512-Oj+Bh6NFyl2cdkuairXRay9EFEOD/lQq+/Ne53uRNmp+WF6TAEw1L9/Z3Ptk5qLXlkM6RI3CHULuJhofy2wHFA==',
  /** 宿主脚本自己 import 的 HTTP 外壳（与上游依赖解出来的同一版，锁文件里只有一份）。 */
  hostDeps: { '@hono/node-server': '2.0.10' },
  /** 10-07 实测（干净缓存 `npm ci`）：要下的包数、压缩字节、解开后的字节——界面上的「约 30 MB」由它算。 */
  packages: 318,
  downloadBytes: 26_800_000,
  installedBytes: 243_000_000,
  /** 上游 `engines.node`；安装包自带的 Node 22.23 满足。 */
  minNode: '22.18.0',
} as const

export type OpenConnectorPin = {
  package: string
  version: string
  integrity: string
  hostDeps: Readonly<Record<string, string>>
  packages: number
  downloadBytes: number
  installedBytes: number
  minNode: string
}

/** 桌面壳告诉服务进程「本机 runtime 由我来起，你可以替用户下载」的那个开关（值为 `1`）。 */
export const LOCAL_RUNTIME_ENV = 'AGENTSWS_CONNECT_LOCAL_RUNTIME'

/** 只认这种目录名——删除 / 回退之前都先过一遍，防止拼出 `..` 之类的路径。 */
export const VERSION_DIR_RE = /^\d+\.\d+\.\d+$/

export function isVersionDir(name: string): boolean {
  return VERSION_DIR_RE.test(name)
}

/** 安装目录里的 package.json：与锁文件根上那一条逐字对应（`npm ci` 会核对）。 */
export function hostPackageJson(pin: OpenConnectorPin = OPEN_CONNECTOR_PIN): {
  name: string
  version: string
  private: true
  type: 'module'
  dependencies: Record<string, string>
} {
  return {
    name: 'agentsws-open-connector-host',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: { ...pin.hostDeps, [pin.package]: pin.version },
  }
}

export interface LocalRuntimeLayout {
  /** `<data>/runtime/open-connector`：我们下载的那一份全在这里（「删除下载」只删它）。 */
  root: string
  /** `<root>/<版本>`：一版一个目录，`npm ci` 装在里面。 */
  versionDir(version: string): string
  current: string
  control: string
  supervisor: string
  /** 下载缓存（装好就删；失败后重试能接着用）。 */
  cache: string
  /** `<data>/runtime/open-connector-data`：连接与凭据（加密）——**删除下载不碰它**。 */
  data: string
}

export function localRuntimeLayout(dataDir: string): LocalRuntimeLayout {
  const root = join(dataDir, 'runtime', 'open-connector')
  return {
    root,
    versionDir: (version) => {
      if (!isVersionDir(version)) throw new Error(`不是一个版本号：${version}`)
      return join(root, version)
    },
    current: join(root, 'current.json'),
    control: join(root, 'control.json'),
    supervisor: join(root, 'supervisor.json'),
    cache: join(root, '.npm-cache'),
    data: join(dataDir, 'runtime', 'open-connector-data'),
  }
}

// ── 两边之间的三份小文件（写的一方先写临时文件再改名，读的一方坏了就当没有） ─────────────

/** 装好了哪一版；`previous` 是保留着可回退的上一版。 */
export interface CurrentFile {
  version: string
  previous?: string
  installed_at: string
}

/** 服务进程对桌面壳的话：要不要跑、第几次「重启」（数字变了就重启一次）。 */
export interface ControlFile {
  desired: 'run' | 'stop'
  restart_seq: number
  updated_at: string
}

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed'

/** 桌面壳对服务进程的话：监督者现在什么状态（界面上「启动中 / 出错」看它）。 */
export interface SupervisorFile {
  state: SupervisorState
  /** 跑的是哪一版。 */
  version?: string
  port: number
  pid?: number
  /** 连续失败几次（稳定跑一会儿清零）。 */
  attempts: number
  started_at?: string
  last_exit?: { code: number | null; signal: string | null; at: string }
  /** `backoff` 时距下次重启的毫秒数。 */
  retry_in_ms?: number
  /** 子进程最后一行错误输出（已脱敏、截短）——「出错」时问号里给它。 */
  last_error?: string
  updated_at: string
}

const isObj = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function parseCurrentFile(raw: unknown): CurrentFile | undefined {
  if (!isObj(raw) || !str(raw.version) || !isVersionDir(raw.version)) return undefined
  return {
    version: raw.version,
    ...(str(raw.previous) && isVersionDir(raw.previous) && raw.previous !== raw.version
      ? { previous: raw.previous }
      : {}),
    installed_at: str(raw.installed_at) ? raw.installed_at : '',
  }
}

export function parseControlFile(raw: unknown): ControlFile | undefined {
  if (!isObj(raw)) return undefined
  if (raw.desired !== 'run' && raw.desired !== 'stop') return undefined
  const seq = raw.restart_seq
  return {
    desired: raw.desired,
    restart_seq: typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : 0,
    updated_at: str(raw.updated_at) ? raw.updated_at : '',
  }
}

const STATES: readonly SupervisorState[] = ['stopped', 'starting', 'running', 'backoff', 'failed']

export function parseSupervisorFile(raw: unknown): SupervisorFile | undefined {
  if (!isObj(raw)) return undefined
  const state = raw.state
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const port = num(raw.port)
  if (port === undefined) return undefined
  const exit = isObj(raw.last_exit) ? raw.last_exit : undefined
  const pid = num(raw.pid)
  const retry = num(raw.retry_in_ms)
  return {
    state: state as SupervisorState,
    port,
    attempts: num(raw.attempts) ?? 0,
    updated_at: str(raw.updated_at) ? raw.updated_at : '',
    ...(str(raw.version) ? { version: raw.version } : {}),
    ...(pid === undefined ? {} : { pid }),
    ...(str(raw.started_at) ? { started_at: raw.started_at } : {}),
    ...(exit === undefined
      ? {}
      : {
          last_exit: {
            code: typeof exit.code === 'number' ? exit.code : null,
            signal: typeof exit.signal === 'string' ? exit.signal : null,
            at: str(exit.at) ? exit.at : '',
          },
        }),
    ...(retry === undefined ? {} : { retry_in_ms: retry }),
    ...(str(raw.last_error) ? { last_error: raw.last_error.slice(0, 300) } : {}),
  }
}

// ── 宿主脚本：上游的 npm 包是「无头库」，HTTP 外壳与配置由宿主自己管（上游 docs/headless.md） ────

/** 宿主脚本在版本目录里的文件名（桌面壳每次起之前覆盖写一遍——我们升级了它也跟着换）。 */
export const HOST_FILE = 'agentsws-host.mjs'

/** 宿主脚本拒绝启动时的退出码（`EX_CONFIG`）：缺密钥 / proxy 没封死。监督者见到它不必再试。 */
export const HOST_EXIT_CONFIG = 78

/** 监听成功后打的那一行（桌面壳看到它才算「起来了」）。 */
export const HOST_READY_RE = /^\[agentsws-oc\] listening on http:\/\/127\.0\.0\.1:(\d+)/

/**
 * 08 §5 安装器策略落在这里：**加密主密钥、管理令牌缺一个都不启动**；provider proxy 默认全封（`*`）；
 * 只监听 127.0.0.1；`/v1` 再挂一把由管理令牌派生的静态令牌——全新库里一张 token 都没有时 `/v1`
 * 也不再匿名可读（上游默认「有了第一张 token 才开鉴权」）。先查环境变量、后 import 上游包：
 * 拒绝启动的那条路不依赖包装没装好。
 */
export const HOST_SCRIPT = `// Agents 工坊 · 本机 OpenConnector 宿主（WP247）。由工作台自动写入，每次启动都会覆盖，别手改。
import { createHash } from 'node:crypto'
import * as http from 'node:http'

const env = process.env
const refuse = (why) => {
  console.error('[agentsws-oc] refusing to start: ' + why)
  process.exit(${HOST_EXIT_CONFIG})
}
const need = (name) => {
  const value = (env[name] ?? '').trim()
  if (value === '') refuse(name + ' is not set')
  return value
}
const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
const encryptionKey = need('OOMOL_CONNECT_ENCRYPTION_KEY')
const adminToken = need('OOMOL_CONNECT_ADMIN_TOKEN')
const dataDir = need('OOMOL_CONNECT_DATA_DIR')
const port = Number(need('AGENTSWS_OC_PORT'))
if (!Number.isInteger(port) || port <= 0 || port > 65535) refuse('bad AGENTSWS_OC_PORT')
const blockedProxies = list(env.OOMOL_CONNECT_BLOCKED_PROXIES)
if (!blockedProxies.includes('*')) refuse('OOMOL_CONNECT_BLOCKED_PROXIES must contain *')
if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv()

const { createConnectorRuntime } = await import('@oomol-lab/open-connector')
const { serve } = await import('@hono/node-server')
const origin = 'http://127.0.0.1:' + port
const say = (level) => (_fields, message) => console.error('[' + level + '] ' + String(message))
const runtime = await createConnectorRuntime({
  dataDir,
  publicOrigin: origin,
  encryptionKey,
  adminToken,
  runtimeToken: createHash('sha256').update('agentsws-oc-runtime:' + adminToken).digest('hex'),
  network: { trustedHosts: list(env.OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS) },
  actionPolicy: { blockedProxies },
  logger: { info: () => {}, warn: say('warn'), error: say('error') },
})
const server = serve({ fetch: (request) => runtime.fetch(request), port, hostname: '127.0.0.1' }, () => {
  console.log('[agentsws-oc] listening on ' + origin)
})
server.on('error', (err) => {
  console.error('[agentsws-oc] ' + (err.code ?? err.message))
  process.exit(1)
})
let closing = false
const shutdown = () => {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(0), 5000).unref()
  server.close()
  runtime.close().catch(() => {}).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
if (env.AGENTSWS_STOP_ON_STDIN_END === '1') {
  process.stdin.on('end', shutdown)
  process.stdin.on('error', shutdown)
  process.stdin.resume()
}
`

export interface HostEnvInput {
  port: number
  /** {@link LocalRuntimeLayout.data}。 */
  dataDir: string
  encryptionKey: string
  adminToken: string
  /** 代理 fake-IP 时的出站信任名单（`AGENTSWS_CONNECT_TRUSTED_HOSTS`，逗号分隔）。 */
  trustedHosts?: string
}

/** 交给宿主子进程的那几条（密钥只走这一条路：环境变量，不落盘、不进参数）。 */
export function hostEnv(input: HostEnvInput): Record<string, string> {
  const trusted = input.trustedHosts?.trim()
  return {
    AGENTSWS_OC_PORT: String(input.port),
    OOMOL_CONNECT_DATA_DIR: input.dataDir,
    OOMOL_CONNECT_ENCRYPTION_KEY: input.encryptionKey,
    OOMOL_CONNECT_ADMIN_TOKEN: input.adminToken,
    OOMOL_CONNECT_BLOCKED_PROXIES: '*',
    // Windows 上没有 SIGTERM：监督者关 stdin 请它收尾（WP218 那套）
    AGENTSWS_STOP_ON_STDIN_END: '1',
    ...(trusted === undefined || trusted === ''
      ? {}
      : { OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS: trusted }),
  }
}
