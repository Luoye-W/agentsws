/**
 * 今日战报（37 §1 对照表第 9 行：空态 = 四格战报）。
 *
 * 四个数**全部从事件日志算**，一个不估。事件日志是 append-only 的（21 §1），所以
 * 同一天同一份事件永远算出同一份战报——这也是它能当"复盘卡"输入的前提（37 §2.4）。
 *
 * 四格各自的判据，写死在这里，别在别处再定义一次：
 *
 * | 格子 | 判据 |
 * |---|---|
 * | AI 自主处理 | `run.completed` 且这次运行**没有**产生过 `approval.created`——跑完了，全程没回头问人 |
 * | 你已处理 | `approval.decided` 且 `actor.kind === 'person'`——`by: 'mandate'` 的自动决定不算你的功劳 |
 * | 自动发送 | `approval.auto_approved`——额度内自动批准，没经过人 |
 * | 拦截待确认 | `approval.created`——被拦下来转人确认的，每建一张卡就是一次拦截 |
 */
import type { EventEnvelope } from '@agentsws/contracts'
import type { BattleReport } from './types.js'

export const BATTLE_REPORT_EVENT_TYPES: readonly string[] = [
  'run.completed',
  'approval.created',
  'approval.decided',
  'approval.auto_approved',
]

export interface BattleReportOptions {
  now: string
  /** 工作区时区偏移（分钟）；日界线按它切，不按 UTC */
  tz_offset_minutes: number
}

/** 本地日界线：把 UTC 毫秒挪到工作区当地，再截到天。 */
function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

/**
 * 事件 → 四格。
 *
 * 传进来的事件可以是全量的：不在今天、不是这四种类型的一律不计，所以调用方
 * 用 `types` 预过滤只是省 IO，不影响结果。
 */
export function battleReport(
  events: readonly EventEnvelope[],
  options: BattleReportOptions,
): BattleReport {
  const nowMs = Date.parse(options.now)
  const today = localDate(Number.isFinite(nowMs) ? nowMs : 0, options.tz_offset_minutes)

  const todays: EventEnvelope[] = []
  for (const e of events) {
    const at = Date.parse(e.at)
    if (!Number.isFinite(at)) continue
    if (localDate(at, options.tz_offset_minutes) !== today) continue
    todays.push(e)
  }

  // 「这次运行有没有回头问过人」要看整个当天的事件，不能边遍历边判。
  const askedRuns = new Set<string>()
  for (const e of todays) {
    if (e.type !== 'approval.created') continue
    const run = e.correlation.run_id ?? e.actor.run_id
    if (run !== undefined) askedRuns.add(run)
  }

  let ai_handled = 0
  let handled = 0
  let auto_sent = 0
  let intercepted = 0

  for (const e of todays) {
    switch (e.type) {
      case 'run.completed': {
        const run = e.correlation.run_id ?? e.actor.run_id
        if (run === undefined || !askedRuns.has(run)) ai_handled += 1
        break
      }
      case 'approval.decided':
        if (e.actor.kind === 'person') handled += 1
        break
      case 'approval.auto_approved':
        auto_sent += 1
        break
      case 'approval.created':
        intercepted += 1
        break
      default:
        break
    }
  }

  return { date: today, ai_handled, handled, auto_sent, intercepted }
}
