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
  /**
   * WP53：真环境记录源真的跑了一次工具（17 §2 的 `tool.result` 之外多这一条）。
   * payload 只有 `tool` / `status` / `duration_ms` / `provenance` 条数 / 失败原因码，
   * **订单内容一个字节都不进**（21 §1）。
   */
  | 'tool.executed'
  /** WP53：31 §3.3 的联系人台账里多认识了一个人；payload 只有不可逆的 id 与来路。 */
  | 'contact.noted'
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
  /**
   * 47 J2 / J3：检索命中了一条**历史案例**（带"当时"时间戳的旧状态），
   * 而这次运行问的是"现在怎么样"。Agent 以操作层为准回答，同时把这条知识标出来
   * ——它该更新了。24 的学习回路吃这条对应的 `knowledge_update` 卡。
   */
  | 'knowledge.card.stale'
  | 'knowledge.card.cited'
  | 'knowledge.gap.opened'
  | 'knowledge.gap.answered'
  // WP56（48 §4 #6 知识溯源链）：源页 / 文档内容变了之后的那条链。
  // `knowledge.card.stale` 复用上面那条（47 J2 与源页复核是同一个意思：这条别当"现在"用）。
  /** 复核完了（或受管辖数值压根没变）→ 这张卡回鲜，`last_verified_at` 往前走。 */
  | 'knowledge.card.refreshed'
  /** 开了一张复核卡（`knowledge_update` 的 recheck 形态，三选一）。 */
  | 'knowledge.recheck.opened'
  /** 有人答了那张复核卡：确认没变 / 按新值更新 / 忽略。 */
  | 'knowledge.recheck.resolved'
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
  /*
   * WP51（46）：首次设置与同事发现。
   *
   * 三条纪律写在 payload 里：`workspace.profile_set` 只记**归一化后的哈希**与有没有域名，
   * 全称不进日志；`discovery.peer_seen` 只有对方的 peer_id 与主机端口，没有成员名单；
   * 邀请码同样只记指纹（`code_sha256` 的前若干位），明文只出现在 owner 手里那一次。
   */
  | 'workspace.profile_set'
  | 'discovery.enabled'
  | 'discovery.disabled'
  | 'discovery.peer_seen'
  | 'invite.created'
  | 'invite.redeemed'
  | 'membership.requested'
  | 'membership.approved'
  | 'membership.rejected'
  /*
   * WP65（52 O1）：品牌是顶层——公司 = 组织，品牌 = 工作区。
   *
   * `organization.created` 的 payload 与 `workspace.profile_set` 同一条纪律：
   * 只记归一化后的 `company_key` 与有没有域名，公司全称不进日志。
   * `brand.created` 只记新品牌的 `workspace_id` 与它挂在哪个组织下——品牌名是
   * 用户起的名字，与公司名同级，一样不进日志。
   *
   * 切品牌（`brand.switched`）**不在这里**：它是客户端的一次导航，不改任何数据，
   * 不该占内核日志的一行（52 §4）。
   */
  | 'organization.created'
  | 'brand.created'
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
  /*
   * WP58（49 M1）：本地工作区与云账号的关联。**本地事件**，不是云侧的。
   *
   * payload 只有邮箱**域名**与云侧组织 id（见 `CloudAccountLinkedPayload`）：
   * 令牌明文与哈希、邮箱本地部分一个字节都不进（21 §1）。
   */
  | 'cloud.account_linked'
  | 'cloud.account_unlinked'
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
  // WP57（48 §4 L3 #11）：网站在线聊天。入站仍用 `inbound.*`（同一条管线），
  // 这三条记的是聊天独有的那几件事：一轮判了什么、人接管了、求助超时怎么处理的
  | 'chat.turn_planned'
  | 'chat.takeover_changed'
  | 'chat.assist_timeout'
  // WP57：商家在聊天里「教 AI」之后沉淀下来的知识候选（承诺类永不自动发布，19）
  | 'knowledge.candidate_created'
  // WP54（48 v2 L1）：职责改名 / 合并之后，已有分配在启动时迁到新 id。
  // payload 只有分配 id、人、旧 id、新 id、迁过去的职责版本——改名也是一次变更，必须留痕。
  | 'assignment.role_migrated'
  // WP55（48 §4 L3 #2–#5）：客服安全边界四件套。payload 一律只有结论与计数，
  // 正文、relay 地址、凭据永不进日志。
  /** Amazon 24h 响应线的三档（提醒 / 升级 / 闭账）。 */
  | 'support.amazon_sla'
  /** 三道门的结论（只记门名与 pass / fail / gate_error，不记被扫的文本）。 */
  | 'guardrail.gate_decided'
  /** 出站 outbox 的状态迁移（prepared → sending → accepted → confirmed / …）。 */
  | 'outbound.state_changed'
  /** `sent_unknown` 的对账结论（找到证据 / 没找到 / 退避次数耗尽）。 */
  | 'outbound.reconciled'
  /** 邮箱加固：毒消息隔离、扫描租约被别人占着、归档文件夹动不了。 */
  | 'inbound.folder_fault'
  /** 死信被人重投回队列。 */
  | 'inbound.requeued'

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
