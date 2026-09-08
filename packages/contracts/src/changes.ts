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
  | 'price_change'
  | 'listing_edit'
  | 'publish_product'
  | 'unpublish_product'
  | 'promotion'
  | 'campaign_send'
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
