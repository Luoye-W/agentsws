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
  EffectiveAction,
  EventEnvelope,
  EventId,
  ExecutionWiring,
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
  KnowledgeSourceFile,
  KnowledgeSourceInput,
  LessonRecord,
  MaybePromise,
  ModuleHealth,
  ObjectRef,
  Operation,
  PermissionScope,
  PersonId,
  PromotionTier,
  Range,
  RangeRef,
  Recipient,
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
import type {
  DeckCard,
  QueryContext as DeckQueryContext,
  ReportData as DeckReportData,
  ReportSpec as DeckReportSpec,
} from '@agentsws/deck'
import type { ReasonJudgeInput, SimilarCard } from './card-follow.js'
import type { IdempotencyStore } from './idempotency.js'
import type { ActivityPort } from './routes/activity.js'
import type { AdCreativePort } from './routes/ad-creative.js'
import type { AdsPort } from './routes/ads.js'
import type { AmazonKeywordsPort } from './routes/amazon-keywords.js'
import type { AmazonListingPort } from './routes/amazon-listing.js'
import type { AskPort } from './routes/ask.js'
import type { AutopilotPort } from './routes/autopilot.js'
import type { B2bOutboundPort, B2bPort, B2bSalesPort } from './routes/b2b.js'
import type { BackgroundPort } from './routes/background.js'
import type { BackupPort } from './routes/backup.js'
import type { BrandAssetsPort } from './routes/brand-assets.js'
import type { BrandDesignPort } from './routes/brand-design.js'
import type { BrandIntakePort } from './routes/brand-intake.js'
import type { BrowserPort } from './routes/browser.js'
import type { CatalogPort } from './routes/catalog.js'
import type { ChangeFilesPort } from './routes/changes.js'
import type { ChatPort } from './routes/chat.js'
import type { CloudPort } from './routes/cloud.js'
import type { CloudAccountPort } from './routes/cloud-account.js'
import type { CompetitorWatchPort } from './routes/competitor-watch.js'
import type { ComputerUsePort } from './routes/computer-use.js'
import type { ConnectionDirectoryPort } from './routes/connection-directory.js'
import type { ConnectionsPort } from './routes/connections.js'
import type { ContentDigestPort } from './routes/content-digest.js'
import type { ContentUpdatesPort } from './routes/content-updates.js'
import type { DataServiceApiPort } from './routes/data-service.js'
import type { DesignPort } from './routes/design.js'
import type { DshScenesPort } from './routes/dsh-scenes.js'
import type { EconomicsPort } from './routes/economics.js'
import type { ExtensionPort } from './routes/extension.js'
import type { ExtensionActionsPort } from './routes/extension-actions.js'
import type { ExtensionInstallPort } from './routes/extension-install.js'
import type { ExtensionOnboardingPort } from './routes/extension-onboarding.js'
import type { ExtensionPanelPort } from './routes/extension-panel.js'
import type { FeedbackPort } from './routes/feedback.js'
import type { FreeChatPort } from './routes/free-chat.js'
import type { GenuiImageHostsPort } from './routes/genui-image-hosts.js'
import type { HandoffPort } from './routes/handoff.js'
import type { ReconcilePort } from './routes/health.js'
import type { HelpPort } from './routes/help.js'
import type { JoinPort } from './routes/join.js'
import type { KolPort } from './routes/kol.js'
import type { MeetingsPort } from './routes/meetings.js'
import type { MessagesPort } from './routes/messages.js'
import type { ModelsPort } from './routes/models.js'
import type { NotificationsPort } from './routes/notifications.js'
import type { NpmRegistryPort } from './routes/npm-registry.js'
import type { OfficialPluginsPort } from './routes/official-plugins.js'
import type { OnboardingPort } from './routes/onboarding.js'
import type { OffboardPort, OrgPort } from './routes/org.js'
import type { OrganizationsPort } from './routes/organizations.js'
import type { OutboundPort } from './routes/outbound.js'
import type { PersonaPort } from './routes/personas.js'
import type { PlatformKitPort } from './routes/platform-kit.js'
import type { PositionEntryPort } from './routes/positions.js'
import type { PrPort } from './routes/pr.js'
import type { PrivacyPort } from './routes/privacy.js'
import type { ReadRoutesApiPort } from './routes/read-routes.js'
import type { RedditWatchPort } from './routes/reddit-watch.js'
import type { RoleRulesPort } from './routes/role-rules.js'
import type { RunLimitsPort } from './routes/run-limits.js'
import type { SearchDataApiPort } from './routes/search-data.js'
import type { SecretaryPort } from './routes/secretary.js'
import type { SecretsPort } from './routes/secrets.js'
import type { SeoPort } from './routes/seo.js'
import type { ShopAdminPort } from './routes/shop-admin.js'
import type { ShopifyConnectPort } from './routes/shopify-connect.js'
import type { SitePort } from './routes/site.js'
import type { SiteHealthPort } from './routes/site-health.js'
import type { SocialPort } from './routes/social.js'
import type { StandbyPort } from './routes/standby.js'
import type { StoragePort } from './routes/storage.js'
import type { TelemetrySettingsPort } from './routes/telemetry.js'
import type { UpdatePausePort } from './routes/update-pause.js'
import type { WorkPort } from './routes/work.js'
import type { WorkArchivePort } from './routes/work-archive.js'
import type { WorkshopServicesApiPort } from './routes/workshop-services.js'
import type { WriteReviewPort } from './routes/write-review.js'
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
    /** WP488：这次问的是售前还是售后（不给 = 两边都取）。 */
    stage?: 'both' | 'presales' | 'postsales'
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
  /**
   * WP97（36 §11，`sidebar-compare` #13）：按 source_id 取**原件字节**（只读）。
   *
   * 读不到 / 不是本工作区的 / 这个源没有本机原件（飞书文档一类）→ `undefined`，
   * 路由翻成 404。**网关不做任何转换**，它只把字节转下去（与 `/knowledge/export` 同形）。
   */
  sourceFile?(actor: GatewayActor, id: string): MaybePromise<KnowledgeSourceFile | undefined>
  /**
   * WP99（19 §1.3「上传」）：**收一份文件**。
   *
   * 网关只做两件事：把 multipart 里那一个 `file` 拆出来，与一道粗的大小闸。
   * **权威的闸在宿主那一侧**（`apps/server/src/knowledge-upload.ts`：扩展名白名单、
   * magic bytes 与扩展名对得上、文件名洗净、纯文本档反着判）——网关不认识
   * Office 格式，也不该认识。
   *
   * 落进对象存储、登记成一条 `kind: 'upload'` 的源、进溯源链，都在宿主那一侧。
   */
  uploadSource?(
    actor: GatewayActor,
    input: { filename: string; bytes: Uint8Array },
  ): MaybePromise<KnowledgeSource>
  /**
   * WP99：删一个导入源（21 的擦除语义：字节真删、行留墓碑）。
   *
   * 不存在 / 不是本工作区的 / 已经删过的 → `false`，路由翻成 404
   * （与 `sourceFile` 同一条：不区分"不存在"与"不是你的"）。
   */
  deleteSource?(actor: GatewayActor, id: string): MaybePromise<boolean>
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
  /* ── WP56（48 §4 #6 / #9）：复核队列与知识包。都是**可选**面 ────────────── */
  /** 源页 / 文档改了之后开出来的复核（`status` 缺省只给还开着的）。 */
  rechecks?(actor: GatewayActor, filter: { status?: string }): MaybePromise<unknown[]>
  /**
   * WP488（决策 1680 / 1681 / 1686）：从过往邮件 / 官网 / 售后网站学一遍——开跑前的预估
   * （几次模型调用、预估花费、网关上限装不装得下、接没接邮箱）。
   */
  learnEstimate?(
    actor: GatewayActor,
    input: {
      source: 'email' | 'website'
      months?: number | undefined
      urls?: string[] | undefined
    },
  ): MaybePromise<unknown>
  /** WP488：开一次（后台跑；回这一次的进度对象）。学到的一律待确认，出一张汇总卡。 */
  learnStart?(
    actor: GatewayActor,
    input: {
      source: 'email' | 'website'
      months?: number | undefined
      urls?: string[] | undefined
    },
  ): MaybePromise<unknown>
  /** WP488：这个品牌最近几次（新的在前）。 */
  learnJobs?(actor: GatewayActor): MaybePromise<unknown[]>
  /** WP488（决策 1682）：改一条知识的范围（公共 / 售前 / 售后）。看不见的卡当不存在。 */
  setCardStage?(
    actor: GatewayActor,
    id: string,
    stage: 'both' | 'presales' | 'postsales',
  ): MaybePromise<unknown | undefined>
  /** 答一张复核卡：确认没变 / 按新值更新 / 忽略。 */
  resolveRecheck?(
    actor: GatewayActor,
    id: string,
    input: { resolution: 'unchanged' | 'adopt_new' | 'ignore' },
  ): MaybePromise<unknown>
  /**
   * 导入一个 `kefu-knowledge-pack/v1`。
   *
   * 19 §4 的纪律不变：**承诺类（定价 / 政策 / 边界）一律落候选**，
   * 其余的也只有 `confidence: high` 且带核实日期时才自动激活。
   */
  importPack?(
    actor: GatewayActor,
    input: { zip?: Uint8Array; files?: readonly { path: string; content: string }[] },
  ): MaybePromise<{
    imported: number
    activated: number
    proposed: number
    warnings: string[]
    manifest: { name: string; version: string }
  }>
  /**
   * 36 §2.2 业务边界清单：15 条里哪几条商家已经答过。
   *
   * "答过"不是另存一张表——答案就在知识库里（`layer: 'policy'` 的卡），
   * 这一条只是把注册表与知识库对一遍，告诉人还差哪几条。
   */
  boundaries?(actor: GatewayActor): MaybePromise<
    {
      id: string
      label: string
      question: string
      answered: boolean
      options: { id: string; label: string }[]
    }[]
  >
  /** 整库导出成一个知识包。**zip 在下游打**——网关不认识 zip 格式，只转字节。 */
  exportPack?(actor: GatewayActor): MaybePromise<{ filename: string; zip: Uint8Array }>
}

