/**
 * WP247（Luoye 10-07 定 85）：**本机连接器（OpenConnector）作为工作台的后台服务随应用起停**——
 * 不要 Docker，用安装包自带的 Node 跑服务进程按需下载好的那一份。
 *
 * 13 §5 的「进程监督：起、停、崩溃重启、端口分配、日志」落在这里：
 *
 * - **起哪一版**：服务进程下载装好后写 `current.json`；这里每 2 秒看一眼（`tick`），有了就起，
 *   版本变了（升级 / 回退）就重启到新的那一版；
 * - **要不要跑、要不要重启**：服务进程写 `control.json`（设置 · 诊断里的「重启」「删除下载」）；
 * - **起停与崩溃重启**：`sidecar.ts` 的监督者（退避重启，连续失败到上限就停在 `failed`，等人点重启）；
 * - **报状态**：监督者每变一次就写 `supervisor.json`，界面上的「启动中 / 出错」看它；
 * - **只听 127.0.0.1**、端口由壳选好（{@link pickConnectPort}）经 `AGENTSWS_CONNECT_URL` 告诉服务进程；
 * - **密钥只经环境变量**（`secrets.ts` 的两把，safeStorage 背书）；宿主脚本每次起之前覆盖写一遍；
 * - **退出**：`stop()` 关 stdin 请它收尾，Windows 上到点按进程树强杀（`node-runtime.ts`，WP218 那套）。
 *
 * 地址出处的规则不变（{@link planConnectRuntime}）：`AGENTSWS_CONNECT_URL` 显式给了就用它、**不拉起本机的**。
 */

import { join } from 'node:path'
import {
  HOST_FILE,
  HOST_SCRIPT,
  hostEnv,
  LOCAL_RUNTIME_ENV,
  localRuntimeLayout,
  parseControlFile,
  parseCurrentFile,
  type SupervisorFile,
} from '@agentsws/connect-adapter/local-runtime'
import type { BackoffOptions } from './backoff.js'
import { CONNECT_STANDIN_ENV, type ConnectLauncher, connectUrlFrom } from './connect-runtime.js'
import type { Logger } from './logging.js'
import type { Clock, FileStore, Spawner, TimerHandle, TimerPort } from './ports.js'
import { inheritEnv } from './server-process.js'
import { createSidecar, type Sidecar, type SidecarSnapshot } from './sidecar.js'

/** 第一次选端口时先试这个（不在各系统的临时端口段里，也不撞常见开发端口）；占了就往后找。 */
export const DEFAULT_CONNECT_PORT = 43170

/** 本机连接器从哪来（地址只有两种出处：环境变量、本机 sidecar）。 */
export type ConnectPlan =
  /** `AGENTSWS_CONNECT_URL` 显式给了：用它，不拉起本机的（Docker / 外部 / 将来的云端连接）。 */
  | { kind: 'external'; url: string }
  /** 开发替身（开发期默认、或 `AGENTSWS_CONNECT_STANDIN=1`）。 */
  | { kind: 'stand_in' }
  /** 本机按需下载、壳来起停（打包版默认；开发期 `AGENTSWS_CONNECT_LOCAL_RUNTIME=1` 也走这条）。 */
  | { kind: 'local' }
  /** `remote` 档：这台电脑上什么都不起。 */
  | { kind: 'none' }

export function planConnectRuntime(input: {
  env: Readonly<Record<string, string | undefined>>
  packaged: boolean
  remote: boolean
}): ConnectPlan {
  if (input.remote) return { kind: 'none' }
  const explicit = connectUrlFrom(input.env)
  if (explicit !== undefined) return { kind: 'external', url: explicit }
  if (input.env[CONNECT_STANDIN_ENV] === '1') return { kind: 'stand_in' }
  if (input.packaged || input.env[LOCAL_RUNTIME_ENV] === '1') return { kind: 'local' }
  return { kind: 'stand_in' }
}

export function localConnectUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * 选端口：先试上次用的（配置里记着，OAuth 回调地址因此稳定），再往后找十个，最后让系统给一个。
 * 回来的就是要写回配置的那个。
 */
