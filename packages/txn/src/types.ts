import type {
  ApprovalExecutionContext,
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  AuthorizationCheckInput,
  ChangeKind,
  Clock,
  CreateApprovalInput as ContractCreateApprovalInput,
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
/**
 * 施行回调收到的那一组东西。`fencing_token` 是 31 §3.2「单一施行者」的凭据：
 * 同一个目标每次拿到锁都发一张**严格递增**的号。
 *
 * 后端该拿它做什么：**记下见过的最大号，比它小的一律拒**。
 * 这样即使一个卡住的老施行者租约过期后又醒过来，它那一次写也进不去
 * ——锁能防同时写，防不了「以为自己还持着锁」的迟到写，能防的只有围栏号。
 */
export interface ApplyCallbackOptions {
  idempotencyKey: string
  attempt: number
  fencing_token: number
}
export type BackendApply = (
  change: StagedChange,
  opts: ApplyCallbackOptions,
) => Promise<BackendResult> | BackendResult
export type DeliverOutbound = (
  item: ApprovalItem,
  opts: ApplyCallbackOptions,
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
  /**
   * 31 §3.2 单一施行者队列的**租约时长**。施行者拿锁时写一个到期时刻；
   * 进程崩了没来得及释放，别人等到期就能接管（接管时围栏号 +1）。
   * 太短会让慢后端被抢锁（靠围栏号兜底），太长会让崩溃后的目标卡住这么久。
   */
  apply_lease_ms: number
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

/**
 * 15 §apply / 31 §3.2「同目标同 kind 的 apply 串行（单一施行者队列）」的锁。
 *
 * WP4 只做到了**进程内**串行（一个 Promise 链）——同一台机器上跑两个服务进程、
 * 或者桌面壳把 sidecar 重启了而老进程还没死透，两边就会同时 apply 同一条变更。
 * WP31 把它换成落盘的锁 + **围栏号**（fencing token）。
 */
export interface ApplyLock {
  /** `<target>|<kind>` */
  key: string
  /** 施行者实例 id（同一个进程内的所有 apply 共用一个）。 */
  holder: string
  /** 严格递增；每次成功拿锁 +1。后端拿它拒绝迟到的老施行者。 */
  token: number
  acquired_at: Iso8601
  expires_at: Iso8601
}

export interface AcquireApplyLockInput {
  key: string
  holder: string
  now: Iso8601
  leaseMs: number
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

  /**
   * 拿一把施行锁。拿到回 {@link ApplyLock}（`token` 比上一次大）；
   * 别人正持着且租约没过期 → `undefined`（调用方回 `conflict`）。
   * 租约过期即可接管——**接管也要拿到新号**，老施行者的迟到写才拦得住。
   */
  acquireApplyLock(input: AcquireApplyLockInput): ApplyLock | undefined
  /** 释放。`token` 对不上（已被别人接管）就什么都不做——别把别人的锁放了。 */
  releaseApplyLock(key: string, token: number): void
  /** 现在谁持着（诊断与错误信息用）。 */
  applyLockOf(key: string): ApplyLock | undefined

  reserve(counter: string, change_id: string, amount: number): Reservation
  reservationOf(change_id: string): Reservation | undefined
  countReserved(counter: string): number
  commitReservation(change_id: string): void
  releaseReservation(change_id: string): void

  putProvenance(state: ProvenanceState): void
  getProvenance(run_id: RunId): ProvenanceState | undefined

  /**
   * 15 §5.8 对账游标：`unknown` 的对账重启后要能接着跑，
   * 所以「处理到哪儿了」必须和状态存在同一处（内存档同样提供，两档接口一致）。
   */
  getCursor(name: string): string | undefined
  setCursor(name: string, value: string): void
  /** 15 §5.8：还没对上账的变更（`status = unknown`），按创建顺序。 */
  pendingReconcile(workspace_id?: WorkspaceId): StagedChange[]

  /**
   * 把一组写放进一个事务（stage / decide / apply 三处的状态跃迁各自原子）。
   * SQLite 档是真事务（抛异常即整组回滚）；内存档直接执行——内存里没有半写状态可回滚。
   */
  transaction<T>(fn: () => T): T
}

/**
 * 创建审批项时的额外上下文。
 *
 * WP4 时这是包内的交叉类型；WP31 把它搬进契约（`ApprovalExecutionContext`），
 * 这里只留一个别名——「收件人门禁拿什么判」不该只有宿主实现知道。
 */
export type ApprovalContext = ApprovalExecutionContext

/**
 * 建一张审批项的入参：**就是契约的那一份**（14 / `ApprovalBus.create`）。
 *
 * 契约上 `automation` 只强制 `level_at_creation`——「auto_approved / mandate_check /
 * sampling 由宿主计算，调用方只给等级」。补齐默认值的地方是 {@link normalizeCreateInput}，
 * 补完之后包内各步拿到的是 {@link NormalizedCreateInput}。
 */
export type CreateApprovalInput<P> = ContractCreateApprovalInput<P>

/**
 * 补齐 `automation` 默认值之后的入参：预检、物化、额度判定都按它算，
 * 于是 `input.automation.mandate_check` 在包内永远有值。
 */
export type NormalizedCreateInput<P> = Omit<CreateApprovalInput<P>, 'automation'> & {
  automation: ApprovalItem['automation']
}

/**
 * 14：调用方只给等级时，宿主补齐其余三项。
 *
 * - `auto_approved: false`——自动通过是宿主算出来的结论，调用方声明不算数；
 * - `mandate_check: { within: false, caps_hit: [] }`——**没报过额度就当没核过**，
 *   预检据此判 `mandate: 'review'`，卡走人审（宁可多一次人看）；
 * - `sampling: { selected: false }`——抽检由宿主按 `sampling_rate` 掷。
 *
 * 整个 `automation` 都不给时，等级按最严的 `L1`（全人审）算。
 */
export function normalizeCreateInput<P>(input: CreateApprovalInput<P>): NormalizedCreateInput<P> {
  const a = input.automation ?? { level_at_creation: 'L1' as Level }
  return {
    ...input,
    automation: {
      level_at_creation: a.level_at_creation,
      auto_approved: a.auto_approved ?? false,
      mandate_check: a.mandate_check ?? { within: false, caps_hit: [] },
      sampling: a.sampling ?? { selected: false },
    },
  }
}

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