/* 19 §1.3 / §4 的知识源与缺口对象已进契约（WP35），这里只转出去，不再自己定义。 */
export type {
  KnowledgeGap,
  KnowledgeGapAnswer,
  KnowledgeGapInput,
  KnowledgeGapStatus,
  KnowledgeSourceFile,
  KnowledgeSourceInput,
} from '@agentsws/contracts'

/** WP69（54 §3）：某一层记忆里的一段（岗位页 / 职责层的"记忆"小节列的就是它们）。 */
export interface SkillMemoryEntry {
  /** WP71：改 / 删这一条用的地址（服务端给，前端不拼）。 */
  id?: string
  skill: string
  section_id: string
  heading?: string
  body: string
  origin: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: string }
  /** WP71：手动加的，还是从事项 / 复盘提升上来的。 */
  source?: 'manual' | 'promoted'
  added_by?: string
  added_at?: string
  /** WP320：人写的还是 AI 随工作自己记的（没有 = 早于 WP320，按人写的算）。 */
  written_by?: 'person' | 'ai'
  /** WP320：AI 记的那条从哪次运行 / 哪件事来的。 */
  run_id?: string
  matter_id?: string
  /** WP320：为什么记（asked / preference / correction / fact / manual / merge …）。 */
  reason?: string
}

/**
 * WP320：记忆账上的一笔（新增 / 改动 / 合并 / 删除）。界面上「记住了：……」小提醒就读它。
 * `text` 是这条记忆现在的样子（截短）；删掉的是删之前的样子。
 */
export interface MemoryChangeView {
  id: string
  at: string
  kind: 'added' | 'updated' | 'merged' | 'removed'
  entry_id: string
  tier: SkillTier
  scope_id: string
  text: string
  by: string
  written_by: 'person' | 'ai'
  run_id?: string
  matter_id?: string
  reason?: string
}

