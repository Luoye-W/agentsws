import type { ApprovalItem } from './approval.js'
import type {
  AssignmentId,
  Iso8601,
  Money,
  ObjectRef,
  PersonId,
  RiskClass,
  RoleId,
  RunId,
  WorkspaceId,
} from './common.js'

/** 15 §2 变更种类目录（v1）。新增 kind 必须同时给 risk_class、默认 caps、硬约束与合成 executor。 */
export type ChangeKind =
  | 'refund'
  | 'reship'
  | 'address_change'
  | 'discount_code'
  /** WP17：安抚补偿（店铺余额 / 补发优惠券），与营销发码分开计额度 */
  | 'goodwill_credit'
  | 'price_change'
  | 'listing_edit'
  | 'publish_product'
  | 'unpublish_product'
  | 'promotion'
  | 'campaign_send'
  /**
   * WP64（51 §2.3）：邮件营销的分群规则改动（谁进这个人群、谁出去）。
   * 它自己不发信，所以不是 `campaign_send`；但改错了下一次发送就发给错的人，因此照样进账本。
   */
  | 'segment_edit'
  /**
   * WP64（51 §2.3）：自动流（弃购 / 复购）的开关与文案。
   *
   * **触发条件不在 Agent 手里**：放宽一次触发条件等于把一整条流悄悄发给多得多的人，
   * 而它在账本上看起来只是"改了一条流"。硬规则在 `@agentsws/core` 的 guardrail 里。
   */
  | 'flow_edit'
  /** WP64（51 §2.4）：标记发货 + 回填物流单号（Shopify `fulfillmentCreate`）。 */
  | 'create_fulfillment'
  /** WP64（51 §2.4）：拆单——一张订单分几个包裹分别发。 */
  | 'split_order'
  /**
   * WP64（51 §2.4）：取消订单。
   *
   * 连带退款与库存回补，而且**不可逆**——15 §2 的 `HARD_L1` 里有它，永远人审。
   */
  | 'cancel_order'
  | 'publish_post'
  | 'bid_change'
  | 'budget_change'
  | 'create_campaign'
  | 'pause_ad'
  | 'negative_keyword'
  | 'publish_theme'
  | 'merge_pr'
  | 'deploy'
  | 'dns_change'
  | 'payment_config'
  | 'tax_config'
  | 'domain_config'
  /**
   * WP63（51 §2.1 商品管理）：库存**直接设定或加减**。
   *
   * 它既不是 `listing_edit`（不改商品信息）也不是 `price_change`，而且改错会当场超卖——
   * 所以它必须有自己的额度（`max_inventory_adjust`）。`after.mode` 分两种：
   * `adjust` 是在现有数量上加减（收货 / 报损），额内可自动；`set` 是盘点后直接写一个数，
   * **永远人审**（把一个仓写成 0 和写成 1000 在 API 上是同一次调用）。
   */
  | 'inventory_adjust'
  /**
   * WP63（51 §2.1 商品管理）：集合增删商品 / 改集合本身。
   *
   * 从 `listing_edit` 里分出来，因为影响面不同：改一件商品的文案只影响那一件，
   * 往「首页精选」里塞或拿掉一件商品，改的是整家店的货架。
   */
  | 'collection_edit'
  /** WP63（51 §2.1 评价管理）：公开回复一条评价（草稿，批了才发）。 */
  | 'review_reply'
  /** WP63（51 §2.1 评价管理）：给订单发邀评（合规词表 + 每日上限）。 */
  | 'review_invite'
  /**
   * WP67（48 §5.1）：给红人发一封开发信（`outbound_message` 的一种）。
   *
   * **不进 `HARD_L1`**：开发信是 L2 起、采纳率够了可以升 L3——它是一封"你好，
   * 我们想聊聊合作"，发错了道个歉就过去了，跟群发给几万顾客不是一个量级。
   * 真正不许越的那条线是**禁承诺**：正文里不许出现"我们付你 X 美元"
   * "样品免费寄"这类话，由 guardrail 的禁承诺词表当场 block
   * （不是转人审——这种句子不该有"人点一下就发出去"的路径，同 51 §2.1 的邀评）。
   * 日配额（`max_outreach_per_day`）与退订 / 抑制名单走的是与客服出站、
   * 邮件营销**同一份**规则（`@agentsws/core` 的 suppression.ts）。
   */
  | 'kol_outreach'
  /**
   * WP67（48 §5.1）：建一条合作 / 改合作预算。
   *
   * **永远 L1**（15 §2 的 `HARD_L1` 里有它）。理由跟采纳率无关：合作是一笔钱和
   * 一纸条款，采纳率证明得了"这个 Agent 挑人挑得准"，证明不了"这个价该给"。
   */
  | 'kol_collaboration'
  /** WP67（48 §5.1）：交付物的审核结论（通过 / 要求改 / 拒收）。L2。 */
  | 'kol_deliverable_review'
  /** WP67（48 §5.1）：发一个联盟折扣码。L2，且折扣率有上限（`max_affiliate_discount_pct`）。 */
  | 'kol_affiliate_code'
  /** WP67（48 §5.1）：建一条带 UTM 的追踪链接。L3——它不动钱也不发信，只是给链接加参数。 */
  | 'kol_tracked_link'
  /**
   * WP72（56 §2 内容组）：发一条内容 / 排一条内容。
   *
   * **永远 L1**（15 §2 的 `HARD_L1` 里有它）。理由与 `campaign_send` 同一条：
   * 发出去收不回来，而且看的是**外人**不是同事——一条发错的帖子在被删掉之前
   * 已经被截图了。排期与立发是同一条 kind：一条排在明天早上八点的帖子，
   * 到点之后没有第二道门，所以门必须在**排**的时候。
   */
  | 'social_post'
  /**
   * WP72（56 §2 内容组）：改账号资料（简介、头像、置顶、主页链接）。L1。
   *
   * 它不发内容，但它改的是**所有人点进来第一眼看到的东西**，而且改完没有"撤回"。
   * 账号名（handle）更狠：一改，旧帖里的链接与所有外部引用一起断——
   * 所以它在受保护字段里，Agent 提都不许提。
   */
  | 'social_profile_edit'
  /**
   * WP72（56 §2 社群组）：批 / 拒一条入群申请，或把人移出群。L2。
   *
   * L2 而不是 L1：批错一个人，踢出去就是了；额度（`max_member_approvals_per_day`）
   * 挡的是"一口气把 300 个申请全批了"那一下。
   */
  | 'community_membership'
  /**
   * WP72（56 §2 社群组）：群发 / 广播（群公告、频道推送、WhatsApp 模板消息）。
   *
   * **永远 L1**（15 §2 的 `HARD_L1` 里有它）。与 `campaign_send` 逐字同理，
   * 外加两条社群特有的硬闸（`@agentsws/core` 的 guardrail）：不报
   * `suppression_checked` 就 block；WhatsApp 少 `template_id` 或
   * `opt_in_verified !== true` 就 block——那两条不是额度，是平台会封号的事。
   */
  | 'community_broadcast'
  /**
   * WP72（56 §2 社群组）：改群规。L1。
   *
   * 群规是这个群的法律。放宽一条（"允许发链接"）等于把垃圾闸门打开，
   * 而它在账本上看起来只是"改了一段文字"——同 `flow_edit` 那条理由。
   */
  | 'community_rules'
  /**
   * WP72（56 §2 社群组）：管理动作——删帖 / 禁言 / 封禁。
   *
   * **按 `after.action` 分档**（56 §2 那一格）：删帖与禁言 L2（做错了改得回来），
   * 封禁 L1（把一个人从你自己的社群里永久赶出去，这件事该由人点）。分档在
   * guardrail 的 switch 里，不在这条 kind 上——同 `publish_post` 按
   * `after.published` 分档的老办法。
   */
  | 'community_moderation'
  /**
   * WP76（58 §1）：**向设计岗下一张需求单**。L3。
   *
   * 它不出图、不花钱、不对外发一个字——它做的事是"把一件事从我这条职责交到
   * 设计岗手上"（54：开一个事项并路由过去）。所以它是四条里最轻的一条：
   * 下错了，设计岗那边关掉就是了。写成 ChangeKind 而不是一个普通动作，
   * 是为了让它进变更账本——面板上"这周社媒给设计下了几张单"要数得出来。
   */
  | 'design_request'
  /**
   * WP76（58 §1）：需求单 → brief（目标 / 受众 / 尺寸 / 文案 / 禁忌 + 变体计划）。L3。
   *
   * L3 自动是因为 brief **不产生任何外部可见的东西**：它是一段给人看的文字，
   * 看完不合适改一句就是了。真正要人点的是后面两条。
   */
  | 'design_brief'
  /**
   * WP76（58 §1）：调图片模型出变体初稿。L2——**出卡给人挑**。
   *
   * 两条硬规矩在 `@agentsws/core` 的 guardrail 里：一次要几张（`n`）不许超过
   * `max_variants_per_brief`（58 §6 默认 6），提示词里带品牌禁忌词当场 **block**
   * （不是转人审——那种提示词不该有"人点一下就发给模型"的路径，同邀评词表）。
   */
  | 'design_variant'
  /**
   * WP76（58 §1）：把人选定的那一张入素材库并回给需求方。
   *
   * **永远 L1**（15 §2 的 `HARD_L1` 里有它）。理由是 04 §6 那条纪律本身：
   * Agent 出 brief、规格、变体与初稿，**视觉决定永远是人**。入库 = 这张图
   * 从此代表这个品牌出现在顾客面前，而且下游（Amazon 上架、社媒发布、投放）
   * 直接拿它去用。放在硬顶而不是只写在职责 yml 的 `ceiling: L1` 里：
   * yml 可以被工作区策略放宽，硬顶不行（15 §2）。
   */
  | 'asset_publish'

