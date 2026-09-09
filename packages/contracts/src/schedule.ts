import type {
  AssignmentId,
  Iso8601,
  ObjectRef,
  PersonId,
  RoleId,
  RunId,
  WorkspaceId,
} from './common.js'
import type { RunRequest } from './run.js'

/** 25 §4 时钟可替换（合成时钟快进）；所有 now() 经它。 */
export interface Clock {
  now(): Iso8601
  sleep?(ms: number): Promise<void>
}

/** 13 §1.3 / 25 §3 定时任务：与会话、职责绑定；AI 可设人可管。（WP27 按实现补齐：interval、running/cancelled、title/handler/params、misfire_grace、lease；系统巡检可无 origin/action） */
export interface ScheduledTask {
  id: string
  workspace_id: WorkspaceId
  owner: PersonId
  role_id: RoleId
  assignment_id: AssignmentId
  /** 列表与对话卡上的一句人话 */
  title?: string
  /** Agent 设的定时任务有对话来源；系统巡检（幂等清理、令牌刷新）没有 */
  origin?: { conversation_id: string; run_id?: RunId; message_ref?: string }
  trigger:
    | { kind: 'once'; at: Iso8601 }
    | { kind: 'interval'; every_ms: number; from?: Iso8601 }
    | { kind: 'cron'; expr: string; tz: string }
    | { kind: 'after_event'; event: string }
  /** 到点起 RunRequest（Agent 设的）；系统巡检用 handler + params 代替 */
  action?: Partial<RunRequest> & { kind: RunRequest['kind'] }
  handler?: string
  params?: unknown
  context_policy?: 'resume_conversation' | 'fresh_with_summary'
  state: 'pending' | 'active' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  created_by: 'user' | 'agent' | 'system'
  approval?: string
  misfire_policy: 'run_once_now' | 'skip'
  /** 判"错过"还是"刚到点"的那条线；缺省 5 分钟 */
  misfire_grace_ms?: number
  /** 同一任务不重入（进程内 + 重启后接管） */
  lease?: { holder: string; until: Iso8601 }
  next_fire_at?: Iso8601
  last_fire_at?: Iso8601
  fire_count: number
  last_result?: string
  created_at?: Iso8601
  updated_at?: Iso8601
}

export interface Scheduler {
  schedule(task: Omit<ScheduledTask, 'id' | 'fire_count'>): Promise<ScheduledTask>
  cancel(id: string): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  list(filter: {
    workspace_id: WorkspaceId
    owner?: PersonId
    role_id?: RoleId
    conversation_id?: string
  }): Promise<ScheduledTask[]>
  /** 由调度循环调用：返回到点的任务并推进 next_fire_at；错过的按 misfire_policy */
  tick(now: Iso8601): Promise<{ fired: ScheduledTask[]; misfired: ScheduledTask[] }>
}

/** 25 §1 流程（v1：内存状态机 + 合成时钟；Inngest 后置） */
export type WorkflowStepKind =
  | 'run'
  | 'approval'
  | 'wait_event'
  | 'sleep'
  | 'action'
  | 'branch'
  | 'human_task'
export interface WorkflowDef {
  id: string
  version: string
  name: string
  role_id: RoleId
  steps: WorkflowStep[]
  /** 25 §1：按步骤 id 的补偿动作 */
  compensation?: Record<string, WorkflowStep>
  /** 任一命中即停（邮件序列"任一回复即停"） */
  stop_on?: string[]
  /** 超期只记事件，不自动杀实例 */
  sla?: { total_days: number }
}
export interface WorkflowStep {
  id: string
  kind: WorkflowStepKind
  params: unknown
  retry?: { max: number; backoff_ms: number }
  on_fail?: 'retry' | 'compensate' | 'escalate' | 'skip'
}
export interface WorkflowInstance {
  id: string
  def: { id: string; version: string }
  workspace_id: WorkspaceId
  role_id: RoleId
  subject: ObjectRef
  conversation_id?: string
  state: 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'compensated' | 'cancelled'
  cursor: string
  history: {
    step_id: string
    at: Iso8601
    result: unknown
    outcome?: 'ok' | 'failed' | 'skipped' | 'compensated'
    attempt?: number
  }[]
  /** 在等什么（事件 / 审批 / 人工任务 / 睡眠 / 重试）与等到什么时候 */
  waiting?: {
    reason: 'event' | 'approval' | 'human_task' | 'sleep' | 'retry'
    until?: Iso8601
    key?: string
  }
  attempts?: Record<string, number>
  started_at: Iso8601
}
export interface WorkflowEngine {
  start(
    def: WorkflowDef,
    subject: ObjectRef,
    ctx: { workspace_id: WorkspaceId; conversation_id?: string },
  ): Promise<WorkflowInstance>
  signal(instance_id: string, event: { type: string; payload?: unknown }): Promise<WorkflowInstance>
  status(instance_id: string): Promise<WorkflowInstance | undefined>
  pause?(instance_id: string): Promise<void>
  resume?(instance_id: string): Promise<void>
  cancel?(instance_id: string): Promise<void>
  list?(filter: {
    workspace_id: WorkspaceId
    state?: WorkflowInstance['state']
  }): Promise<WorkflowInstance[]>
  /** 由调度循环调用：唤醒到点的 sleep / 超时的 wait */
  tick?(now: Iso8601): Promise<void>
}
