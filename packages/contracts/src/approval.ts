import type { ExecutionSnapshot } from './changes.js'
import type {
  AssignmentId,
  Iso8601,
  Level,
  ObjectRef,
  PersonId,
  RangeRef,
  RiskClass,
  RoleId,
  RunId,
  WorkspaceId,
} from './common.js'
import type { MatterId, TodoId } from './work.js'

/** 14 §1 审批项种类 */
export type ApprovalKind =
  | 'outbound_draft'
  | 'staged_change'
  | 'knowledge_update'
  | 'skill_promotion'
  | 'skill_lesson'
  | 'claim'
  | 'policy_change'
  | 'home_suggestion'
  | 'scheduled_task'
  | 'app_install'
  | 'app_upgrade'
  | 'app_uninstall'
  | 'upstream_upgrade'
  | 'join_mapping'
  | 'dev_handoff_result'
  /** WP17：本条对话的一次性缺资料提问（去重键带 conversation）；与 policy_change（一答定终身）分开 */
  | 'ai_question'
  /** WP22 / 37 §2.4：早上的每日计划建议卡（选择题：采纳 / 调整 / 稍后）；payload = DailyPlanDraft */
  | 'daily_plan'
  /** WP22 / 37 §2.4：晚上的复盘卡；payload = ReviewDraft，含明天的计划草案 */
  | 'review'

/** 14 §13.2 抽检复核：L2 自动批被抽中后，范围管理者看完说什么（WP32） */
export interface SamplingReview {
  by: PersonId
  at: Iso8601
  verdict: 'ok' | 'issue'
  note?: string
}

export type ApprovalState =
  | 'proposed'
  | 'blocked'
  | 'auto_approved'
  | 'pending'
  | 'in_review'
  | 'approved'
  | 'approved_edited'
  | 'rejected'
  | 'redirected'
  | 'deferred'
  | 'withdrawn'
  | 'expired'
  | 'superseded'
  | 'applying'
  | 'applied'
  | 'apply_failed'

export type DecisionAction =
  | 'approve'
  | 'approve_edited'
  | 'reject'
  | 'redirect'
  | 'defer'
  | 'withdraw'

export interface Diff {
  before: unknown
  after: unknown
  summary?: string
}

export interface PrecheckResult {
  provenance?: 'ok' | 'fail'
  record_read?: 'ok' | 'fail'
  mandate?: 'within' | 'review' | 'block'
  fencing?: 'ok' | 'fail'
  redaction?: 'ok' | 'fail'
  semantic_diff?: 'ok' | 'empty'
  permission_diff?: 'ok' | 'fail'
  eval?: 'ok' | 'fail'
  simulation?: 'ok' | 'fail'
  secret_scan?: 'ok' | 'fail'
  notes?: string[]
}

export interface Recipient {
  person: PersonId
  via: 'role_holder' | 'scope_manager' | 'owner' | 'explicit' | 'escalation'
}

export interface Decision {
  action: DecisionAction
  by: PersonId | 'mandate'
  at: Iso8601
  via: 'workstation' | 'im_card' | 'email' | 'api' | 'batch'
  reason?: string
  edited_payload?: unknown
  edit_diff?: Diff
  redirect_to?: { person_id?: PersonId; role_id?: RoleId }
  defer_until?: Iso8601
  /** 36 §2 选择题卡：人选了哪个改法，落库后异步施行也拿得到（WP29） */
  selected_option_id?: string
  /** 绑定 (item_id, revision, execution_snapshot)；revision 变化即失效；by='mandate' 的自动决定无 token */
  decision_token?: string
}

export interface ApplyRecord {
  attempts: {
    at: Iso8601
    by_executor: string
    idempotency_key: string
    result: 'ok' | 'failed' | 'unknown'
    error?: string
    execution_id?: string
  }[]
  guardrail_rerun?: { passed: boolean; caps_hit: string[] }
  outcome_ref?: ObjectRef
}

export interface Delivery {
  channel: 'workstation' | 'feishu_card' | 'wecom_card' | 'dingtalk_card' | 'email'
  to: PersonId
  sent_at: Iso8601
  external_id?: string
  view: 'full' | 'redacted'
  decision_token: string
  status: 'sent' | 'delivered' | 'acted' | 'expired' | 'failed'
}

