/**
 * WP328：什么时候该巡查（纯函数，按品牌时区算）。
 *
 * - **一天一次起步**：隔 `every_hours` 小时；一天一次（≥ 24）时，当天到了 `day_start_hour` 才跑；
 * - 关机期间错过的**只补一次**，不连读好几轮；一块失败了，隔一小时再试（不连着撞）。
 * - **每周最后一次不在这里排**：周五周报（WP330）出之前调 `sweepNow` 做（与 WP330 对齐，免得两边各跑一次）。
 */
import type { Iso8601, RedditWatchPart, RedditWatchSettings } from '@agentsws/contracts'

export const RETRY_GAP_MS = 55 * 60_000
/** 「隔 N 小时」允许早几分钟（定时一小时一拍，别因为差几秒错过一整轮）。 */
const SLACK_MS = 10 * 60_000

export interface PartClock {
  /** 这一块上次读成是什么时候。 */
  last_ok_at?: Iso8601
  /** 上次试是什么时候（成没成都算）。 */
  last_try_at?: Iso8601
}

export interface DueInput {
  now: Iso8601
  tz_offset_minutes: number
  settings: RedditWatchSettings
  parts: Partial<Record<RedditWatchPart, PartClock>>
  /** 这一块现在有没有可读的（没配版块 / 关键词的不算）。 */
  applicable: RedditWatchPart[]
}

const local = (ms: number, tz: number): Date => new Date(ms + tz * 60_000)

/** 这一拍要跑哪几块（空 = 不跑）。 */
export function dueParts(input: DueInput): RedditWatchPart[] {
  const nowMs = Date.parse(input.now)
  if (!input.settings.enabled || input.applicable.length === 0) return []
  const tooSoon = (p: RedditWatchPart): boolean => {
    const t = input.parts[p]?.last_try_at
    return t !== undefined && nowMs - Date.parse(t) < RETRY_GAP_MS
  }
  const every = input.settings.every_hours * 3_600_000
  const daily = input.settings.every_hours >= 24
  const dayOf = (t: number): number =>
    Math.floor((t + input.tz_offset_minutes * 60_000) / 86_400_000)
  const hourNow = local(nowMs, input.tz_offset_minutes).getUTCHours()
  return input.applicable.filter((p) => {
    if (tooSoon(p)) return false
    const ok = input.parts[p]?.last_ok_at
    if (!daily) return ok === undefined || nowMs - Date.parse(ok) >= every - SLACK_MS
    // 一天一次（或隔几天一次）：按本地日子数，到了开始的钟点才跑
    if (hourNow < input.settings.day_start_hour) return false
    return (
      ok === undefined ||
      dayOf(nowMs) - dayOf(Date.parse(ok)) >= Math.round(input.settings.every_hours / 24)
    )
  })
}