export async function pickConnectPort(input: {
  preferred: number
  isFree: (port: number) => Promise<boolean>
  osPort: () => Promise<number>
}): Promise<number> {
  const start = input.preferred > 0 ? input.preferred : DEFAULT_CONNECT_PORT
  for (let p = start; p < start + 10 && p <= 65535; p += 1) {
    if (await input.isFree(p)) return p
  }
  return input.osPort()
}

export interface LocalConnectLauncherOptions {
  /** 服务进程的数据目录（`AGENTSWS_DB_DIR`）——下载器按同一个目录放东西。 */
  dataDir: string
  port: number
  /** 跑它的 node（与服务进程同一份：安装包自带的 Node 22）。 */
  nodeExec: string
  /** 借 Electron 当 Node 用（`AGENTSWS_SIDECAR_RUNTIME=electron` 那档）时要 `ELECTRON_RUN_AS_NODE`。 */
  electron?: boolean
  /** 两把密钥（每次起都现取：轮换后下次起用新的）。 */
  secrets: () => { encryptionKey: string; adminToken: string }
  baseEnv: Readonly<Record<string, string | undefined>>
  files: FileStore
  spawner: Spawner
  timers: TimerPort
  clock: Clock
  logger: Logger
  backoff?: BackoffOptions
  random?: () => number
  /** 连续崩这么多次就停下等人点「重启」（默认 8）。 */
  maxAttempts?: number
  stableAfterMs?: number
  /** 多久看一眼那两份文件（默认 2 秒）。 */
  pollMs?: number
  /** 子进程输出（壳把它写进 `open-connector.log`，过脱敏）。 */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void
  /** 写进 `supervisor.json` 的那一行错误先过这道（密钥字面量遮掉）。 */
  redact?: (line: string) => string
}

export interface LocalConnectLauncher extends ConnectLauncher {
  /** 看一眼 `current.json` / `control.json`，让监督者跟上（定时器每 `pollMs` 叫一次；测试直接叫）。 */
  tick(): void
  snapshot(): SidecarSnapshot & { version: string | undefined }
  readonly port: number
  readonly url: string
}

/** 宿主脚本那边也认的代理变量（有一个就给 `NODE_USE_ENV_PROXY=1`，Node 22.21+ 的内置 fetch 才走代理）。 */
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

