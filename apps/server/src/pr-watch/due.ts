/**
 * WP386：每条监控源什么时候该拉（纯函数，按品牌时区算；照 `reddit-watch/due.ts`）。
 *
 * - 默认一天一次、本地 `day_start_hour`（默认 9 点）之后跑；隔几小时由每条源自己的 `every_hours` 定（默认 24，
 *   满 20 条全新的 Google Alerts feed 会被自动改成 4）；
 * - 关机期间错过的**只补一次**（按本地日子数 / 隔了多久判，不连拉好几轮）；
 * - 拉失败的隔一小时再试（不连着撞）。
 */
import type { Iso8601, MonitorSettings, MonitorSource } from '@agentsws/contracts'
import { RETRY_GAP_MS } from '../reddit-watch/due.js'

/** 「隔 N 小时」允许早几分钟（定时一小时一拍，别因为差几秒错过一整轮）。 */
const SLACK_MS = 10 * 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface MonitorDueInput {
  now: Iso8601
  tz_offset_minutes: number
  settings: MonitorSettings
  sources: readonly MonitorSource[]
}

const dayOf = (t: number, tz: number): number => Math.floor((t + tz * 60_000) / DAY_MS)

/** 这条源现在该不该拉。 */
export function sourceDue(source: MonitorSource, input: Omit<MonitorDueInput, 'sources'>): boolean {
  if (!input.settings.enabled || source.paused === true) return false
  const nowMs = Date.parse(input.now)
  const tried = source.last_try_at
  if (tried !== undefined && nowMs - Date.parse(tried) < RETRY_GAP_MS) return false
  const ok = source.last_ok_at
  const every = Math.max(1, source.every_hours)
  if (every < 24) return ok === undefined || nowMs - Date.parse(ok) >= every * HOUR_MS - SLACK_MS
  const hourNow = new Date(nowMs + input.tz_offset_minutes * 60_000).getUTCHours()
  if (hourNow < input.settings.day_start_hour) return false
  return (
    ok === undefined ||
    dayOf(nowMs, input.tz_offset_minutes) - dayOf(Date.parse(ok), input.tz_offset_minutes) >=
      Math.round(every / 24)
  )
}

/** 这一拍要拉哪几条（空 = 不拉）。 */
export function dueSources(input: MonitorDueInput): MonitorSource[] {
  return input.sources.filter((s) => sourceDue(s, input))
}

/**
 * 下一次什么时候拉（右栏「计划」卡：「信息监控 · 明早 9:00」）。没有能拉的源、或总开关关了 → `undefined`。
 * 现在就该拉的，回下一个整点（定时一小时一拍）。
 */
export function nextMonitorRunAt(input: MonitorDueInput): Iso8601 | undefined {
  if (!input.settings.enabled) return undefined
  const nowMs = Date.parse(input.now)
  const tz = input.tz_offset_minutes * 60_000
  const nextHour = Math.ceil((nowMs + 1) / HOUR_MS) * HOUR_MS
  let best: number | undefined
  for (const s of input.sources) {
    if (s.paused === true) continue
    let at: number
    if (sourceDue(s, input)) at = nextHour
    else {
      const tried = s.last_try_at === undefined ? undefined : Date.parse(s.last_try_at)
      const retry =
        tried !== undefined && nowMs - tried < RETRY_GAP_MS && s.status === 'failed'
          ? tried + RETRY_GAP_MS
          : undefined
      const every = Math.max(1, s.every_hours)
      const ok = s.last_ok_at === undefined ? undefined : Date.parse(s.last_ok_at)
      if (every < 24) at = ok === undefined ? nextHour : ok + every * HOUR_MS
      else {
        const startToday = dayOf(nowMs, input.tz_offset_minutes) * DAY_MS - tz
        const start = startToday + input.settings.day_start_hour * HOUR_MS
        const wait = Math.round(every / 24)
        const doneDay = ok === undefined ? undefined : dayOf(ok, input.tz_offset_minutes)
        const nextDay =
          doneDay === undefined ? dayOf(nowMs, input.tz_offset_minutes) : doneDay + wait
        at = nextDay * DAY_MS - tz + input.settings.day_start_hour * HOUR_MS
        if (at <= nowMs) at = Math.max(start, nextHour)
      }
      if (retry !== undefined) at = Math.min(at, retry)
    }
    best = best === undefined ? at : Math.min(best, at)
  }
  return best === undefined ? undefined : new Date(Math.max(best, nowMs)).toISOString()
}
