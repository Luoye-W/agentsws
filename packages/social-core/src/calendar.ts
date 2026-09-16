/**
 * 内容日历与排期撞车（56 §3 `calendar.ts`）。
 *
 * 这个模块只回答三个问题，一个都不许靠模型：
 *
 * 1. **本周 / 下周排了什么**（{@link contentCalendar}）——面板上那两格。
 * 2. **这条排期和别的撞了没有**（{@link scheduleConflicts}）。
 * 3. **下一个空档在什么时候**（{@link nextFreeSlot}）——撞了之后卡面上要给得出
 *    一个能点的建议，不能只说"撞了"。
 *
 * 什么叫"撞车"，在 {@link SCHEDULE_RULES} 里写死，因为它是三条判断而不是一条：
 *
 * - **同号同时段**：同一个账号上两条帖子挨得太近（默认 90 分钟）。这是真正的
 *   撞车——平台会把第二条压下去，而且关注的人会觉得被刷屏。
 * - **同号同日超额**：同一个账号一天排了超过 `max_per_day` 条。这一条与 guardrail
 *   的 `max_posts_per_day` 是**同一个数的两个位置**：这里是排的时候提前告诉你，
 *   那里是提交的时候真拦。提前说不代表这里能放行——两边都要过。
 * - **跨号同文案**：同一段文案在两个账号上同一天发。多数时候这是有意的
 *   （一稿多投），所以它是 `notice` 不是 `conflict`——**提醒，不拦**。
 *
 * 时间一律 ISO 8601 字符串进、字符串出；**这个包里没有 `Date.now()`**
 * （调用方给 `now`），所以同样的输入永远算出同样的日历。
 */

import type { Iso8601, SocialPost, SocialPostStatus } from '@agentsws/contracts'

/** 撞车判断的三个旋钮。调用方可以按职责额度盖过去，但默认值就是 56 §7 那几个数。 */
export interface ScheduleRules {
  /** 同一个账号上两条帖子至少隔多久（分钟）。 */
  min_gap_minutes: number
  /** 同一个账号一天最多几条（与 guardrail 的 `max_posts_per_day` 同一个数）。 */
  max_per_day: number
}

/** 56 §7 的默认值：发帖 3 / 天；同号两条至少隔 90 分钟。 */
export const SCHEDULE_RULES: ScheduleRules = { min_gap_minutes: 90, max_per_day: 3 }

/** 撞车的种类。`same_copy_across_accounts` 是**提醒**，不拦。 */
export type ScheduleConflictKind =
  | 'too_close'
  | 'over_daily_cap'
  | 'same_copy_across_accounts'
  | 'in_the_past'

export interface ScheduleConflict {
  kind: ScheduleConflictKind
  /** `conflict` 要人改；`notice` 只是说一声。 */
  severity: 'conflict' | 'notice'
  /** 跟谁撞了（`in_the_past` / `over_daily_cap` 没有对手，这一格是空的）。 */
  with_post_ids: string[]
  /** 一句人话，原样进卡面。 */
  message: string
}

/** 排进日历的一条（`SocialPost` 的子集——日历不需要正文全文）。 */
export interface CalendarEntry {
  post_id: string
  account_id: string
  channel: string
  kind: string
  status: SocialPostStatus
  scheduled_at: Iso8601
  /** 文案的前 60 字（日历格子里显示的那一截）。 */
  preview: string
}

/** 一周的日历。`from` / `to` 是这一周的左闭右开区间。 */
export interface CalendarWeek {
  from: Iso8601
  to: Iso8601
  entries: CalendarEntry[]
}

const MINUTE = 60_000
const DAY = 86_400_000

const ms = (v: string | undefined): number => (v === undefined ? Number.NaN : Date.parse(v))

/**
 * 归一化文案，用来判"同一段文案"。
 *
 * 只做保守的两件事：去两端空白、把连续空白压成一个。**不**去标点、不转小写——
 * 两段只差一个表情的文案在运营眼里就是两条（一条给 IG 一条给 X），
 * 判成同一条会让"一稿多投"的提醒天天响。
 */
