import type { ExecutionSnapshot } from './changes.js'
import type {
  AssignmentId,
  Iso8601,
  Level,
  ObjectRef,
  PersonId,
  RangeRef,
  RoleId,
  RunId,
  WorkspaceId,
} from './common.js'

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

export interface ApprovalItem<P = unknown> {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  kind: ApprovalKind
  revision: number
  role_id: RoleId
  range?: RangeRef[]
  subject: { object: ObjectRef; work_item_id?: string; conversation_id?: string }
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
  execution_snapshot?: ExecutionSnapshot
  /** 快照分量来源与门禁输入（09-09 WP4） */
  execution_context?: {
    connection_id?: string
    record_version?: string
    attachments?: string[]
    mandate_hash?: string
    change_id?: string
    thread_participants?: string[]
    verified_contacts?: string[]
    precheck_overrides?: Partial<PrecheckResult>
  }
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
  via: Decision['via']
}

export interface ApprovalBus {
  create<P>(
    input: Omit<
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
      /** auto_approved / sampling 由宿主计算，调用方只给等级 */
      automation?: Partial<ApprovalItem['automation']> & {
        level_at_creation: ApprovalItem['automation']['level_at_creation']
      }
    },
  ): Promise<ApprovalItem<P>>
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
