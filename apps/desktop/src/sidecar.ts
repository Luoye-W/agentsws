/**
 * sidecar 监督者（13 §5「进程监督：起、停、崩溃重启、健康检查、端口分配、日志」）。
 *
 * 状态机：
 * ```
 * stopped ──start()──► starting ──(存活 stableAfterMs)──► running
 *    ▲                     │                                  │
 *    │                    退出                                退出
 *    │                     ▼                                  ▼
 *    └──stop()───────── backoff ◄────────────────────────── backoff
 *                          │ 超过 maxAttempts
 *                          ▼
 *                        failed
 * ```
 * `restart()` 先停再等旧进程真的退出才拉新的——同一个端口不能有两个进程抢。
 * 子进程输出逐行交给回调（日志层负责脱敏）；本模块不 import electron，也不碰 node:child_process。
 */
import { type BackoffOptions, backoffDelay } from './backoff.js'
import type { Logger } from './logging.js'
import type { ChildHandle, Clock, Spawner, SpawnRequest, TimerHandle, TimerPort } from './ports.js'

export type SidecarState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed'

export interface SidecarExit {
  code: number | null
  signal: string | null
  at: string
}

export interface SidecarSnapshot {
  name: string
  state: SidecarState
  pid: number | undefined
  /** 连续失败次数；稳定运行 `stableAfterMs` 后清零。 */
  attempts: number
  startedAt: string | undefined
  lastExit: SidecarExit | undefined
  /** `backoff` 态下距下次重启的毫秒数。 */
  retryInMs: number | undefined
}

export interface SidecarOptions {
  name: string
  /** 每次启动重新求值：端口、急停档位、密钥都可能变了。 */
  request: () => SpawnRequest
  spawner: Spawner
  timers: TimerPort
  clock: Clock
  logger: Logger
  backoff?: BackoffOptions
  random?: () => number
  /** 连续失败上限；`undefined` = 一直重试（默认）。 */
  maxAttempts?: number
  /** 活过这么久算稳定，失败计数清零；默认 20s。 */
  stableAfterMs?: number
  /** 子进程输出（已按行切好）。 */
  onOutput?: (stream: 'stdout' | 'stderr', line: string) => void
}

export interface Sidecar {
  start(): void
  /** 主动停：不再退避重启。 */
  stop(): void
  restart(): void
  snapshot(): SidecarSnapshot
  subscribe(listener: (snapshot: SidecarSnapshot) => void): () => void
}

/** 把 chunk 流切成整行，保留半行等下一块。 */
export function createLineSplitter(emit: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) emit(line)
      idx = buffer.indexOf('\n')
    }
  }
}

export function createSidecar(options: SidecarOptions): Sidecar {
  const { name, request, spawner, timers, clock, logger } = options
  const stableAfterMs = options.stableAfterMs ?? 20_000
  const random = options.random ?? (() => 0)
  const log = logger.child(name)

  let state: SidecarState = 'stopped'
  let child: ChildHandle | undefined
  let generation = 0
  let attempts = 0
  let startedAt: string | undefined
  let lastExit: SidecarExit | undefined
  let retryTimer: TimerHandle | undefined
  let stableTimer: TimerHandle | undefined
  let retryInMs: number | undefined
  /** 主动停（stop / restart）时置位，防止退出回调触发退避重启。 */
  let intentional = false
  let pendingRestart = false
  const listeners = new Set<(snapshot: SidecarSnapshot) => void>()

  const snapshot = (): SidecarSnapshot => ({
    name,
    state,
    pid: child?.pid,
    attempts,
    startedAt,
    lastExit,
    retryInMs,
  })

  const publish = (): void => {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      timers.clear(retryTimer)
      retryTimer = undefined
    }
    retryInMs = undefined
  }

  const clearStable = (): void => {
    if (stableTimer !== undefined) {
      timers.clear(stableTimer)
      stableTimer = undefined
    }
  }

  const scheduleRetry = (): void => {
    attempts += 1
    if (options.maxAttempts !== undefined && attempts > options.maxAttempts) {
      state = 'failed'
      log.error('连续启动失败，放弃重启', { attempts })
      publish()
      return
    }
    const delay = backoffDelay(attempts, options.backoff, random)
    retryInMs = delay
    state = 'backoff'
    log.warn('子进程退出，稍后重启', { attempts, delayMs: delay })
    publish()
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined
      retryInMs = undefined
      launch()
    }, delay)
  }

  const handleExit = (mine: number, code: number | null, signal: string | null): void => {
    if (mine !== generation) return
    child = undefined
    startedAt = undefined
    lastExit = { code, signal, at: clock.now() }
    clearStable()
    if (intentional) {
      intentional = false
      state = 'stopped'
      log.info('子进程已停止', { code, signal })
      if (pendingRestart) {
        pendingRestart = false
        launch()
        return
      }
      publish()
      return
    }
    if (state === 'failed') {
      publish()
      return
    }
    scheduleRetry()
  }

  function launch(): void {
    generation += 1
    const mine = generation
    const spawnRequest = request()
    let handle: ChildHandle
    try {
      handle = spawner.spawn(spawnRequest)
    } catch (err) {
      lastExit = { code: null, signal: null, at: clock.now() }
      log.error('拉起子进程失败', { error: String(err) })
      scheduleRetry()
      return
    }
    child = handle
    state = 'starting'
    startedAt = clock.now()
    // 日志里只留命令与参数，env 一律不打（里面有密钥）。
    log.info('子进程已启动', {
      command: spawnRequest.command,
      args: spawnRequest.args.join(' '),
      pid: handle.pid,
    })

    handle.onStdout(
      createLineSplitter((line) => {
        options.onOutput?.('stdout', line)
      }),
    )
    handle.onStderr(
      createLineSplitter((line) => {
        options.onOutput?.('stderr', line)
      }),
    )
    handle.onExit((code, signal) => {
      handleExit(mine, code, signal)
    })

    stableTimer = timers.setTimeout(() => {
      stableTimer = undefined
      if (state !== 'starting') return
      state = 'running'
      attempts = 0
      log.info('子进程稳定运行')
      publish()
    }, stableAfterMs)
    publish()
  }

  return {
    start() {
      if (state === 'starting' || state === 'running') return
      clearRetry()
      attempts = 0
      launch()
    },
    stop() {
      clearRetry()
      clearStable()
      pendingRestart = false
      if (child === undefined) {
        intentional = false
        state = 'stopped'
        publish()
        return
      }
      intentional = true
      state = 'stopped'
      child.kill('SIGTERM')
      publish()
    },
    restart() {
      clearRetry()
      clearStable()
      attempts = 0
      if (child === undefined) {
        launch()
        return
      }
      pendingRestart = true
      intentional = true
      state = 'stopped'
      child.kill('SIGTERM')
      publish()
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      listener(snapshot())
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
