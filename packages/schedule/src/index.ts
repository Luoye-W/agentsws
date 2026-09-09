/**
 * `@agentsws/schedule` —— 定时与流程（契约 25）。
 *
 * 两件东西：
 * - **调度器**：「什么时候」。at / interval / cron，落盘、重启续跑、错过补跑、不重入。
 * - **流程引擎**：「一串怎么串起来」。步骤、等待、分支、重试、补偿、断点续跑。
 *
 * 都不认识业务：到点或到步喊一声登记过的处理器，业务在宿主那边。
 */
export {
  type CronExpr,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  nextCronAfter,
  parseCron,
  tzOffsetMinutes,
  type WallClock,
  wallClock,
} from './cron.js'
export { invalid, notFound, ScheduleError } from './errors.js'
export { counterRandom, type IdFactory, makeIdFactory } from './ids.js'
export {
  type Migration,
  migrate,
  SCHEDULE_MIGRATIONS,
  schemaVersion,
} from './migrations.js'
export {
  decideScheduleApproval,
  type ScheduleApprovalDecision,
  type ScheduleApprovalInput,
  type ScheduleEffect,
} from './policy.js'
export {
  createScheduler,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_MISFIRE_GRACE_MS,
  type FireOutcome,
  firstFireAt,
  nextFireAfter,
  type Scheduler,
  type SchedulerOptions,
  type TickResult,
} from './scheduler.js'
export {
  createSqliteScheduleStore,
  SqliteScheduleStore,
  type SqliteScheduleStoreOptions,
} from './sqlite-store.js'
export {
  isDue,
  isWakeable,
  MemoryScheduleStore,
  matchInstance,
  matchTask,
  RUNNABLE_STATES,
} from './store.js'
export {
  SCHEDULE_EVENTS,
  type ScheduleEventSink,
  type ScheduleFilter,
  type ScheduleFireContext,
  type ScheduleHandler,
  type ScheduleInput,
  type ScheduleStore,
  type ScheduleTask,
  type ScheduleTaskState,
  type ScheduleTrigger,
  SYSTEM_ACTION,
  WORKFLOW_EVENTS,
  type WorkflowDefinition,
  type WorkflowFilter,
  type WorkflowHandlers,
  type WorkflowInstanceRecord,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowStepRecord,
  type WorkflowWaiting,
} from './types.js'
export {
  createWorkflowEngine,
  DEFAULT_BACKOFF_MS,
  type SleepParams,
  type WaitEventParams,
  type WorkflowEngine,
  type WorkflowEngineOptions,
  type WorkflowSignal,
} from './workflow.js'
