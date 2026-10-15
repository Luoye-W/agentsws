/**
 * WP328：什么时候该巡查（纯函数，按品牌时区算）。
 *
 * - **一天一次起步**：隔 `every_hours` 小时；一天一次（≥ 24）时，当天到了 `day_start_hour` 才跑；
 * - 关机期间错过的**只补一次**，不连读好几轮；一块失败了，隔一小时再试（不连着撞）。
 * - 只管自己的节奏；出报告前要最新数据由 AI 调「立即巡查」（`sweepNow`，WP331）。
 * - WP340：**每个版块可单独设一周几次**（{@link dueSubs}）：按本地周一起的一周里均匀排几个「到点日」，
 *   到点日的 `day_start_hour` 之后这个版块上次读成早于这个点就该读（错过的也只补一次）；没设的版块跟 `every_hours` 走。
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

/* ── WP340：按版块分频率 ───────────────────────────────────────────── */

const DAY_MS = 86_400_000

/**
 * 一周 `perWeek` 次时，最近一个到点时刻（本地周一起，到点日 = ⌊i·7/n⌋，到点 = 那天的 `day_start_hour`）。
 * 7 = 每天、3 = 周一三五、2 = 周一四、1 = 周一。
 */
export function lastSlotAt(
  nowMs: number,
  tzOffsetMinutes: number,
  perWeek: number,
  dayStartHour: number,
): number {
  const n = Math.max(1, Math.min(7, Math.round(perWeek)))
  const slots = new Set(Array.from({ length: n }, (_, i) => Math.floor((i * 7) / n)))
  const localNow = nowMs + tzOffsetMinutes * 60_000
  const today = Math.floor(localNow / DAY_MS)
  for (let back = 0; back <= 7; back += 1) {
    const day = today - back
    // 1970-01-01 是周四：周一起的第几天 = (day + 3) mod 7
    const weekday = (((day + 3) % 7) + 7) % 7
    if (!slots.has(weekday)) continue
    const at = day * DAY_MS + dayStartHour * 3_600_000
    if (at <= localNow) return at - tzOffsetMinutes * 60_000
  }
  return 0
}

export interface SubDueInput {
  now: Iso8601
  tz_offset_minutes: number
  settings: RedditWatchSettings
  /** 版块（原样大小写）。 */
  subs: string[]
  /** 每个版块的钟（键小写）；没有的用 `fallback`（老设置迁移：用原来整块「自家版块」那一个）。 */
  clocks: Record<string, PartClock>
  fallback?(sub: string): PartClock | undefined
}

/** 这一拍该读哪几个版块。 */
export function dueSubs(input: SubDueInput): string[] {
  if (!input.settings.enabled) return []
  const nowMs = Date.parse(input.now)
  const perWeek = input.settings.sub_per_week ?? {}
  return input.subs.filter((sub) => {
    const key = sub.toLowerCase()
    const clock = input.clocks[key] ?? input.fallback?.(sub) ?? {}
    const n = perWeek[key]
    if (n === undefined)
      return (
        dueParts({
          now: input.now,
          tz_offset_minutes: input.tz_offset_minutes,
          settings: input.settings,
          parts: { own_sub: clock },
          applicable: ['own_sub'],
        }).length > 0
      )
    const t = clock.last_try_at
    if (t !== undefined && nowMs - Date.parse(t) < RETRY_GAP_MS) return false
    const ok = clock.last_ok_at
    const slot = lastSlotAt(nowMs, input.tz_offset_minutes, n, input.settings.day_start_hour)
    return ok === undefined || Date.parse(ok) < slot
  })
}
