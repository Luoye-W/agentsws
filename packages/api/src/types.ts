/**
 * 网关的端口（28 §2「网关里不写业务」）：每个端口都是已合并模块公开方法的最小投影，
 * 用契约类型描述，装配在 `apps/server`。这里不 import 任何实现包。
 */

import type {
  ApprovalBus,
  ApprovalItem,
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
  KnowledgeGap,
  KnowledgeGapAnswer,
  KnowledgeGapInput,
  KnowledgeGapStatus,
  KnowledgeLayer,
  KnowledgeSource,
  KnowledgeSourceInput,
  LessonRecord,
  MaybePromise,
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
  TokenInfo,
  Trace,
  WorkspaceId,
} from '@agentsws/contracts'
import type { DeckCard, QueryContext as DeckQueryContext } from '@agentsws/deck'
import type { IdempotencyStore } from './idempotency.js'
import type { AskPort } from './routes/ask.js'
import type { CatalogPort } from './routes/catalog.js'
import type { BackupPort } from './routes/backup.js'
import type { ConnectionsPort } from './routes/connections.js'
import type { ReconcilePort } from './routes/health.js'
import type { MeetingsPort } from './routes/meetings.js'
import type { ModelsPort } from './routes/models.js'
import type { OffboardPort, OrgPort } from './routes/org.js'
import type { PrivacyPort } from './routes/privacy.js'
import type { SecretsPort } from './routes/secrets.js'
import type { WorkPort } from './routes/work.js'
import type { WsOptions } from './routes/ws.js'

/** 一次请求解析出的主体（28 §2「每请求解析 { person, workspace, assignment?, kind }」）。 */
export interface Principal {
  person_id: PersonId
  workspace_id: WorkspaceId
  kind: 'session' | 'api_key' | 'runtime' | 'internal'
}

export interface RequestContext {
  trace_id: string
  principal?: Principal
  /**
   * 这次请求用的那张 token 原文（`Authorization` 里的，或会话 cookie 里的）。
   *
   * 只有 `POST /v1/auth/logout` 用得着——注销要撤销的正是**这一张**，不是这个人的全部。
   * 它不进日志、不进响应、不进 OpenAPI。
   */
  token?: string
  /** X-Assignment；已校验属于本人且未撤销。 */
  assignment?: Assignment
}

/** 20 §3 一张 token 的状态：WP35 起在契约里（`IdentityService.tokenInfo?`）。 */
export type { TokenInfo } from '@agentsws/contracts'

/**
 * `IdentityService.tokenInfo?` 装上了的那一档。
 *
 * 契约上它是**可选**方法（不属于「身份」的最小面）；网关拿 `hasTokenInfo` 探一下，
 * 探不到就少一个 `expires_at`，其余照常。
 */
export interface IdentityTokenInfo {
  tokenInfo(token: string): MaybePromise<TokenInfo | undefined>
}

export function hasTokenInfo(identity: unknown): identity is IdentityTokenInfo {
  return (
    identity !== null &&
    typeof identity === 'object' &&
    typeof (identity as { tokenInfo?: unknown }).tokenInfo === 'function'
  )
}