export type ChangeStatus =
  | 'staged'
  | 'approved'
  | 'auto_approved'
  | 'applying'
  | 'applied'
  | 'unknown'
  | 'failed'
  | 'expired'
  | 'withdrawn'
  | 'superseded'
  | 'reversed'

export interface GuardrailHit {
  rule: string
  cap?: number | string
  actual?: number | string
  severity: 'review' | 'block'
}
export interface GuardrailResult {
  verdict: 'allow' | 'require_review' | 'block'
  hits: GuardrailHit[]
  effective_mandate_hash: string
  evaluated_at: Iso8601
  /** 15 §3.2（09-08）：软额度已被人批准的例外，apply 不再因它失败 */
  approved_exception?: boolean
}

/** 14 §4（09-08）：批准绑定的不可变执行快照 */
export interface ExecutionSnapshot {
  hash: string
  components: Record<string, string>
}

export interface ApplyError {
  code:
    | 'stale_record'
    | 'guardrail'
    | 'provider_error'
    | 'policy_tightened'
    | 'not_approved'
    | 'snapshot_mismatch'
    | 'unknown_outcome'
    | 'provenance_missing'
    | 'authorization_check_failed'
  message: string
  retryable: boolean
}

export interface StagedChange {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  role_id: RoleId
  assignment_id: AssignmentId
  run_id: RunId
  change_set_id: string
  kind: ChangeKind
  risk_class: RiskClass
  target: ObjectRef
  field?: string
  before: unknown
  after: unknown
  record_version?: string
  money?: Money & { margin_before_pct?: number; margin_after_pct?: number }
  guardrail: GuardrailResult
  guardrail_rerun?: GuardrailResult
  reservation?: { counter: string; amount: number; released?: boolean }
  execution_snapshot?: ExecutionSnapshot
  notes: string[]
  created_by: { kind: 'agent' | 'person'; id: string }
  status: ChangeStatus
  approval?: { item_id: string; by: PersonId | 'mandate'; at: Iso8601 }
  apply?: {
    by_executor: string
    at: Iso8601
    idempotency_key: string
    execution_id?: string
    outcome_ref?: ObjectRef
    error?: ApplyError
  }
  /** 15 §3.2（09-09）：软额度已被人批准的例外，apply 不因它失败 */
  approved_exception?: boolean
  reversal_of?: string
  expires_at: Iso8601
  created_at: Iso8601
  updated_at: Iso8601
}

