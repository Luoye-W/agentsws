/**
 * Extracted from KefuAgent src/lib/support/amazon-sla.ts
 * (AMAZON_SLA_WINDOW_MINUTES / REMINDER / CRITICAL 三档、锚点语义、停表规则)，
 * rewritten for agentsws contracts.
 *
 * KefuAgent 那版是 Amazon 专用的**全天候 1440 分钟挂钟倒计时**——因为 Amazon 的响应率
 * 考核不看周末与节假日。中台要管的不止 Amazon，所以这里把"日历"抽出来：
 * `always` 保留原语义（逐字节等价于 1440 分钟挂钟），`business` 按注入的工作日历折算。
 *
 * 时间全部经参数传入（`now` / `received_at`），包内不碰 `Date.now()`。
 */
import type { Iso8601 } from '@agentsws/contracts'
import type { Classification, Urgency } from './types.js'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** 24 小时挂钟（KefuAgent `AMAZON_SLA_WINDOW_MINUTES`）。 */
export const SLA_WINDOW_MINUTES = 1440
/** 剩余 ≤ 12 小时进提醒档（`AMAZON_SLA_REMINDER_MINUTES`）。 */
export const SLA_REMINDER_MINUTES = 12 * 60
/** 剩余 ≤ 4 小时（含负数）进告警档（`AMAZON_SLA_CRITICAL_MINUTES`）。 */
export const SLA_CRITICAL_MINUTES = 4 * 60

/**
 * 工作日历。`always` = 全天候（Amazon 口径）；`business` = 只在工作时段走表。
 * 日历本身是数据，由职责 / 工作区配置注入，包里只给一份保守缺省。
 */
export interface BusinessCalendar {
  mode: 'always' | 'business'
  /** 相对 UTC 的分钟偏移（东八区 = 480）。 */
  utc_offset_minutes: number
  /** 工作日（0 = 周日 … 6 = 周六）。 */
  business_days: readonly number[]
  /** 本地工作时段，小时（含 start，不含 end）。 */
  business_hours: { start: number; end: number }
  /** 本地日期 `YYYY-MM-DD` 的假日列表。 */
  holidays: readonly string[]
}

export const ALWAYS_ON_CALENDAR: BusinessCalendar = {
  mode: 'always',
  utc_offset_minutes: 0,
  business_days: [0, 1, 2, 3, 4, 5, 6],
  business_hours: { start: 0, end: 24 },
  holidays: [],
}

/** 东八区 9–18 点、周一到周五。 */
export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = {
  mode: 'business',
  utc_offset_minutes: 480,
  business_days: [1, 2, 3, 4, 5],
  business_hours: { start: 9, end: 18 },
  holidays: [],
}

export interface SlaTargets {
  /** 首响时限（分钟）。 */
  first_response_minutes: number
  /** 解决时限（分钟）。 */
  resolution_minutes: number
}

export const DEFAULT_SLA_TARGETS: SlaTargets = {
  first_response_minutes: SLA_WINDOW_MINUTES,
  resolution_minutes: SLA_WINDOW_MINUTES * 3,
}

/** 投诉与高紧急度把首响压到 4 小时（与告警档同一个数）。 */
export function targetsFor(classification: Classification, base = DEFAULT_SLA_TARGETS): SlaTargets {
  const urgency: Urgency = classification.urgency
  if (classification.intent === 'complaint' || urgency === 'high') {
    return {
      first_response_minutes: Math.min(base.first_response_minutes, SLA_CRITICAL_MINUTES),
      resolution_minutes: base.resolution_minutes,
    }
  }
  return base
}

function localParts(
  ms: number,
  cal: BusinessCalendar,
): { day: number; minuteOfDay: number; date: string } {
  const shifted = new Date(ms + cal.utc_offset_minutes * MINUTE_MS)
  return {
    day: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    date: shifted.toISOString().slice(0, 10),
  }
}

function isWorking(ms: number, cal: BusinessCalendar): boolean {
  if (cal.mode === 'always') return true
  const { day, minuteOfDay, date } = localParts(ms, cal)
  if (!cal.business_days.includes(day)) return false
  if (cal.holidays.includes(date)) return false
  return minuteOfDay >= cal.business_hours.start * 60 && minuteOfDay < cal.business_hours.end * 60
}

/** 一天最多推进多少次（防止假日表把循环拖长）：两年。 */
const MAX_DAY_STEPS = 730

/**
 * 从 `from` 起加 `minutes` 个**工作分钟**，返回到期时刻。
 * `always` 日历退化成简单加法，与 KefuAgent 的 `anchor + 1440min` 逐分钟一致。
 */