export interface EventLogPort {
  read(filter: {
    workspace_id: WorkspaceId
    since?: EventId
    /** WP35：时间闭区间，与 `since` 同给取交集；SQLite 档下推到 SQL。 */
    since_at?: Iso8601
    until_at?: Iso8601
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope>
  /**
   * 网关自己要记的那几条（`halt.changed`）。可选：只读投影不实现它，
   * 那就只是少一条日志，路由照常工作。
   */
  append?(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
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
  /* ── 19 §6 的其余四件事。都是**可选**面：装了才有，没装那几条路由回 not_implemented ── */
  /** 导入源清单（19 §1.3 KnowledgeSource）。 */
  sources?(actor: GatewayActor): MaybePromise<KnowledgeSource[]>
  /** 登记一个导入源；真正的解析与分块由 knowledge 包做，网关只转发。 */
  addSource?(actor: GatewayActor, input: KnowledgeSourceInput): MaybePromise<KnowledgeSource>
  /** 19 §3 `cite`：记一次引用（`usage.cited + 1`）。 */
  cite?(actor: GatewayActor, fact_card_id: string, run_id: RunId): MaybePromise<void>
  /** 19 §4 缺口队列。 */
  gaps?(actor: GatewayActor, filter: { status?: KnowledgeGapStatus }): MaybePromise<KnowledgeGap[]>
  openGap?(actor: GatewayActor, input: KnowledgeGapInput): MaybePromise<KnowledgeGap>
  /** 有人答了 → 自动变一张 `knowledge_update` 审批项（19 §4）。 */
  answerGap?(
    actor: GatewayActor,
    id: string,
    input: { answer: string; layer?: KnowledgeLayer },
  ): MaybePromise<KnowledgeGapAnswer>
}

/* 19 §1.3 / §4 的知识源与缺口对象已进契约（WP35），这里只转出去，不再自己定义。 */
export type {
  KnowledgeGap,
  KnowledgeGapAnswer,
  KnowledgeGapInput,
  KnowledgeGapStatus,
  KnowledgeSourceInput,
} from '@agentsws/contracts'

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
  /** WP29 技能页：每个技能的当前版本、三层 overlay、待审提案数。没装配就 not_implemented。 */
  list?(actor: {
    person_id: PersonId
    workspace_id: WorkspaceId
    department_id?: string
  }): Promise<SkillSummary[]>
  /** 24 §2 排除：个人不用某个技能，不影响别人。 */
  exclude?(name: string, person_id: PersonId, excluded: boolean): Promise<void>
  /** 24 §2 晋升：产出一条 `skill_promotion` 审批项（不落任何一层）。 */
  promote?(input: {
    skill: string
    section_ids: string[]
    to_tier: 'company' | 'department'
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<{ accepted: boolean; approval_item_id?: string; reason?: string }>
  /** WP29：待审的 `skill_lesson` 提案卡（技能页上的"待审提案"）。 */
  proposals?(actor: {
    person_id: PersonId
    workspace_id: WorkspaceId
  }): Promise<SkillProposalSummary[]>
}

/** 一层 overlay 在界面上的样子：来源是"人写的"还是"学到的"，一眼能看出来。 */
export interface SkillOverlayView {
  tier: 'company' | 'department' | 'personal'
  owner: string
  version: number
  base_version: string
  ops: {
    op: 'replace' | 'append' | 'remove'
    section_id: string
    heading?: string
    origin: 'authored' | 'learned'
    body?: string
    learned_from?: { lessons: string[]; at: Iso8601 }
  }[]
}

export interface SkillSummary {
  name: string
  /** 基础版所在的层 */
  tier: string
  version: string
  excluded: boolean
  sections: { id: string; heading: string; origin: 'authored' | 'learned' }[]
  overlays: SkillOverlayView[]
  pending_proposals: number
}

export interface SkillProposalSummary {
  approval_item_id: string
  skill: string
  section_id: string
  heading: string
  title: string
  summary: string
  hits: number
  confidence: number
  options: { id: string; label: string }[]
  quotes: string[]
  diff: { before: string | null; after: string; summary: string }
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
  /** WP18：不给就用内存档；apps/server 在有数据目录时传 SqliteIdempotencyStore。 */
  idempotencyStore?: IdempotencyStore
  /** 事件长轮询的最大等待与轮询间隔。 */
  events?: { maxWaitMs?: number; pollIntervalMs?: number; defaultLimit?: number }
  /** WP33 WebSocket 事件流（`/v1/ws`）。 */
  ws?: WsOptions
  /** 服务端版本号，进 `/v1/health`。 */
  version?: string
  /**
   * 本地单机档（回环口、没有邮件通道）直接把一次性登录 token 回给调用方；
   * 托管档必须置 false——那时 token 只能经邮件投递，不进 HTTP 响应（20 §3）。
   */
  exposeMagicLinkToken?: boolean
  /**
   * 13 §5：进程身份进 `/v1/health`（桌面壳靠它认出「这个 sidecar 就是我起的那个」）。
   * `port` 是取值函数——端口是 listen 之后才知道的。
   */
  instance?: { pid: number; port(): number | undefined }
  /**
   * 13 §5 浏览器会话：桌面壳与服务进程共享的一次性会话密钥（`AGENTSWS_SESSION_KEY`）。
   * 给了就开 `POST /v1/auth/session`：拿密钥换一个 HttpOnly + SameSite=Strict cookie，
   * 之后浏览器靠 cookie、SDK 靠 bearer，**token 一次都不进 URL**。
   */
  sessionKey?: string
  /** 会话 cookie 名，默认 `agentsws_session`。 */
  sessionCookieName?: string
  /** 本地单机档只有一个人；换会话时不必让调用方报邮箱。 */
  sessionOwnerEmail?: string
}

/* ------------------------------------------------------------------ */
/* 25 定时与流程面                                                       */
/* ------------------------------------------------------------------ */

/**
 * 定时任务的网关投影。
 *
 * 比契约的 `ScheduledTask` **宽一点**：多一个 `interval` 触发器、多 `running` / `cancelled`
 * 两个状态、多 `title` / `handler`（见 WP27 交付报告的「需要契约改动」）。网关这一层
 * 不判断这些字段的语义，只负责把它们原样端出去。
 */
export interface ScheduledTaskView {
  id: string
  workspace_id: WorkspaceId
  owner: PersonId
  role_id: RoleId
  assignment_id: AssignmentId
  title?: string | undefined
  handler?: string | undefined
  trigger: { kind: string } & Record<string, unknown>
  state: string
  created_by: 'user' | 'agent'
  misfire_policy: 'run_once_now' | 'skip'
  fire_count: number
  next_fire_at?: Iso8601 | undefined
  last_fire_at?: Iso8601 | undefined
  last_result?: string | undefined
  approval?: string | undefined
  origin?: { conversation_id: string } & Record<string, unknown>
}

/** 流程实例的网关投影（25 §1；`cancelled` 是实现层多出来的一态）。 */
export interface WorkflowInstanceView {
  id: string
  def: { id: string; version: string }
  workspace_id: WorkspaceId
  role_id: RoleId
  subject: ObjectRef
  conversation_id?: string | undefined
  state: string
  cursor: string
  history: { step_id: string; at: Iso8601; result: unknown }[]
  started_at: Iso8601
}

export interface ScheduleActor {
  workspace_id: WorkspaceId
  person_id: PersonId
}

export interface ScheduleListQuery extends ScheduleActor {
  assignment_id: AssignmentId
  /** `position` = 本次绑定的岗位；`mine` = 本人全部岗位；`workspace` = 整个工作区 */
  scope: 'position' | 'mine' | 'workspace'
  conversation_id?: string
  state?: string[]
}

export interface ScheduleCreateInput extends ScheduleActor {
  /** 本次绑定的岗位（X-Assignment） */
  assignment_id: AssignmentId
  /** 建给哪个岗位；不给就是本次绑定的这个。给别人的要那边点头（25 §5） */
  target_assignment_id?: AssignmentId
  title: string
  trigger: { kind: string } & Record<string, unknown>
  handler?: string
  params?: Record<string, unknown>
  /** 到点那一下会做什么（25 §3 决定要不要人点头） */
  effect: 'read_only' | 'writes' | 'sends'
  misfire_policy: 'run_once_now' | 'skip'
  conversation_id?: string
}

export interface SchedulePatchInput {
  action?: 'pause' | 'resume' | undefined
  trigger?: ({ kind: string } & Record<string, unknown>) | undefined
  title?: string | undefined
  params?: Record<string, unknown> | undefined
  misfire_policy?: 'run_once_now' | 'skip' | undefined
}

export interface ScheduleRunOutcome {
  task: ScheduledTaskView
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface WorkflowListQuery {
  workspace_id: WorkspaceId
  def_id?: string
  state?: string[]
  subject?: { type: string; id: string }
}

/** 25 §5 的端口；没装调度器的发行版不给它，那几条路由回 `not_implemented`。 */
export interface SchedulePort {
  list(query: ScheduleListQuery): MaybePromise<ScheduledTaskView[]>
  create(input: ScheduleCreateInput): MaybePromise<ScheduledTaskView>
  update(
    actor: ScheduleActor,
    id: string,
    patch: SchedulePatchInput,
  ): MaybePromise<ScheduledTaskView>
  cancel(actor: ScheduleActor, id: string): MaybePromise<ScheduledTaskView>
  runNow(actor: ScheduleActor, id: string): MaybePromise<ScheduleRunOutcome>
  workflows(query: WorkflowListQuery): MaybePromise<WorkflowInstanceView[]>
  workflow(actor: ScheduleActor, id: string): MaybePromise<WorkflowInstanceView | undefined>
  /**
   * 25 §5 `POST /workflows/{def}/start`：开一条流程实例。
   * 可选面——没装流程引擎的发行版少这一条路由（回 not_implemented），其余照常。
   */
  startWorkflow?(
    actor: ScheduleActor & { assignment_id: AssignmentId },
    input: { def_id: string; subject: { type: string; id: string }; conversation_id?: string },
  ): MaybePromise<WorkflowInstanceView>
  /** 流程定义的一句人话标题（"建之前先查"要拿它去比） */
  workflowDefinition?(def_id: string): MaybePromise<{ id: string; name: string } | undefined>
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
  /** 36 工作台面（首页 / 岗位 / 积木）；没装配时那几条路由回 not_implemented。 */
  workstation?: WorkstationPort
  /** 37 工作模型（事项 / 目标 / 待办 / 日历 / 计划 / 复盘）；没装配时那几条路由回 not_implemented。 */
  work?: WorkPort
  /** 37 §4 会议内核；没装配时 `/v1/meetings/*` 回 not_implemented。 */
  meetings?: MeetingsPort
  /** WP20 连接面（连接向导 / 凭据原生表单直填）；没装配时 `/v1/connections/*` 回 not_implemented。 */
  connections?: ConnectionsPort
  /** WP31 本机秘密库密钥轮换；没装配时 `POST /v1/secrets/rotate` 回 not_implemented。 */
  secrets?: SecretsPort
  /** WP25 模型面（provider 配置 / 默认模型 / 预算 / 花费）；没装配时 `/v1/models/*` 回 not_implemented。 */
  models?: ModelsPort
  /**
   * WP28 制度面（05 职责 / 岗位 / 分配 / 策略层 + 20 成员与邀请）；
   * 没装配时 `/v1/roles`、`/v1/org/*`、成员与邀请那几条回 not_implemented。
   */
  org?: OrgPort
  /** 36 §3「问 AI」；不给的话那条路回 not_implemented。 */
  ask?: AskPort
  /**
   * 40 §2 工具箱与查重；没装配时 `/v1/catalog/*` 回 not_implemented，
   * 五个"建"的入口也**不再查重**（`guardSimilar` 直接放行）——查重是加分项，
   * 不该让没装工具箱的发行版连定时任务都建不了。
   */
  catalog?: CatalogPort
  /** 25 定时与流程面；没装调度器时 `/v1/schedules` 与 `/v1/workflows` 回 not_implemented。 */
  schedules?: SchedulePort
  /**
   * WP34：15 §5.8 对账状态；`GET /v1/health` 的 `reconcile` 那一格。
   * 没装配就不出这一格（不要用 `done` 冒充「没装」）。
   */
  reconcile?: ReconcilePort
  /**
   * WP34：21 §4「删这个人」的跨库编排；没装配时 `POST /v1/privacy/erase`
   * 回 not_implemented。
   */
  privacy?: PrivacyPort
  /**
   * WP36：40 §1.2「离职是一个正式动作」的编排；没装配时
   * `POST /v1/workspaces/:id/members/:person_id/offboard` 与前员工层那两条回 not_implemented。
   */
  offboard?: OffboardPort
  /**
   * WP36：40 §1.3 备份 / 搬家。内存档（没有数据目录）没有可导的东西，
   * 不装配时 `POST /v1/backup/export` 回 not_implemented。
   */
  backup?: BackupPort
  traceScope: TraceScope
  /** 长轮询用；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  options?: GatewayOptions
}

/**
 * 36 工作台端口。
 *
 * 「岗位」= 一个人对某职责在某范围上的持有，也就是一条 Assignment（`position_id === assignment_id`），
 * 所以工作台的每个页面天然对应一个 `X-Assignment`，不会出现跨 Assignment 并集（31 §3.1）。
 *
 * 网关只做装配与校验，数从 `@agentsws/deck` 的命名查询里算（29 原则 ③「数字不经模型手」）。
 */
export interface PositionSummary {
  position_id: AssignmentId
  role_id: RoleId
  role_name: string
  ranges: RangeRef[]
  /** 05 §4：连接器齐了没有 */
  ready: boolean
  missing_connectors: string[]
  /** 用户挑过的数字块；没挑过就是职责默认值（36 §3） */
  tile_ids: string[]
  /** 该岗位记住的时间范围（36 §3：时间范围跟随岗位记忆） */
  range: WorkstationRange
  /** 首页要不要给这个岗位出一条核心数据条（没有默认块的职责不出） */
  show_tiles: boolean
}

export type WorkstationRange = 'yesterday' | 'last_7d'

export interface WorkstationActor {
  workspace_id: WorkspaceId
  person_id: PersonId
}

export interface WorkstationPort {
  /** 本人持有的岗位。 */
  positions(actor: WorkstationActor): MaybePromise<PositionSummary[]>
  /** 某岗位队列里的审批项（已按 recipient 过滤）。 */
  items(actor: WorkstationActor, position: PositionSummary): MaybePromise<ApprovalItem[]>
  /**
   * 某岗位的查询上下文：连接状态 + 店铺侧行 + 审批项。
   * 返回的是 deck 的 `QueryContext`，网关不认识里面的字段，只负责传。
   */
  queryContext(
    actor: WorkstationActor,
    position: PositionSummary,
    range: WorkstationRange,
  ): MaybePromise<DeckQueryContext>
  /** 系统卡（重新授权 / 预算告急 / 模型不可用）与每日摘要——不是审批项，宿主直接给。 */
  systemCards(actor: WorkstationActor): MaybePromise<{ alerts: DeckCard[]; digest?: DeckCard }>
  /** ObjectRef → 人话（前端不猜、也不查库）。 */
  label(ref: ObjectRef): string | undefined
  /** 36 §3：换 / 增减数字块与时间范围，跟随岗位记忆。 */
  setHomeTiles(
    actor: WorkstationActor,
    input: { position_id: AssignmentId; tile_ids: string[]; range?: WorkstationRange },
  ): MaybePromise<PositionSummary>
}
