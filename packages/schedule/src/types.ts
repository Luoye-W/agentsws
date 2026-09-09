/**
 * 本包的类型（契约 25 的实现侧扩展）。
 *
 * 契约里的 `ScheduledTask` / `WorkflowDef` / `WorkflowInstance` 是形状定稿，
 * 但少了实现必需的几样东西（都写进交付报告的「需要契约改动」）：
 *
 * | 扩展 | 为什么 |
 * |---|---|
 * | `trigger.kind = 'interval'` | 25 §4 的「每 N 分钟」用 cron 表达不了跨小时的整点漂移（`poll` 每 15 分钟） |
 * | `state` 多 `running` / `cancelled` | 25 §3 的状态机是 `scheduled → running → done \| failed \| cancelled`；契约只有五态 |
 * | `title` | WP22 已提：列表与对话卡要一句人话 |
 * | `handler` / `params` | 调度器不认识业务：到点只喊一声「谁登记了这个名字」 |
 * | `misfire_grace_ms` | 25 §3「错过触发」要有一条线来判「错过」还是「刚到点」 |
 * | `lease` | 同一任务不重入（进程内 + 重启后接管） |
 *
 * 契约形状的任务（`once` / `cron` / `after_event` + 五态）原样能进能出，见
 * `test/contract.test.ts`。
 */
import type {
  AssignmentId,
  Iso8601,
  ObjectRef,
  PersonId,
  RoleId,
  RunRequest,
  ScheduledTask,
  WorkflowStepKind,
  WorkspaceId,
} from '@agentsws/contracts'

/** 25 §3 / §4：一次性、固定间隔、cron、等事件。 */
export type ScheduleTrigger =
  | { kind: 'once'; at: Iso8601 }
  | { kind: 'interval'; every_ms: number; from?: Iso8601 }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'after_event'; event: string }

/** 25 §3 状态机：`scheduled(pending/active) → running → done | failed | cancelled`。 */
export type ScheduleTaskState =
  | 'pending'
  | 'active'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface ScheduleTask
  extends Omit<
    ScheduledTask,
    | 'trigger'
    | 'state'
    | 'origin'
    | 'context_policy'
    | 'action'
    | 'next_fire_at'
    | 'last_fire_at'
    | 'last_result'
    | 'approval'
  > {
  /** 下一次什么时候（`after_event` 与已结束的任务没有）。 */
  next_fire_at?: Iso8601 | undefined
  last_fire_at?: Iso8601 | undefined
  last_result?: string | undefined
  /** Agent 建的写类定时任务经过的那条审批项（25 §3）。 */
  approval?: string | undefined
  trigger: ScheduleTrigger
  state: ScheduleTaskState
  /**
   * 25 §3「与会话绑定」。系统自己的巡检（幂等表清理、令牌刷新）没有会话，
   * 所以这里可省——契约里它是必填，见交付报告。
   */
  origin?: ScheduledTask['origin']
  context_policy?: ScheduledTask['context_policy']
  /** 到点做什么。系统任务没有 RunRequest，只有 `handler`。 */
  action?: ScheduledTask['action']
  /** 列表与对话卡上的一句人话 */
  title?: string
  /** 到点交给哪个处理器（`register` 登记的名字） */
  handler?: string
  /** 处理器参数。**不放秘密**：它会进事件日志的 payload 摘要 */
  params?: Record<string, unknown>
  /** 超过这条线才算「错过」（默认 5 分钟，25 §4 精度分钟） */
  misfire_grace_ms?: number
  /** 同一任务不重入：谁在跑、租约到什么时候 */
  lease?: { holder: string; until: Iso8601 } | undefined
  last_error?: string | undefined
  created_at: Iso8601
  updated_at: Iso8601
}

/** `schedule()` 的入参：id / 计数 / 时间戳由调度器填。 */
export type ScheduleInput = Omit<
  ScheduleTask,
  'id' | 'fire_count' | 'state' | 'created_at' | 'updated_at' | 'lease'
