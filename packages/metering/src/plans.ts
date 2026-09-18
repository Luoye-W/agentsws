/**
 * 会员的 term / cycle（65 §7，机制照 KefuAgent 搬）。
 *
 * **term 是一段时间，cycle 是里面的一个自然月。** 开通 24 个月 = 一个 term +
 * 24 个 cycle，每个 cycle 到点发一次积分、各自带各自的到期日、且被 term 末尾封顶。
 *
 * 为什么不是"开通时一次性把 24 个月的量发掉"：用户第三个月不用了，我们已经把
 * 24 个月的积分给出去了。
 *
 * 三条从 KefuAgent 的事故里抄回来的纪律：
 *
 * 1. **grant_key 绝不含时间戳**。它由 `(term_id, cycle_start)` 推导，同一个 cycle
 *    在任何一次定时任务里算出来都是同一串。KefuAgent 曾经用 `Date.now()` 当 key，
 *    于是定时任务每跑一次就重发一次，白送了一整个月的积分。
 *    库里还有一道 `wallet_lots (org_id, source_ref)` 的唯一索引兜底。
 * 2. **日历月按固定时区算**（`Asia/Shanghai`，UTC+8 无夏令时），不用本机时区。
 *    容器里没设 TZ、换个机房，"这个月的第一天"就漂一天，两台机器算出两个
 *    grant_key，幂等当场失效。
 * 3. **调档沿用旧 anchor**：从月付换成年付不该把所有 cycle 边界都推到今天，
 *    否则这个月会发两次。
 *
 * 纯函数，无 IO 无时钟：`now` 由调用方传。
 */

import {
  MEMBERSHIP_MAX_TERM_MONTHS,
  MEMBERSHIP_UTC_OFFSET_MINUTES,
  type MembershipPlan,
} from '@agentsws/contracts'
import plansFile from './plans.json' with { type: 'json' }

export interface PlansFile {
  version: number
  as_of: string
  note: string
  needs_decision: string
  plans: MembershipPlan[]
}

export const PLANS_FILE = plansFile as unknown as PlansFile

export const plans = (file: PlansFile = PLANS_FILE): MembershipPlan[] => file.plans

export function planById(id: string, file: PlansFile = PLANS_FILE): MembershipPlan | undefined {
  return file.plans.find((p) => p.id === id)
}

const OFFSET_MS = MEMBERSHIP_UTC_OFFSET_MINUTES * 60 * 1000

/** 一个时刻在 `Asia/Shanghai` 挂历上的年 / 月 / 日 / 当天已过毫秒。 */
interface LocalParts {
  year: number
  month: number
  day: number
  timeOfDayMs: number
}

function toLocal(iso: string): LocalParts {
  const shifted = new Date(Date.parse(iso) + OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    timeOfDayMs:
      shifted.getUTCHours() * 3_600_000 +
      shifted.getUTCMinutes() * 60_000 +
      shifted.getUTCSeconds() * 1000 +
      shifted.getUTCMilliseconds(),
  }
}

function fromLocal(p: LocalParts): string {
  const base = Date.UTC(p.year, p.month - 1, p.day)
  return new Date(base + p.timeOfDayMs - OFFSET_MS).toISOString()
}

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * 在 `Asia/Shanghai` 挂历上往后推 N 个自然月。
 *
 * **日号超界要收回来**：1 月 31 日 + 1 个月 = 2 月 28 日（不是 3 月 3 日）。
 * 不收的话，一个 1 月 31 日开通的年付会员，一年下来的 cycle 边界会往后漂三天，
 * 于是有一个月被发了两次。
 */
export function addCalendarMonths(iso: string, months: number): string {
  const p = toLocal(iso)
  const total = (p.year * 12 + (p.month - 1)) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const day = Math.min(p.day, daysInMonth(year, month))
  return fromLocal({ year, month, day, timeOfDayMs: p.timeOfDayMs })
}

/** 这一天在 `Asia/Shanghai` 挂历上的 `YYYY-MM-DD`（grant_key 的稳定部分）。 */
export function shanghaiDate(iso: string): string {
  const p = toLocal(iso)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** 一个算出来的 cycle（还没落库，也还没发积分）。 */
export interface PlannedCycle {
  index: number
  starts_at: string
  /** 被 term 的 `ends_at` 封顶。 */
  ends_at: string
  grant_key: string
  credits: number
}

export interface TermPlanInput {
  term_id: string
  plan: MembershipPlan
  /** 计算所有边界的锚点。调档时沿用旧的。 */
  anchor_at: string
  /** term 的末尾。 */
  ends_at: string
}

/**
 * 幂等键：`mship:<term_id>:<cycle 起始那一天>`。
 *
 * **没有时间戳、没有随机数、没有序号之外的任何变量**——同一个 cycle 在任何一次
 * 计算里都是同一串。它同时被当作 `wallet_lots.source_ref`，那张表上有唯一索引，
 * 所以就算逻辑上漏判一次，库也会把第二笔挡回来。
 */
export const grantKeyOf = (term_id: string, cycle_start: string): string =>
  `mship:${term_id}:${shanghaiDate(cycle_start)}`

/**
 * 把一个 term 拆成 N 个 cycle。
 *
 * 最后一个 cycle 的 `ends_at` 被 term 末尾封顶——term 到 3 月 10 日结束，
 * 3 月那一个 cycle 送的积分不该活到 4 月 1 日。
 */
export function planCycles(input: TermPlanInput): PlannedCycle[] {
  const endMs = Date.parse(input.ends_at)
  const out: PlannedCycle[] = []
  for (let i = 0; i < MEMBERSHIP_MAX_TERM_MONTHS + 1; i++) {
    const starts_at = addCalendarMonths(input.anchor_at, i)
    if (Date.parse(starts_at) >= endMs) break
    const rawEnd = addCalendarMonths(input.anchor_at, i + 1)
    const ends_at = Date.parse(rawEnd) > endMs ? input.ends_at : rawEnd
    out.push({
      index: i + 1,
      starts_at,
      ends_at,
      grant_key: grantKeyOf(input.term_id, starts_at),
      credits: input.plan.credits_per_cycle,
    })
  }
  return out
}

/**
 * term 的末尾：给月数就是 anchor + N 个自然月；给绝对日期就是那个日期。
 *
 * 两个都给按**绝对日期**（人明确写了一个日子，那就是他的意思）；一个都不给抛。
 */
export function termEndsAt(
  anchor_at: string,
  input: { months?: number | undefined; until?: string | undefined },
): string {
  if (input.until !== undefined && input.until.trim() !== '') {
    const ms = Date.parse(input.until)
    if (Number.isNaN(ms)) throw new Error('until 不是合法时间')
    return new Date(ms).toISOString()
  }
  const months = input.months
  if (months === undefined || !Number.isInteger(months) || months < 1)
    throw new Error('months 要是 1 以上的整数，或者给一个 until')
  if (months > MEMBERSHIP_MAX_TERM_MONTHS)
    throw new Error(`手动开通最多 ${String(MEMBERSHIP_MAX_TERM_MONTHS)} 个月`)
  return addCalendarMonths(anchor_at, months)
}

/** 现在该发的那些 cycle（起始时间已到、还没发过的）。定时续发拿它跑。 */
export function dueCycles(cycles: PlannedCycle[], now: string, granted: Set<string>): PlannedCycle[] {
  const nowMs = Date.parse(now)
  return cycles.filter((c) => Date.parse(c.starts_at) <= nowMs && !granted.has(c.grant_key))
}
