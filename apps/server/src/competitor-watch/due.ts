/**
 * WP392：什么时候该读（纯函数，按品牌时区算；照 `reddit-watch/due.ts`）。
 *
 * - **一天一次起步**（决策 668）：隔 `every_hours` 小时；一天一次（≥ 24）时，当天到了 `day_start_hour` 才读；
 *   频率是用户能改的设置，这里不写死；
 * - **新加的源马上读一次当底子**（方案卡上点了「就这样」就先读，不等明早）；
 * - 关机期间错过的**只补一次**（开机后下一拍看「隔了几天」，到了就读一次，不连读好几轮）；
 * - 读失败了**隔一小时再试**，不连着撞；
 * - 暂停的源、总开关关了，都不读。
 */
import type { CompetitorWatchSettings, CompetitorWatchSource, Iso8601 } from '@agentsws/contracts'

/** 失败之后隔多久再试（定时一小时一拍，留 5 分钟余量）。 */
export const RETRY_GAP_MS = 55 * 60_000
/** 「隔 N 小时」允许早几分钟（别因为差几秒错过一整轮）。 */
const SLACK_MS = 10 * 60_000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export interface DueInput {
  now: Iso8601
  tz_offset_minutes: number
  settings: CompetitorWatchSettings
  sources: readonly Pick<
    CompetitorWatchSource,
    'id' | 'status' | 'last_ok_at' | 'last_try_at' | 'paused'
  >[]
}

const dayOf = (ms: number, tz: number): number => Math.floor((ms + tz * 60_000) / DAY_MS)
const hourOf = (ms: number, tz: number): number => new Date(ms + tz * 60_000).getUTCHours()

/** 这一拍该读哪几条源（空 = 不读）。 */
export function dueSources(input: DueInput): string[] {
  const s = input.settings
  if (!s.enabled) return []
  const now = Date.parse(input.now)
  const tz = input.tz_offset_minutes
  const daily = s.every_hours >= 24
  return input.sources
    .filter((src) => {
      if (src.paused === true) return false
      const tried = src.last_try_at === undefined ? undefined : Date.parse(src.last_try_at)
      if (tried !== undefined && now - tried < RETRY_GAP_MS) return false
      const ok = src.last_ok_at === undefined ? undefined : Date.parse(src.last_ok_at)
      // 还没读成过：马上读一次当底子（失败过的照「隔一小时再试」）
      if (ok === undefined) return true
      if (!daily) return now - ok >= s.every_hours * HOUR_MS - SLACK_MS
      if (hourOf(now, tz) < s.day_start_hour) return false
      return dayOf(now, tz) - dayOf(ok, tz) >= Math.max(1, Math.round(s.every_hours / 24))
    })
    .map((src) => src.id)
}

/** 下一次会读的时刻（计划卡上「竞品监控 · 明早 9:00」那一格）；没有源 / 关着回 `undefined`。 */
export function nextReadAt(input: DueInput): Iso8601 | undefined {
  const s = input.settings
  const live = input.sources.filter((x) => x.paused !== true)
  if (!s.enabled || live.length === 0) return undefined
  const now = Date.parse(input.now)
  const tz = input.tz_offset_minutes
  const daily = s.every_hours >= 24
  const times = live.map((src) => {
    const tried = src.last_try_at === undefined ? undefined : Date.parse(src.last_try_at)
    const retryAt = tried === undefined ? now : tried + RETRY_GAP_MS
    const ok = src.last_ok_at === undefined ? undefined : Date.parse(src.last_ok_at)
    if (ok === undefined || (src.status === 'failed' && tried !== undefined && tried > ok))
      return Math.max(now, retryAt)
    if (!daily) return Math.max(now, ok + s.every_hours * HOUR_MS - SLACK_MS, retryAt)
    // 一天一次：上次读成那天 + N 天，当地 day_start_hour
    const days = Math.max(1, Math.round(s.every_hours / 24))
    const startOfLocalDay = (dayOf(ok, tz) + days) * DAY_MS - tz * 60_000
    return Math.max(now, startOfLocalDay + s.day_start_hour * HOUR_MS, retryAt)
  })
  return new Date(Math.min(...times)).toISOString()
}