/**
 * 一张审批项的**执行上下文**：执行快照的分量来源（14 §4 / 31 §3.2）与门禁输入（31 §3.3）。
 *
 * 落在 `ApprovalItem.execution_context` 上，由 `ApprovalBus.create` 的 `context` 传入。
 * 创建时算一次快照、apply 前按同一份重算——两次算的必须是同一组分量，
 * 所以它不能是宿主实现的私有交叉类型（WP4 的做法），得在契约里（WP24 后置项，WP31 补）。
 */
export interface ApprovalExecutionContext {
  /** 快照分量：这条变更打到哪个连接上 */
  connection_id?: string
  /** 快照分量：目标记录的版本（apply 前重读，变了即 stale_record） */
  record_version?: string
  /** 快照分量：附件哈希（排序后进快照） */
  attachments?: string[]
  /** 快照分量：生效额度的哈希 */
  mandate_hash?: string
  /** `staged_change` 审批项指向的账本条目 */
  change_id?: string
  /** 31 §3.3 收件人门禁：线程原有参与者 */
  thread_participants?: string[]
  /** 31 §3.3 收件人门禁：经验证的客户联系方式 */
  verified_contacts?: string[]
  /** 预检结论覆盖（脱敏等由调用方判定时） */
  precheck_overrides?: Partial<PrecheckResult>
}

export interface ApprovalItem<P = unknown> {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  kind: ApprovalKind
  revision: number
  role_id: RoleId
  range?: RangeRef[]
  subject: {
    object: ObjectRef
    /**
     * 37 §2.2b：`work_item` 的正式形态就是 `Matter`。
     * `matter_id` 是正名后的字段；`work_item_id` 暂留为别名（同一个 id），等调用方都迁完再删。
     */
    matter_id?: MatterId
    /** @deprecated 用 `matter_id`；WP22 起两者同值 */
    work_item_id?: string
    /** 37 §2.1 交点一：待办委托给 Agent，Run 里产生的卡挂回这条待办 */
    todo_id?: TodoId
    conversation_id?: string
  }
  dedupe_key: string
  title: string
  summary: string
  payload: P
  evidence: {
    run_id?: RunId
    source_events: string[]
    provenance: { seen: ObjectRef[] }
    diff?: Diff
    precheck: PrecheckResult
    citations?: { fact_card_id: string; quote: string }[]
  }
  proposer: {
    kind: 'agent' | 'person' | 'sentinel' | 'registry' | 'system'
    id: string
    assignment_id?: AssignmentId
  }
  automation: {
    level_at_creation: Level
    auto_approved: boolean
    mandate_check: { within: boolean; caps_hit: string[] }
    sampling: {
      selected: boolean
      reviewed?: { by: PersonId; at: Iso8601; outcome: 'ok' | 'issue'; note?: string }
    }
  }
  routing: {
    recipients: Recipient[]
    assignee?: PersonId
    explicit?: PersonId
    rule: 'role_holder' | 'scope_manager' | 'owner' | 'explicit' | 'unclaimed'
    escalation: {
      after_hours: number
      business_hours: boolean
      chain: ('scope_manager' | 'owner')[]
      escalated_at: Iso8601[]
    }
    separation_of_duties: boolean
  }
  priority: 'immediate' | 'queue' | 'digest'
  due_at?: Iso8601
  /** 36 §2：选择题卡的选项；有则 approve 必须带 selected_option_id（否则 invalid_input / details.reason='OPTION_REQUIRED'） */
  options?: { id: string; label: string }[]
  /** 卡片档位用；真源仍在变更账本（15） */
  risk_class?: RiskClass
  /** 稍后（snooze）记账；KefuAgent deck 同义 */
  snoozed?: { count: number; until?: Iso8601 }
  execution_snapshot?: ExecutionSnapshot
  /** 快照分量来源与门禁输入（09-09 WP4）；创建时由 `ApprovalBus.create` 的 `context` 给 */
  execution_context?: ApprovalExecutionContext
  state: ApprovalState
  decision?: Decision
  apply?: ApplyRecord
  deliveries: Delivery[]
  links: { parent?: string; children: string[]; supersedes?: string; superseded_by?: string }
  created_at: Iso8601
  updated_at: Iso8601
  expires_at?: Iso8601
}