export function addWorkingMinutes(from: Iso8601, minutes: number, cal: BusinessCalendar): Iso8601 {
  const start = Date.parse(from)
  if (cal.mode === 'always') return new Date(start + minutes * MINUTE_MS).toISOString()

  const perDay = Math.max(1, (cal.business_hours.end - cal.business_hours.start) * 60)
  let cursor = start
  let remaining = minutes
  let steps = 0
  while (remaining > 0 && steps < MAX_DAY_STEPS * 24 * 60) {
    if (!isWorking(cursor, cal)) {
      // 跳到下一个工作时段的开头：先按分钟对齐，再按天跳过非工作日
      const { minuteOfDay } = localParts(cursor, cal)
      const startMin = cal.business_hours.start * 60
      const endMin = cal.business_hours.end * 60
      if (minuteOfDay < startMin) {
        cursor += (startMin - minuteOfDay) * MINUTE_MS
      } else if (minuteOfDay >= endMin) {
        cursor += (24 * 60 - minuteOfDay + startMin) * MINUTE_MS
      } else {
        // 工作时段内但今天是休息日 / 假日 → 跳到明天开工
        cursor += (24 * 60 - minuteOfDay + startMin) * MINUTE_MS
      }
      steps += perDay
      continue
    }
    const { minuteOfDay } = localParts(cursor, cal)
    const untilClose = cal.business_hours.end * 60 - minuteOfDay
    const step = Math.min(remaining, untilClose)
    cursor += step * MINUTE_MS
    remaining -= step
    steps += step
  }
  return new Date(cursor).toISOString()
}

export type SlaTier = 'ok' | 'reminder' | 'critical' | 'breached'

export interface SlaState {
  /** 倒计时锚点：最后一条**买家**消息的时刻（不是任何系统通知）。 */
  anchor_at: Iso8601
  first_response_due_at: Iso8601
  resolution_due_at: Iso8601
  /** 距首响到期还有多少分钟（可为负）。 */
  first_response_remaining_minutes: number
  resolution_remaining_minutes: number
  tier: SlaTier
  first_response_breached: boolean
  resolution_breached: boolean
  /** 已回复：停表（KefuAgent 的 "买家消息已回复，倒计时停表"）。 */
  stopped: boolean
  responded_within_target: boolean
}

export interface SlaInput {
  /** 最后一条买家消息（锚点）。 */
  anchor_at: Iso8601
  now: Iso8601
  /** 我们最后一次对外回复；晚于锚点即停表。 */
  last_outbound_at?: Iso8601
  /** 问题解决时刻。 */
  resolved_at?: Iso8601
  targets?: SlaTargets
  calendar?: BusinessCalendar
}

/** 计算 SLA。纯函数：所有时刻由调用方给（宿主从注入的 Clock 取 `now`）。 */
export function computeSla(input: SlaInput): SlaState {
  const cal = input.calendar ?? ALWAYS_ON_CALENDAR
  const targets = input.targets ?? DEFAULT_SLA_TARGETS
  const anchorMs = Date.parse(input.anchor_at)
  const nowMs = Date.parse(input.now)

  const first_response_due_at = addWorkingMinutes(
    input.anchor_at,
    targets.first_response_minutes,
    cal,
  )
  const resolution_due_at = addWorkingMinutes(input.anchor_at, targets.resolution_minutes, cal)
  const firstDueMs = Date.parse(first_response_due_at)
  const resolutionDueMs = Date.parse(resolution_due_at)

  const repliedMs =
    input.last_outbound_at === undefined ? undefined : Date.parse(input.last_outbound_at)
  const stopped = repliedMs !== undefined && repliedMs > anchorMs
  const clockMs = stopped && repliedMs !== undefined ? repliedMs : nowMs

  const first_response_remaining_minutes = Math.round((firstDueMs - clockMs) / MINUTE_MS)
  const resolvedMs = input.resolved_at === undefined ? undefined : Date.parse(input.resolved_at)
  const resolution_remaining_minutes = Math.round(
    (resolutionDueMs - (resolvedMs ?? nowMs)) / MINUTE_MS,
  )

  const first_response_breached = first_response_remaining_minutes < 0
  const resolution_breached = resolution_remaining_minutes < 0

  const tier: SlaTier = stopped
    ? 'ok'
    : first_response_breached
      ? 'breached'
      : first_response_remaining_minutes <= SLA_CRITICAL_MINUTES
        ? 'critical'
        : first_response_remaining_minutes <= SLA_REMINDER_MINUTES
          ? 'reminder'
          : 'ok'

  return {
    anchor_at: input.anchor_at,
    first_response_due_at,
    resolution_due_at,
    first_response_remaining_minutes,
    resolution_remaining_minutes,
    tier,
    first_response_breached,
    resolution_breached,
    stopped,
    responded_within_target: stopped && !first_response_breached,
  }
}

/** 响应率的分桶键：按**锚点**那天算，不按结账那天（跨零点的回复仍记在来信那天）。 */
export function responseDayKey(at: Iso8601): string {
  return new Date(Date.parse(at)).toISOString().slice(0, 10)
}

/** 报告与卡片标题上的周期戳（`2026-09-08 01:00 UTC`）。 */
export function slaCycleStamp(due_at: Iso8601): string {
  const iso = new Date(Date.parse(due_at)).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** 一段时间跨了几天（报告里"逾期多久"用）。 */
export function daysBetween(from: Iso8601, to: Iso8601): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS)
}
