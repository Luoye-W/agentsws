import type { AssignmentId, Iso8601, Money, ObjectRef, PersonId, RiskClass, RoleId, RunId, WorkspaceId } from './common.js'

/** 15 §2 变更种类目录（v1）。新增 kind 必须同时给 risk_class、默认 caps、硬约束与合成 executor。 */
export type ChangeKind =
  | 'refund' | 'reship' | 'address_change' | 'discount_code' | 'price_change' | 'listing_edit'
  | 'publish_product' | 'unpublish_product' | 'promotion' | 'campaign_send' | 'publish_post'
  | 'bid_change' | 'budget_change' | 'create_campaign' | 'pause_ad' | 'negative_keyword'
  | 'publish_theme' | 'merge_pr' | 'deploy' | 'dns_change' | 'payment_config' | 'tax_config' | 'domain_config'

export type ChangeStatus =
  | 'staged' | 'approved' | 'auto_approved' | 'applying' | 'applied' | 'unknown'
  | 'failed' | 'expired' | 'withdrawn' | 'superseded' | 'reversed'

export interface GuardrailHit { rule: string; cap?: number | string; actual?: number | string; severity: 'review' | 'block' }
export interface GuardrailResult {
  verdict: 'allow' | 'require_review' | 'block'
  hits: GuardrailHit[]
  effective_mandate_hash: string
  evaluated_at: Iso8601
  /** 15 §3.2（09-08）：软额度已被人批准的例外，apply 不再因它失败 */
  approved_exception?: boolean
}

/** 14 §4（09-08）：批准绑定的不可变执行快照 */
export interface ExecutionSnapshot { hash: string; components: Record<string, string> }

export interface ApplyError { code: 'stale_record' | 'guardrail' | 'provider_error' | 'policy_tightened' | 'not_approved' | 'snapshot_mismatch' | 'unknown_outcome'; message: string; retryable: boolean }

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
    by_executor: string; at: Iso8601; idempotency_key: string; execution_id?: string
    outcome_ref?: ObjectRef; error?: ApplyError
  }
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
export interface AuthorizationCheckResult { ok: boolean; reason?: string }

export interface ChangeLedger {
  stage(input: Omit<StagedChange, 'id' | 'status' | 'guardrail' | 'created_at' | 'updated_at' | 'expires_at'>): Promise<StagedChange>
  get(id: string): Promise<StagedChange | undefined>
  list(filter: { workspace_id: WorkspaceId; target?: ObjectRef; kind?: ChangeKind; status?: ChangeStatus[]; run_id?: RunId; since?: Iso8601 }): Promise<StagedChange[]>
  approve(id: string, by: PersonId | 'mandate', approval_item_id: string, snapshot: ExecutionSnapshot): Promise<StagedChange>
  apply(id: string, executor: string): Promise<StagedChange>
  withdraw(id: string, by: PersonId): Promise<StagedChange>
  reverse(id: string, by: PersonId): Promise<StagedChange>
}

export interface GuardrailEvaluator {
  evaluate(change: Pick<StagedChange, 'kind' | 'target' | 'field' | 'before' | 'after' | 'money' | 'change_set_id' | 'workspace_id' | 'assignment_id'>, ctx: { at: Iso8601; phase: 'stage' | 'apply' }): Promise<GuardrailResult>
  authorizationCheck(input: AuthorizationCheckInput): Promise<AuthorizationCheckResult>
}
