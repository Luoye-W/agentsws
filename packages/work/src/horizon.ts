/**
 * 37 §2.2：待办的 `horizon` 由 `due` / `scheduled` 推出，也可手动。
 *
 * 一个对象，长期 / 短期靠字段区分：
 * - 无 due 无 scheduled → `backlog`（长期待办，住在待办箱，不上日历）
 * - 有 scheduled，或 due 落在「今天」→ `today`
 * - due / scheduled 落在**本周**剩下的日子里 → `week`
 * - 更远 → `backlog`
 * - **已过期的 due 算今天**：过期的事不该沉回待办箱
 *
 * WP474（决策 1531，Luoye 10-22 否了「滚动 7 天」）：**本周 = 本周一 00:00 到周日 24:00**（品牌时区）。
 * 周日晚上记的「本周」就只剩当天；下周一的事在周日看是「以后」。
 *
 * `horizon` 存的是**写入那一刻**的结论，日子一过就不准了——所以读的时候用 {@link viewTodo} 按现在重算
 * （老数据里按滚动口径存的不改写，读的时候按新口径算）。
 */
import type { Iso8601, Todo, TodoHorizon } from '@agentsws/contracts'
import { DAY_MS, MINUTE_MS, ms, startOfDay } from './util.js'

export interface HorizonInput {
  due?: Iso8601 | undefined
  scheduled?: { start: Iso8601; end: Iso8601 } | undefined
}

/** 一周几天（WP474 起「本周」= 周一到周日，不再是「今天 + 之后 6 天」）。 */
export const WEEK_DAYS = 7

/** 这一刻所在那一周的周一 00:00（品牌时区；返回 UTC 毫秒）。 */
export function startOfWeek(atMs: number, tzOffsetMinutes: number): number {
  const day = startOfDay(atMs, tzOffsetMinutes)
  const weekday = new Date(day + tzOffsetMinutes * MINUTE_MS).getUTCDay()
  return day - ((weekday + 6) % 7) * DAY_MS
}

export function deriveHorizon(
  input: HorizonInput,
  now: Iso8601,
  tzOffsetMinutes: number,
): TodoHorizon {
  const today = startOfDay(ms(now), tzOffsetMinutes)
  const tomorrow = today + DAY_MS
  // 下周一 00:00：之前的都算本周
  const weekEnd = startOfWeek(ms(now), tzOffsetMinutes) + WEEK_DAYS * DAY_MS
  if (input.scheduled !== undefined) {
    const start = ms(input.scheduled.start)
    if (start < tomorrow) return 'today'
    if (start < weekEnd) return 'week'
    return 'backlog'
  }
  if (input.due === undefined) return 'backlog'
  const due = ms(input.due)
  // 过期的与今天到期的都算今天
  if (due < tomorrow) return 'today'
  if (due < weekEnd) return 'week'
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

/**
 * WP474（决策 1531）：读的时候这一条落在哪一档。
 *
 * - **有日子的**（due / scheduled）：按现在重算（{@link deriveHorizon}）。只有一个例外：今天手动提到「今天」的
 *   （每日计划「提到今天」）当天照旧算今天。
 * - **没日子的**：存的那一档是「定下那一刻」的——`horizon_at`（老数据没有就看 `updated_at`）。
 *   - 「今天」：同一天照旧；同一周里过了那天回「本周」；跨了周同「本周」；
 *   - 「本周」：同一周照旧；**跨了周 → 挪进新的「本周」，标「上周没做完」**（`carried_over`）；
 *   - 「以后」照旧。
 *
 * 只算、不写：没做完的才标 `carried_over`。
 */
export function effectiveHorizon(
  todo: Pick<Todo, 'horizon' | 'due' | 'scheduled' | 'horizon_at' | 'updated_at' | 'status'>,
  now: Iso8601,
  tzOffsetMinutes: number,
): { horizon: TodoHorizon; carried_over: boolean } {
  const nowMs = ms(now)
  const setAt = ms(todo.horizon_at ?? todo.updated_at)
  const known = Number.isFinite(setAt)
  // 「还是那一天 / 那一周」：定下的那一刻不早于今天 / 本周（时钟往回拨、定在将来的也算没过期）
  const sameDay = known && startOfDay(setAt, tzOffsetMinutes) >= startOfDay(nowMs, tzOffsetMinutes)
  const sameWeek =
    known && startOfWeek(setAt, tzOffsetMinutes) >= startOfWeek(nowMs, tzOffsetMinutes)
  if (todo.due !== undefined || todo.scheduled !== undefined) {
    const derived = deriveHorizon(
      {
        ...(todo.due === undefined ? {} : { due: todo.due }),
        ...(todo.scheduled === undefined ? {} : { scheduled: todo.scheduled }),
      },
      now,
      tzOffsetMinutes,
    )
    if (todo.horizon === 'today' && sameDay) return { horizon: 'today', carried_over: false }
    return { horizon: derived, carried_over: false }
  }
  if (todo.horizon === 'backlog') return { horizon: 'backlog', carried_over: false }
  if (todo.horizon === 'today' && sameDay) return { horizon: 'today', carried_over: false }
  if (sameWeek || !known) return { horizon: 'week', carried_over: false }
  const open = todo.status === 'open' || todo.status === 'doing' || todo.status === 'blocked'
  return { horizon: 'week', carried_over: open }
}

/**
 * 读出去的那一份：`horizon` 按现在重算，跨周没做完的标 `carried_over`。不改存的那一份（存储层也不存 `carried_over`）。
 */
export function viewTodo(todo: Todo, now: Iso8601, tzOffsetMinutes: number): Todo {
  const { carried_over: _drop, ...rest } = todo
  const eff = effectiveHorizon(rest, now, tzOffsetMinutes)
  return {
    ...rest,
    horizon: eff.horizon,
    ...(eff.carried_over ? { carried_over: true } : {}),
  }
}