export interface DecideInput {
  decision_token: string
  action: DecisionAction
  reason?: string
  edited_payload?: unknown
  redirect_to?: { person_id?: PersonId; role_id?: RoleId }
  defer_until?: Iso8601
  /** 36 §2：选择题卡的答案 */
  selected_option_id?: string
  /** 36 §2「指导」：先选作用域再一句话；作用域决定落到本条回复 / 技能 overlay 提案 / 职责策略变更 */
  instruction?: { scope: 'single_reply' | 'similar_cases' | 'global_rule'; text: string }
  /** 乐观并发：与 ApprovalItem.revision 比对 */
  version?: number
  via: Decision['via']
}

/** `ApprovalBus.create` 的入参：宿主负责生成的字段不收，另收一份执行上下文。 */
export type CreateApprovalInput<P> = Omit<
  ApprovalItem<P>,
  | 'id'
  | 'revision'
  | 'state'
  | 'deliveries'
  | 'links'
  | 'created_at'
  | 'updated_at'
  | 'decision'
  | 'apply'
  | 'automation'
> & {
  links?: Partial<ApprovalItem['links']>
  /**
   * **调用方只给 `level_at_creation`**，其余三项由宿主补齐。不是「爱给不给」——
   * 是「宿主保证补上」：WP35 之前宿主只做浅合并，只给等级的卡
   * `automation.mandate_check` 留成 undefined，一路带到工作台投影那步才炸。
   *
   * 宿主补的默认值（`ApprovalBus.create` 的义务）：
   * - `auto_approved: false`——自动通过是 §5 算出来的结论（低风险已建模变更 + 额度内），
   *   调用方声明不算数；
   * - `mandate_check: { within: false, caps_hit: [] }`——**没报过额度就当没核过**，
   *   预检据此判 `mandate: 'review'`，卡走人审；
   * - `sampling: { selected: false }`——抽检由宿主按工作区 `sampling_rate` 掷。
   *
   * 整个 `automation` 都不给时，等级按最严的 `L1`（全人审）算。
   */
  automation?: Partial<ApprovalItem['automation']> & {
    level_at_creation: ApprovalItem['automation']['level_at_creation']
  }
  /**
   * 31 §3.2 / §3.3：执行快照的分量来源与收件人门禁的输入。
   *
   * WP4 把它做成了宿主包（`@agentsws/txn`）的交叉类型，于是「收件人门禁拿什么判」
   * 这件事在契约上看不见——WP24 的合并记录把它列成后置项，这里补上。
   * 宿主收下后原样落在 `ApprovalItem.execution_context`。
   */
  context?: ApprovalExecutionContext
}

export interface ApprovalBus {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
  get(id: string): Promise<ApprovalItem | undefined>
  queue(filter: {
    workspace_id: WorkspaceId
    person_id: PersonId
    lane: 'mine' | 'scope' | 'unclaimed'
    kind?: ApprovalKind
    role_id?: RoleId
    state?: ApprovalState[]
  }): Promise<ApprovalItem[]>
  decide(id: string, by: PersonId, input: DecideInput): Promise<ApprovalItem>
  claim(id: string, by: PersonId): Promise<ApprovalItem>
  release(id: string, by: PersonId): Promise<ApprovalItem>
  withdraw(id: string, by: PersonId): Promise<ApprovalItem>
  retryApply(id: string, by: PersonId): Promise<ApprovalItem>
  /** 14 §8：同 kind 同 role 批量；每条单独记 Decision，一条失败不影响其他 */
  decideBatch(
    entries: { id: string; decision_token: string }[],
    by: PersonId,
    input: Omit<DecideInput, 'decision_token' | 'via'>,
  ): Promise<{ id: string; item?: ApprovalItem; error?: unknown }[]>
  /** 由调度调用：24 工作小时 → scope_manager，48 → owner；加人不换人 */
  escalate(now: Iso8601): Promise<ApprovalItem[]>
  expire(now: Iso8601): Promise<ApprovalItem[]>
  history(id: string): Promise<{ revisions: ApprovalItem[]; events: string[] }>
}
