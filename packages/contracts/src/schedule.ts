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

/** 13 §1.3 / 25 §3 定时任务：与会话、职责绑定；AI 可设人可管。 */
export interface ScheduledTask {
  id: string
  workspace_id: WorkspaceId
  owner: PersonId
  role_id: RoleId
  assignment_id: AssignmentId
  origin: { conversation_id: string; run_id?: RunId; message_ref?: string }
  trigger:
    | { kind: 'once'; at: Iso8601 }
    | { kind: 'cron'; expr: string; tz: string }
    | { kind: 'after_event'; event: string }
  action: Partial<RunRequest> & { kind: RunRequest['kind'] }
  context_policy: 'resume_conversation' | 'fresh_with_summary'
  state: 'pending' | 'active' | 'paused' | 'done' | 'failed'
  created_by: 'user' | 'agent'
  approval?: string
  misfire_policy: 'run_once_now' | 'skip'
  next_fire_at?: Iso8601
  last_fire_at?: Iso8601
  fire_count: number
  last_result?: string
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
  steps: {
    id: string
    kind: WorkflowStepKind
    params: unknown
    on_fail?: 'retry' | 'compensate' | 'escalate' | 'skip'
  }[]
}
export interface WorkflowInstance {
  id: string
  def: { id: string; version: string }
  workspace_id: WorkspaceId
  role_id: RoleId
  subject: ObjectRef
  conversation_id?: string
  state: 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'compensated'
  cursor: string
  history: { step_id: string; at: Iso8601; result: unknown }[]
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
}