/** 15 §6 Provenance：只证明"读过"，不证明"有权"。 */
export interface ProvenanceState {
  run_id: RunId
  seen: Record<string, string[]>
  read_full: string[]
  recorded_at: Iso8601
}

/** 15 §6.1（09-08）关系授权门禁的输入 */
export interface AuthorizationCheckInput {
  kind: ChangeKind
  requester: { channel: string; external_id: string; resolved?: ObjectRef }
  target: ObjectRef
  target_owner?: ObjectRef
}
export interface AuthorizationCheckResult {
  ok: boolean
  reason?: string
}

/** 15 §5：stage 的输入——mandate / 等级 / provenance / 请求者由调用方（执行器运行时）给 */
export interface StageInput {
  workspace_id: WorkspaceId
  role_id: RoleId
  assignment_id: AssignmentId
  run_id: RunId
  change_set_id: string
  kind: ChangeKind
  target: ObjectRef
  field?: string
  before: unknown
  after: unknown
  record_version?: string
  money?: StagedChange['money']
  notes?: string[]
  created_by: StagedChange['created_by']
  /** 关系授权门禁输入（refund / reship / address_change 必填） */
  requester?: AuthorizationCheckInput['requester']
  target_owner?: ObjectRef
  /** 收件人门禁（outbound）：线程原参与者 / 已验证联系方式 */
  thread_participants?: string[]
  verified_contacts?: string[]
  connection_id?: string
  attachments?: string[]
}

