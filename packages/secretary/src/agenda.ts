/**
 * 日程与冲突（41 §1.2 第二行）。
 *
 * 秘书不自己攒一份日历——**日历是视图**（37 §2），四类来源（会议 / 排期待办 / 定时任务 /
 * 卡片到期）由 `@agentsws/work` 的 `buildCalendar` 合并好之后交到这里。本文件只回答两个问题：
 * 1. 这个时段撞不撞（撞了是撞在"已经占着"还是"根本不在他的可用时段里"）；
 * 2. 撞了的话，往后哪几个时段能约。
 *
 * 纯函数：没有 IO、没有 `Date.now()`——"现在"由调用方经 Clock 给。
 */
import type { CalendarItem, Iso8601 } from '@agentsws/contracts'
import type { AgendaCheckResult, Availability, ConflictReason, MeetSlot } from './types.js'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const DAY_MINUTES = 1440

/** 找替代时段时按这个粒度走（半小时）。 */
export const SLOT_STEP_MINUTES = 30
/** 默认往后找几天。 */
export const DEFAULT_HORIZON_DAYS = 7
/** 默认给几个替代。 */
export const DEFAULT_ALTERNATIVES = 3

const ms = (iso: Iso8601): number => Date.parse(iso)
const iso = (at: number): Iso8601 => new Date(at).toISOString()

/** `HH:MM` → 一天里的第几分钟；不合法回 undefined（宁可不判，也不猜）。 */
export function parseHm(value: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 24 || min > 59) return undefined
  const total = h * 60 + min
  return total > DAY_MINUTES ? undefined : total
}

/** 本地日零点对应的 UTC 毫秒。 */
export function localDayStart(atMs: number, tzOffsetMinutes: number): number {
  const shift = tzOffsetMinutes * MINUTE_MS
  return Math.floor((atMs + shift) / DAY_MS) * DAY_MS - shift
}

/** 本地星期几（0 = 周日）。 */
export function localWeekday(atMs: number, tzOffsetMinutes: number): number {
  return new Date(atMs + tzOffsetMinutes * MINUTE_MS).getUTCDay()
}

/** 一条日历项占的时间段；全天项不占时段（它们是"到期"，不是"在开会"）。 */
function span(item: CalendarItem): { from: number; to: number } | undefined {
  if (item.all_day) return undefined
  const from = ms(item.start)
  const to = item.end === undefined ? from + 60 * MINUTE_MS : ms(item.end)
  return to <= from ? { from, to: from + MINUTE_MS } : { from, to }
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }): boolean =>
  a.from < b.to && a.to > b.from

