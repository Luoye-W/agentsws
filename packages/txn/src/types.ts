import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  AuthorizationCheckInput,
  ChangeKind,
  Clock,
  Decision,
  ErrorCode,
  EventEnvelope,
  ExecutionSnapshot,
  Iso8601,
  Level,
  Mandate,
  ObjectRef,
  PersonId,
  ProvenanceState,
  Recipient,
  RoleId,
  RunId,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'

/** 事件出口：形状按 EventEnvelope（21 §1），不依赖 kernel 包。 */
export type EventSink = (e: EventEnvelope) => void | Promise<void>

/** 交易控制模块统一错误（28 §2 的错误码，不自造同义码）。 */
export class TxnError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'TxnError'
  }
}

/** apply 步骤 4：重读目标记录。 */
export interface RecordRead {
  record_version?: string
  record?: unknown
}
export type ReadRecord = (target: ObjectRef) => Promise<RecordRead> | RecordRead

/** apply 步骤 6：真正的写。三态返回（15 §5.8）。 */
export interface BackendResult {
  status: 'ok' | 'failed' | 'unknown'
  execution_id?: string
  outcome_ref?: ObjectRef
  error?: { message: string; retryable?: boolean }
}
export type BackendApply = (
  change: StagedChange,
  opts: { idempotencyKey: string; attempt: number },
) => Promise<BackendResult> | BackendResult
export type DeliverOutbound = (
  item: ApprovalItem,
  opts: { idempotencyKey: string; attempt: number },
) => Promise<BackendResult> | BackendResult

/** 14 §4.2：谁能决定（Assignment 的 approve 操作）、个人工作区成员数、升级链。 */
export interface Directory {
  canApprove?(person: PersonId, item: ApprovalItem): boolean
  memberCount?(workspace_id: WorkspaceId): number
  scopeManager?(item: ApprovalItem): PersonId | undefined
  owner?(item: ApprovalItem): PersonId | undefined
}

export interface TxnPolicy {
  /** 14 §13.2：L2 抽检 10% */
  sampling_rate: number
  /** 31 §3.2：批准后取消窗口，默认 120 秒 */
  cancel_window_sec: number
  /** 14 §4.4：默认 7 天；对外草稿 48h；认领 14 天 */
  expiry_days: { default: number } & Partial<Record<ApprovalKind, number>>
  /** 14 §11.6：24 工作小时 → scope_manager；48 → owner */
  escalation_hours: { scope_manager: number; owner: number }
  /** 工作时间简化：周一至周五 9–18，按该偏移解释工作区 tz */
  business_tz_offset_minutes: number
  /** 15 §5.8：retryable 失败重试 ≤ 3（同 key） */
  retry_max: number
  /** 15 §3.2：累计窗口天数 */
  cumulative_window_days: number
  executor_id: string
  executor_version: string
}

export interface TxnOptions {
  clock: Clock
  random: () => number
  eventSink: EventSink
  store?: TxnStore
  /** 抽检用随机源；缺省复用 random */
  sampler?: () => number
  readRecord?: ReadRecord
  backendApply?: BackendApply
  deliverOutbound?: DeliverOutbound
  directory?: Directory
  /** apply 时的当前生效额度（策略层可能已收紧）；缺省用 stage 时那份 */
  mandateFor?: (change: StagedChange) => Mandate
  policy?: Partial<TxnPolicy>
  /** decision_token 的 HMAC 密钥；缺省由注入的 random 生成 */
  secret?: string
}

/** 14 §7：一次性 decision_token，绑定 (item_id, revision, execution_snapshot.hash)。 */
export interface TokenRecord {
  token: string
  item_id: string
  revision: number
  snapshot_hash: string
  person: PersonId
  issued_at: Iso8601
  revoked: boolean
  used?: { at: Iso8601; by: PersonId; action: Decision['action'] }
}

export interface Reservation {
  counter: string
  change_id: string
  amount: number
  state: 'held' | 'committed' | 'released'
}

export interface ApprovalFilter {
  workspace_id?: WorkspaceId
  kind?: ApprovalKind
  role_id?: RoleId
  state?: ApprovalState[]
  dedupe_key?: string
}

export interface ChangeFilter {
  workspace_id?: WorkspaceId
  target?: ObjectRef
  kind?: ChangeKind
  status?: StagedChange['status'][]
  run_id?: RunId
  since?: Iso8601
  assignment_id?: string
  change_set_id?: string
}