/** WP320：「设置 → 通用」的「自动记忆」——每个人在每个品牌里一份，默认开。 */
export interface AutoMemoryPort {
  get(actor: { person_id: PersonId; workspace_id: WorkspaceId }): MaybePromise<{ enabled: boolean }>
  set(
    actor: { person_id: PersonId; workspace_id: WorkspaceId },
    enabled: boolean,
  ): MaybePromise<{ enabled: boolean }>
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
  /** WP29 技能页：每个技能的当前版本、三层 overlay、待审提案数。没装配就 not_implemented。 */
  list?(actor: {
    person_id: PersonId
    workspace_id: WorkspaceId
    department_id?: string
  }): Promise<SkillSummary[]>
  /** 24 §2 排除：个人不用某个技能，不影响别人。 */
  exclude?(name: string, person_id: PersonId, excluded: boolean): Promise<void>
  /**
   * 24 §2 晋升：产出一条 `skill_promotion` 审批项（不落任何一层）。
   * WP69（54 §3）目标层从两档变四档；提到岗位 / 职责层时 `scope_id` 说清楚是哪一个。
   */
  promote?(input: {
    skill: string
    section_ids: string[]
    to_tier: PromotionTier
    scope_id?: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<{
    accepted: boolean
    approval_item_id?: string
    reason?: string
    /** WP275：① 个人 / ② 同事互联里人自己提的，已经当场生效（不出待审卡）。 */
    applied?: boolean
  }>
  /**
   * WP69（54 §3）：某一层记忆里有哪几段（第三栏「记忆」面板列的就是它们）。
   * WP71 起多回一格 `can_edit`——**能不能改由服务端说了算**，界面照着它决定出不出
   * 改 / 删 / 手动加那三个按钮（前端自己判等于把判据抄了第二份）。
   */
  memory?(input: {
    tier: SkillTier
    scope_id?: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<{ summary: string; entries: SkillMemoryEntry[]; can_edit?: boolean }>
  /**
   * WP71（36 §10）：手动加一条记忆（写本层）。
   *
   * 与"提到上一层"是两件事：提升产的是一张待审的卡（24 §3），这条是**当场写进本层**——
   * 因为本层就是本人自己的活儿那一层，没有第二个人要为它点头。越层一律 403。
   *
   * **WP71b 起这三条写是这道门本身**：网关不再用 `skill.stage@workspace` 拦
   * （职责模板里没有那个域，留着它等于"非 owner 一律改不动"），所以**实现方必须
   * 自己先过 `canEditMemory` 再落笔**，越层抛 `forbidden`。判据与 `memoryAccess().write`
   * 是同一份，界面上的 `can_edit` 也从那里来——三处永远说同一句话。
   */
  addMemory?(input: {
    tier: SkillTier
    scope_id?: string
    text: string
    heading?: string
    skill?: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<SkillMemoryEntry>
  /** WP71：改本层的一条。 */
  updateMemory?(input: {
    id: string
    text: string
    heading?: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<SkillMemoryEntry>
  /** WP71：删本层的一条。 */
  deleteMemory?(input: {
    id: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<void>
  /**
   * WP71b：**这一层的记忆，本人看不看得见 / 改不改得动**。
   *
   * 网关拿它替代原来那条 `skill.read@workspace` 元组判定——职责模板里根本没有
   * `skill` 这个域，那条判定的实际效果是"除了 owner 谁都读不到自己干活那一层"。
   * 判据在服务端一份（`canReadMemory` / `canEditMemory`），网关只问结论。
   */
  memoryAccess?(input: {
    tier: SkillTier
    scope_id?: string
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<{ read: boolean; write: boolean; reason?: string }>
  /**
   * WP320：记忆账上最近几笔（`since` 之后；`by: 'ai'` 只要 AI 记的）。**只回本人的**——
   * AI 替你记的、你自己改的；别人那几笔不出现在你的小提醒里。看不见的那几层也不回。
   */
  memoryChanges?(input: {
    since?: string
    written_by?: 'person' | 'ai'
    actor: { person_id: PersonId; workspace_id: WorkspaceId }
  }): Promise<MemoryChangeView[]>
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
  /** WP209：`body` 是这一段现在的正文（技能页的搜索要搜到正文）。 */
  sections: { id: string; heading: string; origin: 'authored' | 'learned'; body?: string }[]
  overlays: SkillOverlayView[]
  pending_proposals: number
  /* ── WP209 技能页「先分类、再展开」：以下几格**只加**，老服务进程不回也照样能看 ── */
  /** 给人看的名字（SKILL.md frontmatter 的 `display_name` / `display_name_en`）。 */
  display_name?: { zh: string; en: string }
  /** 一句话说明（frontmatter 的 `summary` / `summary_en`）。 */
  summary?: { zh: string; en: string }
  /** frontmatter 的 `description` 原文（问号里放它）。 */
  description?: string
  /**
   * 归在哪几个岗位下：职责 yml 的 `skills:` 反查 + frontmatter 的 `positions`。
   * `common` = 通用（不属于哪个岗位，或者只挂在 `common.*` 职责上）。
   */
  positions?: SkillPositionRef[]
  /** 哪几条职责在用它（职责 yml 的 `skills:` 反查）。 */
  roles?: SkillRoleRef[]
  /** 本人名下有没撤销的职责在用它。 */
  in_use?: boolean
  /**
   * WP397：这一本从哪来（frontmatter 的 `origin`）。`official` = 平台官方技能原样收录
   * （Shopify、Amazon 官方卖家技能）；`adapted` = 改写自开源。我们自己写的不回。
   */
  origin?: 'official' | 'adapted'
}

/** WP209：技能归属的一个岗位。 */
export interface SkillPositionRef {
  id: string
  name: { zh: string; en: string }
  /** 本人在这个岗位下有职责（技能页把这些组排前面）。 */
  mine: boolean
}

/** WP209：在用这个技能的一条职责。 */
export interface SkillRoleRef {
  role_id: string
  name: { zh: string; en: string }
  /** 这条职责挂在哪几个岗位下（没有 = 通用职责）。 */
  position_ids: string[]
  /** 本人持有这条职责。 */
  mine: boolean
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
  /**
   * 05 §4 解析完三层额度之后的写动作。**可选**：老的装配没给这一格也照常跑
   * （`/v1/positions/:id/ontology` 会当成"这条岗位没有可提议的动作"）。
   */
  actions?: EffectiveAction[]
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
  /**
   * WP462：人在确认卡上点了「确认」——把这条分配接到职责现在的版本（宿主记一条
   * `assignment.role_major_upgraded`）。回接上之后的版本；本来就对得上回 `undefined`。可选：没装的宿主回 501。
   */
  reconfirmAssignment?(id: AssignmentId): { role_id: string; from: string; to: string } | undefined
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
  /**
   * WP140（docs/78 阻断 #3）：限流桶用的**墙钟**（毫秒）。不给就是 `Date.now`。
   *
   * 限流防的是真实世界里的刷接口，和合成时间无关：demo 注入的合成时钟只在批卡 / 跳时间时
   * 才往前走，桶挂在它上面就「用完永不回血」。所以令牌桶一律按真实时间回血；这个口子
   * 只给测试换一个可拨的墙钟。幂等表的保留时长仍走注入的 `Clock`。
   */
  wallClockMs?: () => number
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
  /**
   * 决策 945：服务开给局域网（NAS / 任何非回环访问）时，主人第一次进门用的**一次性设置码**。
   * 码只印在服务日志里（能看日志的人 = 管这台机器的人），对上了就作废、再印一个新的。
   * 给了就开 `POST /v1/auth/setup-code`；本机档不给。
   */
  ownerSetupCode?: OwnerSetupCodePort
  /**
   * 决策 942（WP371）：托盘「在浏览器打开」直接进。给了 true（且配了 `sessionKey`）就开
   * `POST /v1/auth/browser-link`：桌面壳拿会话密钥换一条给主人的一次性登录 token
   * （15 分钟、用一次就废），交给系统浏览器。**只在本机档开**（服务只听 127.0.0.1 / ::1）；
   * 局域网档（决策 945）、托管档一律不给。
   */
  browserLink?: boolean
  /**
   * 决策 944（WP371）：浏览器会话（`POST /v1/auth/verify` 换来的那张）活多久。
   * apps/server 给 30 天（`identity.ts` 的 `BROWSER_SESSION_TTL_MS`）；不给就是身份服务的默认（12 小时）。
   * 桌面壳那张（`POST /v1/auth/session`）不受影响。
   */
  browserSessionTtlMs?: number
  /**
   * 决策 943（WP371）：本机成员用工坊账号（邮箱 + 6 位验证码）证明身份进工作区。
   * 给了就开 `POST /v1/auth/account/code` 与 `POST /v1/auth/account/verify`。
   */
  accountLogin?: AccountLoginPort
}

/**
 * 决策 943：用工坊账号认人。本机服务进程替页面去问云端「这个邮箱 + 验证码对不对」，
 * 云端说对就回那个账号的邮箱；云端那张会话当场注销，**本机不留同事的云令牌**。
 */
export interface AccountLoginPort {
  /** 发一封 6 位登录验证码（没注册的邮箱云上静默不发，回包一样）。 */
  sendCode(input: { email: string; locale: 'zh' | 'en' }): Promise<{ expires_at: string }>
  /** 验码：对上了回云端账号的邮箱（小写）；对不上抛 `ApiError`（原样带回云的原因）。 */
  verifyCode(input: { email: string; code: string }): Promise<string>
}

/** 决策 945：一次性设置码。对上了返回该以谁的身份进（主人的邮箱，现取），对不上返回 undefined。 */
export interface OwnerSetupCodePort {
  redeem(code: string): Promise<string | undefined>
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
  /**
   * WP181：按官方「自动化任务」的时间写法改时间（右栏定时任务面板的「每天 / 每周几点」）——
   * `daily` / `weekly` / `cron` / `every_seconds` / `at` 恰好一个，形状照官方工具参数。
   * 只对用官方规则建的任务有效；校验与下一次怎么算都是官方的。
   */
  rule?: Record<string, unknown> | undefined
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
  /**
   * WP415（只加）：一张卡这一步接没接通（执行器登记表 × 运行形态）。卡片投影时问它：
   * `not_wired` 的卡不出「通过」、决定时也批不了；`demo` 的卡标「演示」。不给 = 不标（老行为）。
   */
  executionWiring?: (item: ApprovalItem) => ExecutionWiring | undefined
  /**
   * WP194（只加）：一次请求绑定好分配之后，路由在这个作用域里跑。宿主用它开一个
   * 「这一次算在谁头上」的作用域（本机公司成员 + 岗位），底下打云的客户端据此带归属头。
   * 不给 = 直接跑（老行为）。
   */
  requestScope?: (
    scope: { person_id: PersonId; assignment: Assignment },
    next: () => Promise<void>,
  ) => Promise<void>
  halt: Halt
  /**
   * WP215（只加）：**这个品牌自己的**急停视图（全局急停 + 品牌急停合起来）。给了就在
   * 标了 `outbound` 的路由上按主体所在品牌再判一次——品牌 B 按了急停，B 的施行与发送被拦，
   * A 照常。不给 = 只看全局那一份（老行为）。
   */
  brandHalt?: (workspace_id: string) => Halt | undefined
  trace: Trace
  clock: Clock
  eventLog: EventLogPort
  modules: ModulesPort
  approvals: ApprovalBus
  /**
   * WP414（只加）：「发送 / 通过」之后问「要一起发吗」用——给一张刚批了的卡和同一个人、同一条职责的
   * 待处理卡，回其中**像**的（宿主用现有的相似度工具算）。不给 = 不问（老行为）。
   */
  similarCards?(
    leader: ApprovalItem,
    pool: readonly ApprovalItem[],
  ): SimilarCard[] | Promise<SimilarCard[]>
  /**
   * WP414（10-19 更正，只加）：「不要 / 稍后」**给了理由**之后，按这条理由逐张判候选卡是不是也属于这种情况
   * （AI 判；词重合只做预筛），回判为是的（每张一句为什么）。不给 = 不跟随。
   */
  judgeByReason?(input: ReasonJudgeInput): Promise<SimilarCard[]>
  /**
   * WP174：`scope_manager` 的卡落到谁（岗位上级 → 老板）。`POST /v1/approvals` 给了
   * `rule: 'scope_manager'` 却没给收件人时用它；没装配就照旧落在提的人自己身上。
   */
  routeScopeManager?(input: {
    workspace_id: WorkspaceId
    role_id: RoleId
    proposer: PersonId
  }): Promise<Recipient>
  /**
   * WP421（只加）：卡上点了「改一下」（指导，作用域「这一条」）之后**按指导重写**。
   * 不是 AI 跑出来的卡（B2B 询盘首回 / 报价单这类由服务端起草的）没有运行可以接着改——宿主在这里按卡的种类
   * 重起草、出一张新卡。回新卡的 id；这种卡不归它管 / 重写不了回 `undefined`（界面照旧）。不给 = 老行为。
   */
  redraft?(input: {
    item: ApprovalItem
    text: string
    person_id: PersonId
    assignment_id: string
  }): Promise<{ approval_item_id?: string; message: string } | undefined>
  changes: ChangesPort
  /**
   * WP95（36 §11，`docs/upstream/sidebar-compare.md` #11）：一条变更改了哪几个文件。
   * 没装配时 `GET /v1/changes/:id/files` 回 `not_implemented`——第三栏的
   * 「变更审阅」面板照实说"这台机器上没有这份工作副本"，其余照常。
   */
  changeFiles?: ChangeFilesPort
  guardrails: GuardrailPort
  knowledge: KnowledgePort
  skills: SkillsPort
  roles: RolesPort
  /** 36 工作台面（首页 / 岗位 / 积木）；没装配时那几条路由回 not_implemented。 */
  workstation?: WorkstationPort
  /**
   * WP69（54）岗位面：岗位实体、从岗位开一件事、换职责。
   * 没装配时 `GET /v1/positions/:id`、`POST /v1/positions/:id/matters`、
   * `POST /v1/matters/:id/reroute` 回 not_implemented——工作台照常能用，
   * 只是少了"交给这个岗位一件事"那个按钮。
   */
  positions?: PositionEntryPort
  /**
   * WP120（69 §4）：角色定位面——右栏「角色」面板看的与改的就是它。
   * 没装配时 `/v1/personas*` 回 not_implemented：提示里照样有 persona
   * （那是包里的原文），只是公司改不了它。
   */
  personas?: PersonaPort
  /**
   * WP284（决策 275）：职责规矩里那几句「以后都这样」（看 / 改 / 删）。
   * 没装配时 `/v1/roles/:id/rules*` 回 not_implemented。
   */
  roleRules?: RoleRulesPort
  /**
   * WP428（决策 1244 改）：全自动——够条件 → 建议开、人点了才开、随时能关（`/v1/autopilot*`）。
   * 没装配时回 not_implemented。
   */
  autopilot?: AutopilotPort
  /** WP483（决策 1660）：岗位上的「发之前让我看一眼」（`/v1/write-review`）。没装配时回 not_implemented。 */
  writeReview?: WriteReviewPort
  /**
   * WP323（docs/102 §5）：发出记录与记录去处 `/v1/outbound/*`。
   * 没装配时回 not_implemented。
   */
  outbound?: OutboundPort
  /**
   * WP284（docs/95 §5）：「以后都这样」那张策略卡发给谁批。③ 回老板（与改职责规矩同一条路）；
   * ① ② 回 `undefined` = 写指导的本人自己点。不给 = 一律本人（老行为）。
   */
  instructionRuleApprover?(workspace_id: WorkspaceId): MaybePromise<PersonId | undefined>
  /**
   * WP68（48 §5.4）：本地红人库。没装配时 `/v1/kol/*` 回 not_implemented——
   * 红人营销那五条职责的面板照常读得到（投影是装配期塞进去的），
   * 只是没有任何增删改的入口。
   */
  kol?: KolPort
  /**
   * WP119（68）：浏览器插件的本地一面。没装配时 `/v1/extension/*` 回
   * not_implemented——工作台的连接页照实说「这台机器上还没有插件那一面」，
   * 其余一切照常。插件的数据**只走本机**：它连的是 `127.0.0.1`，不是云。
   */
  extension?: ExtensionPort
  /**
   * WP313（docs/101 §5.4）：插件动作通道（广告后台）。没装配时那几条路由回 not_implemented，
   * 插件照实说「这个版本还没有」。插件的会话仍由 {@link extension} 那一套令牌判。
   */
  extensionActions?: ExtensionActionsPort
  /**
   * WP345（决策 871）：插件随工坊安装与更新（固定文件夹在哪、里面是哪一版；插件报版本、问新版）。
   * 没装配时那三条路由回 not_implemented——连接卡退回只出配对码那一块。
   */
  extensionInstall?: ExtensionInstallPort
  /**
   * WP360（决策 947）：需要插件的岗位一开始就引导装好插件（要不要、配上没有、还差哪步、稍后、接方案卡）。
   * 没装配时那三条路由回 not_implemented——岗位页顶上就不出那张卡。
   */
  extensionOnboarding?: ExtensionOnboardingPort
  /**
   * WP413（真机联调 R1）：插件常驻侧边栏（进度 / 要你处理 / 记录）。没装配时 `/v1/extension/panel*` 回
   * not_implemented，插件侧边栏照实说「先升级 Agents 工坊」。会话仍由 {@link extension} 那一套令牌判。
   */
  extensionPanel?: ExtensionPanelPort
  /**
   * WP328（docs/102）：Reddit 每日巡查（插件只读 + 工作台看 / 改 / 现在巡查 / 周汇总）。
   * 没装配时那几条路由回 not_implemented。插件的会话仍由 {@link extension} 那一套令牌判（scope `reddit.read`）。
   */
  redditWatch?: RedditWatchPort
  /**
   * WP392（docs/104）：竞品监控（工作台看各监控源状态 / 竞品变化表 / 改频率 / 现在读一次）。
   * 没装配时那几条路由回 not_implemented。
   */
  competitorWatch?: CompetitorWatchPort
  /**
   * WP396（docs/106 §13）：自家 Amazon Listing 体检（面板看最近一次 / 现在体检 / 改规则）。
   * 没装配时那几条路由回 not_implemented。
   */
  amazonListing?: AmazonListingPort
  /**
   * WP73（56 §6）：本地社媒库。没装配时 `/v1/social/*` 回 not_implemented——
   * 社媒运营那九条职责的面板照常读得到（投影是装配期塞进去的），
   * 只是没有任何增删改的入口。
   */
  social?: SocialPort
  /**
   * WP76（58 §5）：本地设计库。没装配时 `/v1/design/*` 回 not_implemented——
   * 设计岗位那五条职责的面板照常读得到（投影是装配期塞进去的），
   * 只是没有任何增删改的入口。
   */
  design?: DesignPort
  /**
   * WP77（59 §1 / §2）：建站数据面。没装配时 `/v1/site/*` 回 not_implemented——
   * 建站那四条职责的检查单、邮件模板与 App 清单要它才动得了。
   */
  site?: SitePort
  /**
   * WP75（57 §5）：这个品牌的广告库那一面（`/v1/ads/*`）。
   *
   * 不给 = 这个服务进程没装投放岗位，那几条路由一律 `not_implemented`
   * ——**不是** 404：路由在那儿，只是这台机器上没有广告库。
   */
  ads?: AdsPort
  /**
   * WP317（docs/101 §5.1④）：素材流水线那一面（`/v1/ads/creative/*`）。
   * 不给 = 没装配，那几条路由回 `not_implemented`。
   */
  adCreative?: AdCreativePort
  /**
   * WP78（60 §5）：本地公关库。没装配时 `/v1/pr/*` 回 not_implemented——
   * 公共关系那四条职责要它才动得了。
   */
  /** WP172（docs/84）：B2B 库（`/v1/b2b/*`）。不给 = 那几条路 501。 */
  b2b?: B2bPort
  /** WP173（docs/84 §2）：开发信序列（`/v1/b2b/outbound/*`）。不给 = 那几条路 501。 */
  b2bOutbound?: B2bOutboundPort
  /** WP182（docs/84 §3）：业务——事实卡、报价单、样品（`/v1/b2b/sales` 等）。不给 = 那几条路 501。 */
  b2bSales?: B2bSalesPort
  pr?: PrPort
  /**
   * WP154「内容与搜索」：问题清单与"现在跑一轮"。没装配时 `/v1/seo/*` 回 not_implemented。
   */
  seo?: SeoPort
  /** 37 工作模型（事项 / 目标 / 待办 / 日历 / 计划 / 复盘）；没装配时那几条路由回 not_implemented。 */
  work?: WorkPort
  /**
   * WP207：左栏职责下的对话 / 任务、自动归档与找回。没装配时 `/v1/work/rail|archived|search`、
   * `/v1/matters/:id/unarchive`、`/v1/settings/work-archive` 回 not_implemented——左栏照常列岗位与职责。
   */
  workArchive?: WorkArchivePort
  /**
   * WP276（docs/95 §4）：交给对方（`/v1/handoffs*`、`/v1/work/colleagues`）。没装配时回 not_implemented。
   */
  handoff?: HandoffPort
  /**
   * WP276：这个品牌现在是不是 ② 同事互联（同步；`peersBypass` 问它）。不给 = 永远不是。
   */
  peerAccess?: (workspace_id: WorkspaceId) => boolean
  /** 37 §4 会议内核；没装配时 `/v1/meetings/*` 回 not_implemented。 */
  meetings?: MeetingsPort
  /**
   * WP113（63）：消息——统一收件处。没装配时 `/v1/messages/*` 回 not_implemented——
   * 左栏的「消息」照实说"这台机器上还没连邮箱"，工作台其余一切照常。
   */
  messages?: MessagesPort
  /** WP20 连接面（连接向导 / 凭据原生表单直填）；没装配时 `/v1/connections/*` 回 not_implemented。 */
  connections?: ConnectionsPort
  /**
   * WP83（54（将改号 55）§4）：连接目录与岗位连接清单。
   * 没装配时 `/v1/connection-directory*` 与 `GET /v1/positions/:id/connections`
   * 回 not_implemented——连接页与岗位页照常能用，只是少了"添加连接"那一屏
   * 与岗位页那张"连上这 N 个就能开工"的卡。
   */
  connectionDirectory?: ConnectionDirectoryPort
  /**
   * WP82（55 §3 末段）：这台机器上的浏览器怎么配。
   * 没装配时 `/v1/settings/browser*` 回 not_implemented——不配浏览器照常能用，
   * 只是没有哪条职责开得了浏览器（`RunRequest.browser` 一直是空的）。
   */
  browser?: BrowserPort
  /**
   * WP236：运行时长线（空闲超时 / 总时长上限）。没装配时 `/v1/settings/run-limits` 回 not_implemented，
   * 运行照缺省（空闲 3 分钟、总时长 20 分钟）。
   */
  runLimits?: RunLimitsPort
  /** WP341 追加（849）：外部图片白名单（品牌级）。 */
  imageHosts?: GenuiImageHostsPort
  /** WP320：「自动记忆」开关。没装配时 `/v1/settings/auto-memory` 回 not_implemented。 */
  autoMemory?: AutoMemoryPort
  /** WP429：站内通知。没装配时 `/v1/notifications*` 回 not_implemented。 */
  notifications?: NotificationsPort
  /** WP475：左下角「反馈」。没装配时 `/v1/feedback*` 回 not_implemented。 */
  feedback?: FeedbackPort
  /** WP476：「帮助改进工坊（匿名使用数据）」开关。没装配时 `/v1/settings/telemetry` 回 not_implemented。 */
  telemetry?: TelemetrySettingsPort
  /**
   * WP136（docs/79）：dsh 场景切换（列 / 建 / 删自建 / 起停网页场景）。
   * 只有本机档装配；没装配时 `/v1/dsh-scenes*` 回 not_implemented。
   */
  dshScenes?: DshScenesPort
  /**
   * 教程上官网（私有 docs/113）：右栏「教程」的目录与正文（官网拉回来的 / 随包的）。
   * 没装配时 `/v1/help/*` 回 not_implemented。
   */
  help?: HelpPort
  /**
   * WP155（docs/81）：搜索数据接口（连接页那一行 + SERP / AI 问答探测）。按品牌取。
   * 没装配时 `/v1/search-data*` 回 not_implemented。
   */
  searchData?: SearchDataApiPort
  /**
   * WP265：连接页 Shopify 卡的一键授权（接私有云 WP263）。按品牌取（令牌是品牌那一把）。
   * 没装配时 `/v1/shopify-connect*` 回 not_implemented。
   */
  shopifyConnect?: ShopifyConnectPort
  /**
   * WP246（决策 87 / 88）：取数路线（体检、设置、Reddit 读号）。按品牌取。
   * 没装配时 `/v1/settings/read-routes*` 与 `/v1/settings/reddit-read-account/*` 回 not_implemented。
   */
  readRoutes?: ReadRoutesApiPort
  /**
   * WP254（决策 100 / 123）：下载源（官方源 / 国内源，每台机一份）。
   * 没装配时 `/v1/settings/npm-registry` 回 not_implemented。
   */
  npmRegistry?: NpmRegistryPort
  /**
   * WP192（docs/83 §4）：官方数据接口统一能力口（能力清单、同步调用、异步任务）。按品牌取。
   * 没装配时 `/v1/data-service*` 回 not_implemented。
   */
  dataService?: DataServiceApiPort
  /**
   * WP390（docs/105）：工坊服务（目录缓存、看看 / 交给工坊办、订单面板）。按品牌取。
   * 没装配时 `/v1/workshop-services*` 回 not_implemented。下单 / 验收都走卡（`service_order`），不在这里。
   */
  workshopServices?: WorkshopServicesApiPort
  /** WP31 本机秘密库密钥轮换；没装配时 `POST /v1/secrets/rotate` 回 not_implemented。 */
  secrets?: SecretsPort
  /**
   * WP58（49 M1）：这台机器上的工作区有没有关联 agentsws 云账号。
   * 没装配时 `/v1/cloud/account/*` 回 not_implemented——云账号是加分项，
   * 不接它的发行版照常能用（"用我的 key"那一档，49 M2 的默认）。
   */
  cloudAccount?: CloudAccountPort
  /** WP40 数据后端（41 §2.4 的三档与迁移向导）；没装配时 `/v1/storage/*` 回 not_implemented。 */
  storage?: StoragePort
  /**
   * WP60（49 §6 / 48 L6）：在线值守。没装配时 `/v1/standby*` 回 not_implemented——
   * 值守是托管档的一项增值能力，不是工作台的前提。
   */
  standby?: StandbyPort
  /** WP25 模型面（provider 配置 / 默认模型 / 预算 / 花费）；没装配时 `/v1/models/*` 回 not_implemented。 */
  models?: ModelsPort
  /**
   * WP59（49 M2 / M5）：云上的余额与价目在本地的投影 + 每项能力"用我的 / 用 agentsws 的"。
   * 没装配时 `/v1/cloud/*` 与 `/v1/settings/capability-sources` 回 not_implemented——
   * 不接云也照常能用（那正是"用我的"那一档）。
   */
  cloud?: CloudPort
  /**
   * 41 §1 秘书面（profile 与公开级别 / 代答 / 日程与约时间 / 任务路由）；
   * 没装配时 `/v1/me/*` 的秘书那几条与 `/v1/people/*` 回 not_implemented。
   * 工作台照常能用——秘书是加分项，不是首页的前提。
   */
  secretary?: SecretaryPort
  /**
   * WP28 制度面（05 职责 / 岗位 / 分配 / 策略层 + 20 成员与邀请）；
   * 没装配时 `/v1/roles`、`/v1/org/*`、成员与邀请那几条回 not_implemented。
   */
  org?: OrgPort
  /**
   * WP51（46）：首次设置向导、同事发现、邀请码与申请加入。
   * 没装配时 `/v1/onboarding/*`、`/v1/discovery/*`、`/v1/invites`、`/v1/memberships/*`
   * 回 not_implemented——向导是加分项，没有它工作台照常能用（只是第一次打开时没人带路）。
   */
  onboarding?: OnboardingPort
  /**
   * WP121（70 §3）：贴一个网址自动分析出品牌档案。
   * 没装配时 `/v1/brand-intake/*` 回 not_implemented——向导第 ② 步退回手填，
   * 与"还没有网站"那条旁路走同一条路。
   */
  brandIntake?: BrandIntakePort
  /**
   * WP122（71）：每个品牌一份 DESIGN.md。
   * 没装配时 `/v1/brand-design/*` 回 not_implemented——四个出活的岗位照常干活，
   * 只是提示词里不注入品牌令牌（`brandDesignContext()` 回 `present: false`）。
   */
  brandDesign?: BrandDesignPort
  /**
   * WP65（52 O1）：组织（公司）与它下面的品牌工作区。
   * 没装配时 `/v1/orgs/*` 回 not_implemented——多品牌是加分项，
   * 一个品牌的工作台不装它照常能用。
   */
  organizations?: OrganizationsPort
  /**
   * WP50 Join 向导（20 §4–§5、45）：个人工作区并进公司的对照 / 合并 / 退出。
   * 没装配时 `/v1/join/*` 回 not_implemented。
   */
  join?: JoinPort
  /** 36 §3「问 AI」；不给的话那条路回 not_implemented。 */
  ask?: AskPort
  /** WP188「随便聊」；不给的话 `/v1/free-chat/*` 回 not_implemented。 */
  freeChat?: FreeChatPort
  /**
   * WP57（48 §4 L3 #11）：网站在线客服。没装配时 `/v1/chat/*` 回 not_implemented——
   * 在线客服是一条职责，不是工作台的前提。
   */
  chat?: ChatPort
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
   * WP298：前端报错（`POST /v1/client-errors`）写到哪。网关已经洗过、截过长、限过流；
   * 宿主只管落一行日志。不装配时照收照答，只是不落（嵌入式用法 / 云端）。
   */
  clientErrors?: ClientErrorPort
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
  /**
   * WP144（docs/80）：电脑操控——总开关、可以操作电脑的职责、驱动与自检、正在操作 / 停止。
   * 一台机器一份，只有本机档装配得上有意义的内容；没装配时
   * `/v1/settings/computer-use*` 与 `/v1/computer-use/*` 回 not_implemented。
   */
  computerUse?: ComputerUsePort
  /**
   * WP180：设置 →「官方插件」——装 / 升级 / 卸载出卡、只从审过的清单装；运行中保存配置只许写非锁定行。
   * 一台机器一份；没装配时 `/v1/settings/official-plugins*` 回 not_implemented。
   */
  officialPlugins?: OfficialPluginsPort
  /**
   * WP219（docs/90）：设置 → 通用「已审的内容更新」——自动 / 每次问我、现在查一次、更新、退回、查看改动。
   * 按品牌；没装配时 `/v1/settings/content-updates*` 回 not_implemented（设置页那一行不出）。
   */
  contentUpdates?: ContentUpdatesPort
  /**
   * WP406（私有 docs/107）：岗位更新——第三栏「设定 · 岗位更新」与「挑着看」、订阅、现在查一次。
   * 按品牌；没装配时 `/v1/content-updates/*` 回 not_implemented（第三栏那一页不出）。
   */
  contentDigest?: ContentDigestPort
  /**
   * WP216：这个品牌的平台专属那一套（官方技能 / 官方 MCP / 官方 CLI）。按品牌档案判断；
   * 没装配时 `/v1/platform-kit*` 回 not_implemented。
   */
  platformKit?: PlatformKitPort
  /**
   * WP261（决策 175 第 1 步）：「授权管理商品和页面」那一行（Shopify CLI `store auth`）。按品牌；
   * 没装配时 `/v1/shop-admin*` 回 not_implemented（岗位页那一行不出）。
   */
  shopAdmin?: ShopAdminPort
  /**
   * WP268（决策 213）：品牌素材库（列 / 取原图 / 传一张）。按品牌；没装配时 `/v1/brand-assets*` 回 not_implemented。
   */
  brandAssets?: BrandAssetsPort
  /**
   * WP215（52 §4 收口）：每个品牌一套后台——状态、全进程并发上限、品牌急停。
   * 没装配时 `/v1/settings/background*` 回 not_implemented。
   */
  background?: BackgroundPort
  /**
   * WP225（WP218 决定 ③）：岗位 AI 正在干活没有（跨品牌，只回数量）。桌面壳「重启并更新」前问它；
   * 没装配时 `GET /v1/activity` 回 not_implemented（壳当「不知道」，不拦）。
   */
  activity?: ActivityPort
  /**
   * WP224（docs/91 §2.2 #1 / #3）：毛利率事实卡、两条止损线对照、本周经营一页纸。
   * 没装配时 `/v1/economics/*` 回 not_implemented。
   */
  economics?: EconomicsPort
  /**
   * WP337：重启并更新前看一眼 / 暂停全部 / 没重启成放开。没装配时 `/v1/update/*` 回 not_implemented
   * （壳当「不知道」：不弹三选一、照旧问一句就重启）。
   */
  updatePause?: UpdatePausePort
  /** WP381：网站 / 商品体检与 AI 来源流量。没装配时 `/v1/site-health*` 回 not_implemented。 */
  siteHealth?: SiteHealthPort
  /** WP398：Amazon 词库。没装配时 `/v1/amazon-keywords*` 回 not_implemented。 */
  amazonKeywords?: AmazonKeywordsPort
}

/**
 * 36 工作台端口。
 *
 * 「岗位」= 一个人对某职责在某范围上的持有，也就是一条 Assignment（`position_id === assignment_id`），
 * 所以工作台的每个页面天然对应一个 `X-Assignment`，不会出现跨 Assignment 并集（31 §3.1）。
 *
 * 网关只做装配与校验，数从 `@agentsws/deck` 的命名查询里算（29 原则 ③「数字不经模型手」）。
 */
/** WP298：一条前端报错（已洗：没有查询串、没有个人数据；每段都截过长度）。 */
export interface ClientErrorEntry {
  kind: 'boundary' | 'panel' | 'error' | 'rejection' | 'preload' | 'other'
  name: string
  message: string
  stack?: string
  route: string
  scope?: string
  app_version?: string
  user_agent?: string
}

export interface ClientErrorPort {
  record(entry: ClientErrorEntry): void
}

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
  /**
   * WP462（只加）：这条职责升了大版本、这条分配要重新确认才接着用（自动接不上的那一种）。
   * 有这一格时 `ready` 为 false，界面就地出一张确认卡（点了走 `POST /v1/assignments/:id/reconfirm`）；
   * 别的岗位、职责照常。老前端不读它，照旧只看到这一条「没就绪」。
   */
  needs_reconfirm?: RoleReconfirmView
}

/** WP462：确认卡要的那几格（与 `@agentsws/roles` 的 `RoleUpgradeNeeded` 同形）。 */
export interface RoleReconfirmView {
  reason: 'role_major_upgraded'
  assignment_id: string
  role_id: string
  role_name: string
  from: string
  to: string
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
   * WP278（决策 284）：发给本人、挂在**底座职责**（`common.*`）上的卡——不管他手上有没有那条底座分配
   * （② 里「有人申请加入」挂在 `common.owner` 上，却是发给每个人的）。只有一个岗位的人首页就是岗位页，
   * 岗位页按岗位里的职责筛卡，这些卡要另外收进来。不实现 = 不收。
   */
  baseItems?(actor: WorkstationActor): MaybePromise<ApprovalItem[]>
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
  /**
   * WP66（52 O1）：**按品牌**把 ObjectRef 翻成人话。
   *
   * `label` 没有 actor——它是同步的、在拼卡片时一条一条调的。装了多品牌的进程
   * 必须知道翻的是哪个品牌的订单 / 客户，否则 A 的客户名会出现在 B 的卡片上。
   * 不实现就退回 `label`（单品牌装配一行不变）。
   */
  labelFor?(actor: WorkstationActor, ref: ObjectRef): string | undefined
  /** 36 §3：换 / 增减数字块与时间范围，跟随岗位记忆。 */
  setHomeTiles(
    actor: WorkstationActor,
    input: { position_id: AssignmentId; tile_ids: string[]; range?: WorkstationRange },
  ): MaybePromise<PositionSummary>
  /**
   * WP438（决策 1336）：固定下来的 AI 报表与每份报表的快照。不实现 = 只有默认报表、没有历史（内存档的老装配）。
   */
  reports?: ReportStorePort
}

/** WP438：一份固定下来的报表（AI 做的；默认报表不进库，写在 deck 的表里）。 */
export interface SavedReport {
  workspace_id: string
  person_id: string
  spec: DeckReportSpec
  /** 固定到哪个岗位（模板 id）。 */
  position: string
  /** 职责层也固定在这条职责上（不给 = 只在岗位层）。 */
  duty?: string
  pinned_at: string
  /** 改过几次（「问 AI」接着改一次 +1）。 */
  version: number
}

export interface ReportSnapshotMeta {
  at: string
  range: string
}

/**
 * WP438（决策 1336 甲）：报表的存放处——固定的 AI 报表（活的：存规格不存图）+ 每次重算留的快照（往回翻）。
 * 草稿（对话里刚出、还没点「固定」的那一份）只在内存里。
 */
export interface ReportStorePort {
  list(workspace_id: string, person_id: string): MaybePromise<SavedReport[]>
  get(workspace_id: string, id: string): MaybePromise<SavedReport | undefined>
  save(report: SavedReport): MaybePromise<void>
  remove(workspace_id: string, id: string): MaybePromise<void>
  putDraft(workspace_id: string, spec: DeckReportSpec): void
  draft(workspace_id: string, id: string): DeckReportSpec | undefined
  snapshots(workspace_id: string, id: string): MaybePromise<ReportSnapshotMeta[]>
  snapshot(workspace_id: string, id: string, at: string): MaybePromise<DeckReportData | undefined>
  addSnapshot(workspace_id: string, data: DeckReportData): MaybePromise<void>
}