> & {
  id?: string
  state?: ScheduleTaskState
  fire_count?: number
}

export interface ScheduleFilter {
  workspace_id: WorkspaceId
  owner?: PersonId
  role_id?: RoleId
  assignment_id?: AssignmentId
  conversation_id?: string
  state?: ScheduleTaskState[]
  handler?: string
}

/** 到点时交给处理器的东西。处理器只管做事，状态与事件由调度器写。 */
export interface ScheduleFireContext {
  task: ScheduleTask
  /** 触发时刻（合成时钟里就是虚拟时刻） */
  at: Iso8601
  /** 第几次（从 1 起） */
  fire_count: number
  /** 这一次触发的幂等键：`sched_<id>_<fire_count>` */
  idempotency_key: string
  /** 是不是补跑（关机错过） */
  misfired: boolean
}

export type ScheduleHandler = (ctx: ScheduleFireContext) => Promise<unknown> | unknown

/* ------------------------------------------------------------------ */
/* 流程                                                                 */
/* ------------------------------------------------------------------ */

/** 25 §1 步骤。契约的 `WorkflowDef.steps[]` 少了 `retry`，这里补上。 */
export interface WorkflowStep {
  id: string
  kind: WorkflowStepKind
  params: unknown
  retry?: { max: number; backoff_ms: number }
  on_fail?: 'retry' | 'compensate' | 'escalate' | 'skip'
}

export interface WorkflowDefinition {
  id: string
  version: string
  name: string
  role_id: RoleId
  steps: WorkflowStep[]
  /** 25 §1：失败要补救（重寄、撤回通知） */
  compensation?: Record<string, WorkflowStep>
  /**
   * 25 §1 邮件序列「任一回复即停」：收到这些事件，实例立刻 `done`，
   * 无论它当时停在哪一步（在 `sleep` 里也算）。
   */
  stop_on?: string[]
  /** 25 §1 `sla.total_days`：超期只记事件，不自动杀实例。 */
  sla?: { total_days: number }
}

export type WorkflowState =
  | 'running'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'failed'
  | 'compensated'
  | 'cancelled'

export interface WorkflowStepRecord {
  step_id: string
  at: Iso8601
  result: unknown
  /** `ok` / `failed` / `skipped` / `compensated` */
  outcome: 'ok' | 'failed' | 'skipped' | 'compensated'
  attempt: number
}

/** 实例在等什么（`wait_event` / `approval` / `human_task` / `sleep` / 重试退避）。 */
export interface WorkflowWaiting {
  reason: 'event' | 'approval' | 'human_task' | 'sleep' | 'retry'
  event?: string
  approval_id?: string
  human_task_id?: string
  /** 到点自动醒（`sleep` 与重试退避） */
  wake_at?: Iso8601
  /** 等不到就算失败（`wait_event` 超时） */
  timeout_at?: Iso8601
}

export interface WorkflowInstanceRecord {
  id: string
  def: { id: string; version: string }
  workspace_id: WorkspaceId
  role_id: RoleId
  subject: ObjectRef
  conversation_id?: string
  state: WorkflowState
  cursor: string
  history: WorkflowStepRecord[]
  started_at: Iso8601
  updated_at: Iso8601
  due_at?: Iso8601
  waiting?: WorkflowWaiting | undefined
  /** 每步已经试了几次（重试上限判定） */
  attempts: Record<string, number>
  /** 定义快照：重启后接着跑的是**当初那一版**，不是后来改过的 */
  definition: WorkflowDefinition
  last_error?: string | undefined
}

export interface WorkflowFilter {
  workspace_id: WorkspaceId
  def_id?: string
  state?: WorkflowState[]
  subject?: ObjectRef
  conversation_id?: string
}