/** block 不建账本条目也不进队列，只返回原因 */
export type StageOutcome =
  | { ok: true; change: StagedChange; approval: ApprovalItem }
  | {
      ok: false
      reason: 'guardrail' | 'authorization_check_failed' | 'provenance_missing'
      guardrail?: GuardrailResult
      message: string
    }

/**
 * 变更账本（09-09 按 31 §1 I8 合并为交易控制模块的一部分）：
 * 批准标记只由审批总线写、apply 只由执行器发起，因此账本上没有 approve / apply。
 */
export interface ChangeLedger {
  stage(input: StageInput): Promise<StageOutcome>
  get(id: string): Promise<StagedChange | undefined>
  list(filter: {
    workspace_id: WorkspaceId
    target?: ObjectRef
    kind?: ChangeKind
    status?: ChangeStatus[]
    run_id?: RunId
    since?: Iso8601
  }): Promise<StagedChange[]>
  withdraw(id: string, by: PersonId): Promise<StagedChange>
  /** 可逆 kind 生成 reversal_of 的 staged 行；走完整审批需再 stage */
  reverse(id: string, by: PersonId): Promise<StagedChange>
}

export type ApplyOutcome = { status: 'applied' | 'failed' | 'unknown'; change: StagedChange }

/** 15 §5 执行器：只有它能真写；三态；同目标同 kind 串行 */
export interface Executor {
  apply(change_id: string, opts?: { force?: boolean }): Promise<ApplyOutcome>
  /** 一条失败不影响其他 */
  applyAll(change_ids: string[]): Promise<ApplyOutcome[]>
  /** unknown 后由对账确认最终结果 */
  reconcile(
    change_id: string,
    outcome: {
      status: 'applied' | 'failed'
      execution_id?: string
      outcome_ref?: ObjectRef
      note?: string
    },
  ): Promise<ApplyOutcome>
  /** 批准后取消窗口内可撤 */
  cancel(change_id: string): Promise<StagedChange>
  /** 含子变更的父项（回信）：所有子 applied 之后才施行父 */
  applyApproval(item_id: string): Promise<ApprovalItem>
}

export interface GuardrailEvaluator {
  evaluate(
    change: Pick<
      StagedChange,
      | 'kind'
      | 'target'
      | 'field'
      | 'before'
      | 'after'
      | 'money'
      | 'change_set_id'
      | 'workspace_id'
      | 'assignment_id'
    >,
    ctx: { at: Iso8601; phase: 'stage' | 'apply' },
  ): Promise<GuardrailResult>
  authorizationCheck(input: AuthorizationCheckInput): Promise<AuthorizationCheckResult>
}
