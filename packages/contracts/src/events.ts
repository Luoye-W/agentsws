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
  | 'simulation.sampling_review'
  | 'simulation.reconciled'
  | 'simulation.process_restarted'
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
  // WP44：Shopify 深度接入——老 shpat 连接标 legacy；主题 CLI 只记命令名与退出码；GraphQL 校验结果
  | 'connect.legacy_connection_detected'
  | 'shopify.theme_command'
  | 'shopify.theme_pushed'
  | 'shopify.theme_published'
  | 'shopify.theme_dev_started'
  | 'shopify.theme_cli'
  | 'shopify.graphql_rejected'
  | 'shopify.graphql_unvalidated'
  | 'shopify.devmcp_started'
  | 'shopify.devmcp_unavailable'
  // WP46：活数据源——只记条数 / 页数 / 耗时 / 失败原因码，订单原文不进事件
  | 'data.refreshed'
  | 'data.refresh_failed'
  // WP47：范围模型（44）——品牌（范围组）与产品线的增删改；payload 只有 id / 名字 / 成员条数
  | 'range_group.created'
  | 'range_group.updated'
  | 'range_group.deleted'
  | 'product_line.created'
  | 'product_line.updated'
  | 'product_line.deleted'
  /** 44 G5：品牌组成员变了，挂了它的岗位范围自动跟着变——**变更必须留痕**（40 §1 的底线）。 */
  | 'assignment.range_expanded'
  // WP50：个人用 → 公司用（45）。合并与别名都留痕；payload 只有 id / 名字 / 条数，不含成员内容
  /** 45 H3：两条品牌合成一条（公司那份取并集，个人那份 `superseded_by`）。 */
  | 'range_group.merged'
  /** 45 H3：两条产品线合成一条。 */
  | 'product_line.merged'
  /**
   * 45 H3：一条岗位范围因为别名被改指到公司那份，或退出公司时别名断开恢复个人那份。
   * payload 带 `from` / `to` / `direction`（`to_company` | `back_to_personal`）。
   */
  | 'range.alias_resolved'
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
  // WP42：价目表刷新（只记条数与来源）
  | 'pricing.refreshed'
  // privacy (21)
  | 'privacy.erased'
  // meetings (37 §4)：payload 只有摘要与条数，转写与音频永不进日志
  | 'meeting.record.ingested'
  | 'meeting.record.blocked'
  | 'meeting.record.transcribed'
  | 'meeting.record.processed'
  | 'meeting.record.failed'
  // 工作模型 (37 §2)：摘要级，正文永不进日志（正文在事项时间线里）
  | 'todo.created'
  | 'todo.updated'
  | 'todo.done'
  | 'todo.dropped'
  | 'matter.opened'
  | 'matter.closed'
  | 'matter.message'
  // 恢复先对账（WP34 B）：payload 只有条数与结论
  | 'reconcile.started'
  | 'reconcile.finished'
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
    /** 续传游标：ulid 严格递增，`id > since`。 */
    since?: EventId
    /** 时间下界（ISO-8601，闭区间，`at >= since_at`）；与 `since` 可同时给，取交集。 */
    since_at?: Iso8601
    /** 时间上界（ISO-8601，闭区间，`at <= until_at`）。 */
    until_at?: Iso8601
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope>
  /** 21 §1：回放一次运行，重组模型输入（17 用例 1） */
  replayRun(run_id: RunId): AsyncIterable<EventEnvelope>
}