/** 这个时段落在他的可用时段规则里吗（同一个本地日之内）。 */
export function withinAvailability(
  slot: MeetSlot,
  availability: Availability,
  tzOffsetMinutes: number,
): boolean {
  const from = ms(slot.start)
  const to = ms(slot.end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false
  const dayStart = localDayStart(from, tzOffsetMinutes)
  // 跨天的会不接：可用时段是"周几的几点到几点"，跨过本地日界就没法判
  if (to > dayStart + DAY_MS) return false
  const weekday = localWeekday(from, tzOffsetMinutes)
  const startMin = Math.round((from - dayStart) / MINUTE_MS)
  const endMin = Math.round((to - dayStart) / MINUTE_MS)
  for (const rule of availability.rules) {
    if (!rule.days.includes(weekday)) continue
    const a = parseHm(rule.from)
    const b = parseHm(rule.to)
    if (a === undefined || b === undefined || b <= a) continue
    if (startMin >= a && endMin <= b) return true
  }
  return false
}

/** 那天已经有几场会（`max_meetings_per_day` 用它判）。 */
export function meetingsOnDay(
  items: readonly CalendarItem[],
  atMs: number,
  tzOffsetMinutes: number,
): number {
  const dayStart = localDayStart(atMs, tzOffsetMinutes)
  return items.filter((i) => {
    if (i.source !== 'meeting') return false
    const s = span(i)
    return s !== undefined && s.from >= dayStart && s.from < dayStart + DAY_MS
  }).length
}

export interface AlternativesInput {
  /** 从什么时候开始找（通常是 max(现在, 想约的那个时刻)） */
  from: Iso8601
  duration_minutes: number
  items: readonly CalendarItem[]
  availability: Availability
  tz_offset_minutes: number
  limit?: number
  horizon_days?: number
}

/**
 * 往后找几个能约的时段。
 *
 * 走法是确定的：按本地日一天天扫，每天按可用时段规则从窗口开头以 {@link SLOT_STEP_MINUTES}
 * 的粒度往后走，撞上已占用的就跳过。同样的输入永远出同样的几个时段。
 */
export function alternativeSlots(input: AlternativesInput): MeetSlot[] {
  const limit = input.limit ?? DEFAULT_ALTERNATIVES
  const horizon = input.horizon_days ?? DEFAULT_HORIZON_DAYS
  const duration = Math.max(1, input.duration_minutes) * MINUTE_MS
  const fromMs = ms(input.from)
  if (!Number.isFinite(fromMs) || limit <= 0) return []
  const busy = input.items
    .map(span)
    .filter((s): s is { from: number; to: number } => s !== undefined)
  const out: MeetSlot[] = []
  const rules = [...input.availability.rules].sort((a, b) => a.from.localeCompare(b.from))
  for (let d = 0; d < horizon && out.length < limit; d += 1) {
    const dayStart = localDayStart(fromMs + d * DAY_MS, input.tz_offset_minutes)
    const weekday = localWeekday(dayStart, input.tz_offset_minutes)
    if (
      input.availability.max_meetings_per_day !== undefined &&
      meetingsOnDay(input.items, dayStart, input.tz_offset_minutes) >=
        input.availability.max_meetings_per_day
    )
      continue
    for (const rule of rules) {
      if (!rule.days.includes(weekday)) continue
      const a = parseHm(rule.from)
      const b = parseHm(rule.to)
      if (a === undefined || b === undefined || b <= a) continue
      for (
        let start = dayStart + a * MINUTE_MS;
        start + duration <= dayStart + b * MINUTE_MS && out.length < limit;
        start += SLOT_STEP_MINUTES * MINUTE_MS
      ) {
        if (start < fromMs) continue
        const candidate = { from: start, to: start + duration }
        if (busy.some((s) => overlaps(candidate, s))) continue
        out.push({ start: iso(start), end: iso(candidate.to) })
      }
    }
  }
  return out
}

export interface AgendaCheckInput {
  slot: MeetSlot
  items: readonly CalendarItem[]
  availability: Availability
  tz_offset_minutes: number
  now: Iso8601
  alternatives?: number
  horizon_days?: number
}

/**
 * 这个时段能不能约。
 *
 * 撞了不只回"不行"——回**为什么**（占着 / 不在可用时段 / 已经过去 / 那天会太多）与几个替代，
 * 因为界面上要出的是一句人话加三个可点的时段，不是一个红叉。
 */
export function checkAgenda(input: AgendaCheckInput): AgendaCheckResult {
  const from = ms(input.slot.start)
  const to = ms(input.slot.end)
  const reasons: ConflictReason[] = []
  const conflicts: AgendaCheckResult['conflicts'] = []
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    if (to <= ms(input.now)) reasons.push('in_the_past')
    if (!withinAvailability(input.slot, input.availability, input.tz_offset_minutes))
      reasons.push('outside_availability')
    const wanted = { from, to }
    for (const item of input.items) {
      const s = span(item)
      if (s === undefined || !overlaps(wanted, s)) continue
      conflicts.push({
        id: item.id,
        title: item.title,
        start: item.start,
        ...(item.end === undefined ? {} : { end: item.end }),
      })
    }
    if (conflicts.length > 0) reasons.push('busy')
    if (
      input.availability.max_meetings_per_day !== undefined &&
      meetingsOnDay(input.items, from, input.tz_offset_minutes) >=
        input.availability.max_meetings_per_day
    )
      reasons.push('too_many_meetings')
  } else {
    reasons.push('outside_availability')
  }
  const ok = reasons.length === 0
  const duration = Math.max(1, Math.round((to - from) / MINUTE_MS))
  return {
    ok,
    conflicts,
    reasons,
    alternatives: ok
      ? []
      : alternativeSlots({
          from: iso(Math.max(ms(input.now), Number.isFinite(from) ? from : ms(input.now))),
          duration_minutes: Number.isFinite(duration)
            ? duration
            : input.availability.default_minutes,
          items: input.items,
          availability: input.availability,
          tz_offset_minutes: input.tz_offset_minutes,
          ...(input.alternatives === undefined ? {} : { limit: input.alternatives }),
          ...(input.horizon_days === undefined ? {} : { horizon_days: input.horizon_days }),
        }),
  }
}

/**
 * 忙闲（时段级）：把日程压成"几点到几点有事"，**不带标题、不带和谁**。
 * 41 §1.3 里"忙闲"与"日程明细"是两行、两个级别——这里出的是前者。
 */
export function busySlots(items: readonly CalendarItem[]): MeetSlot[] {
  const spans = items
    .map(span)
    .filter((s): s is { from: number; to: number } => s !== undefined)
    .sort((a, b) => a.from - b.from)
  const out: { from: number; to: number }[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last !== undefined && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else out.push({ ...s })
  }
  return out.map((s) => ({ start: iso(s.from), end: iso(s.to) }))
}
