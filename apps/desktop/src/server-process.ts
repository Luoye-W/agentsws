/**
 * 怎么把 `apps/server` 起起来。
 *
 * 13 §5 本来的打算是借 Electron 自带的 Node（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，
 * 「一个安装包把运行时带齐」），同一段也留了后手：「Electron 内置 Node 版本须满足要求，
 * **不够则 sidecar 用独立打包的 Node**」。v1 走的是后手，原因是原生模块：
 * `better-sqlite3` 11 的 C++ 编不过 Electron 44 的 V8 头（`v8::External::Value()` 换了签名），
 * 而不重建的话 ABI 又对不上（`ERR_DLOPEN_FAILED`）。`resolveServerRuntime()` 因此默认选
 * 独立 Node；两条路都保留，将来原生模块跟上了改一个返回值就能切回去。
 *
 * 环境变量按**白名单**传：宿主环境里可能有开发者自己的 `DEEPSEEK_API_KEY`、
 * `OOMOL_CONNECT_*`，全量继承会让"密钥只从 safeStorage 来"这条纪律形同虚设。
 */
import { join } from 'node:path'
import type { HaltScope } from './halt.js'
import { haltEnv } from './halt.js'
import type { SpawnRequest } from './ports.js'
import type { DesktopSecrets } from './secrets.js'
import { secretsToEnv } from './secrets.js'

/** 子进程唯一需要继承的宿主变量。 */
export const INHERITED_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ComSpec',
  'NODE_EXTRA_CA_CERTS',
] as const

export function inheritEnv(
  base: Readonly<Record<string, string | undefined>>,
  names: readonly string[] = INHERITED_ENV,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = base[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** 用哪个 Node 跑服务进程。 */
export type ServerRuntime =
  /** Electron 自带的 Node（打包后；原生模块按 Electron ABI 重建过）。 */
  | { kind: 'electron'; execPath: string }
  /** 独立 Node（开发期；原生模块按本机 Node ABI 编译）。 */
  | { kind: 'node'; execPath: string }

export interface ServerSpawnInput {
  runtime: ServerRuntime
  /** `apps/server` 的入口 js。 */
  entry: string
  port: number
  dataDir: string
  halt: readonly HaltScope[]
  secrets: DesktopSecrets
  version: string
  baseEnv: Readonly<Record<string, string | undefined>>
  cwd?: string
  /**
   * `AGENTSWS_HALT_FILE`：桌面壳与服务进程**共用同一份急停真源**（13 §5）。
   * 内核启动读它、每次 `set` 写回它——所以托盘按下的暂停，重启之后仍然是停的，
   * 而且不必再靠重启 sidecar 来生效。
   */
  haltFile?: string
  /**
   * `AGENTSWS_CONNECT_URL`：OpenConnector 本地 runtime 的地址（08 / 18）。
   * 名字与默认值都在 `apps/server/src/connect-url.ts`，桌面壳只负责把宿主环境里
   * 那一条透传下去——不透传的话服务进程会用它自己的默认值，两边看的就不是同一个 runtime。
   */
  connectUrl?: string
}

export function serverSpawnRequest(input: ServerSpawnInput): SpawnRequest {
  const env: Record<string, string> = {
    ...inheritEnv(input.baseEnv),
    // 只有借 Electron 的可执行文件当纯 Node 用时才需要这一条。
    ...(input.runtime.kind === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    AGENTSWS_PORT: String(input.port),
    AGENTSWS_DB_DIR: input.dataDir,
    AGENTSWS_VERSION: input.version,
    ...(input.haltFile === undefined ? {} : { AGENTSWS_HALT_FILE: input.haltFile }),
    ...(input.connectUrl === undefined ? {} : { AGENTSWS_CONNECT_URL: input.connectUrl }),
    ...haltEnv(input.halt),
    ...secretsToEnv(input.secrets),
  }
  return {
    command: input.runtime.execPath,
    args: [input.entry],
    env,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  }
}

export interface RuntimeChoiceInput {
  env: Readonly<Record<string, string | undefined>>
  /** 打包后的 `process.resourcesPath`；开发期给 `undefined`。 */
  resourcesPath: string | undefined
  exists: (path: string) => boolean
  /** `process.execPath`（Electron 可执行文件）。 */
  electronExecPath: string
}

/**
 * 选 Node（13 §5「Electron 内置 Node 版本不够则 sidecar 用独立打包的 Node」）。
 *
 * v1 一律走独立 Node，理由是 `better-sqlite3` 11 编不过 Electron 44 的 V8 头
 * （见 README「原生模块」）。顺序：
 * 1. `AGENTSWS_SIDECAR_RUNTIME=electron` —— 明确要求借 Electron 自带 Node 的逃生口；
 * 2. `AGENTSWS_NODE` —— 指定 node 可执行文件；
 * 3. 安装包里随包携带的 `<resources>/node`；
 * 4. `PATH` 上的 `node`。
 */
export function resolveServerRuntime(input: RuntimeChoiceInput): ServerRuntime {
  if (input.env.AGENTSWS_SIDECAR_RUNTIME === 'electron')
    return { kind: 'electron', execPath: input.electronExecPath }
  const explicit = input.env.AGENTSWS_NODE
  if (explicit !== undefined && explicit !== '') return { kind: 'node', execPath: explicit }
  if (input.resourcesPath !== undefined && input.resourcesPath !== '') {
    const bundled = join(input.resourcesPath, 'node')
    if (input.exists(bundled)) return { kind: 'node', execPath: bundled }
  }
  return { kind: 'node', execPath: 'node' }
}

/**
 * 找 `apps/server` 的入口：打包后在 `resources/server/index.js`，开发期靠 node 解析
 * `@agentsws/server`。两条路都给，第一条存在的赢。
 */
export function resolveServerEntry(
  candidates: readonly (string | undefined)[],
  exists: (path: string) => boolean,
): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && exists(candidate)) return candidate
  }
  throw new Error(
    `找不到服务进程入口，试过：${candidates.filter((c) => c !== undefined).join(', ') || '(空)'}`,
  )
}