export function copyKey(body: string): string {
  return body.trim().replace(/\s+/g, ' ')
}

/**
 * 按时区偏移切日界线（分钟；东八区是 `480`）。
 *
 * 为什么要这一刀：一条排在北京时间 09-10 07:30 的帖子，UTC 上是 09-09——
 * 按 UTC 分日，"今天三条"会算成两天各一条半，日额度就形同虚设。
 */
export function localDayKey(at: Iso8601, tz_offset_minutes = 0): string {
  const t = ms(at)
  if (Number.isNaN(t)) return ''
  return new Date(t + tz_offset_minutes * MINUTE).toISOString().slice(0, 10)
}

/** 这一刻所在的那一周的周一零点（按时区偏移；周一开始，不是周日）。 */
export function weekStart(now: Iso8601, tz_offset_minutes = 0): Iso8601 {
  const t = ms(now)
  if (Number.isNaN(t)) return now
  const local = new Date(t + tz_offset_minutes * MINUTE)
  // `getUTCDay()` 在偏移过的时刻上就是本地星期几；周日（0）要回退 6 天而不是 0 天
  const dow = (local.getUTCDay() + 6) % 7
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return new Date(midnight - dow * DAY - tz_offset_minutes * MINUTE).toISOString()
}

/**
 * 内容日历：本周与下周各一格（56 §2 面板那一块）。
 *
 * 只收**排了期的**（`scheduled_at` 有值）。草稿不进日历——日历回答的是
 * "接下来会发什么"，一条还没定时间的草稿不在这个问题的答案里。
 * 已发布的留着：这一周已经发过的东西也是日历的一部分。
 */
export function contentCalendar(
  posts: readonly SocialPost[],
  options: { now: Iso8601; tz_offset_minutes?: number },
): { this_week: CalendarWeek; next_week: CalendarWeek } {
  const tz = options.tz_offset_minutes ?? 0
  const start = ms(weekStart(options.now, tz))
  const bounds = [start, start + 7 * DAY, start + 14 * DAY]
  const entryOf = (p: SocialPost): CalendarEntry => ({
    post_id: p.id,
    account_id: p.account_id,
    channel: p.channel,
    kind: p.kind,
    status: p.status,
    scheduled_at: p.scheduled_at as string,
    preview: p.body.trim().slice(0, 60),
  })
  const weekOf = (from: number, to: number): CalendarWeek => ({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    entries: posts
      .filter((p) => p.scheduled_at !== undefined)
      .filter((p) => {
        const t = ms(p.scheduled_at)
        return !Number.isNaN(t) && t >= from && t < to
      })
      .sort((a, b) => ms(a.scheduled_at) - ms(b.scheduled_at))
      .map(entryOf),
  })
  return {
    this_week: weekOf(bounds[0] as number, bounds[1] as number),
    next_week: weekOf(bounds[1] as number, bounds[2] as number),
  }
}

/**
 * 这条**待排的**帖子跟已有的排期撞了没有。
 *
 * 返回空数组 = 没撞。撞了的按严重度排（`conflict` 在前），因为卡面上只显示第一条
 * 的时候，要显示的是要人改的那一条，不是"顺便说一声"的那一条。
 *
 * `existing` 里已经取消 / 失败的那些**不算数**：一条发失败的帖子不占位置。
 */
