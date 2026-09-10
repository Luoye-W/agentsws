/**
 * `@agentsws/work` —— 工作模型（契约 #19 / 37）。
 *
 * 事项 · 目标 · 待办 · 每日计划 · 复盘 · 日历。没有 IO、没有框架、没有模型：
 * 存储与运行时都是注入的，纯逻辑部分（`draftDailyPlan` / `buildReview` / `goalProgress` /
 * `buildCalendar`）给同样的输入永远出同样的输出。
 */
export {
  buildCalendar,
  type CalendarInput,
  type ScheduledTaskLike,
  sortCalendar,
  todoCalendarItem,
} from './calendar.js'
export { notFound, WorkError } from './errors.js'
export {
  BEHIND_THRESHOLD_PCT,
  daysLeft,
  elapsedPct,
  type GoalNode,
  goalProgress,
  goalProgressAll,
  goalTree,
  type QueryRunner,
} from './goals.js'
export { deriveHorizon, type HorizonInput, isOpen, resolveHorizon, WEEK_DAYS } from './horizon.js'
export { type Migration, migrate, schemaVersion, WORK_MIGRATIONS } from './migrations.js'
export {
  BUSY_MAX_SUGGESTIONS,
  BUSY_MEETINGS,
  type DailyPlanInput,
  DEFAULT_SELECTED,
  draftDailyPlan,
  freeSlots,
  MAX_SUGGESTIONS,
  planSummary,
  planTitle,
  SLOT_MINUTES,
  WORK_END_HOUR,
  WORK_START_HOUR,
} from './plan.js'
export {
  battleReport,
  buildReview,
  type CardOutcome,
  type ReviewInput,
  reviewSummary,
  reviewTitle,
} from './review.js'
export {
  type CalendarSources,
  type CardRef,
  type CreateGoalInput,
  type CreateMatterInput,
  type CreateTodoInput,
  cardRefOf,
  createWork,
  type HandoverInput,
  type HandoverResult,
  TIMELINE_PAGE,
  type UnfinishedPolicy,
  type UpdateTodoInput,
  Work,
  type WorkEventSink,
  type WorkOptions,
} from './service.js'
export {
  createSqliteWorkStore,
  SqliteWorkStore,
  type SqliteWorkStoreOptions,
} from './sqlite-store.js'
export { MemoryWorkStore, matchGoal, matchMatter, matchTodo } from './store.js'
export {
  atLocalTime,
  DAY_MS,
  HOUR_MS,
  localDay,
  MINUTE_MS,
  makeIdFactory,
  ms,
  overlaps,
  plusMs,
  round2,
  startOfDay,
  uniq,
} from './util.js'
