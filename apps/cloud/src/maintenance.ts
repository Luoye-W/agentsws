/**
 * 进程内的定时清理（WP110）。
 *
 * 三处后置清单在这里收口：
 *
 * - WP59 第 ⑥ 条：sqlite 档的 `sweepReservations` **没有定时调度方**。
 *   进程崩在 `reserve` 与 `settle` 之间留下的孤儿预扣会永远占着积分——
 *   用户看到余额少了一块，却找不到是哪一笔。
 * - WP110 新加的幂等表要有人扫过期行，否则 24h 的 TTL 只在"读到它"时才生效，
 *   没人再读的键会一直躺在库里。
 * - 公共红人库的基准缓存（`kol_benchmarks_cache`）同理：读时判新鲜，
 *   不读就不清，一年前的桶还占着行。
 *
 * **为什么是进程内定时而不是 cron sidecar**：这三件事都要拿着已经开好的那几个
 * 库句柄做，cron 里再开一次 sqlite 连接就等于同一个文件两个写者。测试环境
 * 单机单实例，进程内定时是最短的那条路。
 *
 * **多实例要先解决这个**：三件事都不是幂等冲突敏感的（删过期行重复删没害处），
 * 但 `sweepReservations` 的判据是"比某个时刻老"，两个实例的钟不一样就会有一个
 * 把另一个正在进行中的预扣扫掉。上多实例前先给它一把分布式锁（见 docs/61）。
 */

import type { Clock } from '@agentsws/contracts'

/** 多久扫一次。 */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * 一笔预扣多老算孤儿。
 *
 * 1 小时：最长的一次 AI 调用（流式、长上下文）也不会跑这么久，而比它短的话
 * 会把还在路上的请求那一笔扫掉——那等于免费送了一次调用。
 */
export const RESERVATION_MAX_AGE_MS = 60 * 60 * 1000

/** 基准缓存多老算该清。比 `BENCHMARK_CACHE_MS`（1 小时）宽得多——清早了等于每次都重算。 */
export const BENCHMARK_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 一次清理干掉了多少行。数字只进 stdout，用来回答"定时到底有没有在跑"。 */
export interface SweepReport {
  reservations: number
  idempotency: number
  benchmarks: number
  at: string
}

export interface MaintenanceOptions {
  clock: Clock
  /** 钱包库；sqlite 档才有 `sweepReservations`（内存档没有，也不需要）。 */
  wallet?: { sweepReservations?(olderThan: string): number } | undefined
  /** 幂等表；两档都有 `sweep`。 */
  idempotency?: { sweep?(clock: Clock): number } | undefined
  /** 公共红人库；`sweepBenchmarks` 是可选成员，老实现没有就跳过。 */
  kol?: { sweepBenchmarks?(olderThan: string): number } | undefined
  /** 多久一拍；`0` = 不起定时器（测试手动调 `runOnce`）。 */
  intervalMs?: number
  onReport?: (report: SweepReport) => void
}

export interface Maintenance {
  /** 立刻扫一遍（测试与启动时各调一次——启动那一次清掉上次崩溃留下的孤儿）。 */
  runOnce(): SweepReport
  close(): void
}

const iso = (clock: Clock, backMs: number): string =>
  new Date(Date.parse(clock.now()) - backMs).toISOString()

export function startMaintenance(options: MaintenanceOptions): Maintenance {
  const report = (): SweepReport => {
    /*
     * 每一件各自 try：其中一个库锁住了不该让另外两件也不跑。
     * 失败**不抛**——定时任务把进程带走是最糟的那种失败。
     */
    let reservations = 0
    let idempotency = 0
    let benchmarks = 0
    try {
      reservations =
        options.wallet?.sweepReservations?.(iso(options.clock, RESERVATION_MAX_AGE_MS)) ?? 0
    } catch {
      reservations = 0
    }
    try {
      idempotency = options.idempotency?.sweep?.(options.clock) ?? 0
    } catch {
      idempotency = 0
    }
    try {
      benchmarks = options.kol?.sweepBenchmarks?.(iso(options.clock, BENCHMARK_MAX_AGE_MS)) ?? 0
    } catch {
      benchmarks = 0
    }
    const out: SweepReport = { reservations, idempotency, benchmarks, at: options.clock.now() }
    if (options.onReport !== undefined) options.onReport(out)
    else if (reservations + idempotency + benchmarks > 0)
      // 三个数与时间——没有组织、没有工作区、没有令牌（49 M6 同一条）
      process.stdout.write(
        `[sweep] reservations=${String(reservations)} idempotency=${String(idempotency)} benchmarks=${String(benchmarks)}\n`,
      )
    return out
  }

  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS
  let timer: ReturnType<typeof setInterval> | undefined
  if (intervalMs > 0) {
    timer = setInterval(report, intervalMs)
    timer.unref?.()
  }
  return {
    runOnce: report,
    close() {
      if (timer !== undefined) clearInterval(timer)
    },
  }
}
