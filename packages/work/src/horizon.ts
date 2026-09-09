/**
 * 37 §2.2：待办的 `horizon` 由 `due` / `scheduled` 推出，也可手动。
 *
 * 一个对象，长期 / 短期靠字段区分：
 * - 无 due 无 scheduled → `backlog`（长期待办，住在待办箱，不上日历）
 * - 有 scheduled，或 due 落在「今天」→ `today`
 * - due 落在本周剩下的日子里（今天之后 7 天内）→ `week`
 * - due 更远 → `backlog`
 * - **已过期的 due 算今天**：过期的事不该沉回待办箱
 */
import type { Iso8601, Todo, TodoHorizon } from '@agentsws/contracts'
import { DAY_MS, ms, startOfDay } from './util.js'

export interface HorizonInput {
  due?: Iso8601 | undefined
  scheduled?: { start: Iso8601; end: Iso8601 } | undefined
}

/** 本周的窗口长度：今天 + 之后 6 天（37 §2.2「周计划就是把 backlog 里的挑几条拆成本周的子项」）。 */
export const WEEK_DAYS = 7

export function deriveHorizon(
  input: HorizonInput,
  now: Iso8601,
  tzOffsetMinutes: number,
): TodoHorizon {
  const today = startOfDay(ms(now), tzOffsetMinutes)
  const tomorrow = today + DAY_MS
  if (input.scheduled !== undefined) {
    const start = ms(input.scheduled.start)
    if (start < tomorrow) return 'today'
    if (start < today + WEEK_DAYS * DAY_MS) return 'week'
    return 'backlog'
  }
  if (input.due === undefined) return 'backlog'
  const due = ms(input.due)
  // 过期的与今天到期的都算今天
  if (due < tomorrow) return 'today'
  if (due < today + WEEK_DAYS * DAY_MS) return 'week'
  return 'backlog'
}

/**
 * 写待办时归一 `horizon`：调用方显式给了就用它（手动放进本周 / 今天是允许的），
 * 没给就按 due / scheduled 推。
 */
export function resolveHorizon(
  input: HorizonInput & { horizon?: TodoHorizon | undefined },
  now: Iso8601,
  tzOffsetMinutes: number,
): TodoHorizon {
  return input.horizon ?? deriveHorizon(input, now, tzOffsetMinutes)
}

/** 待办还在不在「未完」状态。 */
export function isOpen(todo: Todo): boolean {
  return todo.status === 'open' || todo.status === 'doing' || todo.status === 'blocked'
}