export function scheduleConflicts(
  candidate: { id?: string; account_id: string; scheduled_at: Iso8601; body: string },
  existing: readonly SocialPost[],
  options: { now: Iso8601; tz_offset_minutes?: number; rules?: Partial<ScheduleRules> },
): ScheduleConflict[] {
  const rules = { ...SCHEDULE_RULES, ...options.rules }
  const tz = options.tz_offset_minutes ?? 0
  const at = ms(candidate.scheduled_at)
  const out: ScheduleConflict[] = []
  if (Number.isNaN(at)) {
    return [
      {
        kind: 'in_the_past',
        severity: 'conflict',
        with_post_ids: [],
        message: `排期时间读不懂：${candidate.scheduled_at}`,
      },
    ]
  }
  if (at < ms(options.now)) {
    out.push({
      kind: 'in_the_past',
      severity: 'conflict',
      with_post_ids: [],
      message: '这个时间已经过去了。排在过去的帖子到点之后不会再触发，会一直躺在待发布里。',
    })
  }

  const live = existing.filter((p) => p.status === 'scheduled' || p.status === 'published')
  const others = live.filter((p) => p.id !== candidate.id)
  const sameAccount = others.filter((p) => p.account_id === candidate.account_id)

  const close = sameAccount.filter((p) => {
    const t = ms(p.scheduled_at)
    return !Number.isNaN(t) && Math.abs(t - at) < rules.min_gap_minutes * MINUTE
  })
  if (close.length > 0) {
    out.push({
      kind: 'too_close',
      severity: 'conflict',
      with_post_ids: close.map((p) => p.id),
      message: `同一个号上 ${rules.min_gap_minutes} 分钟内已经有 ${close.length} 条了。挨得太近，平台会把后一条压下去，关注的人也会觉得被刷屏。`,
    })
  }

  const day = localDayKey(candidate.scheduled_at, tz)
  const sameDay = sameAccount.filter(
    (p) => p.scheduled_at !== undefined && localDayKey(p.scheduled_at, tz) === day,
  )
  if (sameDay.length + 1 > rules.max_per_day) {
    out.push({
      kind: 'over_daily_cap',
      severity: 'conflict',
      with_post_ids: sameDay.map((p) => p.id),
      message: `这个号 ${day} 已经排了 ${sameDay.length} 条，再加一条就超过一天 ${rules.max_per_day} 条了。`,
    })
  }

  const key = copyKey(candidate.body)
  const twins = others.filter(
    (p) =>
      p.scheduled_at !== undefined &&
      localDayKey(p.scheduled_at, tz) === day &&
      copyKey(p.body) === key &&
      key !== '',
  )
  if (twins.length > 0) {
    out.push({
      kind: 'same_copy_across_accounts',
      severity: 'notice',
      with_post_ids: twins.map((p) => p.id),
      // 一稿多投多数时候是有意的，所以只说一声
      message: `同一段文案同一天在别的号上也排了（${twins.length} 条）。一稿多投是常事，说一声而已。`,
    })
  }

  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'conflict' ? -1 : 1))
}

/**
 * 从 `from` 起往后找第一个不撞的时刻（按 `step_minutes` 一格格试）。
 *
 * 找不到就回 `undefined`——**不硬塞一个**：一天已经排满了的时候，正确的回答是
 * "今天排不下了，要不要挪到明天"，而不是给一个照样会被拦下来的时间。
 */
export function nextFreeSlot(
  candidate: { account_id: string; body: string },
  existing: readonly SocialPost[],
  options: {
    now: Iso8601
    from: Iso8601
    tz_offset_minutes?: number
    rules?: Partial<ScheduleRules>
    step_minutes?: number
    /** 最多往后找多久（小时）。默认 72 小时——再远就不该由机器替人决定了。 */
    horizon_hours?: number
  },
): Iso8601 | undefined {
  const step = (options.step_minutes ?? 30) * MINUTE
  const horizon = (options.horizon_hours ?? 72) * 60 * MINUTE
  const start = Math.max(ms(options.from), ms(options.now))
  if (Number.isNaN(start)) return undefined
  for (let t = start; t <= start + horizon; t += step) {
    const at = new Date(t).toISOString()
    const hits = scheduleConflicts({ ...candidate, scheduled_at: at }, existing, options).filter(
      (c) => c.severity === 'conflict',
    )
    if (hits.length === 0) return at
  }
  return undefined
}
