import type { EventId, Iso8601, ObjectRef, RunId, WorkspaceId } from './common.js'

/** 事件日志信封（21 §1）。append-only；写永远最新版；payload 已脱敏，秘密从不进。 */
export interface EventEnvelope<T extends string = string, P = unknown> {
  id: EventId
  schema_version: number
  workspace_id: WorkspaceId
  type: T
  at: Iso8601
  actor: { kind: 'person' | 'agent' | 'system' | 'sentinel'; id: string; run_id?: RunId }
  subject?: ObjectRef
  correlation: {
    trace_id: string
    run_id?: RunId
    work_item_id?: string
    change_id?: string
    execution_id?: string
  }
  payload: P
  payload_encrypted?: { key_id: string; blob: string }
  prev_hash?: string
}

/** 已定义的事件类型名（14 §10、15 §7、17 §2、19 §6、24 §5、25 §5、22 §3）。新增事件加在这里。 */
export type KnownEventType =
  // approval (14)
  | 'approval.created'
  | 'approval.blocked'
  | 'approval.routed'
  | 'approval.delivered'
  | 'approval.claimed'
  | 'approval.escalated'
  | 'approval.decided'
  | 'approval.auto_approved'
  | 'approval.sampled'
  | 'approval.applying'
  | 'approval.applied'
  | 'approval.apply_failed'
  | 'approval.expired'
  | 'approval.withdrawn'
  | 'approval.superseded'
  // changes (15)
  | 'change.staged'
  | 'change.blocked'
  | 'change.approved'
  | 'change.applying'
  | 'change.applied'
  | 'change.unknown'
  | 'change.failed'
  | 'change.expired'
  | 'change.withdrawn'
  | 'change.superseded'
  | 'change.reversed'
  | 'guardrail.hit'
  // run (17)
  | 'run.started'
  | 'context.injected'
  | 'prompt.assembled'
  | 'text.delta'
  | 'tool.call'
  | 'tool.result'
  | 'proposal.created'
  | 'ui'
  | 'ui.partial'
  | 'progress'
  | 'budget.warning'
  | 'budget.exhausted'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  // model (22)
  | 'model.usage'
  | 'model.blocked_residency'
  | 'model.provider_down'
  | 'model.budget_frozen'
  // knowledge (19)
  | 'knowledge.card.proposed'
  | 'knowledge.card.activated'
  | 'knowledge.card.retired'
  | 'knowledge.card.conflict'
  | 'knowledge.card.recalled'
  | 'knowledge.card.cited'
  | 'knowledge.gap.opened'
  | 'knowledge.gap.answered'
  // simulation (26)：RunRequest 落日志，回放据此重组 prompt
  | 'simulation.run_request'
  // delivery / notification (18)
  | 'notification.sent'
  // connect (08/18)：payload 只带 token 指纹，永不带原文
  | 'connect.token_issued'
  | 'connect.tokens_revoked'
  | 'connect.executed'
  | 'connect.execute_failed'
  | 'connect.proxy_denied'
  | 'connect.connection_started'
  | 'connect.connection_established'
  | 'connect.connection_transferred'
  // WP20：表单直填只记字段名；试连只记 ok / reason
  | 'connect.form_submitted'
  | 'connect.connection_removed'
  | 'connect.connection_tested'
  // WP24：问 AI 只记哈希；急停变更
  | 'ask.answered'
  | 'halt.changed'
  // WP28：成员与邀请（token 只记指纹）
  | 'invitation.created'
  | 'invitation.accepted'
  | 'membership.removed'
  // schedule / workflow (25 §5, WP27)
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.fired'
  | 'schedule.failed'
  | 'schedule.misfired'
  | 'schedule.paused'
  | 'schedule.resumed'
  | 'schedule.deleted'
  | 'workflow.started'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  | 'workflow.waiting'
  | 'workflow.failed'
  | 'workflow.compensated'
  | 'workflow.done'
  | 'workflow.cancelled'
  // WP31：本机秘密库密钥轮换（payload 只有时间与条数）
  | 'secrets.key_rotated'
  // privacy (21)
  | 'privacy.erased'
  // meetings (37 §4)：payload 只有摘要与条数，转写与音频永不进日志
  | 'meeting.record.ingested'
  | 'meeting.record.blocked'
  | 'meeting.record.transcribed'
  | 'meeting.record.processed'
  | 'meeting.record.failed'
  // inbound / delivery (18)
  | 'inbound.received'
  | 'inbound.deduped'
  | 'inbound.dead_letter'
  | 'delivery.sent'
  | 'delivery.failed'

export interface EventLog {
  append<T extends string, P>(
    e: Omit<EventEnvelope<T, P>, 'id' | 'at'>,
  ): Promise<EventEnvelope<T, P>>
  read(filter: {
    workspace_id: WorkspaceId
    since?: EventId
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope>
  /** 21 §1：回放一次运行，重组模型输入（17 用例 1） */
  replayRun(run_id: RunId): AsyncIterable<EventEnvelope>
}