function readJson(files: FileStore, path: string): unknown {
  const text = files.readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function createLocalConnectLauncher(
  options: LocalConnectLauncherOptions,
): LocalConnectLauncher {
  const { files, timers, clock } = options
  const layout = localRuntimeLayout(options.dataDir)
  const log = options.logger.child('open-connector')
  const pollMs = options.pollMs ?? 2000
  const redact = options.redact ?? ((s: string) => s)
  let version: string | undefined
  let seenSeq: number | undefined
  let lastError: string | undefined
  let poll: TimerHandle | undefined
  let started = false

  const spawnEnv = (): Record<string, string> => {
    const base = options.baseEnv
    const { encryptionKey, adminToken } = options.secrets()
    const proxied = PROXY_ENV.some((k) => (base[k] ?? '') !== '')
    const trusted = base.AGENTSWS_CONNECT_TRUSTED_HOSTS
    return {
      ...inheritEnv(base),
      ...(options.electron === true ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(proxied ? { NODE_USE_ENV_PROXY: '1' } : {}),
      ...hostEnv({
        port: options.port,
        dataDir: layout.data,
        encryptionKey,
        adminToken,
        ...(trusted === undefined ? {} : { trustedHosts: trusted }),
      }),
    }
  }

  const sidecar: Sidecar = createSidecar({
    name: 'open-connector',
    spawner: options.spawner,
    timers,
    clock,
    logger: options.logger,
    maxAttempts: options.maxAttempts ?? 8,
    stableAfterMs: options.stableAfterMs ?? 10_000,
    backoff: options.backoff ?? { baseMs: 1000, maxMs: 30_000, jitter: 0.2 },
    ...(options.random === undefined ? {} : { random: options.random }),
    request: () => {
      const dir = layout.versionDir(version ?? '0.0.0')
      const host = join(dir, HOST_FILE)
      // 宿主脚本随我们的版本走：每次起之前覆盖写一遍（下载那一刻写的可能是老版本工作台写的）
      if (files.readText(host) !== HOST_SCRIPT) files.writeText(host, HOST_SCRIPT)
      files.ensureDir(layout.data)
      lastError = undefined
      return {
        command: options.nodeExec,
        args: [host],
        env: spawnEnv(),
        cwd: dir,
        stopViaStdin: true,
      }
    },
    onOutput: (stream, line) => {
      options.onOutput?.(stream, line)
      if (stream === 'stderr' && line.trim() !== '') lastError = redact(line).slice(0, 300)
    },
  })

  const writeSupervisor = (s: SidecarSnapshot): void => {
    const file: SupervisorFile = {
      state: s.state,
      port: options.port,
      attempts: s.attempts,
      updated_at: clock.now(),
      ...(version === undefined ? {} : { version }),
      ...(s.pid === undefined ? {} : { pid: s.pid }),
      ...(s.startedAt === undefined ? {} : { started_at: s.startedAt }),
      ...(s.lastExit === undefined ? {} : { last_exit: { ...s.lastExit } }),
      ...(s.retryInMs === undefined ? {} : { retry_in_ms: s.retryInMs }),
      ...(lastError === undefined || s.state === 'running' ? {} : { last_error: lastError }),
    }
    try {
      files.ensureDir(layout.root)
      const tmp = `${layout.supervisor}.tmp`
      files.writeText(tmp, `${JSON.stringify(file, null, 2)}\n`)
      files.rename(tmp, layout.supervisor)
    } catch (err) {
      log.warn('写不进监督者状态', { error: String(err) })
    }
  }
  sidecar.subscribe(writeSupervisor)

  /** 装好了而且程序文件真在（被人手删了就当没装，别去起一个不存在的东西）。 */
  const installed = (): string | undefined => {
    const cur = parseCurrentFile(readJson(files, layout.current))
    if (cur === undefined) return undefined
    const pkg = join(layout.versionDir(cur.version), 'node_modules', '@oomol-lab', 'open-connector')
    return files.exists(join(pkg, 'package.json')) ? cur.version : undefined
  }

  const tick = (): void => {
    const want = installed()
    const control = parseControlFile(readJson(files, layout.control))
    const desired = control?.desired ?? 'run'
    const seq = control?.restart_seq ?? 0
    const state = sidecar.snapshot().state
    if (want === undefined || desired === 'stop') {
      seenSeq = seq
      if (state !== 'stopped') {
        log.info('停下本机连接器', {
          reason: want === undefined ? 'not_installed' : 'desired_stop',
        })
        sidecar.stop()
      }
      return
    }
    if (want !== version) {
      log.info(version === undefined ? '起本机连接器' : '换版本，重启本机连接器', {
        from: version ?? '-',
        to: want,
        port: options.port,
      })
      version = want
      seenSeq = seq
      if (state === 'stopped' || state === 'failed') sidecar.start()
      else sidecar.restart()
      return
    }
    if (seenSeq !== undefined && seq !== seenSeq) {
      seenSeq = seq
      log.info('按要求重启本机连接器')
      sidecar.restart()
      return
    }
    seenSeq = seq
    // 删除下载之后又装回来 / 停了又要跑：stopped 就起（failed 等人点重启，不自己硬拉）
    if (state === 'stopped') sidecar.start()
  }

  const loop = (): void => {
    poll = timers.setTimeout(() => {
      poll = undefined
      tick()
      if (started) loop()
    }, pollMs)
  }

  return {
    mode: 'npm',
    port: options.port,
    url: localConnectUrl(options.port),
    tick,
    snapshot: () => ({ ...sidecar.snapshot(), version }),
    start() {
      if (!started) {
        started = true
        tick()
        loop()
      }
      return Promise.resolve()
    },
    stop() {
      started = false
      if (poll !== undefined) {
        timers.clear(poll)
        poll = undefined
      }
      sidecar.stop()
      return Promise.resolve()
    },
  }
}