/** 一步交给宿主做的事。宿主返回什么，就记进 history。 */
export interface WorkflowStepContext {
  instance: WorkflowInstanceRecord
  step: WorkflowStep
  at: Iso8601
  attempt: number
  /** 每步幂等键：`wf_<instance>_<step>`（重试之间稳定，宿主据此去重） */
  idempotency_key: string
}

export interface WorkflowHandlers {
  /** `run` = 发 RunRequest 等 RunResult；`action` = 执行器 apply 已批变更 */
  run?(ctx: WorkflowStepContext): Promise<unknown> | unknown
  action?(ctx: WorkflowStepContext): Promise<unknown> | unknown
  /** `approval` = 建审批项，返回它的 id；决定后宿主 `signal` 回来 */
  approval?(ctx: WorkflowStepContext): Promise<string> | string
  /** `human_task` = 队列里一条待办，返回它的 id */
  humanTask?(ctx: WorkflowStepContext): Promise<string> | string
  /** `branch` = 按上一步结果分流，返回下一步 id（`undefined` = 顺序往下） */
  branch?(ctx: WorkflowStepContext): Promise<string | undefined> | string | undefined
}

/* ------------------------------------------------------------------ */
/* 存储                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 内存档与 SQLite 档共用的接口（照 `@agentsws/txn` 的做法：同一份一致性套件跑两遍）。
 * 全同步——`better-sqlite3` 是同步 API，硬套 Promise 只会让重启续跑更难讲清楚。
 */
export interface ScheduleStore {
  putTask(task: ScheduleTask): void
  getTask(id: string): ScheduleTask | undefined
  listTasks(filter: ScheduleFilter): ScheduleTask[]
  /**
   * 到点的任务，**跨工作区**（调度循环不认识工作区，它只认时间）。
   * 只回 `pending` / `active` / `running` 三态；`running` 交给调用方判租约。
   */
  dueTasks(before: Iso8601): ScheduleTask[]
  /** 库里出现过的工作区（`after_event` 任务不排队，只能这样找一遍）。 */
  workspaces(): WorkspaceId[]
  deleteTask(id: string): void
  putInstance(instance: WorkflowInstanceRecord): void
  getInstance(id: string): WorkflowInstanceRecord | undefined
  listInstances(filter: WorkflowFilter): WorkflowInstanceRecord[]
  /** 到点该醒的实例（`sleep` / 重试退避 / `wait_event` 超时），跨工作区。 */
  wakeableInstances(before: Iso8601): WorkflowInstanceRecord[]
  /** 还在等信号的实例（`wait_event` / 审批 / 待办），跨工作区。 */
  waitingInstances(): WorkflowInstanceRecord[]
  close?(): void
}

/** 25 §5 事件。名字还没进契约的 `KnownEventType`（见交付报告）。 */
export const SCHEDULE_EVENTS = {
  created: 'schedule.created',
  updated: 'schedule.updated',
  fired: 'schedule.fired',
  failed: 'schedule.failed',
  misfired: 'schedule.misfired',
  paused: 'schedule.paused',
  resumed: 'schedule.resumed',
  deleted: 'schedule.deleted',
} as const

export const WORKFLOW_EVENTS = {
  started: 'workflow.started',
  stepCompleted: 'workflow.step.completed',
  stepFailed: 'workflow.step.failed',
  waiting: 'workflow.waiting',
  failed: 'workflow.failed',
  compensated: 'workflow.compensated',
  done: 'workflow.done',
  cancelled: 'workflow.cancelled',
} as const

/** 事件出口：宿主把它接到 21 §1 的那条日志上；不接就是不记。 */
export type ScheduleEventSink = (event: {
  type: string
  workspace_id: WorkspaceId
  at: Iso8601
  subject?: ObjectRef
  payload: Record<string, unknown>
}) => void

/** 契约的 `action` 至少要有 `kind`；系统任务用 `scheduled`。 */
export const SYSTEM_ACTION: { kind: RunRequest['kind'] } = { kind: 'scheduled' }
