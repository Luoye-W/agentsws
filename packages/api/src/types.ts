/**
 * 网关的端口（28 §2「网关里不写业务」）：每个端口都是已合并模块公开方法的最小投影，
 * 用契约类型描述，装配在 `apps/server`。这里不 import 任何实现包。
 */
import type {
  ApprovalBus,
  Assignment,
  AssignmentId,
  ChangeKind,
  ChangeStatus,
  Clock,
  DataDomain,
  EventEnvelope,
  EventId,
  FactCard,
  GuardrailResult,
  Halt,
  IdentityService,
  Iso8601,
  KnowledgeLayer,
  LessonRecord,
  ModuleHealth,
  ObjectRef,
  Operation,
  PermissionScope,
  PersonId,
  Range,
  RangeRef,
  RetrievalActor,
  RetrievalHit,
  RoleId,
  RunId,
  Sensitivity,
  SkillTier,
  StagedChange,
  Trace,
  WorkspaceId,
} from '@agentsws/contracts'

/** 一次请求解析出的主体（28 §2「每请求解析 { person, workspace, assignment?, kind }」）。 */
export interface Principal {
  person_id: PersonId
  workspace_id: WorkspaceId
  kind: 'session' | 'api_key' | 'runtime' | 'internal'
}

export interface RequestContext {
  trace_id: string
  principal?: Principal
  /** X-Assignment；已校验属于本人且未撤销。 */
  assignment?: Assignment
}

export interface EventLogPort {
  read(filter: {
    workspace_id: WorkspaceId
    since?: EventId
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope>
}

export interface ModulesPort {
  health(): ModuleHealth[]
}

/** 15 §7 的账本读写投影；`stage` 只有执行器能调，不经网关。 */
export interface ChangesPort {
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
  reverse(id: string, by: PersonId): Promise<StagedChange>
}

export interface GuardrailEvaluateInput {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  at: Iso8601
  phase: 'stage' | 'apply'
  change: {
    kind: ChangeKind
    target: ObjectRef
    field?: string
    before: unknown
    after: unknown
    amount_base?: number
    margin_after_pct?: number
  }
}

/** 15 §7 `POST /guardrails/evaluate`：只评估不 stage。 */
export interface GuardrailPort {
  evaluate(input: GuardrailEvaluateInput): Promise<GuardrailResult>
}

/**
 * 19 §3 过滤下推需要的 actor：身份 + 本次 Assignment 的 scopes / ranges
 * （契约的 `RetrievalActor` 只带身份，授权由 WP3 的 EffectiveConfig 给）。
 */
export interface GatewayActor extends RetrievalActor {
  grants: PermissionScope[]
  ranges: RangeRef[]
}

export interface KnowledgePort {
  search(q: {
    text: string
    actor: GatewayActor
    domains?: (DataDomain | 'company')[]
    scope?: RangeRef[]
    layers?: KnowledgeLayer[]
    k?: number
    precheck?: boolean
  }): Promise<{ hits: RetrievalHit[]; relevant: boolean; matched: string[]; missing: string[] }>
  cards(
    filter: {
      workspace_id: WorkspaceId
      domain?: string
      layer?: KnowledgeLayer
      status?: FactCard['status']
    },
    actor: GatewayActor,
  ): Promise<FactCard[]>
  card(id: string, actor: GatewayActor): Promise<FactCard | undefined>
  health(
    workspace_id: WorkspaceId,
  ): Promise<{ total: number; silent: number; stale: number; conflicts: number }>
}

/** 写个人层 overlay 的入参（24 §1 OverlayOp）。 */
export interface OverlayInput {
  skill: string
  tier: SkillTier
  owner: PersonId | string
  ops: {
    op: 'replace' | 'append' | 'remove'
    section_id: string
    body?: string
    origin?: 'authored' | 'learned'
  }[]
  base_version: string
  version: number
}

/**
 * skills 包用交叉类型扩了契约的 ResolvedSkill / Overlay（OverlayOpEx 等），
 * 网关只做序列化，因此这里只声明用得到的最小形状——运行时仍是完整对象。
 */
export interface SkillsPort {
  resolve(
    name: string,
    actor: { person_id: PersonId; workspace_id: WorkspaceId; department_id?: string },
  ): Promise<{ name: string; markdown: string } | undefined>
  setOverlay(overlay: OverlayInput): Promise<{ skill: string; version: number }>
  lessons(filter: {
    workspace_id?: WorkspaceId
    status?: LessonRecord['status']
  }): LessonRecord[] | Promise<LessonRecord[]>
}

/** 05 §4 有效配置的最小投影：网关只做序列化与身份校验，字段由 roles 包决定。 */
export interface EffectiveConfigLike {
  assignment_id: AssignmentId
  person_id: PersonId
  workspace_id: WorkspaceId
  role_id: RoleId
  scopes: PermissionScope[]
  ranges: RangeRef[]
  ready: boolean
  unassigned_range: boolean
}

/** 31 §3.1：一次请求绑定一个 Assignment，判定用完整元组。 */
export interface RolesPort {
  can(
    id: AssignmentId,
    domain: DataDomain,
    op: Operation,
    request: { range: Range; sensitivity: Sensitivity },
  ): boolean
  effectiveConfig(id: AssignmentId): EffectiveConfigLike
  getAssignment(id: AssignmentId): Assignment | undefined
  listAssignments(person_id: PersonId, filter?: { workspace_id?: WorkspaceId }): Assignment[]
}

/** trace_id 的异步传播（28 §1「trace_id 贯穿 run→tool→action→apply→delivery」）。 */
export interface TraceScope {
  run<T>(trace_id: string, fn: () => T): T
  current(): string | undefined
}

export interface RateLimitPolicy {
  /** 桶容量（突发上限）。 */
  burst: number
  /** 每秒补充的令牌数。 */
  per_second: number
}

export interface GatewayOptions {
  /** 按 workspace × kind 的限流（28 §2）；不给则用默认。 */
  rateLimit?: Partial<Record<Principal['kind'], RateLimitPolicy>> & {
    default?: RateLimitPolicy
  }
  /** 幂等表保留时长，默认 24h（28 §2）。 */
  idempotencyTtlMs?: number
  /** 事件长轮询的最大等待与轮询间隔。 */
  events?: { maxWaitMs?: number; pollIntervalMs?: number; defaultLimit?: number }
  /** 服务端版本号，进 `/v1/health`。 */
  version?: string
  /**
   * 本地单机档（回环口、没有邮件通道）直接把一次性登录 token 回给调用方；
   * 托管档必须置 false——那时 token 只能经邮件投递，不进 HTTP 响应（20 §3）。
   */
  exposeMagicLinkToken?: boolean
}

export interface GatewayDeps {
  identity: IdentityService
  halt: Halt
  trace: Trace
  clock: Clock
  eventLog: EventLogPort
  modules: ModulesPort
  approvals: ApprovalBus
  changes: ChangesPort
  guardrails: GuardrailPort
  knowledge: KnowledgePort
  skills: SkillsPort
  roles: RolesPort
  traceScope: TraceScope
  /** 长轮询用；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  options?: GatewayOptions
}
