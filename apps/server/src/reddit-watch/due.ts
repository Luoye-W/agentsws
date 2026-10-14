/**
 * WP328：什么时候该巡查（纯函数，按品牌时区算）。
 *
 * - **一天一次起步**：隔 `every_hours` 小时；一天一次（≥ 24）时，当天到了 `day_start_hour` 才跑；
 * - **每周最后一次**：`final_weekday` 的 `final_time` 之后跑一次全量（周报接在它后面）；那天关机了，
 *   周六开机补一次（周日就是新的一周了）；
 * - 关机期间错过的**只补一次**，不连读好几轮；一块失败了，隔一小时再试（不连着撞）。
 */
import type { Iso8601, RedditWatchPart, RedditWatchSettings } from '@agentsws/contracts'
import { redditWeekWindow } from '@agentsws/contracts'

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
  /** 本周最后一次已经跑过的时间（没有就没有）。 */
  last_final_at?: Iso8601
}

export type DueVerdict =
  | { final: true; parts: RedditWatchPart[] }
  | { final: false; parts: RedditWatchPart[] }

const local = (ms: number, tz: number): Date => new Date(ms + tz * 60_000)

/** 现在是不是已经过了本周最后一次的时刻（周六补跑也算）。 */
export function finalDue(
  input: Pick<DueInput, 'now' | 'tz_offset_minutes' | 'settings' | 'last_final_at'>,
): boolean {
  const nowMs = Date.parse(input.now)
  const l = local(nowMs, input.tz_offset_minutes)
  const day = l.getUTCDay()
  const [hh, mm] = input.settings.final_time.split(':').map(Number)
  const minutes = l.getUTCHours() * 60 + l.getUTCMinutes()
  const reached =
    day > input.settings.final_weekday ||
    (day === input.settings.final_weekday && minutes >= (hh ?? 17) * 60 + (mm ?? 0))
  if (!reached) return false
  const { since } = redditWeekWindow(input.now, input.tz_offset_minutes)
  return input.last_final_at === undefined || input.last_final_at < since
}

/** 这一拍要跑哪几块（空 = 不跑）。 */
export function dueParts(input: DueInput): DueVerdict {
  const nowMs = Date.parse(input.now)
  if (!input.settings.enabled || input.applicable.length === 0) return { final: false, parts: [] }
  const tooSoon = (p: RedditWatchPart): boolean => {
    const t = input.parts[p]?.last_try_at
    return t !== undefined && nowMs - Date.parse(t) < RETRY_GAP_MS
  }
  // 本周最后一次：全量跑（正在跑的那一轮没结束时，服务那一侧不会再起新的一轮）
  if (finalDue(input)) return { final: true, parts: [...input.applicable] }
  const every = input.settings.every_hours * 3_600_000
  const daily = input.settings.every_hours >= 24
  const dayOf = (t: number): number =>
    Math.floor((t + input.tz_offset_minutes * 60_000) / 86_400_000)
  const hourNow = local(nowMs, input.tz_offset_minutes).getUTCHours()
  const parts = input.applicable.filter((p) => {
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
  return { final: false, parts }
}