/** 内存实现；接口化以便换 SQLite（15 §存放）。所有方法同步。 */
export interface TxnStore {
  putApproval(item: ApprovalItem): void
  getApproval(id: string): ApprovalItem | undefined
  listApprovals(filter?: ApprovalFilter): ApprovalItem[]
  pushRevision(item: ApprovalItem): void
  revisions(id: string): ApprovalItem[]
  pushEventId(item_id: string, event_id: string): void
  eventIds(item_id: string): string[]

  putToken(t: TokenRecord): void
  getToken(token: string): TokenRecord | undefined
  tokensFor(item_id: string): TokenRecord[]
  revokeTokensFor(item_id: string): void

  putChange(c: StagedChange): void
  getChange(id: string): StagedChange | undefined
  listChanges(filter?: ChangeFilter): StagedChange[]
  putMandate(change_id: string, m: Mandate): void
  getMandate(change_id: string): Mandate | undefined
  /** 审批项创建时的执行上下文（快照分量的来源），apply 时按同一份重算 */
  putContext(item_id: string, ctx: ApprovalContext): void
  getContext(item_id: string): ApprovalContext | undefined

  /** 宿主（审批总线）写的批准标记；执行器只信这一处（15 §5.2） */
  markApproved(change_id: string): void
  isApproved(change_id: string): boolean

  reserve(counter: string, change_id: string, amount: number): Reservation
  reservationOf(change_id: string): Reservation | undefined
  countReserved(counter: string): number
  commitReservation(change_id: string): void
  releaseReservation(change_id: string): void

  putProvenance(state: ProvenanceState): void
  getProvenance(run_id: RunId): ProvenanceState | undefined
}

/** 创建审批项时的额外上下文（契约 ApprovalItem 之外，包内交叉类型扩展）。 */
export interface ApprovalContext {
  /** 执行快照分量 */
  connection_id?: string
  record_version?: string
  attachments?: string[]
  mandate_hash?: string
  /** staged_change 审批项指向的账本条目 */
  change_id?: string
  /** 31 §3.3 收件人门禁：线程原参与者 */
  thread_participants?: string[]
  /** 31 §3.3 收件人门禁：已验证联系方式 */
  verified_contacts?: string[]
  /** 预检结论覆盖（脱敏等由调用方判定时） */
  precheck_overrides?: Partial<ApprovalItem['evidence']['precheck']>
}

type ContractCreateInput<P> = Omit<
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
> & { links?: Partial<ApprovalItem['links']> }

export type CreateApprovalInput<P> = ContractCreateInput<P> & { context?: ApprovalContext }

/** 15 §5 apply 的结果。 */
export interface ApplyOutcome {
  change: StagedChange
  status: StagedChange['status']
  error?: NonNullable<StagedChange['apply']>['error']
}

export interface StageApprovalInput {
  title: string
  summary: string
  recipients: Recipient[]
  proposer: ApprovalItem['proposer']
  rule?: ApprovalItem['routing']['rule']
  priority?: ApprovalItem['priority']
  separation_of_duties?: boolean
  escalation?: Partial<ApprovalItem['routing']['escalation']>
  source_events?: string[]
  parent?: string
}

/** 账本 stage 的输入：变更字段 + 评估上下文 + 审批项路由。 */
export interface StageInput {
  workspace_id: WorkspaceId
  role_id: RoleId
  assignment_id: string
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
  /** 生效额度（由 roles 包解析后传入；本包不解析策略层） */
  mandate: Mandate
  /** 该 (assignment, kind) 的当前自动化等级 */
  level: Level
  provenance?: ProvenanceState
  /** 15 §6.1 关系授权门禁的输入 */
  requester?: AuthorizationCheckInput['requester']
  target_owner?: ObjectRef
  connection_id?: string
  margin_after_pct?: number
  daily_spend_total?: number
  approval: StageApprovalInput
}

export type StageOutcome =
  | { ok: true; change: StagedChange; approval: ApprovalItem }
  | {
      ok: false
      reason: 'guardrail' | 'authorization_check_failed'
      guardrail?: StagedChange['guardrail']
      message: string
    }

export interface SnapshotComponents {
  workspace: string
  connection: string
  target: string
  record_version: string
  recipients: string[]
  final_payload: unknown
  attachments: string[]
  executor_version: string
  mandate_hash: string
}

export type { ExecutionSnapshot }
