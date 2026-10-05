/**
 * WP236：一次运行「什么时候该停」——**没动静才停**，不再是固定总时长。
 *
 * 10-06 Windows 真机：Reddit 研究任务正常干着活（每次取数 8–12 秒），60 秒一到被子进程档的固定
 * 总时长静默 `run.cancelled`。改成两条线：
 * - **空闲超时**：连续 N 秒一个事件都没有（模型不说话、工具不回）才算卡死，缺省 3 分钟；
 * - **总时长上限**：再忙也不许无限跑，缺省 20 分钟（研究类职责可调大）。
 *
 * 两个数的来源（先到先得）：职责阈值 `thresholds.run_idle_timeout_seconds` /
 * `run_max_duration_seconds` → 「设置 → 通用」→ 这里的缺省。三个运行时档（dsh 子进程 / 进程内、
 * direct）都用同一个看门狗 {@link createRunWatchdog}，停的时候经 `AbortController.abort(reason)`
 * 把原因带给运行时，`run.cancelled` 照实写出 {@link RunCancelReason}。
 */

/** `run.cancelled` 的原因：没动静太久 / 跑满了总时长 / 人点了停。 */
export type RunCancelReason = 'idle_timeout' | 'max_duration' | 'user'

export const RUN_CANCEL_REASONS: readonly RunCancelReason[] = [
  'idle_timeout',
  'max_duration',
  'user',
]

/** 一次运行的时长线（秒）。 */
export interface RunTimeLimits {
  /** 连续这么多秒没有任何事件才算卡死。 */
  idle_timeout_seconds: number
  /** 一次运行最多跑这么多秒。 */
  max_duration_seconds: number
}

export const DEFAULT_RUN_TIME_LIMITS: Readonly<RunTimeLimits> = {
  idle_timeout_seconds: 180,
  max_duration_seconds: 1200,
}

/** 设置页可选范围（秒）。空闲 1–30 分钟；总时长 5–120 分钟。 */
export const RUN_IDLE_TIMEOUT_RANGE: Readonly<{ min: number; max: number }> = {
  min: 60,
  max: 1800,
}
export const RUN_MAX_DURATION_RANGE: Readonly<{ min: number; max: number }> = {
  min: 300,
  max: 7200,
}

/** 职责阈值里的键（`RoleDefinition.thresholds`）。 */
export const RUN_IDLE_TIMEOUT_THRESHOLD = 'run_idle_timeout_seconds'
export const RUN_MAX_DURATION_THRESHOLD = 'run_max_duration_seconds'

/**
 * 按「职责阈值 → 设置 → 缺省」合出这次运行的时长线。不是正整数的值不算数（不让一个手滑把运行
 * 卡成一秒就停）；空闲线不会比总时长还长。
 */
export function resolveRunTimeLimits(input: {
  thresholds?: Record<string, number> | undefined
  settings?: Partial<RunTimeLimits> | undefined
}): RunTimeLimits {
  const pick = (key: keyof RunTimeLimits, threshold: string): number => {
    const t = input.thresholds?.[threshold]
    if (typeof t === 'number' && Number.isInteger(t) && t > 0) return t
    const s = input.settings?.[key]
    if (typeof s === 'number' && Number.isInteger(s) && s > 0) return s
    return DEFAULT_RUN_TIME_LIMITS[key]
  }
  // 不超过设置页的上限（子进程档拿这两个上限当兜底线，宿主的看门狗永远先到）
  const max_duration_seconds = Math.min(
    pick('max_duration_seconds', RUN_MAX_DURATION_THRESHOLD),
    RUN_MAX_DURATION_RANGE.max,
  )
  const idle_timeout_seconds = Math.min(
    pick('idle_timeout_seconds', RUN_IDLE_TIMEOUT_THRESHOLD),
    RUN_IDLE_TIMEOUT_RANGE.max,
    max_duration_seconds,
  )
  return { idle_timeout_seconds, max_duration_seconds }
}

/** 从 `AbortSignal.reason` 读出停的原因；没给 / 认不得的一律当「人点了停」。 */
export function cancelReasonOf(signal: AbortSignal | undefined): RunCancelReason {
  const r = signal?.reason as unknown
  return typeof r === 'string' && (RUN_CANCEL_REASONS as readonly string[]).includes(r)
    ? (r as RunCancelReason)
    : 'user'
}

/** 看门狗：每来一个事件 `touch()` 一下；空闲或总时长到了就 `onFire(reason)`，只响一次。 */
export interface RunWatchdog {
  touch(): void
  stop(): void
  /** 已经响过的话是哪一种。 */
  fired(): RunCancelReason | undefined
}

export function createRunWatchdog(input: {
  idleMs: number
  maxMs: number
  onFire(reason: Extract<RunCancelReason, 'idle_timeout' | 'max_duration'>): void
  /** 测试注入；缺省全局计时器。 */
  timers?: {
    set(fn: () => void, ms: number): unknown
    clear(handle: unknown): void
  }
}): RunWatchdog {
  const timers = input.timers ?? {
    set: (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms)
      ;(h as { unref?: () => void }).unref?.()
      return h
    },
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  let reason: Extract<RunCancelReason, 'idle_timeout' | 'max_duration'> | undefined
  let stopped = false
  let idle: unknown
  const fire = (r: NonNullable<typeof reason>): void => {
    if (stopped || reason !== undefined) return
    reason = r
    stop()
    input.onFire(r)
  }
  const max = timers.set(() => fire('max_duration'), input.maxMs)
  const arm = (): void => {
    if (idle !== undefined) timers.clear(idle)
    idle = timers.set(() => fire('idle_timeout'), input.idleMs)
  }
  function stop(): void {
    stopped = true
    timers.clear(max)
    if (idle !== undefined) timers.clear(idle)
  }
  arm()
  return {
    touch() {
      if (!stopped) arm()
    },
    stop,
    fired: () => reason,
  }
}

/**
 * 运行时发 `run.cancelled` 用的那一条：`signal.reason` 是认得的原因就带上，否则不写这一格
 * （模拟 / 老调用方 `abort()` 不带原因，事件字节不变；宿主每次停都带原因）。
 */
export function cancelledEvent(signal: AbortSignal | undefined): {
  type: 'run.cancelled'
  reason?: RunCancelReason
} {
  const r = signal?.reason as unknown
  return typeof r === 'string' && (RUN_CANCEL_REASONS as readonly string[]).includes(r)
    ? { type: 'run.cancelled', reason: r as RunCancelReason }
    : { type: 'run.cancelled' }
}
