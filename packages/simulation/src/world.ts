/**
 * 世界装配：把**同一份生产代码**的外部边界指向替身（09 §3.1「真实内核」）。
 *
 * 内核（事件日志）+ 数据层 + 制度（职责 / 分配 / 策略层）+ 知识 + 模型网关 + 交易控制模块
 * 全部是真实实现；只有 provider（mock OpenConnector）、模型（stub）、人（合成人）、
 * 时钟（合成时钟）、投递（收件箱）、入站（内存管线）是替身。
 */

import {
  compareJoinBundle,
  deriveStoreRanges,
  joinSummary,
  mergeOrgPair,
  type OrgAlias,
  rewriteAliasedAssignments,
} from '@agentsws/catalog'
import type {
  ApprovalItem,
  Assignment,
  ChangeKind,
  DataRecord,
  EventEnvelope,
  InboundEvent,
  Iso8601,
  JoinExportBundle,
  JoinObjectComparison,
  JoinResolution,
  KolChannel,
  KolUtm,
  Mandate,
  ModelGateway,
  ModelProvider,
  ModelRef,
  ObjectRef,
  PersonId,
  PlatformAccount,
  ProductLineRule,
  ProvenanceState,
  RangeRef,
  RoleId,
  RunEvent,
  RunOutput,
  RunRequest,
  RuntimeAdapter,
  RunUsage,
} from '@agentsws/contracts'
import {
  DEFAULT_STOREFRONT_PLATFORM,
  // WP72：渠道 id → 职责 id 与中文名。**全仓唯一**那张渠道清单，不在这里拼字符串
  socialChannelSpec,
  storefrontUnsupportedNote,
  storefrontUsableService,
} from '@agentsws/contracts'
import { companyKey, sha256, suppressedRecipients, withoutSuppressed } from '@agentsws/core'
import type { DataActor, SqliteDataStore } from '@agentsws/data'
import { createDataStore, defineCollection } from '@agentsws/data'
import { assembleView, dataSourcesFromConnections } from '@agentsws/deck'
import type { DshRuntimeMode } from '@agentsws/dsh-adapter'
import { createDshRuntime } from '@agentsws/dsh-adapter'
import type { Kernel, Random } from '@agentsws/kernel'
import { createKernel, seededRandom } from '@agentsws/kernel'
import type { Knowledge } from '@agentsws/knowledge'
import {
  contentHashOf,
  createKnowledge,
  describeFactKeyZh,
  RECHECK_OPTIONS,
} from '@agentsws/knowledge'
// WP67（48 §5.2）：红人那几件事用的是与本体**同一份**纯逻辑，场景里不另写一套
import {
  applyUtm,
  attributeOrders,
  buildUtm,
  canAdvanceCollaboration,
  collaborationStageName,
  draftOutreach,
  planCampaign,
  reviewOutreachBody,
} from '@agentsws/kol-core'
/*
 * WP68（48 §5.3）：云端公共红人库在世界里**真的跑一份**。
 *
 * 用那一份真服务（真钱包、真价目、真加密）而不是一个替身：这条题要钉的是
 * "浏览免费、reveal 扣积分、余额不够回人话"，而这三件事全是那一份代码算出来的。
 */
import { KolPublicService, MemoryKolStore, nodeKolSecrets } from '@agentsws/kol-public'
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import type { ModelGatewayApi, ModelGatewayPolicy, PriceTable } from '@agentsws/model-gateway'
import { createModelGateway, ProviderError, stubProvider } from '@agentsws/model-gateway'
import type { EffectiveConfig, RoleStore } from '@agentsws/roles'
import {
  createRoleStore,
  loadBundledRole,
  parseRole,
  productLineMatches,
  type RangeExpanded,
  rangeTargetOfProduct,
} from '@agentsws/roles'
import {
  aftersalesBrainProvider,
  createDirectRuntime,
  groundingInputFor,
  withToolChoice,
} from '@agentsws/runtime-direct'
import { wallClock } from '@agentsws/schedule'
/*
 * WP72（56 §2 / §3）：社媒那三件事共用的能力。
 *
 * `triageThread` / `handoffOf` 是 56 那条边界的落点（客户问题转客服）；
 * `checkOutbound` 里的承诺扫描与客服回信读的是**同一份词表**；
 * `buildAudience` 里的抑制名单规则与邮件群发是**同一个函数**。
 * 世界里不另写一份，否则这几条题验的就是场景自己写的答案。
 */
import {
  ACTION_WORDS,
  buildAudience,
  checkOutbound,
  handoffOf,
  type ScheduleConflict,
  scheduleConflicts,
  triageThread,
} from '@agentsws/social-core'
import type {
  CreateDraftResult,
  CreatePolicyQuestionFn,
  DraftPayload,
  MockOpenConnector,
  StageIntent,
  StandIns,
  ToolExecution,
} from '@agentsws/stand-ins'
import {
  connectToolExecutor,
  createStandIns,
  MCP_DOCS_TOOL,
  MCP_SCHEMA_TOOL,
  MCP_VALIDATE_TOOL,
  MemoryInboundPipeline,
  MockDevMcp,
  MockShopifyCli,
  SyntheticClock,
} from '@agentsws/stand-ins'
import {
  AMAZON_CHANNEL,
  buildAmazonChannelMeta,
  buildAmazonRewriteInstruction,
  describeAmazonDetection,
  detectAmazonChannel,
  evaluateAmazonOutbound,
  evaluateAutonomyGates,
  hasRewritableAmazonViolation,
  isMarketplaceRelayAddress,
  summarizeAmazonViolations,
} from '@agentsws/support-core'
import type { Txn } from '@agentsws/txn'
import { createTxn, dedupeKey } from '@agentsws/txn'
import { createWork, type Work } from '@agentsws/work'
import { SimulationError } from './errors.js'
import type {
  AssignmentSnapshot,
  BlockedRecord,
  NotificationRecord,
  OutageWindow,
  RunRecord,
  SamplingReviewRecord,
} from './evidence.js'
import { installLearningLoop, type LearningLoop, type LearningOptions } from './learning.js'
import type { Pack, PackAssignment, PackCustomer } from './pack.js'
import type { DesignLoop } from './design.js'
import type { PositionsLoop } from './positions.js'
import { installDailyRoutine, type Routine, type RoutineOptions } from './routine.js'
import type { RuntimeName } from './runtime-name.js'
import type { SecretaryLoop } from './secretary.js'

const CUSTOMERS = defineCollection({
  name: 'customers',
  domain: 'customer',
  fields: {
    name: { sensitivity: 'internal' },
    email: { sensitivity: 'internal' },
    market: { sensitivity: 'internal' },
  },
})

/**
 * 52 O1（WP65）：店铺连接的最小记录。
 *
 * 这里只需要它有一个 `workspace_id`——"A 品牌的连接在 B 品牌看不见"要靠的就是
 * 数据层那一条过滤，不是这张表长什么样。
 */
const BRAND_CONNECTIONS = defineCollection({
  name: 'connections',
  domain: 'customer',
  fields: {
    service: { sensitivity: 'internal' },
    label: { sensitivity: 'internal' },
    /** WP66：这条连接的凭据在加密库里叫什么**名字**（值不在这儿，也不该在）。 */
    credential_key: { sensitivity: 'internal' },
  },
})

/**
 * WP66（52 O3）：一个品牌自己那一套**模型设置**的最小记录。
 *
 * 与 {@link BRAND_CONNECTIONS} 同一条道理：这张表长什么样不重要，重要的是它
 * 有一个 `workspace_id`——"甲品牌的模型设置在乙品牌看不见"靠的是数据层那一刀。
 * 里面只有"用哪家"这个**决定**与凭据的 key 名，API key 一个字节都不进模拟世界。
 */
const BRAND_MODEL_PROVIDERS = defineCollection({
  name: 'model_providers',
  domain: 'customer',
  fields: {
    label: { sensitivity: 'internal' },
    credential_key: { sensitivity: 'internal' },
  },
})

const messageOfError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 05 §1 动作 id ↔ 15 §2 变更种类。 */
const ACTION_BY_KIND: Partial<Record<ChangeKind, string>> = {
  refund: 'stage_refund',
  reship: 'stage_reship',
  address_change: 'stage_address_change',
  // WP44：运营与建站那一侧
  price_change: 'stage_price_change',
  listing_edit: 'stage_listing_edit',
  publish_product: 'stage_publish_product',
  unpublish_product: 'stage_unpublish_product',
  publish_theme: 'stage_publish_theme',
}

const READ_ACTIONS = [
  'shopify_admin.get_order',
  'shopify_admin.list_orders',
  'shopify_admin.get_product',
  'gmail.list_threads',
]
// 注：WP64 的两条职责读的也是这几个（超期巡检读 list_orders、群发的收件人从订单里来）——
// 邮件营销与物流追踪的连接器还是骨架，所以它们那头一个读口都还没有。
const APPLY_ACTIONS = [
  'shopify_admin.create_refund',
  // WP44：改价的施行口（只在 role-apply 令牌里，Agent 的读令牌拿不到）。
  // 主题不在这儿——它走 CLI，那条路根本不发连接器令牌。
  'shopify_admin.update_product_price',
  // WP64（51 §2.4）：标记发货的施行口。与改价同理——只在 role-apply 令牌里，
  // Agent 那把 role-read 拿不到它。
  'shopify_admin.create_fulfillment',
  // WP63（51 §2.1）：上下架的施行口。与改价同一条路——只有执行器拿得到，
  // 而且只在批准之后（`publish_product` / `unpublish_product` 永远人审）
  'shopify_admin.publish_product',
  'shopify_admin.unpublish_product',
  'gmail.send_message',
]
const CONNECTIONS = ['conn_shopify_admin', 'conn_gmail']
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

export interface RunContext {
  run_id: string
  inbound: InboundEvent
  thread: { id: string; ref: ObjectRef; subject: string; participants: string[] }
  /** 来信人解析出的客户（关系授权门禁的 requester） */
  requester?: { customer: PackCustomer; ref: ObjectRef }
  order?: { id: string; ref: ObjectRef; owner?: ObjectRef }
  change_set_id: string
  /** 本次运行产出的子审批项（staged_change），回信作为父项引用它们 */
  child_approval_ids: string[]
  /** 事件流（stage 时从这里推 provenance） */
  events: RunEvent[]
  request?: RunRequest
}

export interface WorldOptions {
  pack: Pack
  seed: number
  start: Iso8601
  /** 事件日志路径；缺省 `:memory:`（fast 档，26 §4）。 */
  dbPath?: string
  /**
   * 用哪个运行时跑（17 §4）。缺省 `stub`（规则草稿，fast 档）；
   * `dsh` 走 `@agentsws/dsh-adapter`（真 DeepSeek Harness 的 seam）；
   * `direct` = `@agentsws/runtime-direct` 的 turn loop，模型换成同样确定性的"规则脑" provider。
   * 同一条场景在三 / 四个运行时下都要过六条不变量——这就是"运行时可替换"的证据（31 §1 I6）。
   */
  runtime?: RuntimeName
  /**
   * WP32：交易控制模块的时限旋钮（升级 / 过期 / 抽检比例）。
   * 只覆盖给到的字段，其余仍是 14 里定的默认值。
   */
  txnPolicy?: SimulationTxnPolicy
  /**
   * WP32 realistic 档：把 stub provider 换成真模型（经网关，key 只从环境变量取）。
   * 不给就是 fast 档那套确定性 provider。
   */
  model?: RealModelBinding
}

/** 14 §11.6 / §13.2 的两个旋钮 + 过期天数（只覆盖给到的字段）。 */
export interface SimulationTxnPolicy {
  escalation_hours?: { scope_manager?: number; owner?: number }
  sampling_rate?: number
  expiry_days?: Record<string, number>
}

/** realistic 档的真模型绑定（22）。 */
export interface RealModelBinding {
  provider: ModelProvider
  ref: ModelRef
  prices: PriceTable
  /** 每次 `complete` 的成本上限（基准货币）；不给就不额外限制。 */
  max_cost_base?: number
}

export type { RuntimeName } from './runtime-name.js'

export interface World {
  clock: SyntheticClock
  random: Random
  kernel: Kernel
  data: SqliteDataStore
  roles: RoleStore
  knowledge: Knowledge
  txn: Txn
  standIns: StandIns
  /** 17 §4 运行时适配器（`stub` 或 `direct-llm`）。 */
  runtime: RuntimeAdapter
  connect: MockOpenConnector
  inbound: MemoryInboundPipeline
  pack: Pack
  workspace_id: string
  assignment: Assignment
  effective: EffectiveConfig
  agentActor: DataActor
  role_id: RoleId
  owner: PersonId
  roleHolder: PersonId
  /** 14 §7 升级链的第一级（pack 没标就是 owner）。 */
  scopeManager: PersonId
  /** 这个世界实际用的模型（fast 档是 stub，realistic 档是真 provider 的 ref）。 */
  modelRef: ModelRef
  events: EventEnvelope[]
  notifications: NotificationRecord[]
  blocked: BlockedRecord[]
  outages: OutageWindow[]
  /**
   * WP44：店铺操作起的那几次运行。
   *
   * 入站信件起的运行由 runner 自己攒；这几次是人在工作台上点出来的，
   * 世界这边攒着，runner 收证据时并进同一份清单——不然
   * `provenance_respected` 拿着 `run_id` 会查不到"这次运行读过什么"。
   */
  shopRuns: RunRecord[]
  runContexts: Map<string, RunContext>
  /**
   * 25 一天的例行公事（早上计划卡 / 晚上复盘卡 / 复盘后的接力）。
   * 场景里出现 `routine.start` 才装；不装的世界一条定时任务都没有，
   * 调度器每一拍空转，原有场景的指标一个不变。
   */
  routine?: Routine
  /**
   * 37 工作模型（事项 / 待办 / 待认领池）。**总是装**——内存档、没有定时任务，
   * 所以不装 `routine.start` 的世界也一条指标不变；装了的话例行公事用的是同一个。
   */
  work: Work
  startRoutine(options?: RoutineOptions): Routine
  /**
   * WP29 学习回路（lesson 池 / 次日提案 / 采纳落 overlay）。
   * 场景里出现 `learning.start` 才装；不装的世界一条 lesson 都不收，
   * 技能正文也不进 prompt——原有场景的 prompt 字节与指标一个不变。
   */
  learning?: LearningLoop
  startLearning(options?: LearningOptions): LearningLoop
  /**
   * 41 §1 秘书 Agent（profile 与公开级别 / 代答 / 约时间 / 任务路由）。
   * 场景里出现 `secretary.*` 才装；不装的世界一次代答都不跑，原有场景的指标一个不变。
   */
  secretary?: SecretaryLoop
  /**
   * WP69（54）：岗位入口（岗位内路由 → 用被路由到的那条职责的分配起 Run）。
   * 场景里出现 `position.*` 才装；不装的世界一次路由都不跑，原有场景的指标一个不变。
   */
  positions?: PositionsLoop
  /**
   * WP76（58）：设计岗位。**惰性**——场景里没有 `design.*` 就一个都不装
   * （同 `positions`）。判据一个字都不在模拟层：路由走 `routeWithinPosition`、
   * brief 走 `design-core` 的 `draftBrief`、入库的"永远人审"走 guardrail 的
   * `HARD_L1`。
   */
  design?: DesignLoop
  /**
   * WP32：每一拍的审批总线例行公事——过期、升级链、抽检复核、把新投递刷成卡片。
   *
   * 这三件事在真实进程里是定时任务（14 §4.4 §7 §13.2）；模拟回路里合成时钟每推进一拍
   * 就得走一遍，否则"4 小时没人理就升级"这种事在虚拟时间里永远不会发生。
   */
  tickApprovals(): Promise<TickApprovalsResult>
  /** 抽检复核记录（14 §13.2：L2 自动批按比例抽出来给人复核）。 */
  samplingReviews: SamplingReviewRecord[]
  /**
   * soak 档的"进程重启"：关掉事件日志的连接再开一次（21 §1 append-only + 链式哈希）。
   *
   * 边界说清楚：能真重启的只有**事件日志**——交易控制模块的存储在 WP4 里还是内存实现，
   * 关掉就没了。所以这条演练验的是"日志是持久的、重启后链还是完整的、接着写不会断链"，
   * 不是"整个进程崩了还能接着干活"。后者要等 txn 的 SQLite 落盘。
   */
  restartEventLog(): Promise<{ events_before: number; events_after: number; chain_ok: boolean }>
  /** 事件日志文件（`:memory:` 时为 undefined）。soak 档要看它有没有上界。 */
  dbPath?: string
  /**
   * 15 §5.8 unknown 的自动对账：拿**出站观察**里那条同幂等键的记录当事实来源，
   * 确认这笔到底做没做成，然后 `Executor.reconcile` 收口。
   *
   * 真实进程里这是每天一次的定时任务（WP34 的对账消费者）；模拟回路里由场景的
   * `reconcile.run` 触发——soak 档每天一次，所以"unknown 在下一次对账内清零"是可断言的。
   */
  reconcileUnknown(): Promise<{ reconciled: number; applied: number; failed: number }>
  /**
   * WP56（48 §4 #6）：一个知识源同步了一次新正文。
   *
   * 内容 hash 没变就什么都不做；变了但受管辖数值没变就自动回鲜；
   * 数值也变了才把派生卡标 `stale` 并开一张复核卡（`knowledge_update` 的 recheck 形态）。
   */
  syncKnowledgeSource(ref: string, content: string): Promise<{ stale: number; rechecks: number }>
  /** WP56：人在复核卡上选了一个（确认没变 / 按新值更新 / 忽略）。 */
  resolveKnowledgeRecheck(item: ApprovalItem, option: string | undefined): Promise<void>
  /** 05 §4：每个分配的有效配置快照（"不做跨 Assignment 并集"的断言读它）。 */
  assignmentSnapshots(): AssignmentSnapshot[]
  /** WP69（54）：场景里现配出来的分配登记进快照（`position.staff` 用）。 */
  registerAssignment(a: Assignment): void
  gateway(): ModelGatewayApi
  /** 场景 `inject.budget`：换一套预算重建网关（BudgetLedger 的 caps 在构造时固定）。 */
  setBudget(budget: ModelGatewayPolicy['budget']): void
  /** 场景 `model.outage`：从现在起 `ms` 毫秒内所有 provider 调用失败。 */
  startOutage(ms: number): void
  modelDown(): boolean
  /** 17 §2 事件 → 事件日志（含 correlation.run_id）。 */
  appendRunEvent(req: RunRequest, e: RunEvent): void
  appendEvent(type: string, payload: unknown, opts?: AppendOpts): void
  notify(n: NotificationRecord): void
  /** 从事件日志推出该次运行的 provenance（15 §6：只证明"读过"）。 */
  provenanceOf(ctx: RunContext): ProvenanceState
  customerRefOf(email: string): ObjectRef | undefined
  emailOfCustomer(ref: ObjectRef): string | undefined
  readCustomer(id: string): Promise<DataRecord<Record<string, unknown>> | undefined>
  searchPolicies(
    text: string,
  ): Promise<{ hits: { id: string; statement: string; layer: string; as_of?: string }[] }>
  /**
   * WP44：店铺操作（运营改价 / 建站主题）。
   *
   * 这三条走的是**真机制**：先经 mock connect 真读一次记录（所以 provenance 是真的），
   * 再过 Dev MCP 替身的官方 GraphQL 校验，最后经 `txn.ledger.stage` 提一条变更。
   * 批准与施行照旧走审批总线与执行器——这一层只负责"提"。
   */
  shop: ShopOps
  /**
   * WP64：邮件营销（51 §2.3）与订单履约（51 §2.4）。
   *
   * 走的也是真机制：先经 mock connect 真读一次（订单 / 收件人都有 provenance），
   * 再过 `txn.ledger.stage`。两条职责各自的额度与等级来自**那个人那条分配**的
   * 生效配置，不是主分配的——3 人公司里运营一个人挂三条职责，这一点才看得出来。
   */
  web: WebOps
  /**
   * WP67：红人营销（48 §5.1）。
   *
   * 也走真机制：开发信的禁承诺由 **guardrail** 拦（不是场景自己判），
   * 归因读的是 mock connect 真给的订单金额（场景只说"哪张单用了哪个码"），
   * 额度与等级来自那个人 `kol.youtube` 那条分配的生效配置。
   */
  kol: KolOps
  /**
   * WP72：社媒运营（56 §2）与客服的社群管理（56 §4）。
   *
   * 走的也是真机制：发内容的"永远人审"由 guardrail 的 `HARD_L1` 按回来、
   * 回评论的承诺扫描由 guardrail 拦、"这是不是客户的问题"由 `social-core` 的
   * `triageThread` 判——三件事都不是场景自己写的答案。
   */
  social: SocialOps
  /**
   * WP47 / 44：品牌（范围组）与产品线的组织动作。
   *
   * 也走真机制：品牌成员一变，职责层重算所有挂了它的岗位的范围，这里记一条
   * `assignment.range_expanded` 并给 owner 发一张 L3 卡（44 G5）。
   */
  org: OrgOps
  /**
   * WP51 / 46 §2：两个各自单干的人怎么发现对方、怎么连上。
   *
   * 走的也是真机制里那几件真事：公司名归一化用的是服务进程**同一个函数**
   * （`@agentsws/core` 的 `companyKey`），申请加入出的是一张真的 `membership`
   * 审批卡（14），批了才建成员。局域网那一跳是替身——一条内存"网段"，
   * 与服务进程注入假 mDNS 的测试同一种做法。
   */
  discover: DiscoverOps
  mandateFor(action: string): Mandate
  levelFor(action: string): 'L1' | 'L2' | 'L3'
  issueReadToken(): Promise<string>
  issueApplyToken(): Promise<string>
  close(): Promise<void>
}

/** WP44：一次店铺操作的结果。没提成时 `reason` 说得出为什么。 */
export interface ShopStageResult {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** WP64（51 §2.4）：一次超期巡检的结论。 */
export interface OverdueSweepResult {
  /** 压了超过 `overdue_days` 天还没发的那几张单（按最早的排前面）。 */
  orders: { id: string; name: string; days: number }[]
  /** 判定用的那条线（来自职责 yml 的 caps，不写死在代码里）。 */
  overdue_days: number
}

/** WP64（51 §2.3）：一次群发提案的结论——发给谁、剔了谁。 */
export interface CampaignStageResult extends ShopStageResult {
  /** 剔除之后真正会收到的人。 */
  audience: string[]
  /** 在抑制 / 退订名单上、因此被剔掉的人。 */
  suppressed: string[]
  /** 提案时报的等级（场景可以故意报高，看硬顶会不会把它按回来）。 */
  level_requested: 'L1' | 'L2' | 'L3'
}

export interface WebOps {
  /**
   * 51 §2.4：跑一次超期未发的巡检。
   *
   * 这不是"查一张表"——它经 mock connect 真读一次 `list_orders`，按订单上的
   * 结构化字段（`fulfillment_status` + `created_at`）判，然后给人发一条通知。
   * 阈值从职责 yml 的 `overdue_days` 来。
   */
  overdueSweep(input: { who: PersonId }): Promise<OverdueSweepResult>
  /** 51 §2.4：标记发货 + 回填单号（`create_fulfillment`，L2）。 */
  markShipped(input: {
    who: PersonId
    order: string
    carrier: string
    tracking: string
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<ShopStageResult>
  /**
   * 51 §2.3：某个顾客点了退订。
   *
   * 这是**世界里发生的一件事**（和"预算没了""模型挂了"同一类），不是场景把答案
   * 递给 Agent——退订之后这个人还在不在收件人里，由 `campaignSend` 自己按
   * `@agentsws/core` 的那一份规则算。
   */
  unsubscribe(input: { email: string }): void
  /** 51 §2.3：提一条群发（`campaign_send`，**发送永远 L1**）。 */
  campaignSend(input: {
    who: PersonId
    campaign: string
    note?: string
    /** 故意报高的等级；15 §2 的 hard_ceiling 会把它按回人审（回归用）。 */
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<CampaignStageResult>
}

/** WP67（48 §5.1）：一次开发信提案的结论。 */
export interface OutreachStageResult extends ShopStageResult {
  /** 第一稿命中的禁承诺词（空 = 第一稿就干净）。 */
  forbidden_hits: string[]
  /** 改写过没有（第一稿被拦下来才会有第二稿）。 */
  rewritten: boolean
  /** 这一封会发给几个人（剔掉名单之后）。 */
  recipients: number
  /** 抑制 / 退订名单里剔掉了几个。 */
  suppressed: number
}

/** WP67（48 §5.1）：一次合作提案的结论。 */
export interface CollaborationStageResult extends ShopStageResult {
  budget: number
  currency: string
  level_requested: 'L1' | 'L2' | 'L3'
}

/** WP67（48 §5.1）：一次归因的结论。 */
export interface AttributionResultSummary {
  /** 归上的订单数。 */
  matched: number
  /** 归不上的订单数（**不猜**：`attribution.ts` 的 `unmatched`）。 */
  unmatched: number
  /** 归上的收入。 */
  revenue: number
  /** 凭什么归的（`affiliate_code` / `utm_content`）。 */
  basis: string[]
}

/** WP67（48 §5.1）：红人营销那几件事。 */
export interface KolOps {
  /**
   * 起草并提一封开发信（`kol_outreach`）。
   *
   * 第一稿故意可以带承诺词——guardrail 的禁承诺是 **block**，于是这一跳会
   * 先被拦一次；拦下之后按 `reviewOutreachBody` 给的那句话改写，再提一次。
   * "拦下是打回重写，不是静默删改后照发"（同 WP55 的 Amazon 出站硬闸）。
   */
  outreach(input: {
    who: PersonId
    creator: string
    /** 第一稿正文（场景写一句带承诺的话，看拦不拦得住）。 */
    draft: string
  }): Promise<OutreachStageResult>
  /** 建一条合作（`kol_collaboration`，**永远 L1**）。 */
  collaboration(input: {
    who: PersonId
    creator: string
    budget: number
    /** 故意报高的等级；15 §2 的 hard_ceiling 会把它按回人审。 */
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<CollaborationStageResult>
  /** 建一条带 UTM 与联盟码的追踪链接（`kol_tracked_link`，L3）。 */
  trackedLink(input: { who: PersonId; creator: string; code: string }): Promise<ShopStageResult>
  /**
   * 世界里发生的一件事：有人用这个联盟码下了一单。
   *
   * 与"顾客点了退订"同一类——它只记下"哪张订单用了哪个码"，
   * 金额与币种归因那一跳自己去连接器读，不由场景递。
   */
  affiliateOrder(input: { order: string; code: string }): void
  /** 跑一次归因：读订单 → 按码 / UTM 匹配 → 回填那三个数。 */
  attribution(input: { who: PersonId }): Promise<AttributionResultSummary>

  /* ── WP68（48 §5.2 / §5.3）──────────────────────────────────────── */

  /** 往世界的红人库里放一个人（数据写在场景里，不藏在这里）。 */
  creator(input: {
    channel: string
    handle: string
    followers: number
    engagement_rate?: number
    category?: string
  }): void
  /**
   * 跑一次 campaign 向导：挑人 → 按渠道建合作。
   *
   * **不并集权限**（05 §4）：`channels` 里那个人没有 `kol.<channel>` 分配的，
   * 清单上有、合作不建。判的是 `roles.assignments` 里真有没有那条，
   * 不是场景说了算。
   */
  campaign(input: {
    who: PersonId
    goal: string
    budget: number
    channels: string[]
    headcount: number
  }): Promise<CampaignResultSummary>
  /** 往**云端公共库**里放一个人（模拟别的工作区 / 插件贡献过）。 */
  publicCreator(input: {
    channel: string
    handle: string
    followers: number
    engagement_rate?: number
    email?: string
  }): void
  /** 浏览公共库（免费）+ 付费取一个邮箱（`data.kol.lookup`）。 */
  revealFromPublicLibrary(input: {
    who: PersonId
    channel: string
    handle: string
    topup?: number
  }): Promise<RevealResultSummary>
}

/**
 * WP72（56 §2）：把第一稿里带承诺的那几句去掉，别的原样留着。
 *
 * **不是"改写"，是"删掉不该说的那一句"**：按句切开，逐句过同一份承诺扫描
 * （`social-core` 的 `checkOutbound` → `support-core` 的词表），过不了的那句丢掉。
 * 这样做的理由与开发信那一条逐字相同——拦下是打回重写，重写的结果必须能再过一遍闸；
 * 一个会"稍微改一改再发"的重写器，等于把那道闸变成了摆设。
 *
 * 一句都不剩时回一句最保守的话：宁可少说，不可乱许。
 */
function rewriteWithoutCommitment(text: string): string {
  const parts = text
    .split(/(?<=[。！？!?])/g)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const kept = parts.filter((s) => checkOutbound(s).ok)
  const joined = kept.join('')
  return checkOutbound(joined).ok && joined !== '' ? joined : '这个我去确认一下再回你。'
}

/**
 * WP72（56 §2 / §4）：社媒运营那三件事。
 *
 * 三条 op 覆盖 56 §5 的四条模拟题：发内容（永远人审）、回一条留言（先判类：
 * 是客户问题就转客服、不是就自己回且过承诺扫描）、群发（受众减抑制名单，永远人审）。
 */
export interface SocialOps {
  /**
   * 提一条内容（`social_post`）。
   *
   * `level` 是**故意报高的**那一格：15 §2 的 `HARD_L1` 会把它按回人审。
   * `scheduled_at` 不给 = 立即发；给了 = 到点自己出去，所以门在这一下
   * （到点之后没有第二道门）。
   */
  post(input: {
    who: PersonId
    channel: string
    body: string
    scheduled_at?: string
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialPostResult>
  /**
   * 处理一条留言（评论 / 帖子 / 私信）。
   *
   * 先判类（`social-core` 的 `triageThread`）：判成客户问题 → **出一张转客服卡，
   * 社媒运营不答**；否则按 `draft` 起草一条回复，过承诺扫描（第一稿故意可以带
   * 承诺词，guardrail 会拦，拦下是打回重写）。
   */
  reply(input: {
    who: PersonId
    channel: string
    author: string
    /** 对方说的那句话（外部文本，判类用它）。 */
    text: string
    /** 我们这边起的第一稿（场景可以故意写一句带承诺的话）。 */
    draft: string
    surface?: 'comment' | 'thread' | 'dm'
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialReplyResult>
  /** 提一条群发（`community_broadcast`，**永远 L1** + 抑制名单必查）。 */
  broadcast(input: {
    who: PersonId
    channel: string
    body: string
    /** 群里 / 名单上的全部人（抑制名单从世界里那一份退订记录来，不由场景递）。 */
    members: string[]
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialBroadcastResult>
  /**
   * WP73（56 §6）：批一条入群申请（`community_membership`，L2）。
   *
   * **一次一个人**（职责 yml 的 `max_members_per_change: 1`）：批错一个踢出去
   * 就是了，批错三百个这个群就不是原来那个群了。他填的申请答案要在卡面上——
   * 人就是靠那几句判"这是不是广告号"。
   */
  approveMember(input: {
    who: PersonId
    channel: string
    /** 递申请的那个人（平台 id / handle）。 */
    member: string
    /** 他填的申请答案（外部文本，原样进卡、不进事件日志）。 */
    answers?: string[]
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialMembershipResult>
  /**
   * WP73（56 §6）：一个管理动作（`community_moderation`）。
   *
   * 删帖 / 禁言 L2，**封禁 L1**——分档在 guardrail 里按 `after.action` 判，
   * 不在职责上写第二遍（`COMMUNITY_MODERATION_L1_ACTIONS`）。
   */
  moderate(input: {
    who: PersonId
    channel: string
    /** 冲谁来的（帖子 id 或人的 id）。 */
    target: string
    action: 'warn' | 'delete_post' | 'mute' | 'ban' | 'permanent_ban'
    reason?: string
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialModerationResult>
  /**
   * WP73（56 §6）：改群规（`community_rules`，**永远 L1**）。
   *
   * 群规是这个群的法律，放宽一条等于把垃圾闸门打开——所以它与群发一样，
   * 报什么等级都会被按回人审。
   */
  rulesEdit(input: {
    who: PersonId
    channel: string
    /** 改成什么（整段新群规）。 */
    rules: string
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<SocialRulesResult>
}

/** WP73：一条入群审核提案的结果。 */
export interface SocialMembershipResult {
  channel: string
  staged: boolean
  level_requested: 'L1' | 'L2' | 'L3'
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** WP73：一个管理动作提案的结果。 */
export interface SocialModerationResult {
  channel: string
  action: string
  staged: boolean
  level_requested: 'L1' | 'L2' | 'L3'
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** WP73：一次群规改动提案的结果。 */
export interface SocialRulesResult {
  channel: string
  staged: boolean
  level_requested: 'L1' | 'L2' | 'L3'
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** 一条内容提案的结果。 */
export interface SocialPostResult {
  channel: string
  staged: boolean
  level_requested: 'L1' | 'L2' | 'L3'
  scheduled_at?: string
  commitment_hits: string[]
  /**
   * WP73：这条排期撞了什么（`social-core` 的 `scheduleConflicts` 判的）。
   *
   * 空数组 = 没撞。撞了的那几句**原样进卡面**——同渠道同一小时两条，
   * 平台会把后一条压下去，而关注的人只会觉得被刷屏。
   */
  conflicts: string[]
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** 一条留言处理完之后的结果（转客服与自己回两条路共用）。 */
export interface SocialReplyResult {
  channel: string
  /** 判成了六类里的哪一类。 */
  triage: string
  /** 转出去了就有（`dtc.community-support`）。 */
  routed_to?: string
  /** 社媒运营自己回了没有。转客服那一路恒为 `false`——那正是 56 的边界。 */
  answered: boolean
  commitment_hits?: string[]
  rewritten?: boolean
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** 一条群发提案的结果。 */
export interface SocialBroadcastResult {
  channel: string
  staged: boolean
  audience: string[]
  suppressed: string[]
  level_requested: 'L1' | 'L2' | 'L3'
  change_id?: string
  approval_item_id?: string
  reason?: string
}

/** WP68：一次 campaign 向导的结果。 */
export interface CampaignResultSummary {
  /** 清单上一共几个人。 */
  picks: number
  /** 建得了合作的那几条渠道（本人名下有对应职责）。 */
  allowed_channels: string[]
  /** 挑到了人却建不了合作的那几条（05 §4：不并集权限）。 */
  blocked_channels: string[]
  /** 真建出来的合作数。 */
  created: number
}

/** WP68：一次"浏览 + reveal"的结果。 */
export interface RevealResultSummary {
  ok: boolean
  reason?: string
  /** 浏览花了多少积分（**永远是 0**）。 */
  browse_credits: number
  /** reveal 花了多少积分（没取到就是 0）。 */
  reveal_credits: number
  /** 取回来的那一条在本地只留了加密库 key 名。 */
  stored_as_ref: boolean
}

/** WP47：一个人在某条职责上现在看得到什么（44 G2 读那一半）。 */
export interface VisibleScope {
  orders: string[]
  products: string[]
}

export interface OrgOps {
  /** 44 G1：建或改一个品牌（范围组）。改成员会重算挂了它的岗位范围并留痕。 */
  rangeGroup(input: {
    id: string
    name: string
    members: RangeRef[]
  }): Promise<{ created: boolean; affected: number }>
  /** 44 G2：建或改一条产品线。 */
  productLine(input: { id: string; name: string; parent: RangeRef; rule: ProductLineRule }): {
    created: boolean
  }
  /** 改某人某条职责挂的范围 / 品牌（挑店 / 挑品牌 / 挑产品线，44 G3）。 */
  assignRange(input: {
    who: PersonId
    role: RoleId
    ranges?: RangeRef[]
    range_groups?: string[]
  }): { assignment_id: string; ranges: RangeRef[] }
  /** 这个人这条职责现在看得到哪几张订单、哪几件商品。 */
  visible(who: PersonId, role: RoleId): VisibleScope
  /**
   * WP62 / 51 §1 N0：在当前这个网站平台下，**三处**各说了什么。
   *
   * 三处必须说同一句话——用户在哪一处撞上"平台还没接"说不准，有一处含糊
   * （给一个点了也连不上的「去连接」、或者默默回空数据）这一跳就白做了。
   */
  platformCheck(who: PersonId, role: RoleId): Promise<PlatformCheckResult>
  /**
   * 45 H1：某人单干时在**自己的工作区**里攒下的东西（品牌 / 产品线 / 一条岗位）。
   *
   * 个人工作区不是另一套界面，是同一套东西换了个 `workspace_id`——所以这里用的
   * 就是公司那边同一个职责层，只是工作区不同。
   */
  personalWorkspace(input: {
    who: PersonId
    workspace: string
    role: RoleId
    range_groups?: { id: string; name: string; members: RangeRef[] }[]
    product_lines?: { id: string; name: string; parent: RangeRef; rule: ProductLineRule }[]
  }): { assignment_id: string; ranges: RangeRef[] }
  /**
   * 45 H2 / H3：把个人工作区并进公司——对照 → 一张 `join_mapping` 卡 → owner 选 → 落地。
   *
   * 判定与合并都走真的那一套（`@agentsws/catalog`），场景里只给"owner 选了什么"。
   */
  join(input: {
    who: PersonId
    from: string
    decisions?: {
      unique_key: string
      chosen: JoinResolution
      name_choice?: 'company' | 'personal'
    }[]
  }): Promise<JoinRunResult>
  /**
   * 52 O1（WP65）：在同一个组织下开一个**品牌工作区**，并往里放几样真东西。
   *
   * 「开一个品牌」在这里就是"换一个 `workspace_id`"——20 之后所有数据本来就按它切，
   * 所以隔离不用再造一层。这个方法一行"过滤 brand_id"都没有：要是有，
   * 那就说明隔离是假的。
   */
  brand(input: {
    /** 这个品牌的 `workspace_id`。 */
    id: string
    name: string
    who: PersonId
    role: RoleId
    seed?: BrandSeed
  }): Promise<BrandVisibility>
  /**
   * 这个人在**这个品牌**里现在看得到什么（四个库各问一遍）。
   *
   * 问的是同一个人、同一套库，只换 `workspace_id`——所以它答出来的东西就是
   * 52 O2「两个品牌互相看不见」那句话本身。
   */
  brandVisible(brand: string, who: PersonId): Promise<BrandVisibility>
}

/**
 * WP62 / 51 §1 N0：一次"平台看得见什么"的体检（场景里断言用）。
 *
 * 三格分别对应岗位面板、事项工具、首次设置第 ④ 步的清单。
 */
export interface PlatformCheckResult {
  platform: string
  /** 面板「店铺后台」那一块：连没连上、以及那一句"还没接"（接得上时没有）。 */
  panel: { connected: boolean; note?: string }
  /** 查一次订单：成没成、错误里那句人话。 */
  tool: { status: string; reason?: string }
  /**
   * 首次设置清单里这条职责要连的**店铺** provider。
   * 平台没有连接器时是空的——清单里干脆不出那张卡（点进去无处可点的条目就是噪音）。
   */
  shop_services: string[]
}

/**
 * 52 O1（WP65）：往一个**品牌工作区**里放的那几样真东西。
 *
 * 四样各挑一个代表：一条岗位（职责层）、一张待审卡（审批总线）、一张事实卡（知识层）、
 * 一条店铺连接记录（数据层）。它们分属四个不同的库——"两个品牌互相看不见"要是只在
 * 一个库上成立，那就不算成立。
 */
export interface BrandSeed {
  /** 这个品牌里的一张待审卡叫什么。 */
  card?: string
  /** 这个品牌里的一条事实（知识层）。 */
  fact?: string
  /** 这个品牌连的那家店（数据层的一条记录）。 */
  connection?: string
  /**
   * WP66（52 O3）：这个品牌自己那一套**模型设置**（"用哪家、哪个模型"）。
   *
   * 与连接是同一条道理：WP66 之前模型 key 是一台机器一份，所以这一格没得验；
   * 现在它按 `workspace_id` 存了，"两个品牌互相看不见"才轮得到它。
   * 这里放的只有**决定**（哪家 / 哪个模型）与那条凭据在库里叫什么名字——
   * 值一个字节都不进模拟世界（13 §4.3）。
   */
  model?: string
}

/** 一个品牌里**这个人现在看得到什么**（场景里断言用；五个库各问一遍）。 */
export interface BrandVisibility {
  brand: string
  /** 他在这个品牌里有哪几条职责。 */
  positions: string[]
  /** 队列上的卡（标题）。 */
  cards: string[]
  /** 知识层里的事实（statement）。 */
  facts: string[]
  /** 数据层里的店铺连接（id）。 */
  connections: string[]
  /** WP66：这个品牌自己那一套模型设置（label）。 */
  models: string[]
  /**
   * WP66：这个品牌的凭据在加密库里叫什么**名字**（连接的与模型的各一条）。
   *
   * 只有名字，没有值。名字上带着 `ws:<workspace_id>/` 前缀——真实现里也是这么隔的，
   * 所以"甲的名字出现在乙的清单里"这件事在这里一眼看得见。
   */
  credential_keys: string[]
}

/** 一次 Join 跑完的样子（场景里断言用）。 */
export interface JoinRunResult {
  approval_item_id: string
  counts: Record<'same' | 'similar' | 'missing', number>
  merged: number
  created: number
  aliases: { kind: string; from: string; to: string }[]
  range_rewrites: number
}

/**
 * 46 §2：一台各自单干的机器（"一个人用"的那种工作区）在这条模拟网段上的样子。
 *
 * 它只有三样东西：公司档案、开关、以及一个与工作区 id 无关的 peer id。
 * **没有成员名单、没有业务数据**——发现阶段交换的只有 `company_key` 这一串哈希。
 */
export interface DiscoverSide {
  id: string
  owner: PersonId
  legal_name: string
  domain?: string
  discoverable: boolean
  company_key: string
}

export interface DiscoverOps {
  /**
   * 46 §1 ①：某一边走完首次设置的第一步——写下公司全称与域名，开关默认开。
   * 记一条 `workspace.profile_set`（payload 里只有哈希，全称不进日志）与
   * `discovery.enabled`，然后立刻看一眼网段上有没有同一把钥匙的人。
   */
  firstRun(input: {
    side: string
    who: PersonId
    legal_name: string
    domain?: string
    discoverable?: boolean
  }): DiscoverSide
  /** 这一边现在在网段上看得见谁（同 key、不是自己、两边开关都开着）。 */
  peers(side: string): string[]
  /**
   * 46 §2 I3：`from` 朝 `to` 申请加入 → `to` 的 owner 收一张 `membership` 卡。
   * 申请里只有名字与邮箱。批了才建成员——这一步只出卡。
   */
  requestJoin(input: {
    from: string
    to: string
    name: string
    email: string
  }): Promise<{ approval_item_id?: string; reason?: string }>
}

export interface ShopOps {
  /** 改一件商品的价：真读 → 查文档 → 过官方校验 → stage 一条 `price_change`。 */
  priceChange(input: {
    who: PersonId
    product: string
    price: number
    /** 故意写错的 GraphQL（回归"校验挡幻觉"用）；不给就按官方名字生成一段。 */
    graphql?: string
    note?: string
  }): Promise<ShopStageResult>
  /** 推一份**未发布**的主题副本（造预览，线上一个字节不动）。 */
  themePush(input: { who: PersonId; name: string }): Promise<{
    theme_id: string
    theme_name: string
    preview_url?: string
  }>
  /**
   * WP63（51 §2.1 商品管理）：上架 / 撤下一件商品。
   *
   * 先真读一次商品（`before.published` 必须来自记录），再 stage 一条
   * `publish_product` / `unpublish_product`。这两条在 `HARD_L1` 里——
   * `level` 报多高都会被拉回人审，这正是这条回归题要证的事。
   */
  publishProduct(input: {
    who: PersonId
    product: string
    /** `true` 上架、`false` 撤下。 */
    publish: boolean
    /** 故意报高的自动化等级（回归"永远人审"用）。 */
    level?: 'L1' | 'L2' | 'L3'
    note?: string
  }): Promise<ShopStageResult>
  /**
   * WP63（51 §2.2 内容与博客）：写一篇文章 / 把它发出去。
   *
   * 同一条 `publish_post`，两种后果：`publish: false` 是草稿（guardrail 判 allow），
   * `publish: true` 是"让它出现在店里"（转人审）。所以一条场景先写后发，就能把
   * 51 §2.2 那句「草稿 L2；发布 L1」整条走完。
   */
  blogPost(input: {
    who: PersonId
    title: string
    publish: boolean
    /** 改已有那篇（不给就按标题算一个稳定 id）。 */
    article?: string
    body?: string
  }): Promise<ShopStageResult>
  /**
   * WP63（51 §2.1 数据日报）：出一张日报卡。
   *
   * 数据日报那一面**没有写动作**——它唯一的产出就是这张卡。所以它不进变更账本，
   * 只进审批队列，而且是 L3 自动出、看完归档：人要做的只有"看一眼"。
   */
  dailyReport(input: { who: PersonId }): Promise<{
    approval_item_id: string
    /** 卡面上那几个数（全部从结构化行算出来，一个字不经模型手）。 */
    figures: { sales: number; orders: number; low_stock: number; pending: number }
  }>
  /** 提一条"把这份副本发布上线"的变更（`publish_theme`，15 §2 永远 L1）。 */
  themePublish(input: {
    who: PersonId
    theme?: string
    /** 故意报高的自动化等级；hard_ceiling 会把它拉回人审（回归用）。 */
    level?: 'L1' | 'L2' | 'L3'
  }): Promise<ShopStageResult>
  /** Dev MCP 替身；场景断言"真的查了、真的验了"读它的 `calls`。 */
  devMcp: MockDevMcp
  /** Shopify CLI 替身（主题那条路不经连接器）。 */
  themeCli: MockShopifyCli
}

export interface TickApprovalsResult {
  expired: number
  /** 本拍新升上去的级数（一张卡升两级算两次） */
  escalated: number
  /** 本拍新抽出来的复核 */
  sampled: number
}

export interface AppendOpts {
  run_id?: string
  change_id?: string
  work_item_id?: string
  subject?: ObjectRef
  actor?: EventEnvelope['actor']
}

const now = (c: SyntheticClock): Iso8601 => c.now()

/** 26 §4 fast 档：内存事件日志 + stub 模型 + 合成时钟。 */
export async function createWorld(opts: WorldOptions): Promise<World> {
  const { pack, seed } = opts
  const clock = new SyntheticClock(opts.start)
  const random = seededRandom(seed)
  const workspace_id = pack.workspace.id

  const dbPath = opts.dbPath ?? ':memory:'
  let kernel = await createKernel({ dbPath, clock, random: seededRandom(seed + 11) })
  /** soak 档"关库再开"的次数（事件 id 的随机源每次要换，见 `restartEventLog`）。 */
  let restarts = 0
  const events: EventEnvelope[] = []
  const notifications: NotificationRecord[] = []
  const blocked: BlockedRecord[] = []
  const outages: OutageWindow[] = []
  const shopRuns: RunRecord[] = []
  const runContexts = new Map<string, RunContext>()

  const appendEnvelope = (e: Omit<EventEnvelope, 'id' | 'at'>): void => {
    const stored = kernel.eventLog.appendSync(e)
    events.push(stored)
  }
  let traceSeq = 0
  const traceId = (): string => {
    traceSeq += 1
    return `tr_sim_${traceSeq.toString().padStart(6, '0')}`
  }

  // ── 制度：职责定义 + 分配 + 策略层 ─────────────────────────────────────
  // pack 自带的职责定义按 id 覆盖内置（WP32：15 / 50 人 pack 要有投放、运营这些岗位，
  // 而 `packages/roles` 只内置了三份；没有 `roles/` 的 pack 一个字都不变）
  const bundledRoles = [
    loadBundledRole('dtc.support'),
    loadBundledRole('common.owner'),
    loadBundledRole('common.member'),
    // WP54（48 v2 L1）：客服岗位另外两条。**这两条在 pack 里没人挂**——职责定义躺在
    // 库里不产生任何行为。装它们只为一件事：`agentsws demo` 起的就是这个世界，
    // 首次设置向导里的「客服」岗位得显示三条而不是一条（种岗位那一步会把解析不到的
    // 职责筛掉）。服务进程侧的 `BUNDLED_ROLES` 早就是这三条，两边别再错位。
    loadBundledRole('dtc.live-chat'),
    loadBundledRole('amz.support'),
    // WP44：建站与主题（12 §2）。没人被分到它的 pack 一个字节都不变——
    // 职责定义在库里躺着不产生任何行为，只有 assignments.yml 里有人挂它才生效
    loadBundledRole('site.builder'),
    // WP64（51 §2.3 / §2.4）：网站运营岗位的邮件营销与订单履约。
    // 3 人 pack 里"运营"这个人真挂着它们（`assignments.yml`），所以这两条不是躺着的。
    loadBundledRole('dtc.email-marketing'),
    loadBundledRole('dtc.fulfillment'),
    // WP63（51 §2）：网站运营岗位的两条职责。`dtc.store` 从 WP62 起就是内置的，
    // WP63 把 15 人 pack 自带的那份副本删了——两份真源迟早会各改各的。
    loadBundledRole('dtc.store'),
    loadBundledRole('dtc.content'),
    // WP67（48 §5.1）：红人营销岗位的五条渠道职责。3 人 pack 里"运营"挂着
    // `kol.youtube`（`assignments.yml`），另外四条躺在库里——躺着不产生任何行为，
    // 装它们是为了首次设置向导里"红人营销"那个岗位显示五条而不是一条
    // （种岗位那一步会把解析不到的职责筛掉，同上面客服那两条的理由）。
    loadBundledRole('kol.youtube'),
    loadBundledRole('kol.instagram'),
    loadBundledRole('kol.tiktok'),
    loadBundledRole('kol.facebook'),
    loadBundledRole('kol.x'),
    // WP72（56 §2 / §4）：社媒运营岗位的九条渠道职责 + 客服岗位的社群管理。
    // 3 人 pack 里"运营"真挂着 `social.meta`（`assignments.yml`），客服真挂着
    // `dtc.community-support`；其余八条躺在库里——躺着不产生任何行为，
    // 装它们是为了首次设置向导里"社媒运营"那个岗位显示九条而不是一条
    // （种岗位那一步会把解析不到的职责筛掉，同上面红人那五条的理由）。
    loadBundledRole('social.meta'),
    loadBundledRole('social.tiktok'),
    loadBundledRole('social.x'),
    loadBundledRole('social.youtube'),
    loadBundledRole('social.facebook-group'),
    loadBundledRole('social.reddit'),
    loadBundledRole('social.discord'),
    loadBundledRole('social.telegram-group'),
    loadBundledRole('social.whatsapp'),
    loadBundledRole('dtc.community-support'),
    // WP76（58 §1）：设计岗位的五条职责。3 人 pack 里"运营"真挂着 `design.dtc`
    // （`assignments.yml`），其余四条躺在库里——躺着不产生任何行为，
    // 装它们是为了首次设置向导里"设计"那个岗位显示五条而不是一条
    // （种岗位那一步会把解析不到的职责筛掉，同上面社媒那九条的理由）。
    loadBundledRole('design.dtc'),
    loadBundledRole('design.amazon'),
    loadBundledRole('design.social'),
    loadBundledRole('design.ads'),
    loadBundledRole('design.exhibition'),
  ]
  const packRoles = pack.roles.map((r) => parseRole(r.yaml, `${pack.dir}/${r.path}`))
  const overridden = new Set(packRoles.map((r) => r.id))
  /** 44 G5：品牌成员一变，职责层喊一声，`org` 那边记事件 + 发卡（装配完成后才接上）。 */
  let rangeExpandedSink: ((e: RangeExpanded) => void) | undefined
  const roles = createRoleStore({
    clock,
    roles: [...bundledRoles.filter((r) => !overridden.has(r.id)), ...packRoles],
    newId: (s) => `asg_${sha256(s).slice(0, 20)}`,
    onRangeExpanded: (e) => rangeExpandedSink?.(e),
  })
  roles.policies.set({
    workspace_id,
    mandates: pack.policy.mandates as Record<string, Partial<Mandate>>,
    global_caps: pack.policy.global_caps,
    ...(pack.policy.separation_of_duties === undefined
      ? {}
      : { separation_of_duties: pack.policy.separation_of_duties }),
  })

  const created = new Map<string, Assignment>()
  for (const a of pack.assignments) {
    const assignment = roles.assignments.create({
      person_id: a.person_id,
      workspace_id,
      role_id: a.role_id,
      ranges: a.ranges,
      granted_by: a.granted_by,
    })
    created.set(`${a.person_id}|${a.role_id}`, assignment)
  }
  const primary: PackAssignment | undefined = pack.assignments.find((a) => a.primary === true)
  if (primary === undefined) {
    throw new SimulationError('invalid_input', 'pack 的 assignments.yml 缺一条 primary: true')
  }
  const assignment = created.get(`${primary.person_id}|${primary.role_id}`)
  if (assignment === undefined) throw new SimulationError('not_found', 'primary assignment 未建立')
  const effective = roles.effectiveConfig(assignment.id, {
    connected: pack.workspace.markets.length >= 0 ? ['email', 'shopify'] : [],
  })
  const owner = pack.people.find((p) => p.owner === true)?.id ?? primary.person_id
  const roleHolder = primary.person_id
  const scopeManager = pack.people.find((p) => p.scope_manager === true)?.id ?? owner
  /** 14 §13.2 默认 10%；场景可以压到 0 或提到 1，报告里要写清用的是哪个数。 */
  const txnSamplingRate = opts.txnPolicy?.sampling_rate ?? 0.1

  const agentActor: DataActor = {
    person_id: assignment.person_id,
    assignment_id: assignment.id,
    workspace_id,
    grants: effective.scopes,
    ranges: effective.ranges,
  }
  const seedActor: DataActor = {
    person_id: owner,
    assignment_id: 'asg_seed',
    workspace_id,
    grants: [
      {
        domain: 'customer',
        ops: ['read', 'stage'],
        range: 'workspace',
        max_sensitivity: 'restricted',
      },
    ],
    ranges: [],
  }

  // ── 数据层：客户记录（上下文里的客户经数据层按 actor 过滤）────────────
  const data = createDataStore({
    dbPath: ':memory:',
    clock,
    collections: [CUSTOMERS, BRAND_CONNECTIONS, BRAND_MODEL_PROVIDERS],
  })
  for (const c of pack.customers) {
    await data.put<{ name: string; email: string; market: string }>(
      'customers',
      {
        id: c.id,
        schema_version: 1,
        workspace_id,
        owners: [roleHolder],
        scope: effective.ranges.length > 0 ? [...effective.ranges] : [],
        sensitivity: 'internal',
        name: c.name,
        email: c.email,
        market: c.market,
      },
      seedActor,
    )
  }

  // ── 知识：pack 的三层 markdown ───────────────────────────────────────
  // 19 §6 的知识事件也进同一条事件日志（契约的 KnownEventType 还没有 knowledge.*，见报告）
  const knowledge = createKnowledge({
    clock,
    workspace_id,
    emit: (e) => {
      appendEnvelope({
        schema_version: 1,
        workspace_id: e.workspace_id,
        type: e.type,
        actor: { kind: 'system', id: 'knowledge' },
        correlation: {
          trace_id: traceId(),
          ...(typeof e.payload.run_id === 'string' ? { run_id: e.payload.run_id } : {}),
        },
        payload: e.payload,
      })
    },
  })
  for (const doc of pack.knowledge) {
    const card = await knowledge.store.propose({
      schema_version: 1,
      workspace_id,
      layer: doc.layer,
      domain: doc.domain as 'company',
      scope: [],
      sensitivity: doc.sensitivity,
      subject: { type: doc.domain, key: doc.subject_key },
      statement: doc.body.trim(),
      provenance: [{ source: 'document', ref: doc.path, at: opts.start }],
      confidence: { value: 0.9, state: 'probable' },
      valid: {},
      owner,
      created_by: { kind: 'person', id: owner },
    })
    await knowledge.store.activate(card.id, owner)
    // ingestMarkdown 只为把长文切段（19 §2），fast 档不检索分段
    knowledge.ingestMarkdown(doc.body, { id: `src_${doc.subject_key}`, ref: doc.path })
    // WP56（48 §4 #6）：每份 pack 知识登记成一个源，并记下这一版的内容 hash。
    // 有了它，后面 `knowledge.source_sync` 才有"上一版"可比。
    const src = knowledge.intake.addSource({
      workspace_id,
      kind: 'upload',
      ref: doc.path,
      parser: 'anydoc',
    })
    knowledge.intake.markSynced(src.id, 1, contentHashOf(doc.body))
  }

  // ── 替身：mock OpenConnector / stub 运行时 / 合成人 / 收件箱 ──────────
  // stage / createDraft 要接到交易控制模块，而交易控制模块又要 connect 做后端——
  // 用可变闭包打断这个环，装配完成后两侧都指向真实实现。
  const holder: {
    stage?: (i: StageIntent) => Promise<{ change_id: string } | undefined>
    createDraft?: (p: DraftPayload) => Promise<CreateDraftResult>
    createPolicyQuestion?: CreatePolicyQuestionFn
    executeTool?: (call: {
      name: string
      input: Record<string, unknown>
      request: RunRequest
    }) => Promise<ToolExecution>
  } = {}

  const standIns = createStandIns({
    seed,
    clock,
    workspace_id,
    state: pack.mockState(),
    stage: (i) => (holder.stage ?? (async () => undefined))(i),
    createDraft: (p) => (holder.createDraft ?? (async () => undefined))(p),
    // WP17 遗留：接上之后 `boundary-first-time` 才真产出一张 policy_change 卡
    createPolicyQuestion: (i) => (holder.createPolicyQuestion ?? (async () => undefined))(i),
    executeTool: (c) => (holder.executeTool ?? (async () => ({ status: 'error' as const })))(c),
  })
  const connect = standIns.connect

  const tokenFor = async (
    kind: 'role-read' | 'role-apply',
    assignment_id: string = assignment.id,
  ): Promise<string> => {
    const t = await connect.issueToken({
      assignment_id,
      kind,
      allowed_actions: kind === 'role-read' ? READ_ACTIONS : [...READ_ACTIONS, ...APPLY_ACTIONS],
      allowed_connections: CONNECTIONS,
      expires_in_seconds: 3600,
    })
    return t.token
  }

  // ── 模型网关：stub provider + 可注入的"模型挂了" ──────────────────────
  let outageUntilMs = 0
  // `direct` 与 `dsh` 两条分支：22 的 stub provider 只出文本、不出 tool_calls，
  // **回合就跑不起来**——direct 的 turn loop 空转，dsh 的 agent-loop 一轮就 idle。
  // 换成同样确定性的"规则脑" provider（判定逻辑与 stub 运行时同一套，只是用工具协议表达）。
  // WP81：dsh 这一档的回合改由官方 agent-loop 驱动，从此与 direct 同一个前提，
  // 所以它也换到规则脑——两条路对着**同一个"模型"**跑，parity 比的才是运行时。
  // realistic 档给了真模型就用它；否则按运行时选确定性的替身 provider
  const modelRef: ModelRef = opts.model?.ref ?? MODEL
  const modelDrivesTools = opts.runtime === 'direct' || opts.runtime?.startsWith('dsh') === true
  const base =
    opts.model !== undefined
      ? opts.model.provider
      : modelDrivesTools
        ? aftersalesBrainProvider({
            clock,
            seed,
            ref: MODEL,
            // 48 v2 L2：规则脑按工作区装配，垂直在这一刻就定了
            ...(pack.workspace.vertical === undefined ? {} : { vertical: pack.workspace.vertical }),
          })
        : stubProvider({ seed, ref: MODEL })
  const gatedProvider: ModelProvider = {
    ref: modelRef,
    ...(base.supports_tool_choice === undefined
      ? {}
      : { supports_tool_choice: base.supports_tool_choice }),
    async complete(req: Parameters<ModelProvider['complete']>[0]) {
      if (clock.nowMs() < outageUntilMs) {
        throw new ProviderError('注入的模型故障：provider 不可用', { status: 503 })
      }
      return base.complete(req)
    },
    async embed(texts: string[]) {
      if (clock.nowMs() < outageUntilMs) {
        throw new ProviderError('注入的模型故障：provider 不可用', { status: 503 })
      }
      if (base.embed === undefined) throw new ProviderError('stub 不支持 embed')
      return base.embed(texts)
    },
  }

  const gatewayPolicy = (budget: ModelGatewayPolicy['budget']): ModelGatewayPolicy => ({
    default: modelRef,
    // realistic 档要走真 provider（多半在境外），驻留策略随之放开；fast 档仍是 cn
    data_residency: opts.model === undefined ? 'cn' : 'any',
    prices: opts.model?.prices ?? { 'stub/stub-v1': { in: 1, out: 2, cached: 0.1 } },
    ...(budget === undefined ? {} : { budget }),
  })
  const buildGateway = (budget: ModelGatewayPolicy['budget']): ModelGatewayApi =>
    createModelGateway({
      providers: [gatedProvider],
      policy: gatewayPolicy(budget),
      clock,
      env: {},
      eventSink: (e) => {
        appendEnvelope({ ...e, correlation: { ...e.correlation } })
      },
    })
  let gateway = buildGateway({ workspace_daily_base: 1000, workspace_monthly_base: 20000 })

  // ── 17 §4：换运行时只换这一处；替身的其余部分（连接器、人、时钟）原样不动 ──
  const liveGateway: ModelGateway = {
    complete: (r) => gateway.complete(r),
    embed: (texts, meta, model) => gateway.embed(texts, meta, model),
    usage: (filter) => gateway.usage(filter),
    budget: (scope) => gateway.budget(scope),
  }
  const dshMode: DshRuntimeMode | undefined =
    opts.runtime === 'dsh-in-process'
      ? 'in-process'
      : opts.runtime === 'dsh-subprocess'
        ? 'subprocess'
        : undefined
  const runtimeAdapter: RuntimeAdapter =
    opts.runtime?.startsWith('dsh') === true
      ? createDshRuntime({
          clock,
          seed,
          ...(dshMode === undefined ? {} : { mode: dshMode }),
          gateway: { complete: (req) => gateway.complete(req) },
          stage: (i) => (holder.stage ?? (async () => undefined))(i),
          createDraft: (p) => (holder.createDraft ?? (async () => undefined))(p),
          createPolicyQuestion: (i) => (holder.createPolicyQuestion ?? (async () => undefined))(i),
          executeTool: (c) =>
            (holder.executeTool ?? (async () => ({ status: 'error' as const })))(c),
        })
      : opts.runtime === 'direct'
        ? createDirectRuntime({
            // 22 的 complete 还没有 tool_choice：包装器在宿主侧补上，
            // grounding 命中时第一轮就被强制到那个工具（17 §5.4 的"强制"那一路）
            gateway: withToolChoice(liveGateway, groundingInputFor),
            clock,
            seed,
            executeTool: (c) => (holder.executeTool ?? (async () => ({ status: 'error' })))(c),
            stage: (i) => (holder.stage ?? (async () => undefined))(i),
            createDraft: (p) => (holder.createDraft ?? (async () => undefined))(p),
            createPolicyQuestion: (i) =>
              (holder.createPolicyQuestion ?? (async () => undefined))(i),
            // 16 §3 副作用表：写外部的 Action 在 `executor` 策略下一律 block
            sideEffectOf: (tool) => {
              try {
                const id = connect.resolveActionId(tool)
                return connect.allActions().find((a) => a.id === id)?.side_effect
              } catch {
                return undefined
              }
            },
          })
        : standIns.stubRuntime

  // ── 交易控制模块（真实实现）──────────────────────────────────────────
  const orderOf = (id: string) => connect.state.orders.find((o) => o.id === id)
  const recordFacts = (target: ObjectRef): { record_version?: string; record?: unknown } => {
    // WP44：改价的 apply 前要重读一次商品。少了这一段，`record_version` 在
    // 施行那一步比出来是 'v1' → ''，每一条改价都会当场判成 stale_record 悄悄失败。
    if (target.type === 'product') {
      const p = connect.state.products.find((x) => x.id === target.id)
      if (p === undefined) return {}
      return {
        record_version: p.record_version,
        record: { price: p.price, title: p.title, status: p.status },
      }
    }
    if (target.type !== 'order') return {}
    const o = orderOf(target.id)
    if (o === undefined) return {}
    return {
      record_version: o.record_version,
      record: {
        total: o.total_price,
        refunded: o.refunded_amount,
        delivered_at: o.delivered_at,
        financial_status: o.financial_status,
        fulfillment: o.fulfillment_status,
      },
    }
  }

  const emailOfCustomer = (ref: ObjectRef): string | undefined =>
    pack.customers.find((c) => c.id === ref.id)?.email

  const txn = createTxn({
    clock,
    random: seededRandom(seed + 21),
    sampler: seededRandom(seed + 31),
    eventSink: (e) => {
      const { id: _id, at: _at, ...rest } = e
      appendEnvelope(rest)
      if (e.type === 'change.blocked' || e.type === 'approval.blocked') {
        const p = e.payload as Record<string, unknown>
        const rules = Array.isArray(p.reasons)
          ? (p.reasons as string[])
          : typeof p.rule === 'string'
            ? [p.rule]
            : Array.isArray(p.hits)
              ? (p.hits as { rule: string }[]).map((h) => h.rule)
              : []
        for (const rule of rules) {
          blocked.push({
            rule,
            at: e.at,
            message: `${e.type}: ${rule}`,
            ...(e.correlation.run_id === undefined ? {} : { run_id: e.correlation.run_id }),
          })
        }
      }
    },
    policy: {
      business_tz_offset_minutes: 480,
      executor_id: 'sim.executor',
      executor_version: 'sim/1',
      // WP32：升级 / 过期 / 抽检比例可以按场景压小；不给就是 14 里定的默认值
      ...(opts.txnPolicy?.escalation_hours === undefined
        ? {}
        : {
            escalation_hours: {
              scope_manager: opts.txnPolicy.escalation_hours.scope_manager ?? 24,
              owner: opts.txnPolicy.escalation_hours.owner ?? 48,
            },
          }),
      ...(opts.txnPolicy?.sampling_rate === undefined
        ? {}
        : { sampling_rate: opts.txnPolicy.sampling_rate }),
      ...(opts.txnPolicy?.expiry_days === undefined
        ? {}
        : {
            expiry_days: { default: 7, ...opts.txnPolicy.expiry_days } as {
              default: number
            } & Record<string, number>,
          }),
    },
    readRecord: (target) => recordFacts(target),
    // 44 G2 前置检查：改价 / 改 Listing 的目标商品必须落在这个岗位的范围里
    targetInRange: ({ assignment_id, target, before }) => {
      const scoped = rangeTargetOfProduct(target, before)
      return scoped === undefined ? undefined : roles.targetInRange(assignment_id, scoped)
    },
    backendApply: async (change, _opts) => {
      // WP44：改价与主题发布的施行口。
      //
      // 改价经 mock connect 真跑一次写 Action，用 `role-apply` 令牌与
      // `Idempotency-Key = change_id`（15 §5 步骤 6）——与退款同一条路，只是 Action 不一样。
      // 主题发布走 CLI 替身：真身 `shopify theme publish` 不经连接器，所以这里也不假装经过。
      // 两条的共同点才是要紧的那一条——**只有执行器能调它们，而且只在批准之后**。
      if (change.kind === 'price_change') {
        const after = change.after as { price?: unknown }
        const price = typeof after.price === 'number' ? after.price : Number.NaN
        if (!Number.isFinite(price)) {
          return { status: 'failed', error: { message: 'price_change 的 after.price 不是数字' } }
        }
        try {
          const res = await connect.execute<{ product_id: string }>(
            'shopify_admin.update_product_price',
            { product_id: change.target.id, price },
            {
              token: await tokenFor('role-apply'),
              connection: 'conn_shopify_admin',
              idempotencyKey: change.id,
            },
          )
          return {
            status: 'ok',
            execution_id: res.execution_id,
            outcome_ref: { type: 'product', id: change.target.id },
          }
        } catch (err) {
          return { status: 'failed', error: { message: messageOfError(err) } }
        }
      }
      // WP63（51 §2.1）：上下架。与改价同一条路，只是 Action 不一样。
      if (change.kind === 'publish_product' || change.kind === 'unpublish_product') {
        const action =
          change.kind === 'publish_product'
            ? 'shopify_admin.publish_product'
            : 'shopify_admin.unpublish_product'
        try {
          const res = await connect.execute<{ product_id: string }>(
            action,
            { product_id: change.target.id },
            {
              token: await tokenFor('role-apply'),
              connection: 'conn_shopify_admin',
              idempotencyKey: change.id,
            },
          )
          return {
            status: 'ok',
            execution_id: res.execution_id,
            outcome_ref: { type: 'product', id: change.target.id },
          }
        } catch (err) {
          return { status: 'failed', error: { message: messageOfError(err) } }
        }
      }
      // WP63（51 §2.2）：博客文章。
      //
      // 合成世界没有博客连接器（真身是 `shopify_admin.create_article` /
      // `update_article`，在写动作对照表里），所以这里写的是世界自己那份内存台账——
      // 与主题那条同理：**不假装经过连接器**，免得出站观察表里凭空多出一条不存在的调用。
      if (change.kind === 'publish_post') {
        const after = change.after as { title?: unknown; published?: unknown }
        const title = typeof after.title === 'string' ? after.title : change.target.id
        articles.set(change.target.id, { title, published: after.published === true })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'content.post_written',
          actor: { kind: 'system', id: 'sim.executor' },
          correlation: { trace_id: traceId() },
          payload: { article_id: change.target.id, published: after.published === true },
        })
        return {
          status: 'ok',
          execution_id: `content_${change.id}`,
          outcome_ref: { type: 'article', id: change.target.id },
        }
      }
      if (change.kind === 'publish_theme') {
        try {
          const out = themeCli.publish({ theme_id: change.target.id })
          return {
            status: 'ok',
            execution_id: `cli_${change.id}`,
            outcome_ref: { type: 'theme', id: out.theme_id },
          }
        } catch (err) {
          return { status: 'failed', error: { message: messageOfError(err) } }
        }
      }
      // WP64（51 §2.4）：标记发货的施行口。补发与拆单在 Shopify 那头是同一个 mutation，
      // 所以三条 kind 走同一段——区别在**为什么发**，那是额度与路由的事，不是执行器的事。
      if (
        change.kind === 'create_fulfillment' ||
        change.kind === 'split_order' ||
        change.kind === 'reship'
      ) {
        const after = change.after as {
          carrier?: unknown
          tracking_number?: unknown
          items?: unknown
        }
        const carrier = typeof after.carrier === 'string' ? after.carrier : ''
        const tracking = typeof after.tracking_number === 'string' ? after.tracking_number : ''
        if (carrier === '' || tracking === '') {
          return {
            status: 'failed',
            error: { message: '没有承运商与单号的"已发货"不叫已发货（51 §2.4）' },
          }
        }
        try {
          const res = await connect.execute<{ id: string }>(
            'shopify_admin.create_fulfillment',
            {
              order_id: change.target.id,
              carrier,
              tracking_number: tracking,
              ...(typeof after.items === 'number' ? { items: after.items } : {}),
            },
            {
              token: await tokenFor('role-apply'),
              connection: 'conn_shopify_admin',
              idempotencyKey: change.id,
            },
          )
          return {
            status: 'ok',
            execution_id: res.execution_id,
            outcome_ref: { type: 'order', id: change.target.id },
          }
        } catch (err) {
          return { status: 'failed', error: { message: messageOfError(err) } }
        }
      }
      // WP64（51 §2.3）：邮件营销这一侧**没有施行口**，而且这是诚实的——
      // 连接器还是骨架（目录 + 只读动作 + 表单，真调用没接）。批了也发不出去，
      // 所以这里说的是"为什么发不出去"，不是一句 `未实现 kind`。
      if (
        change.kind === 'campaign_send' ||
        change.kind === 'segment_edit' ||
        change.kind === 'flow_edit'
      ) {
        return {
          status: 'failed',
          error: {
            message: '邮件营销连接器还没接（51 §2.3）：这条变更批得下来，但现在没有地方施行它',
          },
        }
      }
      if (change.kind !== 'refund') {
        return { status: 'failed', error: { message: `模拟执行器未实现 kind：${change.kind}` } }
      }
      const money = change.money
      if (money === undefined) {
        return { status: 'failed', error: { message: 'refund 缺 money' } }
      }
      try {
        const res = await connect.execute<{ refund_id: string }>(
          'shopify_admin.create_refund',
          { order_id: change.target.id, amount: money.amount, reason: 'return within window' },
          {
            token: await tokenFor('role-apply'),
            connection: 'conn_shopify_admin',
            // 15 §5 步骤 6：Idempotency-Key = change_id，重试用同一把
            idempotencyKey: change.id,
          },
        )
        return {
          status: 'ok',
          execution_id: res.execution_id,
          outcome_ref: { type: 'order', id: change.target.id },
        }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        if (e.code === 'timeout') {
          return { status: 'unknown', error: { message: e.message ?? '超时，结果未知' } }
        }
        return {
          status: 'failed',
          error: {
            message: e.message ?? String(err),
            retryable: e.code === 'rate_limited' || e.code === 'provider_error',
          },
        }
      }
    },
    deliverOutbound: async (item, _o) => {
      const payload = (item.decision?.edited_payload ?? item.payload) as Record<string, unknown>
      const to = payload.to as ObjectRef | undefined
      const body = (payload.body ?? {}) as Record<string, unknown>
      const email = to === undefined ? undefined : emailOfCustomer(to)
      if (to === undefined || email === undefined) {
        return { status: 'failed', error: { message: '收件人无法解析成邮箱' } }
      }
      try {
        const res = await connect.execute<{ message_id: string; thread_id: string }>(
          'gmail.send_message',
          {
            thread_id: payload.thread_ref,
            to: [email],
            subject: String(body.subject ?? ''),
            body: String(body.text ?? ''),
          },
          {
            token: await tokenFor('role-apply'),
            connection: 'conn_gmail',
            idempotencyKey: item.id,
          },
        )
        await standIns.deliveries.email.deliver(
          {
            id: item.id,
            title: String(body.subject ?? ''),
            summary: String(body.text ?? '').slice(0, 200),
            view: 'full',
            decision_token: '',
            actions: [],
          },
          to.id,
        )
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'delivery.sent',
          actor: { kind: 'system', id: 'sim.executor' },
          subject: { type: 'approval_item', id: item.id },
          correlation: {
            trace_id: traceId(),
            ...(item.evidence.run_id === undefined ? {} : { run_id: item.evidence.run_id }),
          },
          payload: {
            channel: 'email',
            to: to.id,
            external_id: res.data.message_id,
            idempotency_key: item.id,
          },
        })
        return { status: 'ok', execution_id: res.execution_id }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return {
          status: e.code === 'timeout' ? 'unknown' : 'failed',
          error: { message: e.message ?? String(err) },
        }
      }
    },
    directory: {
      canApprove: (person, item) =>
        pack.assignments.some((a) => a.person_id === person && a.role_id === item.role_id) ||
        person === owner,
      memberCount: () => pack.people.length,
      // 14 §7：升级链第一级是范围管理者。3 人公司里没有这个人，退回 owner；
      // 15 / 50 人 pack 在 people.yml 里标了 `scope_manager: true`，升级才真的换人。
      scopeManager: () => scopeManager,
      owner: () => owner,
    },
  })
  // 合成人在同一条审批总线上决定（26 §3）
  standIns.actors.attach(txn.approvals)

  // ── 审批卡投递：工作台收件箱（14 §7 每个 recipient 一张卡片）──────────
  const deliveredCards = new Set<string>()
  const flushCards = async (): Promise<void> => {
    for (const item of txn.runtime.store.listApprovals({ workspace_id })) {
      for (const d of item.deliveries) {
        const key = `${item.id}#${d.decision_token}`
        if (deliveredCards.has(key) || d.status !== 'sent') continue
        deliveredCards.add(key)
        await standIns.deliveries.workstation.deliver(
          {
            id: item.id,
            title: item.title,
            summary: item.summary,
            view: d.view,
            decision_token: d.decision_token,
            actions: ['approve', 'approve_edited', 'reject'],
          },
          d.to,
        )
      }
    }
  }

  // ── 抽检复核（14 §13.2）────────────────────────────────────────────
  //
  // L2 额度内的变更自动批（`auto_approved`），审批总线按 `sampling_rate` 掷一次骰子决定
  // 这条要不要人复核。**被抽中不等于有人看见**——总线只在项上打了个标记，
  // 真把它送到复核人手上是宿主的事，所以这一步在模拟回路里补：
  // 抽中的项给范围管理者投一张只读卡（自动批已经生效，复核是事后的），并记一条通知。
  const samplingReviews: SamplingReviewRecord[] = []
  const reviewed = new Set<string>()
  const sampleAutoApproved = async (): Promise<number> => {
    let n = 0
    for (const item of txn.runtime.store.listApprovals({ workspace_id })) {
      if (!item.automation.auto_approved || !item.automation.sampling.selected) continue
      if (reviewed.has(item.id)) continue
      reviewed.add(item.id)
      const at = now(clock)
      samplingReviews.push({
        item_id: item.id,
        kind: item.kind,
        to: scopeManager,
        at,
        rate: txnSamplingRate,
      })
      await standIns.deliveries.workstation.deliver(
        {
          id: `smp_${item.id}`,
          title: `抽检复核：${item.title}`,
          summary: `这条已按额度自动批并施行，抽检比例 ${txnSamplingRate}。看一眼有没有问题。`,
          view: 'full',
          decision_token: '',
          actions: [],
        },
        scopeManager,
      )
      world.appendEvent(
        'simulation.sampling_review',
        { item_id: item.id, kind: item.kind, to: scopeManager, rate: txnSamplingRate },
        { subject: { type: 'approval_item', id: item.id } },
      )
      world.notify({
        to: scopeManager,
        channel: 'workstation',
        title: `抽检复核：${item.title}`,
        at,
        reason: 'L2 自动批按比例抽检（14 §13.2）',
      })
      n += 1
    }
    return n
  }

  // ── 入站替身 ─────────────────────────────────────────────────────────
  const customerRefOf = (email: string): ObjectRef | undefined => {
    const c = pack.customerByEmail(email)
    return c === undefined ? undefined : { type: 'customer', id: c.id }
  }
  const inbound = new MemoryInboundPipeline({
    clock,
    workspace_id,
    resolver: {
      // WP55 / 48 §4 L3 #2：渠道细分判定。判定规则全在 `support-core/amazon`
      // （常量表与正则逐字节抄 KefuAgent）；这里只把邮件头喂进去。真环境那一份
      // （`apps/server` 的 `classifyAmazonSubChannel`）还会按消息类型决定"起不起草"，
      // 模拟回路只跑买家消息族那一条路，所以不复制那个分支。
      sub_channel: (mail) => {
        const detection = detectAmazonChannel({
          from_email: mail.from,
          subject: mail.subject ?? '',
          body_text: mail.body,
        })
        if (detection === undefined) return undefined
        return {
          sub_channel: AMAZON_CHANNEL,
          channel_meta: {
            ...buildAmazonChannelMeta(detection, clock.now()),
            summary: describeAmazonDetection(detection),
          },
        }
      },
      customer: (email) => customerRefOf(email),
      thread: (id) => ({ type: 'thread', id }),
      order: (text) => {
        const m = text.match(/#(\d{3,})/)
        return m?.[1] === undefined ? undefined : { type: 'order', id: `ord_${m[1]}` }
      },
      route: () => ({ role_id: primary.role_id, confidence: 0.9 }),
    },
  })

  // ── 工具执行器：读走 mock connect，`search_policies` 走知识检索 ────────
  const connectExec = connectToolExecutor(connect)
  /** 47 J2：已经给哪几张卡开过"知识过时"卡了（一张卡一次，别刷屏）。 */
  const staleFlagged = new Set<string>()

  /**
   * 47 J2 / J3：检索命中一条**历史案例**就标一次过时。
   *
   * 它带着"当时"的时间戳（`as_of`）——那是它被写下来那一刻的状态，不是现在。
   * Agent 照 J3 的顺序先查了对象、再查的知识，所以它手上已经有当前状态；
   * 这里要做的是把矛盾**报出来**：给 owner 一张 `knowledge_update` 卡，
   * 说清"这条说的是当时，现在以操作层为准，要不要更新它"。24 的学习回路吃这张卡。
   */
  const flagStale = async (hit: {
    fact_card_id: string
    statement_redacted: string
    as_of?: string
  }): Promise<void> => {
    if (staleFlagged.has(hit.fact_card_id)) return
    staleFlagged.add(hit.fact_card_id)
    world.appendEvent('knowledge.card.stale', {
      card_id: hit.fact_card_id,
      ...(hit.as_of === undefined ? {} : { as_of: hit.as_of }),
    })
    await txn.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'knowledge_update',
      role_id: assignment.role_id,
      subject: { object: { type: 'fact_card', id: hit.fact_card_id } },
      dedupe_key: `${workspace_id}:knowledge_update:stale:${hit.fact_card_id}`,
      title: '这条知识可能过时了',
      summary:
        '检索到的是一条历史案例（记的是当时的状态）。回答已经以操作层的当前状态为准；' +
        '这条要不要更新或退休，你定。',
      payload: {
        form: 'knowledge_update',
        reason: 'stale_vs_live_state',
        card_id: hit.fact_card_id,
        ...(hit.as_of === undefined ? {} : { as_of: hit.as_of }),
        options: [
          { id: 'retire', label: '退休它（已经不成立了）' },
          { id: 'keep_as_case', label: '留着当历史案例' },
        ],
      },
      evidence: {
        source_events: [],
        diff: { before: {}, after: { card_id: hit.fact_card_id }, summary: '知识过时' },
        provenance: { seen: [{ type: 'fact_card', id: hit.fact_card_id }] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: assignment.id },
      // 19 §2：知识怎么改是人的事，不自动放行
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [],
        rule: 'owner',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
  }

  const searchPolicies = async (
    text: string,
  ): Promise<{ hits: { id: string; statement: string; layer: string; as_of?: string }[] }> => {
    const res = await knowledge.retrieval.search({
      text,
      // 19 §3 过滤下推：把本次 Assignment 的 scopes 原样传下去（不并集），
      // 无权数据域根本不进候选集
      actor: {
        person_id: assignment.person_id,
        assignment_id: assignment.id,
        role_id: assignment.role_id,
        workspace_id,
        grants: [...effective.scopes],
        ranges: [...effective.ranges],
      },
      // WP56（48 §4 #7）：**不再截 top-3**。这个库按身份过滤之后只有几条，
      // 长上下文档会整库给出来——截断反而会把该看见的那条挡在外面。
      // 超预算时自动退回 lexical，那一档照 DEFAULT_K 收口。
    })
    for (const h of res.hits) {
      if (h.layer === 'historical_case') await flagStale(h)
    }
    return {
      hits: res.hits.map((h) => ({
        id: h.fact_card_id,
        statement: h.statement_redacted,
        layer: h.layer,
        ...(h.as_of === undefined ? {} : { as_of: h.as_of }),
      })),
    }
  }
  /**
   * WP62（51 §1 N0 ③）：这个工作区的网站平台我们还没接 → 店铺那几个工具当场回一句人话。
   *
   * 与服务进程（`apps/server/src/records.ts`）读的是契约里**同一张**平台表：
   * 平台算不出 provider，就没有店铺后台可问；让模型对着一个连不上的连接器空转，
   * 换来的只会是一封编出来的回信。
   */
  const SHOP_TOOL_NAMES = new Set(['get_order', 'list_orders', 'get_product', 'list_products'])
  const platformNote = (): string | undefined =>
    storefrontUnsupportedNote(pack.workspace.storefront_platform)

  holder.executeTool = async (call) => {
    const bare = call.name.slice(call.name.lastIndexOf('.') + 1)
    const note = platformNote()
    if (note !== undefined && SHOP_TOOL_NAMES.has(bare)) {
      return {
        status: 'error',
        reason: `not_connected：${note}查不到订单和商品——这次别猜，照实说查不了。`,
      }
    }
    if (call.name === 'search_policies' || call.name.endsWith('.search_policies')) {
      if (!call.request.tools.allow.includes('search_policies')) {
        return { status: 'blocked', reason: 'not_in_allowlist: search_policies' }
      }
      const query = typeof call.input.query === 'string' ? call.input.query : 'return window'
      const res = await searchPolicies(query)
      return {
        status: 'ok',
        data: res,
        provenance: res.hits.map((h) => ({ type: 'fact_card', id: h.id })),
      }
    }
    return connectExec(call)
  }

  /**
   * 工作模型：事件发进同一条日志（`todo.*` / `matter.*` 摘要），
   * 所以场景可以用 `event_types: [todo.claimed]` 这类断言看见认领发生过。
   */
  const work = createWork({
    workspace_id,
    clock,
    random,
    tz_offset_minutes: wallClock(clock.nowMs(), pack.workspace.tz).offset,
    emit: (e) => {
      world.appendEvent(e.type, e.payload, {
        actor: e.actor,
        ...(e.subject === undefined ? {} : { subject: e.subject }),
      })
    },
  })

  const world: World = {
    work,
    clock,
    random,
    // soak 档的"进程重启"会换一个 SqliteEventLog 实例，所以这里是取值不是快照
    get kernel() {
      return kernel
    },
    // WP44：`shop` 与 `holder.stage` 一样，装在这个对象字面量之后（它要用 txn 与 flushCards），
    // 所以这里取值不是快照
    get shop() {
      return shop
    },
    // WP64：与 `shop` 同理，装在这个对象字面量之后（它要用 txn、flushCards 与 notify）
    get web() {
      return web
    },
    // WP67：同上（48 §5.1 红人营销那几件事）
    get kol() {
      return kol
    },
    // WP72：同上（56 §2 社媒运营 / §4 社群管理）
    get social() {
      return social
    },
    // 44：与 `shop` 同理，装在这个对象字面量之后
    get org() {
      return org
    },
    // 46：同上（它要用 txn 的审批总线与 flushCards）
    get discover() {
      return discover
    },
    data,
    roles,
    knowledge,
    txn,
    standIns,
    runtime: runtimeAdapter,
    connect,
    inbound,
    pack,
    workspace_id,
    assignment,
    effective,
    agentActor,
    role_id: primary.role_id,
    owner,
    roleHolder,
    scopeManager,
    modelRef,
    events,
    notifications,
    blocked,
    outages,
    shopRuns,
    runContexts,
    startRoutine(routineOptions) {
      if (world.routine !== undefined) return world.routine
      const routine = installDailyRoutine(world, routineOptions)
      world.routine = routine
      return routine
    },
    startLearning(learningOptions) {
      if (world.learning !== undefined) return world.learning
      const loop = installLearningLoop(world, learningOptions)
      world.learning = loop
      return loop
    },
    samplingReviews,
    ...(dbPath === ':memory:' ? {} : { dbPath }),
    async restartEventLog() {
      if (dbPath === ':memory:') {
        throw new SimulationError(
          'invalid_input',
          '内存事件日志重启后什么都不剩，这条演练要 dbPath 指向真文件',
        )
      }
      const before = kernel.eventLog.readSync({ workspace_id }).length
      await kernel.dispose()
      restarts += 1
      // 事件 id 来自注入的随机源。真进程重启时熵是新的；模拟回路里如果原样重放同一条
      // 随机序列，新写的第一条事件会撞上库里已有的那条 id（UNIQUE 冲突）。
      // 所以每次重启换一个**确定性的**新种子：既不撞，也仍然可复现。
      kernel = await createKernel({
        dbPath,
        clock,
        random: seededRandom(seed + 11 + restarts * 977),
      })
      const after = kernel.eventLog.readSync({ workspace_id }).length
      const chain = kernel.eventLog.verifyChain(workspace_id)
      return { events_before: before, events_after: after, chain_ok: chain.ok }
    },
    async reconcileUnknown() {
      let reconciled = 0
      let applied = 0
      let failed = 0
      for (const change of txn.runtime.store.listChanges({ workspace_id })) {
        if (change.status !== 'unknown') continue
        // provider 那边这条幂等键到底成没成：出站观察就是"外面发生过什么"的账
        const hit = standIns.observations
          .all()
          .find((o) => o.idempotency_key === change.id && o.status === 'ok')
        const outcome =
          hit === undefined
            ? { status: 'failed' as const, message: '对账确认外部没有这笔' }
            : {
                status: 'applied' as const,
                ...(hit.execution_id === undefined ? {} : { execution_id: hit.execution_id }),
              }
        await txn.executor.reconcile(change.id, outcome)
        reconciled += 1
        if (outcome.status === 'applied') applied += 1
        else failed += 1
      }
      if (reconciled > 0) {
        world.appendEvent('simulation.reconciled', { reconciled, applied, failed })
      }
      return { reconciled, applied, failed }
    },
    /**
     * WP56（48 §4 #6）：一个知识源同步了一次新正文。
     *
     * 判定全在 `packages/knowledge`（内容 hash → 事实指纹 → 该不该惊动人）；
     * 这里只负责把"要惊动人"那一档变成一张卡。
     */
    async syncKnowledgeSource(ref, content) {
      const source = knowledge.intake.sources(workspace_id).find((x) => x.ref === ref)
      if (source === undefined) throw new SimulationError('not_found', `知识源不存在：${ref}`)
      const result = await knowledge.recheck.syncSource({ source, content })
      // 记下这一版，下次再同步时"上一版"就是它
      knowledge.intake.markSynced(source.id, source.chunks, result.plan.content_hash)

      for (const recheck of result.rechecks) {
        const card = knowledge.store.getUnchecked(recheck.card_id)
        const before = recheck.before.map(describeFactKeyZh).join('、')
        const after = recheck.after.map(describeFactKeyZh).join('、')
        const item = await txn.approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'knowledge_update',
          role_id: assignment.role_id,
          subject: { object: { type: 'fact_card', id: recheck.card_id } },
          dedupe_key: `${workspace_id}:knowledge_update:recheck:${recheck.id}`,
          title: '这条知识要复核',
          summary:
            `来源改过了，改的正是这条管着的数值（${before || '—'} → ${after || '—'}）。` +
            '它还在用，只是排到了后面。确认没变 / 按新值更新 / 忽略，你定。',
          payload: {
            form: 'knowledge_recheck',
            recheck_id: recheck.id,
            card_id: recheck.card_id,
            source_id: recheck.source_id,
            before: recheck.before,
            after: recheck.after,
            categories: recheck.categories,
            ...(recheck.proposed_statement === undefined
              ? {}
              : { proposed_statement: recheck.proposed_statement }),
            options: RECHECK_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
          },
          evidence: {
            source_events: [],
            diff: {
              before: { statement: card?.statement ?? null },
              after: { statement: recheck.proposed_statement ?? null },
              summary: '源页改了受管辖数值',
            },
            provenance: { seen: [{ type: 'fact_card', id: recheck.card_id }] },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'agent', id: assignment.id },
          // 19 §2：知识怎么改是人的事，不自动放行
          automation: {
            level_at_creation: 'L1',
            auto_approved: false,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            // 知识的主人就是 owner（19 §2）：这张卡只送他
            recipients: [{ person: owner, via: 'owner' }],
            rule: 'owner',
            escalation: {
              after_hours: 72,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
          options: RECHECK_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
        })
        if (item.state !== 'blocked') knowledge.recheck.linkApproval(recheck.id, item.id)
      }
      await flushCards()
      world.appendEvent('simulation.knowledge_source_synced', {
        ref,
        changed: result.plan.changed,
        refreshed: result.refreshed.length,
        stale: result.stale.length,
        rechecks: result.rechecks.length,
      })
      return { stale: result.stale.length, rechecks: result.rechecks.length }
    },
    /**
     * WP56：人在复核卡上选了一个。
     *
     * 选项 id 是冻结的（`RECHECK_OPTIONS`）；没选（裸 approve）当"确认没变"——
     * 不猜"按新值更新"，改口径这件事必须是显式的。
     */
    async resolveKnowledgeRecheck(item, option) {
      const payload = item.payload as { form?: string; recheck_id?: string }
      if (payload.form !== 'knowledge_recheck' || typeof payload.recheck_id !== 'string') return
      const recheck = knowledge.recheck.get(payload.recheck_id)
      if (recheck === undefined || recheck.status !== 'open') return
      const resolution =
        option === 'adopt_new' || option === 'ignore' || option === 'unchanged'
          ? option
          : 'unchanged'
      await knowledge.recheck.resolve(recheck.id, {
        resolution,
        by: owner,
      })
    },
    async tickApprovals() {
      const at = now(clock)
      const expired = await txn.approvals.expire(at)
      const escalatedItems = await txn.approvals.escalate(at)
      // 升级 = 新增一条投递（14 §7）；不刷成卡片的话新收件人手上没有 decision_token
      await flushCards()
      let escalated = 0
      for (const item of escalatedItems) {
        for (const at_ of item.routing.escalation.escalated_at) {
          if (at_ === at) escalated += 1
        }
      }
      const sampled = await sampleAutoApproved()
      // 46 §2 I3：这一拍里被定了的 membership 卡，效果在这里落地
      await settleMemberships()
      return { expired: expired.length, escalated, sampled }
    },
    /**
     * WP69（54）：场景里新配出来的分配也要进快照。
     *
     * `assignmentSnapshots` 数的是这个世界**建出来的**那些分配（05 §4 的"不做并集"
     * 就是照它一条条比的）。岗位入口会在场景跑的过程中现配岗（`position.staff`），
     * 不登记进来的话，那条断言会以为这个人只有一条分配、直接判"没有意义"。
     */
    registerAssignment(a) {
      created.set(`${a.person_id}|${a.role_id}@${a.workspace_id}`, a)
    },
    assignmentSnapshots() {
      const out: AssignmentSnapshot[] = []
      for (const a of created.values()) {
        const cfg = roles.effectiveConfig(a.id)
        out.push({
          person_id: a.person_id,
          assignment_id: a.id,
          role_id: a.role_id,
          scopes: [
            ...new Set(cfg.scopes.flatMap((s) => s.ops.map((op) => `${s.domain}:${op}`))),
          ].sort(),
          ranges: [...new Set(cfg.ranges.map((r) => `${r.kind}:${r.id}`))].sort(),
          actions: cfg.actions.map((x) => x.id).sort(),
        })
      }
      return out
    },
    gateway: () => gateway,
    setBudget(budget) {
      gateway = buildGateway(budget)
    },
    startOutage(ms) {
      const from = clock.nowMs()
      outageUntilMs = Math.max(outageUntilMs, from + ms)
      outages.push({ from_ms: from, to_ms: outageUntilMs })
    },
    modelDown: () => clock.nowMs() < outageUntilMs,
    appendRunEvent(req, e) {
      const { type, ...payload } = e
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'agent', id: req.actor.person_id, run_id: req.id },
        correlation: {
          trace_id: traceId(),
          run_id: req.id,
          ...(req.work_item === undefined ? {} : { work_item_id: req.work_item.id }),
        },
        payload,
      })
    },
    appendEvent(type, payload, o) {
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type,
        actor: o?.actor ?? { kind: 'system', id: 'simulation' },
        ...(o?.subject === undefined ? {} : { subject: o.subject }),
        correlation: {
          trace_id: traceId(),
          ...(o?.run_id === undefined ? {} : { run_id: o.run_id }),
          ...(o?.change_id === undefined ? {} : { change_id: o.change_id }),
          ...(o?.work_item_id === undefined ? {} : { work_item_id: o.work_item_id }),
        },
        payload,
      })
    },
    notify(n) {
      notifications.push(n)
      void standIns.deliveries.workstation.deliver(
        {
          id: `ntf_${notifications.length}`,
          title: n.title,
          summary: n.reason,
          view: 'full',
          decision_token: '',
          actions: [],
        },
        n.to,
      )
      world.appendEvent('notification.sent', {
        to: n.to,
        channel: n.channel,
        title: n.title,
        reason: n.reason,
      })
    },
    provenanceOf(ctx) {
      return provenanceFromEvents(ctx, now(clock))
    },
    customerRefOf,
    emailOfCustomer,
    async readCustomer(id) {
      return data.get<Record<string, unknown>>('customers', id, agentActor)
    },
    searchPolicies,
    mandateFor(action) {
      const found = effective.actions.find((a) => a.id === action)
      if (found === undefined) throw new SimulationError('not_found', `职责没有动作 ${action}`)
      return found.mandate
    },
    levelFor(action) {
      return effective.automation[action]?.level ?? 'L1'
    },
    issueReadToken: () => tokenFor('role-read'),
    issueApplyToken: () => tokenFor('role-apply'),
    async close() {
      knowledge.close()
      data.close()
      roles.close()
      await kernel.dispose()
    },
  }

  // ── stage / createDraft：stub 运行时的两个出口接到真实交易控制模块 ────
  // ── WP44 店铺操作（运营改价 / 建站主题）────────────────────────────
  //
  // 为什么不是"让模型自己去调 update_product_price"：08 §2.3 与 16 §3 定死了
  // 公司端的写口只在执行器手里。所以这两条做的都是同一件事——**读真记录、过官方校验、
  // 提一条变更**——剩下的（额度、审批、施行、幂等）一步不少地走既有那条链。
  //
  // 主题那一侧多一条纪律：`shopify theme …` 走的是官方 CLI 自己那套登录，**不经连接器**
  // （真身在 `apps/server/src/shopify-theme.ts`）。所以这里用 `MockShopifyCli` 而不是
  // 一条 Action——让它冒充连接器调用，会在出站观察表里凭空多出一条不存在的记录。
  /**
   * WP63（51 §2.2）：合成世界里的文章与页面。
   *
   * 合成 pack 不带博客数据集（也不该带——博客是连接器那一侧的东西）。这里留一个
   * 内存 Map，只为让「先写草稿、再发出去」这条链有一个真的 `before` 可读：
   * 第二次提案时 `before.published` 来自第一次写下的那一条，不是凭空编的。
   */
  const articles = new Map<string, { title: string; published: boolean }>()
  /** 日报看的是"过去一天"。 */
  const REPORT_WINDOW_MS = 86_400_000

  const devMcp = new MockDevMcp()
  const themeCli = new MockShopifyCli({
    state: standIns.connect.state,
    now: () => now(clock),
    onCommand: (cmd, detail) => {
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'shopify.theme_cli',
        actor: { kind: 'system', id: 'shopify-cli' },
        correlation: { trace_id: traceId() },
        payload: { command: cmd, ...detail },
      })
    },
  })
  let shopSeq = 0

  /** 这个人在这条职责上的分配；没有就退回主分配（3 人公司常常一人多职）。 */
  const assignmentFor = (who: PersonId, role_id: RoleId): Assignment =>
    created.get(`${who}|${role_id}`) ?? assignment

  const recipientOf = (
    via: 'scope_manager' | 'owner' | 'role_holder',
  ): { person: PersonId; via: 'scope_manager' | 'owner' | 'role_holder' } => ({
    person: via === 'owner' ? owner : via === 'scope_manager' ? scopeManager : roleHolder,
    via,
  })

  /**
   * 一次店铺操作 = 一次运行。
   *
   * 触发它的不是一封信，是人在工作台上点的一下（`trigger.source = 'manual'`），
   * 但它确确实实起了一次 Agent：查记录、查文档、验 GraphQL、提案。记成 `RunRecord`
   * 有两个不能省的用处——`provenance_respected` 那条不变量要拿 `run_id` 回头查
   * "这次运行到底读过什么"；报告里的运行条数与工具调用数也才对得上。
   */
  interface ShopRun {
    run_id: string
    /**
     * 记一次工具调用：同时进运行事件流与事件日志（`calls_tool` 从事件日志读）。
     * `read` 是这一跳读到的对象——`tool.result.provenance_added` 就是它。
     */
    tool(tool: string, input: Record<string, unknown>, read?: ObjectRef[]): void
    /** 收尾：把读过的对象写进 provenance，运行进证据；返回的那份直接交给 `stage`。 */
    finish(input: { seen: ObjectRef[]; outputs: RunOutput[]; summary: string }): ProvenanceState
  }

  const beginShopRun = async (asg: Assignment): Promise<ShopRun> => {
    shopSeq += 1
    const run_id = `run_shop_${shopSeq}`
    const started_at = now(clock)
    const request: RunRequest = {
      id: run_id,
      schema_version: 1,
      workspace_id,
      kind: 'work_item',
      actor: { person_id: asg.person_id, assignment_id: asg.id, role_id: asg.role_id },
      // 人在工作台上按的那一下就是触发源：没有入站信件，也没有定时器
      trigger: { event_id: `manual_${run_id}`, source: 'manual' },
      context: [],
      grounding: effective.grounding,
      tools: {
        allow: [MCP_DOCS_TOOL, MCP_SCHEMA_TOOL, MCP_VALIDATE_TOOL, 'get_product'].sort(),
        connect_token: await tokenFor('role-read', asg.id),
        // 16 §3：写口只在执行器手里，这次运行拿不到
        side_effect_policy: 'executor',
      },
      skills: [],
      persona: { sections: [] },
      budget: { max_tokens: 60_000, max_tool_calls: 8, max_seconds: 120, max_cost_base: 5 },
      expectations: { outputs: ['staged_change'], must_stage_if_change_requested: true },
      runtime: {
        preset: asg.role_id,
        profile: 'simulation',
        plugins: [],
        model: modelRef,
      },
      idempotency_key: `idem_${run_id}`,
    }
    const events: RunEvent[] = []
    const emit = (e: RunEvent): void => {
      events.push(e)
      world.appendRunEvent(request, e)
    }
    emit({ type: 'run.started', request_id: run_id, runtime: 'shop-op', model: modelRef })
    let calls = 0
    return {
      run_id,
      tool(tool, input, read) {
        calls += 1
        const call_id = `call_${run_id}_${calls}`
        emit({ type: 'tool.call', call_id, tool, input })
        emit({ type: 'tool.result', call_id, status: 'ok', provenance_added: read ?? [] })
      },
      finish({ seen, outputs, summary }) {
        const provenance: ProvenanceState = {
          run_id,
          seen: seen.reduce<Record<string, string[]>>((acc, ref) => {
            acc[ref.type] = [...new Set([...(acc[ref.type] ?? []), ref.id])]
            return acc
          }, {}),
          // 15 §6：读全了才算数——`requires_record_read` 的那道预检看的就是这里
          read_full: seen.map((r) => `${r.type}:${r.id}`),
          recorded_at: now(clock),
        }
        // fast 档的模型是 stub，token 与钱都是 0；工具调用数是真的
        const usage: RunUsage = {
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          tool_calls: calls,
          seconds: 0,
          cost_base: 0,
        }
        emit({ type: 'run.completed', summary, outputs, usage })
        shopRuns.push({
          request,
          started_at,
          finished_at: now(clock),
          status: 'completed',
          events,
          result: {
            request_id: run_id,
            status: 'completed',
            outputs,
            provenance,
            memory_candidates: [],
            lessons: [],
            usage,
            session_ref: { runtime: 'shop-op', session_id: run_id },
            summary,
          },
        })
        return provenance
      },
    }
  }

  // ── WP47 / 44：品牌与产品线 ─────────────────────────────────────────

  /** 44 G5 攒一拍：一次改品牌常常影响好几个岗位，人只该看到一张卡。 */
  const expandedBatch: RangeExpanded[] = []

  rangeExpandedSink = (e) => {
    expandedBatch.push(e)
    appendEnvelope({
      schema_version: 1,
      workspace_id,
      type: 'assignment.range_expanded',
      actor: { kind: 'system', id: 'org.ranges' },
      correlation: { trace_id: traceId() },
      payload: {
        assignment_id: e.assignment_id,
        person_id: e.person_id,
        role_id: e.role_id,
        range_group: e.range_group,
        added: e.added,
        removed: e.removed,
      },
    })
  }

  /** 攒完一拍，给 owner 发一张 L3 卡（默认放行、只通知）。 */
  const flushRangeExpanded = async (): Promise<number> => {
    const batch = expandedBatch.splice(0)
    const first = batch[0]
    if (first === undefined) return 0
    const added = batch.flatMap((e) => e.added)
    const removed = batch.flatMap((e) => e.removed)
    const what =
      added.length > 0
        ? `新增了 ${[...new Set(added.map((r) => r.id))].join('、')}`
        : `去掉了 ${[...new Set(removed.map((r) => r.id))].join('、')}`
    const summary = `「${first.range_group_name}」${what}，这 ${batch.length} 个岗位现在跟着看得到 / 看不到了。不想这样就改岗位的范围。`
    const item = await txn.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: 'common.owner',
      subject: { object: { type: 'policy', id: `range_group:${first.range_group}` } },
      dedupe_key: `${workspace_id}:range_expanded:${first.range_group}:${sha256(what).slice(0, 12)}`,
      title: `品牌「${first.range_group_name}」的范围变了`,
      summary,
      payload: {
        target: 'range_group',
        range_group: first.range_group,
        affected_assignments: batch.map((e) => e.assignment_id),
        added,
        removed,
      },
      evidence: {
        source_events: [],
        diff: { before: { removed }, after: { added }, summary },
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'system', id: 'org.ranges' },
      // 44 G5：自动跟，但留痕——L3 默认放行，只通知
      automation: {
        level_at_creation: 'L3',
        auto_approved: true,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [recipientOf('owner')],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    if (item.state !== 'blocked') await flushCards()
    return batch.length
  }

  /* ── WP51 / 46 §2：同事发现与申请加入 ──────────────────────────────── */
  //
  // 模拟的是"两个各自单干的人在同一个办公室里"：两台机器、两份公司档案、
  // 一条内存网段。三件事是**真的**：
  //
  // 1. 公司名归一化与 `company_key` 用的是服务进程同一个函数（`@agentsws/core`）——
  //    "一个写全称、一个多打空格还加了有限公司" 算出同一把钥匙这件事，
  //    在这里与在真进程里是同一段代码说了算；
  // 2. 申请加入出的是一张真的 `membership` 审批卡，走真的审批总线、真的投递与决定；
  // 3. 批了之后建成员、记 `membership.approved` 并交给 20 §4 的 Join。
  //
  // 替身只有一样：局域网那一跳。多播换成一个数组——够验"同 key 互见、异 key 不见"。
  const sides = new Map<string, DiscoverSide>()
  const seenPairs = new Set<string>()
  /** 已经结过账的 membership 卡（批准的效果只走一次）。 */
  const settledMemberships = new Set<string>()
  /** 卡 id → 这条申请是谁朝谁提的。 */
  const membershipRequests = new Map<
    string,
    { request_id: string; from: string; to: string; name: string; email: string }
  >()

  /** 两边都开着开关、钥匙一样、不是同一边 → 在网段上互相看得见。 */
  const visibleTo = (side: DiscoverSide): DiscoverSide[] =>
    [...sides.values()].filter(
      (other) =>
        other.id !== side.id &&
        other.discoverable &&
        side.discoverable &&
        other.company_key === side.company_key,
    )

  /** 新看见的每一对记一条 `discovery.peer_seen`（同一对只记一次）。 */
  const noticePeers = (side: DiscoverSide): void => {
    for (const other of visibleTo(side)) {
      for (const [a, b] of [
        [side, other],
        [other, side],
      ] as [DiscoverSide, DiscoverSide][]) {
        const key = `${a.id}->${b.id}`
        if (seenPairs.has(key)) continue
        seenPairs.add(key)
        // 日志里只有对方的 peer id：没有公司名、没有成员、没有钥匙
        world.appendEvent(
          'discovery.peer_seen',
          { peer_id: b.id },
          { actor: { kind: 'system', id: 'discovery' } },
        )
      }
    }
  }

  const discover: DiscoverOps = {
    firstRun({ side, who, legal_name, domain, discoverable }) {
      const key = companyKey(legal_name, domain)
      const row: DiscoverSide = {
        id: side,
        owner: who,
        legal_name,
        ...(domain === undefined ? {} : { domain }),
        discoverable: discoverable ?? true,
        company_key: key,
      }
      sides.set(side, row)
      // 21 §5：只有哈希与"有没有域名"进日志，全称留在本机
      world.appendEvent(
        'workspace.profile_set',
        { company_key: key, has_domain: domain !== undefined, discoverable: row.discoverable },
        { actor: { kind: 'person', id: who } },
      )
      world.appendEvent(
        row.discoverable ? 'discovery.enabled' : 'discovery.disabled',
        { available: true },
        { actor: { kind: 'person', id: who } },
      )
      if (row.discoverable) noticePeers(row)
      return { ...row }
    },

    peers(side) {
      const row = sides.get(side)
      if (row === undefined) throw new SimulationError('not_found', `没有这一边：${side}`)
      return visibleTo(row).map((p) => p.id)
    },

    async requestJoin({ from, to, name, email }) {
      const source = sides.get(from)
      const target = sides.get(to)
      if (source === undefined || target === undefined) {
        throw new SimulationError('not_found', `没有这一边：${sides.has(from) ? to : from}`)
      }
      // 46 §2 I1 的底线：钥匙对不上就不是同一家，这条申请压根递不过去
      if (source.company_key !== target.company_key) {
        return { reason: '公司对不上，这条申请不属于那个工作区' }
      }
      const request_id = `mrq_${sha256(`${from}|${to}|${email}`).slice(0, 10)}`
      const summary = `${name}（${email}）在同一个局域网里，公司名算出来和你们一样。同意他就成为成员，之后走一遍合并向导。`
      const item = await txn.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'membership',
        role_id: 'common.owner',
        subject: { object: { type: 'membership_request', id: request_id } },
        dedupe_key: `${workspace_id}:membership:${sha256(email.trim().toLowerCase()).slice(0, 16)}`,
        title: `${name} 想加入`,
        summary,
        // 46 §4：申请阶段只有名字与邮箱，一个业务字段都不带
        payload: { request_id, person: { name, email }, via: 'lan' },
        evidence: {
          source_events: [],
          provenance: { seen: [] },
          diff: { before: null, after: { name, email }, summary: '工作区多一个人' },
          precheck: {},
        },
        proposer: { kind: 'system', id: 'invites' },
        automation: { level_at_creation: 'L1' },
        routing: {
          recipients: [recipientOf('owner')],
          rule: 'owner',
          escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      if (item.state === 'blocked') return { reason: '这条申请被交易控制挡下了' }
      membershipRequests.set(item.id, { request_id, from, to, name, email })
      world.appendEvent(
        'membership.requested',
        {
          request_id,
          via: 'lan',
          // 完整邮箱留在卡里给人看，日志里只有域名
          email_domain: email.split('@')[1] ?? '',
          approval_item_id: item.id,
        },
        { actor: { kind: 'system', id: 'invites' } },
      )
      await flushCards()
      return { approval_item_id: item.id }
    },
  }

  /**
   * 定了的 `membership` 卡 → 真建成员 + 交给 20 §4 的 Join（46 §2 I3）。
   *
   * 每一拍走一遍，所以不管这张卡是被合成人按策略批的还是场景里 `actor.decide`
   * 点的，效果都一样。**批准的效果只走一次**（`settledMemberships`）。
   *
   * 这里只把人放进来：品牌 / 产品线 / 店铺范围的对照是 45 合并向导的活，
   * 凭据仍要本人自己交出。`next: 'join_import'` 就是那个交接点。
   */
  const settleMemberships = async (): Promise<void> => {
    for (const item of txn.runtime.store.listApprovals({ workspace_id })) {
      if (item.kind !== 'membership' || settledMemberships.has(item.id)) continue
      if (item.state !== 'approved' && item.state !== 'rejected') continue
      const row = membershipRequests.get(item.id)
      if (row === undefined) continue
      settledMemberships.add(item.id)
      if (item.state === 'rejected') {
        world.appendEvent(
          'membership.rejected',
          { request_id: row.request_id },
          { actor: { kind: 'person', id: owner } },
        )
        continue
      }
      // 46 I3：谁 owner 批谁是目标——批了之后申请人那一边就是并进来的那一边
      sides.delete(row.from)
      world.appendEvent(
        'membership.approved',
        { request_id: row.request_id, via: 'lan', next: 'join_import' },
        { actor: { kind: 'person', id: owner } },
      )
    }
  }

  const org: OrgOps = {
    async rangeGroup({ id, name, members }) {
      const existing = roles.rangeGroups.get(id)
      if (existing === undefined) {
        roles.rangeGroups.create({ id, workspace_id, name, members })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'range_group.created',
          actor: { kind: 'person', id: owner },
          correlation: { trace_id: traceId() },
          payload: { range_group_id: id, name, members: members.length },
        })
        return { created: true, affected: 0 }
      }
      roles.rangeGroups.update(id, { name, members })
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'range_group.updated',
        actor: { kind: 'person', id: owner },
        correlation: { trace_id: traceId() },
        payload: { range_group_id: id, name, members: members.length },
      })
      const affected = await flushRangeExpanded()
      return { created: false, affected }
    },

    productLine({ id, name, parent, rule }) {
      const existing = roles.productLines.get(id)
      if (existing === undefined) {
        roles.productLines.create({ id, workspace_id, name, parent, rule })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'product_line.created',
          actor: { kind: 'person', id: owner },
          correlation: { trace_id: traceId() },
          payload: { product_line_id: id, name, parent, platform: rule.platform },
        })
        return { created: true }
      }
      roles.productLines.update(id, { name, parent, rule })
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'product_line.updated',
        actor: { kind: 'person', id: owner },
        correlation: { trace_id: traceId() },
        payload: { product_line_id: id, name, platform: rule.platform },
      })
      return { created: false }
    },

    assignRange({ who, role, ranges, range_groups }) {
      const target = assignmentFor(who, role)
      const next = roles.assignments.update(target.id, {
        ...(ranges === undefined ? {} : { ranges }),
        ...(range_groups === undefined ? {} : { range_groups }),
      })
      created.set(`${who}|${role}`, next)
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'assignment.updated',
        actor: { kind: 'person', id: owner },
        correlation: { trace_id: traceId() },
        payload: { assignment_id: next.id, person_id: who, ranges: next.ranges },
      })
      return { assignment_id: next.id, ranges: [...next.ranges] }
    },

    // ── 45：个人用 → 公司用 ────────────────────────────────────────
    personalWorkspace({ who, workspace, role, range_groups, product_lines }) {
      for (const g of range_groups ?? [])
        roles.rangeGroups.create({
          id: g.id,
          workspace_id: workspace,
          name: g.name,
          members: g.members,
          created_by: who,
        })
      for (const l of product_lines ?? [])
        roles.productLines.create({
          id: l.id,
          workspace_id: workspace,
          name: l.name,
          parent: l.parent,
          rule: l.rule,
          created_by: who,
        })
      // 一个人用 = 一家一个人的公司：他在自己那个工作区里也有一条正经岗位
      const asg = roles.assignments.create({
        person_id: who,
        workspace_id: workspace,
        role_id: role,
        granted_by: who,
        ...(range_groups === undefined || range_groups.length === 0
          ? {}
          : { range_groups: range_groups.map((g) => g.id) }),
      })
      // 不用 `${who}|${role}` 那把键：那是"他在公司的岗位"，别被个人那条盖掉
      created.set(`${who}|${role}@${workspace}`, asg)
      return { assignment_id: asg.id, ranges: [...asg.ranges] }
    },

    /*
     * 52 O1（WP65）：开一个品牌 = 换一个 `workspace_id`。
     *
     * 下面四样各进一个**不同的真库**：职责层（分配）、审批总线（卡）、知识层（事实卡）、
     * 数据层（店铺连接）。四个库都只按 `workspace_id` 切，所以这里一行过滤都不用写。
     */
    async brand({ id, name, who, role, seed }) {
      appendEnvelope({
        schema_version: 1,
        workspace_id: id,
        type: 'brand.created',
        actor: { kind: 'person', id: who },
        correlation: { trace_id: traceId() },
        // 品牌名是用户起的名字，与公司名同级——不进日志（21 §1）
        payload: { workspace_id: id, organization_id: workspace_id },
      })
      const asg = roles.assignments.create({
        person_id: who,
        workspace_id: id,
        role_id: role,
        granted_by: who,
      })
      // 与 `personalWorkspace` 同一把键：别把"他在公司的岗位"盖掉
      created.set(`${who}|${role}@${id}`, asg)

      if (seed?.card !== undefined) {
        const item = await txn.approvals.create({
          workspace_id: id,
          schema_version: 1,
          kind: 'outbound_draft',
          role_id: role,
          subject: { object: { type: 'thread', id: `thr_${id}` } },
          dedupe_key: `${id}:outbound_draft:${name}`,
          title: seed.card,
          summary: seed.card,
          payload: {
            channel: 'email',
            to: { type: 'customer', id: `cus_${id}` },
            body: { subject: seed.card, text: seed.card },
          },
          evidence: {
            source_events: [],
            // 14 §6 前置：卡上引用到的东西要真见过，收件人也得在里面（31 §3.3）
            provenance: {
              seen: [
                { type: 'thread', id: `thr_${id}` },
                { type: 'customer', id: `cus_${id}` },
              ],
            },
            precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
          },
          proposer: { kind: 'person', id: who },
          automation: {
            level_at_creation: 'L1',
            auto_approved: false,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: [{ person: who, via: 'role_holder' }],
            rule: 'role_holder',
            escalation: {
              after_hours: 72,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
          // 31 §3.3 收件人门禁：这位客户就是这条会话的原参与者
          context: {
            thread_participants: [`cus_${id}`],
            verified_contacts: [`cus_${id}`],
          },
        })
        void item
      }

      if (seed?.fact !== undefined) {
        const card = await knowledge.store.propose({
          schema_version: 1,
          workspace_id: id,
          layer: 'fact',
          domain: 'company',
          scope: [],
          sensitivity: 'internal',
          subject: { type: 'company', key: `brand.${id}` },
          statement: seed.fact,
          provenance: [{ source: 'document', ref: `${id}.md`, at: clock.now() }],
          confidence: { value: 0.9, state: 'probable' },
          valid: {},
          owner: who,
          created_by: { kind: 'person', id: who },
        })
        await knowledge.store.activate(card.id, who)
      }

      if (seed?.connection !== undefined) {
        await data.put<{ service: string; label: string; credential_key: string }>(
          'connections',
          {
            id: `conn_${id}`,
            schema_version: 1,
            workspace_id: id,
            owners: [who],
            scope: [],
            sensitivity: 'internal',
            service: 'shopify_admin',
            label: seed.connection,
            // WP66：凭据在加密库里的 key **名**（值不在这里，也不该在）
            credential_key: `ws:${id}/conn:conn_${id}`,
          },
          { ...seedActor, workspace_id: id },
        )
      }

      /*
       * WP66（52 O3）：这个品牌自己那一套模型设置。
       *
       * 与上面四样一样，它进的是**按 `workspace_id` 切的那个库**——所以这里
       * 照样一行"过滤 brand_id"都不用写。
       */
      if (seed?.model !== undefined) {
        await data.put<{ label: string; credential_key: string }>(
          'model_providers',
          {
            id: `mp_${id}`,
            schema_version: 1,
            workspace_id: id,
            owners: [who],
            scope: [],
            sensitivity: 'internal',
            label: seed.model,
            credential_key: `ws:${id}/model_provider:mp_${id}`,
          },
          { ...seedActor, workspace_id: id },
        )
      }

      return this.brandVisible(id, who)
    },

    async brandVisible(brand, who) {
      const positions = roles.assignments
        .listByPerson(who, { workspace_id: brand })
        .filter((a) => a.revoked_at === undefined)
        .map((a) => a.role_id)
      const cards = (
        await txn.approvals.queue({
          workspace_id: brand,
          person_id: who,
          lane: 'scope',
          state: ['pending', 'in_review'],
        })
      ).map((i) => i.title)
      const facts = (
        await knowledge.store.list(
          { workspace_id: brand },
          {
            person_id: who,
            assignment_id: 'asg_seed',
            role_id: 'common.owner',
            workspace_id: brand,
            grants: [
              {
                domain: 'knowledge',
                ops: ['read'],
                range: 'workspace',
                max_sensitivity: 'restricted',
              },
            ],
            ranges: [],
          },
        )
      ).map((c) => c.statement)
      const connectionRows = (
        await data.query<{ service: string; label: string; credential_key?: string }>(
          'connections',
          {},
          { ...seedActor, workspace_id: brand },
        )
      ).items
      const modelRows = (
        await data.query<{ label: string; credential_key?: string }>(
          'model_providers',
          {},
          { ...seedActor, workspace_id: brand },
        )
      ).items
      return {
        brand,
        positions,
        cards,
        facts,
        connections: connectionRows.map((r) => r.id),
        models: modelRows.map((r) => r.label),
        credential_keys: [...connectionRows, ...modelRows].flatMap((r) =>
          r.credential_key === undefined ? [] : [r.credential_key],
        ),
      }
    },

    async join({ who, from, decisions }) {
      const liveOf = (ws: string) => ({
        groups: roles.rangeGroups.list(ws).filter((g) => g.superseded_by === undefined),
        lines: roles.productLines.list(ws).filter((l) => l.superseded_by === undefined),
      })
      const mineSide = liveOf(from)
      const bundle: JoinExportBundle = {
        schema_version: 1,
        workspace_id: from,
        person_id: who,
        exported_at: clock.now(),
        range_groups: mineSide.groups.map((g) => structuredClone(g)),
        product_lines: mineSide.lines.map((l) => structuredClone(l)),
        store_ranges: deriveStoreRanges({
          assignment_ranges: roles.assignments
            .listByWorkspace(from, {})
            .filter((a) => a.revoked_at === undefined)
            .flatMap((a) => a.ranges),
          range_groups: mineSide.groups,
          product_lines: [],
        }),
        connections: [],
      }
      const companySide = liveOf(workspace_id)
      const join_id = `join_${sha256(`${from}:${workspace_id}:${who}`).slice(0, 12)}`
      const payload = compareJoinBundle({
        bundle,
        company: {
          range_groups: companySide.groups,
          product_lines: companySide.lines,
          store_ranges: deriveStoreRanges({
            assignment_ranges: roles.assignments
              .listByWorkspace(workspace_id, {})
              .filter((a) => a.revoked_at === undefined)
              .flatMap((a) => a.ranges),
            range_groups: companySide.groups,
            product_lines: companySide.lines,
          }),
        },
        holders: (kind, id) =>
          kind === 'range_group'
            ? roles.rangeGroups.assignments(id).length
            : kind === 'product_line'
              ? roles.productLines.assignments(id).length
              : 0,
        join_id,
        target_workspace_id: workspace_id,
      })
      // 一次 Join 一张卡，owner 一次签字（14；45 §4「任何合并都要人点头」）
      const item = await txn.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'join_mapping',
        role_id: 'common.owner',
        subject: { object: { type: 'policy', id: `join:${join_id}` } },
        dedupe_key: `${workspace_id}:join:${join_id}`,
        title: `${who} 要把个人工作区并进公司`,
        summary: joinSummary(payload),
        payload: payload as unknown as Record<string, unknown>,
        evidence: {
          source_events: [],
          diff: { before: {}, after: { objects: payload.counts }, summary: joinSummary(payload) },
          provenance: { seen: [] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: { kind: 'person', id: who },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [recipientOf('owner')],
          rule: 'owner',
          escalation: {
            after_hours: 72,
            business_hours: true,
            chain: ['owner'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
      })
      if (item.state !== 'blocked') await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'join.started',
        actor: { kind: 'person', id: who },
        correlation: { trace_id: traceId() },
        payload: { join_id, source_workspace_id: from, counts: payload.counts },
      })

      // owner 选了什么（没提到的按 `suggested`——那也是他按下"批准"这一下带来的）
      const picked = new Map((decisions ?? []).map((d) => [d.unique_key, d] as const))
      const aliases: OrgAlias[] = []
      let merged = 0
      let made = 0
      for (const o of payload.objects as JoinObjectComparison[]) {
        const choice = picked.get(o.unique_key)
        const chosen = choice?.chosen ?? o.suggested
        if (chosen === 'skip' || chosen === 'keep_both') continue
        if ((chosen === 'merge_union' || chosen === 'adopt_company') && o.theirs !== undefined) {
          if (chosen === 'merge_union' && o.kind !== 'store_range') {
            const result = mergeOrgPair(roles, {
              kind: o.kind,
              keep: o.theirs.id,
              drop: o.mine.id,
              ...(choice?.name_choice === 'personal' ? { name: o.mine.name } : {}),
              origin: { workspace_id: from, person_id: who, object_id: o.mine.id },
            })
            if (result !== undefined)
              appendEnvelope({
                schema_version: 1,
                workspace_id,
                type: `${o.kind}.merged`,
                actor: { kind: 'person', id: who },
                correlation: { trace_id: traceId() },
                payload: { keep: result.keep, from: result.drop, name: result.name },
              })
          } else if (o.kind === 'range_group') roles.rangeGroups.supersede(o.mine.id, o.theirs.id)
          else if (o.kind === 'product_line') roles.productLines.supersede(o.mine.id, o.theirs.id)
          aliases.push({ kind: o.kind, from: o.mine.id, to: o.theirs.id })
          merged += 1
          continue
        }
        if (chosen === 'create_in_company') {
          if (o.kind === 'range_group') {
            const madeGroup = roles.rangeGroups.create({
              workspace_id,
              name: o.mine.name,
              members: o.mine.members ?? [],
              created_by: who,
              origin: { workspace_id: from, person_id: who, object_id: o.mine.id },
            })
            roles.rangeGroups.supersede(o.mine.id, madeGroup.id)
            aliases.push({ kind: o.kind, from: o.mine.id, to: madeGroup.id })
          } else if (
            o.kind === 'product_line' &&
            o.mine.parent !== undefined &&
            o.mine.rule !== undefined
          ) {
            const madeLine = roles.productLines.create({
              workspace_id,
              name: o.mine.name,
              parent: o.mine.parent,
              rule: o.mine.rule,
              created_by: who,
              origin: { workspace_id: from, person_id: who, object_id: o.mine.id },
            })
            roles.productLines.supersede(o.mine.id, madeLine.id)
            aliases.push({ kind: o.kind, from: o.mine.id, to: madeLine.id })
            appendEnvelope({
              schema_version: 1,
              workspace_id,
              type: 'product_line.created',
              actor: { kind: 'person', id: who },
              correlation: { trace_id: traceId() },
              payload: { product_line_id: madeLine.id, name: madeLine.name, from_join: join_id },
            })
          }
          made += 1
        }
      }
      // 45 H3 最后一句：挂在被取代对象上的岗位范围指到公司那份（两个工作区都过一遍）
      const { rewrites, traces } = rewriteAliasedAssignments(roles, aliases, {
        assignments: [
          ...roles.assignments.listByWorkspace(workspace_id, {}),
          ...roles.assignments.listByWorkspace(from, {}),
        ],
      })
      for (const trace of traces)
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: trace.type,
          actor:
            trace.type === 'range.alias_resolved'
              ? { kind: 'person', id: who }
              : { kind: 'system', id: 'join' },
          correlation: { trace_id: traceId() },
          payload:
            trace.type === 'range.alias_resolved'
              ? { assignment_id: trace.assignment_id, changed: trace.changed }
              : {
                  assignment_id: trace.assignment_id,
                  person_id: trace.person_id,
                  role_id: trace.role_id,
                  reason: 'join_alias',
                  added: trace.added,
                  removed: trace.removed,
                },
        })
      // 合并让公司品牌多了成员 → 挂着它的老同事的范围也跟着变（44 G5，一张 L3 卡）
      await flushRangeExpanded()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'join.completed',
        actor: { kind: 'person', id: who },
        correlation: { trace_id: traceId() },
        payload: { join_id, merged, created: made, range_rewrites: rewrites },
      })
      return {
        approval_item_id: item.id,
        counts: payload.counts,
        merged,
        created: made,
        aliases,
        range_rewrites: rewrites,
      }
    },

    visible(who, role) {
      const target = assignmentFor(who, role)
      const lines = target.ranges
        .filter((r) => r.kind === 'product_line')
        .map((r) => roles.productLines.get(r.id))
        .filter((l) => l !== undefined)
      const state = standIns.connect.state
      // 挂整店 / 整账号的看全部；一条范围都没有的什么都看不到（05 §5）
      if (target.ranges.length === 0) return { orders: [], products: [] }
      if (lines.length === 0)
        return {
          orders: state.orders.map((o) => o.id),
          products: state.products.map((p) => p.id),
        }
      const hits = (product_id: string): boolean =>
        lines.some((l) =>
          productLineMatches(l.rule, { platform: 'shopify', product_ids: [product_id] }),
        )
      return {
        orders: state.orders
          .filter((o) => o.line_items.some((li) => hits(li.product_id)))
          .map((o) => o.id),
        products: state.products.filter((p) => hits(p.id)).map((p) => p.id),
      }
    },

    async platformCheck(who, role) {
      const platform = pack.workspace.storefront_platform ?? DEFAULT_STOREFRONT_PLATFORM
      const note = storefrontUnsupportedNote(pack.workspace.storefront_platform)
      const asg = assignmentFor(who, role)

      // ① 岗位面板：走真的那一套（`@agentsws/deck` 的 `assembleView`），不是照着抄一份
      const sources = dataSourcesFromConnections(
        [
          { service: 'shopify_admin', status: 'active' },
          { service: 'imap_smtp', status: 'active' },
        ],
        { ...(note === undefined ? {} : { storefrontNote: note }) },
      )
      const section = assembleView(role, {
        now: now(clock),
        tz_offset_minutes: wallClock(clock.nowMs(), pack.workspace.tz).offset,
        base_currency: pack.workspace.base_currency,
        role_id: role,
        position_id: asg.id,
        orders: [],
        approvals: [],
        sources,
      }).find((v) => v.source === 'shop')

      // ② 事项工具：真调一次 `get_order`，走的是运行时用的同一个执行器
      const run = await beginShopRun(asg)
      let tool: { status: string; reason?: string }
      try {
        const out = await holder.executeTool?.({
          name: 'get_order',
          input: { order_id: 'ord_1' },
          request: {
            actor: { person_id: who, assignment_id: asg.id, role_id: role },
            tools: { allow: ['get_order'], connect_token: '', side_effect_policy: 'executor' },
          } as unknown as RunRequest,
        })
        tool = {
          status: out?.status ?? 'error',
          ...(out?.reason === undefined ? {} : { reason: out.reason }),
        }
      } finally {
        run.finish({ seen: [], outputs: [], summary: '平台体检：只问了一次，没动任何东西' })
      }

      // ③ 首次设置第 ④ 步的清单：`kind: shop` 的连接器按档案解析（平台没有就是空）
      const def = roles.roles.get(role)
      // 清单问的是"今天点得动的是哪一个"，不是"将来走哪个 provider"
      const shopService = storefrontUsableService(pack.workspace.storefront_platform)
      const shop_services = (def?.connectors ?? [])
        .filter((c) => c.kind === 'shop' || c.kind === 'shopify')
        .flatMap(() => (shopService === undefined ? [] : [shopService]))

      return {
        platform,
        panel: {
          connected: section?.connected ?? false,
          ...(section?.note === undefined ? {} : { note: section.note }),
        },
        tool,
        shop_services: [...new Set(shop_services)],
      }
    },
  }

  const shop: ShopOps = {
    devMcp,
    themeCli,

    async priceChange({ who, product, price, graphql, note }) {
      const asg = assignmentFor(who, 'dtc.store')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'product', id: product }

      // ① 真读一次。读不到就别提——`before` 必须来自记录，不是谁转述的（15 §1）
      let record: { id: string; price: number; title: string; record_version: string }
      try {
        const res = await connect.execute<typeof record>(
          'shopify_admin.get_product',
          { product_id: product },
          { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
        )
        record = res.data
        run.tool('get_product', { product_id: product }, [target])
      } catch (err) {
        blocked.push({
          rule: 'record_read_failed',
          at: now(clock),
          run_id,
          message: messageOfError(err),
        })
        run.finish({ seen: [], outputs: [], summary: '读不到这件商品，没提案' })
        return { staged: false, reason: 'record_read_failed' }
      }

      // ② 先查文档再动手：官方给的是 productVariantsBulkUpdate，不是模型记忆里那个
      const docs = devMcp.execute(MCP_DOCS_TOOL, {
        query: `how to change the price of ${record.title}`,
      })
      run.tool(MCP_DOCS_TOOL, { query: 'change product price', hits: docs.status })

      // ③ 过官方校验。**不给 graphql 的场景按真名字生成**，给了的就照原样验
      const document =
        graphql ??
        `mutation { productVariantsBulkUpdate(productId: "${product}", ` +
          `variants: [{ id: "${product}-v1", price: "${price}" }]) { userErrors { field message } } }`
      const verdict = devMcp.execute(MCP_VALIDATE_TOOL, { document })
      const verdictData = verdict.data as { result?: string; errors?: string[] } | undefined
      const valid = verdict.status === 'ok' && verdictData?.result === 'success'
      run.tool(MCP_VALIDATE_TOOL, { document, verdict: valid ? 'success' : 'failure' })
      if (!valid) {
        const errors = verdictData?.errors ?? [verdict.reason ?? 'unknown']
        blocked.push({
          rule: 'graphql_invalid',
          at: now(clock),
          run_id,
          message: `官方校验器不认这段 GraphQL：${errors.join('；')}`,
        })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'shopify.graphql_rejected',
          actor: { kind: 'agent', id: asg.id, run_id },
          correlation: { trace_id: traceId(), run_id },
          payload: { errors: errors.slice(0, 3) },
        })
        // 读过的照样记：这次运行确实读了商品，只是没提出案来
        run.finish({ seen: [target], outputs: [], summary: '官方校验没过，这条没进队列' })
        return { staged: false, reason: 'graphql_invalid' }
      }

      // ④ 提一条变更。额度与等级来自**这个人这条职责**的生效配置，不是主分配的
      const config = roles.effectiveConfig(asg.id)
      const action = config.actions.find((a) => a.id === 'stage_price_change')
      const provenance = run.finish({
        seen: [target],
        outputs: [],
        summary: `提一条改价：${record.title} ${record.price} → ${price}`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_shop_${run_id}`,
        kind: 'price_change',
        target,
        field: 'price',
        before: { price: record.price, title: record.title },
        after: { price },
        record_version: record.record_version,
        notes: note === undefined ? [] : [note],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate: action?.mandate ?? { caps: {} },
        level: config.automation.stage_price_change?.level ?? 'L1',
        provenance,
        connection_id: 'conn_shopify_admin',
        approval: {
          title: `改价：${record.title} ${record.price} → ${price}`,
          summary: note ?? `${record.title} 的售价从 ${record.price} 改成 ${price}`,
          recipients: [recipientOf('scope_manager')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'scope_manager',
          separation_of_duties: true,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      await flushCards()
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    /**
     * WP63（51 §2.1）：上架 / 撤下。
     *
     * 与改价共用同一条路（真读 → 提案 → 人审 → 施行），只有两处不同：
     * ① 不查 Dev MCP——上下架没有要验的 GraphQL 文档（它就是一个发布状态的开关）；
     * ② `HARD_L1` 会把 `level` 拉回人审，所以这条题里报 L3 也自动不了。
     */
    async publishProduct({ who, product, publish, level, note }) {
      const asg = assignmentFor(who, 'dtc.store')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'product', id: product }

      // 先真读一次：`before.published` 必须来自记录（15 §1）
      let record: { id: string; title: string; status?: string; record_version: string }
      try {
        const res = await connect.execute<typeof record>(
          'shopify_admin.get_product',
          { product_id: product },
          { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
        )
        record = res.data
        run.tool('get_product', { product_id: product }, [target])
      } catch (err) {
        blocked.push({
          rule: 'record_read_failed',
          at: now(clock),
          run_id,
          message: messageOfError(err),
        })
        run.finish({ seen: [], outputs: [], summary: '读不到这件商品，没提案' })
        return { staged: false, reason: 'record_read_failed' }
      }

      const kind: ChangeKind = publish ? 'publish_product' : 'unpublish_product'
      const actionId = publish ? 'stage_publish_product' : 'stage_unpublish_product'
      const config = roles.effectiveConfig(asg.id)
      const action = config.actions.find((a) => a.id === actionId)
      const verb = publish ? '上架' : '撤下'
      const provenance = run.finish({
        seen: [target],
        outputs: [],
        summary: `提一条${verb}：${record.title}`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_shop_${run_id}`,
        kind,
        target,
        before: { published: record.status === 'active', title: record.title },
        after: { published: publish },
        record_version: record.record_version,
        notes: note === undefined ? [] : [note],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate: action?.mandate ?? { caps: {} },
        // 故意允许报高：`HARD_L1` 会把它拉回人审，这正是要证的事
        level: level ?? config.automation[actionId]?.level ?? 'L1',
        provenance,
        connection_id: 'conn_shopify_admin',
        approval: {
          title: `${verb}：${record.title}`,
          summary:
            note ??
            (publish
              ? `${record.title} 会出现在在线商店里，顾客马上买得到。`
              : `${record.title} 会从在线商店撤下，顾客买不到。`),
          recipients: [recipientOf(publish ? 'scope_manager' : 'role_holder')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: publish ? 'scope_manager' : 'role_holder',
          separation_of_duties: true,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      await flushCards()
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    /**
     * WP63（51 §2.2）：写 / 发一篇文章。
     *
     * 草稿与发布是**同一条 kind 的两次提案**，不是两条 kind——所以场景里"先写后发"
     * 走的是同一条路，只有 `after.published` 不同，人看到的却是两种后果。
     */
    async blogPost({ who, title, publish, article, body }) {
      const asg = assignmentFor(who, 'dtc.content')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const id = article ?? `art_${sha256(title).slice(0, 10)}`
      const target: ObjectRef = { type: 'article', id }

      // 改前必读：文章的 `before` 就是那段正文，没读全文就改等于拿摘要覆盖原文。
      // 这里读的是**我们自己库里**那一份（合成世界没有博客连接器），读到就算读过。
      const existing = articles.get(id)
      run.tool('list_articles', { article_id: id }, [target])
      const config = roles.effectiveConfig(asg.id)
      const action = config.actions.find((a) => a.id === 'stage_publish_post')
      const provenance = run.finish({
        seen: [target],
        outputs: [],
        summary: publish ? `提一条发布：${title}` : `提一条草稿：${title}`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_content_${run_id}`,
        kind: 'publish_post',
        target,
        before: { title: existing?.title ?? title, published: existing?.published ?? false },
        after: { title, published: publish, ...(body === undefined ? {} : { body }) },
        notes: [],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate: action?.mandate ?? { caps: {} },
        level: config.automation.stage_publish_post?.level ?? 'L1',
        provenance,
        connection_id: 'conn_shopify_admin',
        approval: {
          title: publish ? `发布文章：${title}` : `文章草稿：${title}`,
          summary: publish
            ? `这篇会出现在店里的博客上。发布永远要人点一下（51 §2.2）。`
            : `草稿存在后台，顾客看不到。`,
          recipients: [recipientOf('scope_manager')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'scope_manager',
          separation_of_duties: true,
          source_events: [],
        },
      })
      articles.set(id, { title, published: publish })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      await flushCards()
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    /**
     * WP63（51 §2.1 数据日报）：一张日报卡。
     *
     * 三件事值得说：
     * 1. **不进变更账本**。数据日报那一面没有写动作——它不改店里的任何东西，
     *    所以它是一张卡，不是一条变更。
     * 2. **数不经模型手**（29 原则 ③）。销售额、订单数、库存告急、待审条数
     *    全部从结构化行数出来，模型一个数都碰不到。
     * 3. **L3 自动出、看完归档**。所以它建出来就是 `auto_approved`——人要做的
     *    只有看一眼；它不该在谁的队列里压着等审批。
     */
    async dailyReport({ who }) {
      const asg = assignmentFor(who, 'dtc.store')
      const at = now(clock)
      const dayStart = Date.parse(at) - REPORT_WINDOW_MS
      const orders = connect.state.orders.filter(
        (o) => Date.parse(o.created_at) >= dayStart && Date.parse(o.created_at) <= Date.parse(at),
      )
      const sales = Math.round(orders.reduce((n, o) => n + o.total_price, 0) * 100) / 100
      // 阈值从职责 yml 来（51 §2.1）；职责没装就退回一个保守的默认
      const lowStockLine = roles.roles.get('dtc.store')?.thresholds?.low_stock_quantity ?? 5
      const low_stock = connect.state.products.filter(
        (p) => typeof p.inventory === 'number' && p.inventory <= lowStockLine,
      ).length
      const pending = txn.runtime.store
        .listApprovals({ workspace_id })
        .filter(
          (i) => i.kind === 'staged_change' && ['pending', 'in_review'].includes(i.state),
        ).length
      const figures = { sales, orders: orders.length, low_stock, pending }
      const date = at.slice(0, 10)
      const item = await txn.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'daily_report',
        role_id: asg.role_id,
        subject: { object: { type: 'workspace', id: workspace_id } },
        dedupe_key: `dk_${workspace_id}|daily_report|${date}`,
        title: `店铺日报 ${date}`,
        summary: `销售额 ${sales}、订单 ${orders.length} 笔；库存告急 ${low_stock} 个 SKU、待审改动 ${pending} 条。`,
        payload: { date, ...figures },
        evidence: {
          run_id: `run_report_${date}`,
          source_events: [],
          provenance: { seen: [] },
          precheck: {},
        },
        proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
        automation: {
          // L3：日报是"看一眼就归档"的东西，不该在谁的队列里压着等审批
          level_at_creation: 'L3',
          auto_approved: true,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [recipientOf('role_holder')],
          rule: 'role_holder',
          escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'digest',
      })
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'digest.daily_report',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId() },
        payload: { date, ...figures },
      })
      await flushCards()
      return { approval_item_id: item.id, figures }
    },

    themePush({ who, name }) {
      const asg = assignmentFor(who, 'site.builder')
      // 造一份未发布副本对线上没有任何影响，所以它不进账本（见
      // `connect-adapter/src/shopify-actions.ts` 里 create_theme 那一条的理由）。
      // 走的是 CLI 那条路，不是连接器——预览链接就是给人看的审批材料。
      const pushed = themeCli.pushUnpublished({ name })
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'shopify.theme_pushed',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId() },
        payload: { theme_id: pushed.theme_id, unpublished: true },
      })
      return Promise.resolve({
        theme_id: pushed.theme_id,
        theme_name: pushed.theme_name,
        ...(pushed.preview_url === undefined ? {} : { preview_url: pushed.preview_url }),
      })
    },

    async themePublish({ who, theme, level }) {
      const asg = assignmentFor(who, 'site.builder')
      const run = await beginShopRun(asg)
      const run_id = run.run_id

      // 真跑一次 `theme list`：`before` 是**现在线上那一份**，不是谁记得的那一份
      const themes = themeCli.list()
      run.tool('theme_list', { count: themes.length })
      const live = themes.find((t) => t.role === 'main')
      const candidate =
        theme === undefined
          ? themes.filter((t) => t.role === 'unpublished').at(-1)
          : themes.find((t) => t.id === theme)
      if (live === undefined || candidate === undefined) {
        blocked.push({
          rule: 'theme_not_found',
          at: now(clock),
          run_id,
          message: '找不到线上主题或要发布的那份副本',
        })
        run.finish({ seen: [], outputs: [], summary: '找不到要发布的主题' })
        return { staged: false, reason: 'theme_not_found' }
      }

      const target: ObjectRef = { type: 'theme', id: candidate.id }
      const config = roles.effectiveConfig(asg.id)
      const action = config.actions.find((a) => a.id === 'stage_publish_theme')
      const provenance = run.finish({
        seen: [target, { type: 'theme', id: live.id }],
        outputs: [
          {
            kind: 'dev_result',
            dev_task_id: run_id,
            payload: { theme_id: candidate.id },
          },
        ],
        summary: `提一条发布主题：${live.name} → ${candidate.name}`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_shop_${run_id}`,
        kind: 'publish_theme',
        target,
        before: { theme_id: live.id, theme_name: live.name },
        after: {
          theme_id: candidate.id,
          theme_name: candidate.name,
          ...(candidate.preview_url === undefined ? {} : { preview_url: candidate.preview_url }),
        },
        notes: [
          `把线上主题从「${live.name}」换成「${candidate.name}」`,
          ...(candidate.preview_url === undefined ? [] : [`预览：${candidate.preview_url}`]),
        ],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate: action?.mandate ?? { caps: {} },
        // 15 §2 hard_ceiling：这里就算报 L3，guardrail 也会把它拉回人审
        level: level ?? config.automation.stage_publish_theme?.level ?? 'L1',
        provenance,
        connection_id: 'conn_shopify_admin',
        approval: {
          title: `发布主题：${candidate.name}`,
          summary: `线上主题会从「${live.name}」换成「${candidate.name}」。批准前先点开预览看一眼。`,
          recipients: [recipientOf('owner')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'owner',
          separation_of_duties: true,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      await flushCards()
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },
  }

  // ── WP64：邮件营销（51 §2.3）与订单履约（51 §2.4）────────────────────

  /**
   * 退订 / 抑制名单。
   *
   * 它在世界里，不在场景里：谁退订过是一件**已经发生的事**，群发时该不该剔他
   * 由 `@agentsws/core` 的那一份规则算（客服出站用的是同一份）。
   */
  const unsubscribed: string[] = []

  /** 这个人这条职责上某个动作的额度与等级（不是主分配的——三条职责三份）。 */
  const actionOf = (asg: Assignment, id: string) => {
    const config = roles.effectiveConfig(asg.id)
    return {
      mandate: config.actions.find((a) => a.id === id)?.mandate ?? { caps: {} },
      level: config.automation[id]?.level ?? 'L1',
    }
  }

  const web: WebOps = {
    async overdueSweep({ who }) {
      const asg = assignmentFor(who, 'dtc.fulfillment')
      const run = await beginShopRun(asg)
      const { mandate } = actionOf(asg, 'stage_create_fulfillment')
      const cap = mandate.caps.overdue_days
      const overdue_days = typeof cap === 'number' ? cap : 3
      const res = await connect.execute<{
        orders: { id: string; name: string; created_at: string; fulfillment_status: string }[]
      }>(
        'shopify_admin.list_orders',
        { first: 200 },
        { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
      )
      const nowMs = Date.parse(now(clock))
      const rows = res.data.orders
        .filter((o) => o.fulfillment_status === 'unfulfilled')
        .map((o) => ({
          id: o.id,
          name: o.name,
          days: Math.floor((nowMs - Date.parse(o.created_at)) / 86_400_000),
        }))
        .filter((o) => Number.isFinite(o.days) && o.days > overdue_days)
        .sort((a, b) => b.days - a.days)
      run.tool('list_orders', { first: 200, unfulfilled: rows.length })
      run.finish({
        seen: rows.map((o) => ({ type: 'order', id: o.id })),
        outputs: [],
        summary: `超期未发 ${rows.length} 张（> ${overdue_days} 天）`,
      })
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.fulfillment_overdue',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId() },
        payload: {
          overdue_days,
          count: rows.length,
          orders: rows.slice(0, 10).map((o) => o.name),
          worst_days: rows[0]?.days ?? 0,
        },
      })
      // 51 §2.4 的 `order.overdue` 通知：压了几天要有人知道，不能只躺在面板上
      if (rows.length > 0) {
        world.notify({
          to: asg.person_id,
          channel: 'workstation',
          title: `超期未发 ${rows.length} 张`,
          at: now(clock),
          reason: `最久的一张压了 ${rows[0]?.days ?? 0} 天（超过 ${overdue_days} 天就该有人看一眼）`,
        })
      }
      return { orders: rows, overdue_days }
    },

    async markShipped({ who, order, carrier, tracking, level }) {
      const asg = assignmentFor(who, 'dtc.fulfillment')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'order', id: order }

      // ① 真读一次：`before` 必须来自记录（15 §1），而且 `requires_record_read` 查的就是它
      let record: {
        id: string
        name: string
        created_at: string
        financial_status: string
        fulfillment_status: string
        record_version: string
      }
      try {
        const res = await connect.execute<typeof record>(
          'shopify_admin.get_order',
          { order_id: order },
          { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
        )
        record = res.data
        run.tool('get_order', { order_id: order }, [target])
      } catch (err) {
        blocked.push({
          rule: 'record_read_failed',
          at: now(clock),
          run_id,
          message: messageOfError(err),
        })
        run.finish({ seen: [], outputs: [], summary: '读不到这张订单，没提案' })
        return { staged: false, reason: 'record_read_failed' }
      }

      const { mandate, level: configured } = actionOf(asg, 'stage_create_fulfillment')
      // `before` 与 `record_version` 走**施行时也会用的那一份**读法（`readRecord`），
      // 否则两处读出来的版本串形状不一样，每一条都会在施行那一步悄悄判成 stale_record。
      // （WP44 的改价撞过同一个坑，见 `recordFacts` 的注释。）
      const facts = recordFacts(target)
      const provenance = run.finish({
        seen: [target],
        outputs: [],
        summary: `标记发货：${record.name} ${carrier} ${tracking}`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_web_${run_id}`,
        kind: 'create_fulfillment',
        target,
        before: { ...(facts.record as Record<string, unknown>), created_at: record.created_at },
        after: { carrier, tracking_number: tracking },
        ...(facts.record_version === undefined ? {} : { record_version: facts.record_version }),
        notes: [`${carrier} ${tracking}`],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        level: level ?? configured,
        provenance,
        connection_id: 'conn_shopify_admin',
        approval: {
          title: `标记发货：${record.name}`,
          summary: `${record.name} 交给 ${carrier}，单号 ${tracking}。`,
          recipients: [recipientOf('scope_manager')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'scope_manager',
          separation_of_duties: true,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      await flushCards()
      return { staged: true, change_id: outcome.change.id, approval_item_id: outcome.approval.id }
    },

    unsubscribe({ email }) {
      if (!unsubscribed.includes(email)) unsubscribed.push(email)
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.email_unsubscribed',
        actor: { kind: 'system', id: 'simulation' },
        correlation: { trace_id: traceId() },
        // 名单上有几个人是要紧的；谁在名单上不进事件日志（那是顾客的隐私）
        payload: { suppression_list_size: unsubscribed.length },
      })
    },

    async campaignSend({ who, campaign, note, level }) {
      const asg = assignmentFor(who, 'dtc.email-marketing')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'email_campaign', id: campaign }

      // ① 收件人从**买过东西的人**里来（复购 / 再营销就是这么选的），
      //    经 mock connect 真读一次订单——名单是查出来的，不是想出来的。
      const res = await connect.execute<{ orders: { id: string; email: string }[] }>(
        'shopify_admin.list_orders',
        { first: 200 },
        { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
      )
      const everyone = [...new Set(res.data.orders.map((o) => o.email).filter((e) => e !== ''))]
      run.tool('list_orders', { first: 200, audience: everyone.length })

      // ② 抑制 / 退订名单必查。剔除用的是 `@agentsws/core` 的那一份规则——
      //    WP55 的客服出站与这里调的是同一个函数，名单口径不许在两边各演化一套。
      const suppressed = suppressedRecipients(everyone, unsubscribed)
      const audience = withoutSuppressed(everyone, unsubscribed)
      const suppressionNote =
        suppressed.length === 0
          ? '退订 / 抑制名单查过了，这一批里没有名单上的人。'
          : `退订 / 抑制名单里的 ${suppressed.length} 个人已经剔除，不在这次的收件人里。`

      const { mandate, level: configured } = actionOf(asg, 'stage_campaign_send')
      const level_requested = level ?? configured
      const provenance = run.finish({
        seen: [target, ...res.data.orders.slice(0, 20).map((o) => ({ type: 'order', id: o.id }))],
        outputs: [],
        summary: `提一条群发：${campaign}，${audience.length} 人`,
      })
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_web_${run_id}`,
        kind: 'campaign_send',
        target,
        before: { status: 'draft' },
        after: {
          audience,
          audience_size: audience.length,
          suppressed,
          // 15 §2：不报"查过了"就 block。fail-closed 在 guardrail 那一层，这里只是照实报。
          suppression_checked: true,
        },
        notes: [...(note === undefined ? [] : [note]), suppressionNote],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        // 15 §2 hard_ceiling：这里就算报 L3，guardrail 也会把它按回人审
        level: level_requested,
        provenance,
        approval: {
          title: `群发：${campaign}（${audience.length} 人）`,
          summary: `${audience.length} 个人会收到这封信。${suppressionNote}`,
          recipients: [recipientOf('owner')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'owner',
          separation_of_duties: true,
          source_events: [],
        },
      })
      const base = { audience, suppressed, level_requested }
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { ...base, staged: false, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.campaign_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          campaign,
          audience_size: audience.length,
          suppressed_removed: suppressed.length,
          level_requested,
          // 硬顶把它按回人审了没有：卡还在等人点 = 按回来了
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
          stated_on_card: outcome.approval.summary.includes(suppressionNote),
        },
      })
      return {
        ...base,
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },
  }

  // ── WP67：红人营销（48 §5.1）────────────────────────────────────────

  /**
   * 世界里发生的事：哪张订单用了哪个联盟码。
   *
   * 与退订名单同一类——它是**已经发生的事实**，不是场景把答案递给 Agent。
   * 金额与币种归因那一跳自己去连接器读，所以这张表里只有"码"，没有钱。
   */
  const affiliateOrders = new Map<string, string>()
  /** 这个世界里建出来的追踪链接（归因那一跳按它匹配订单）。 */
  const trackedLinks: {
    id: string
    collaboration_id: string
    utm: KolUtm
    affiliate_code?: string
  }[] = []

  /**
   * WP68：这个世界的红人库（campaign 向导挑人的池子）。
   *
   * 场景往里放人（`kol.creator`），世界只负责存与算——挑的是谁、为什么挑他，
   * 读场景的人一眼看得出来。
   */
  const kolPool: PlatformAccount[] = []
  /** 建出来的合作（campaign 接受之后每人一条）。 */
  const kolCollaborations: { id: string; creator: string; channel: KolChannel }[] = []
  /** 本地那一侧的联系方式：**只有加密库 key 名**（明文在下面那个 map 里，不出这个闭包）。 */
  const kolContactRefs: { creator: string; value_ref: string }[] = []
  const kolContactPlain = new Map<string, string>()

  /**
   * WP68：云端公共红人库（48 §5.3）——在世界里**真的跑一份**。
   *
   * 用的是 `packages/kol-public` 那一份真服务（真钱包、真价目、真加密），
   * 不是一个替身：这条题要钉的是"浏览免费、reveal 扣积分、余额不够回人话"，
   * 而这三件事全是那一份代码算出来的。少了它，断言就只是在验场景自己写的数。
   */
  const kolWallet = new Wallet({
    store: new MemoryWalletStore(),
    now: () => now(clock),
    newId: (prefix) => `${prefix}_${kolPublicSeq()}`,
  })
  let kolSeq = 0
  const kolPublicSeq = (): string => {
    kolSeq += 1
    return `${now(clock).replace(/\D/g, '').slice(0, 14)}_${kolSeq}`
  }
  const kolPublicService = new KolPublicService({
    store: new MemoryKolStore(),
    wallet: kolWallet,
    pricing: buildPricing(),
    // 测试用的一把邮箱密钥（32 字节全 7）：仓库里没有真 key，这是世界自己造的
    secrets: nodeKolSecrets({
      env: { AGENTSWS_KOL_EMAIL_KEY: Buffer.alloc(32, 7).toString('base64url') },
    }),
    now: () => now(clock),
    newId: (prefix) => `${prefix}_${kolPublicSeq()}`,
  })
  /** 这个工作区在云上的那一份主体（一个账号一个余额，49 §0）。 */
  const kolPrincipal = {
    account_id: 'acc_sim',
    org_id: 'org_sim',
    workspace_id,
    scopes: ['data'],
    region: 'global' as const,
  }

  const kol: KolOps = {
    async outreach({ who, creator, draft }) {
      const asg = assignmentFor(who, 'kol.youtube')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'creator', id: creator }
      const { mandate, level } = actionOf(asg, 'stage_outreach')

      // ① 起草。模板本身干净（`kol-core` 的三封模板里没有承诺的位置），
      //    场景递进来的那一句是"模型自己多写的那一段"。
      const base = draftOutreach('first', {
        creator_name: creator,
        brand: pack.workspace.name,
        brand_pitch: '我们做桌面充电这一类东西。',
        product: '65W 充电器',
        reason: '你那条讲桌面收纳的视频里正好缺一个充电位，',
        sender_name: who,
        channel: 'youtube',
      })
      const first = { subject: base.subject, body: `${base.body}\n${draft}` }
      const scan = reviewOutreachBody(first)

      // ② 收件人：一个合成的红人邮箱，过一遍那**一份**抑制名单规则
      const contact = `${creator}@creators.example`
      const suppressed = suppressedRecipients([contact], unsubscribed)
      const recipients = withoutSuppressed([contact], unsubscribed)

      const stageOnce = async (body: { subject: string; body: string }) =>
        txn.ledger.stage({
          workspace_id,
          role_id: asg.role_id,
          assignment_id: asg.id,
          run_id,
          change_set_id: `cs_kol_${run_id}_${scan.ok ? 'a' : body === first ? 'a' : 'b'}`,
          kind: 'kol_outreach',
          target,
          before: { stage: 'sourced' },
          after: {
            subject: body.subject,
            body: body.body,
            recipients,
            suppressed,
            // 15 §2：不报"查过了"就 block。这里照实报（真查过了，见上面那两行）。
            suppression_checked: true,
            creator_name: creator,
          },
          notes: [
            suppressed.length === 0
              ? '退订 / 抑制名单查过了，这个人不在名单上。'
              : `这个人在退订 / 抑制名单上，已经剔除。`,
          ],
          created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
          mandate,
          level,
          provenance: run.finish({
            seen: [target],
            outputs: [],
            summary: `给 ${creator} 起一封开发信`,
          }),
          approval: {
            title: `开发信：${creator}`,
            summary: body.body.slice(0, 120),
            recipients: [recipientOf('scope_manager')],
            proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
            rule: 'scope_manager',
            separation_of_duties: true,
            source_events: [],
          },
        })

      // ③ 先提第一稿。带承诺词的话 guardrail 会 **block** ——这一下必须真发生，
      //    不是我们自己先扫一遍就绕过去（禁承诺的最后一道闸在 guardrail，永远在）。
      let outcome = await stageOnce(first)
      let rewritten = false
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'simulation.kol_outreach_blocked',
          actor: { kind: 'agent', id: asg.id },
          correlation: { trace_id: traceId(), run_id },
          // 正文不进事件（21 §1）；进的是"命中了哪几条规则"
          payload: { creator, forbidden_hits: scan.forbidden_hits, reason: outcome.reason },
        })
        // ④ 打回重写：把多出来的那一段去掉，模板那一部分原样留着。
        //    "拦下是打回重写，不是静默删改后照发"——改写之后要**再过一遍闸**。
        rewritten = true
        const rerun = await beginShopRun(asg)
        outcome = await (async () => {
          const second = { subject: base.subject, body: base.body }
          const again = reviewOutreachBody(second)
          if (!again.ok) throw new Error('改写之后还带承诺词，模板本身有问题')
          rerun.finish({ seen: [target], outputs: [], summary: `改写 ${creator} 的开发信` })
          return stageOnce(second)
        })()
      }

      const result = {
        forbidden_hits: scan.forbidden_hits,
        rewritten,
        recipients: recipients.length,
        suppressed: suppressed.length,
      }
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { ...result, staged: false, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_outreach_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          creator,
          rewritten,
          recipients: recipients.length,
          suppressed_removed: suppressed.length,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
        },
      })
      return {
        ...result,
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async collaboration({ who, creator, budget, level }) {
      const asg = assignmentFor(who, 'kol.youtube')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'collaboration', id: `col_${creator}` }
      const { mandate, level: configured } = actionOf(asg, 'stage_collaboration')
      const level_requested = level ?? configured
      const currency = pack.workspace.base_currency
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_kol_${run_id}`,
        kind: 'kol_collaboration',
        target,
        before: { stage: 'negotiating' },
        after: {
          stage: 'agreed',
          // 阶段机的合法迁移表只有 `kol-core` 那一份；这里只带结论进去
          stage_transition_ok: canAdvanceCollaboration('negotiating', 'agreed'),
          stage_label: collaborationStageName('agreed'),
          budget,
          currency,
          creator_name: creator,
        },
        notes: [`与 ${creator} 的合作，预算 ${budget} ${currency}。`],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        // 15 §2 hard_ceiling：报 L3 也会被按回人审
        level: level_requested,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `建一条与 ${creator} 的合作`,
        }),
        approval: {
          title: `合作：${creator}（${budget} ${currency}）`,
          summary: `这条合作要付 ${budget} ${currency}。`,
          recipients: [recipientOf('owner')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'owner',
          separation_of_duties: true,
          source_events: [],
        },
      })
      const base = { budget, currency, level_requested }
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { ...base, staged: false, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_collaboration_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          creator,
          budget,
          currency,
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
        },
      })
      return {
        ...base,
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async trackedLink({ who, creator, code }) {
      const asg = assignmentFor(who, 'kol.youtube')
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const collaboration_id = `col_${creator}`
      const target: ObjectRef = { type: 'tracked_link', id: `tl_${creator}` }
      const utm = buildUtm({ channel: 'youtube', campaign: 'autumn-desk', collaboration_id })
      const { mandate, level } = actionOf(asg, 'stage_tracked_link')
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_kol_${run_id}`,
        kind: 'kol_tracked_link',
        target,
        before: {},
        after: {
          url: applyUtm('https://nordvolt.example/p/charger-65w', utm),
          utm,
          affiliate_code: code,
          collaboration_id,
        },
        notes: [`给 ${creator} 建一条追踪链接，联盟码 ${code}。`],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        level,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `建一条追踪链接：${code}`,
        }),
        approval: {
          title: `追踪链接：${creator}`,
          summary: `联盟码 ${code}。`,
          recipients: [recipientOf('role_holder')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'role_holder',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { staged: false, reason: outcome.reason }
      }
      trackedLinks.push({ id: target.id, collaboration_id, utm, affiliate_code: code })
      await flushCards()
      return {
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    affiliateOrder({ order, code }) {
      affiliateOrders.set(order, code)
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_affiliate_order_placed',
        actor: { kind: 'system', id: 'simulation' },
        correlation: { trace_id: traceId() },
        // 谁下的单不进事件；进的是"这个码被用了一次"
        payload: { code },
      })
    },

    async attribution({ who }) {
      const asg = assignmentFor(who, 'kol.youtube')
      const run = await beginShopRun(asg)
      // 订单经 mock connect **真读一次**：金额与币种从这里来，不由场景递
      const res = await connect.execute<{
        orders: { id: string; total_price: number; currency: string }[]
      }>(
        'shopify_admin.list_orders',
        { first: 200 },
        { token: await tokenFor('role-read', asg.id), connection: 'conn_shopify_admin' },
      )
      run.tool('list_orders', { first: 200 })
      const orders = res.data.orders.map((o) => ({
        id: o.id,
        total: o.total_price,
        currency: o.currency,
        ...(affiliateOrders.has(o.id)
          ? { discount_codes: [affiliateOrders.get(o.id) as string] }
          : {}),
      }))
      // 归因规则是 `kol-core` 那一份：匹配不上就进 `unmatched`，**不按时间窗口猜**
      const out = attributeOrders(trackedLinks, orders)
      run.finish({
        seen: orders.slice(0, 20).map((o) => ({ type: 'order', id: o.id })),
        outputs: [],
        summary: `归因：${out.matched.length} 单归上，${out.unmatched.length} 单归不上`,
      })
      const revenue = out.by_link.reduce((a, r) => a + r.revenue, 0)
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_attribution_ran',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id: run.run_id },
        payload: {
          matched: out.matched.length,
          unmatched: out.unmatched.length,
          revenue,
          basis: [...new Set(out.matched.map((m) => m.basis))],
        },
      })
      return {
        matched: out.matched.length,
        unmatched: out.unmatched.length,
        revenue,
        basis: [...new Set(out.matched.map((m) => m.basis))],
      }
    },

    /* ── WP68（48 §5.2 / §5.3）──────────────────────────────────────── */

    creator({ channel, handle, followers, engagement_rate, category }) {
      kolPool.push({
        id: `pa_${handle}`,
        creator_id: `cre_${handle}`,
        channel: channel as KolChannel,
        handle,
        url: `https://example.com/${handle}`,
        followers,
        ...(engagement_rate === undefined ? {} : { engagement_rate }),
        ...(category === undefined ? {} : { category }),
        observed_at: now(clock),
      })
    },

    async campaign({ who, goal, budget, channels, headcount }) {
      // 挑人那一步是 `kol-core` 的纯函数，世界不自己排一遍序
      const plan = planCampaign(
        { goal, budget, channels: channels as KolChannel[], headcount },
        kolPool,
        now(clock),
      )
      const allowed: string[] = []
      const blocked: string[] = []
      let created = 0
      for (const group of plan.by_channel) {
        /*
         * **判的是这个人名下真有没有那条职责**（05 §4「不做跨 Assignment 并集」），
         * 不是场景说了算。一次 campaign 不会把别人的权限并给他。
         */
        const mine = roles.assignments
          .listByPerson(who)
          .find((a) => a.role_id === `kol.${group.channel}` && a.revoked_at === undefined)
        if (mine === undefined) {
          if (group.picks.length > 0) blocked.push(group.channel)
          continue
        }
        allowed.push(group.channel)
        for (const pick of group.picks) {
          // 每条合作用**那条渠道职责自己的分配**去建（额度、等级、权限全从它来）
          const out = await kol.collaboration({
            who,
            creator: pick.account.handle,
            budget: Math.round(plan.budget_per_creator),
          })
          if (out.staged) {
            created += 1
            kolCollaborations.push({
              id: `col_${pick.account.handle}`,
              creator: pick.account.handle,
              channel: group.channel,
            })
          }
        }
      }
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_campaign_planned',
        actor: { kind: 'person', id: who },
        correlation: { trace_id: traceId() },
        payload: {
          goal,
          picks: plan.picks.length,
          allowed_channels: allowed,
          blocked_channels: blocked,
          created,
        },
      })
      return {
        picks: plan.picks.length,
        allowed_channels: allowed,
        blocked_channels: blocked,
        created,
      }
    },

    publicCreator({ channel, handle, followers, engagement_rate, email }) {
      const subject = {
        id: `ws:${workspace_id}`,
        workspace_id,
        org_id: kolPrincipal.org_id,
        kind: 'workspace' as const,
      }
      kolPublicService.contributeAs(kolPrincipal, [
        {
          channel,
          handle,
          followers,
          posts_30d: 6,
          engagement_rate: engagement_rate ?? 0.035,
          categories: ['3c'],
          observed_at: now(clock),
        },
      ])
      // 有邮箱才等于"库里有联系方式"——没有的话 reveal 一分不收
      if (email !== undefined)
        kolPublicService.saveContact(subject, { channel: channel as KolChannel, handle }, { email })
    },

    async revealFromPublicLibrary({ who, channel, handle, topup }) {
      if (topup !== undefined && topup > 0)
        kolWallet.topup({ org_id: kolPrincipal.org_id, credits: topup, kind: 'purchased' })
      const before = kolWallet.balance(kolPrincipal.org_id).available

      // ① 浏览：**免费**。这一行之后余额一分不少，是这条题的一半
      kolPublicService.browse(kolPrincipal, { channel: channel as KolChannel, limit: 10 })
      const afterBrowse = kolWallet.balance(kolPrincipal.org_id).available
      const browse_credits = Math.round((before - afterBrowse) * 100) / 100

      // ② reveal：扣 `data.kol.lookup`。取不到 / 钱不够都回一句人话，并且不收钱
      let ok = true
      let reason: string | undefined
      let reveal_credits = 0
      let stored_as_ref = false
      try {
        const revealed = kolPublicService.reveal(kolPrincipal, {
          channel: channel as KolChannel,
          handle,
        })
        reveal_credits = revealed.credits
        /*
         * 明文在这一行落进"本机加密库"（世界里用一个闭包里的 map 替身），
         * 库里那一条只留 key 名——与服务进程那一跳逐字同一条纪律（48 §5.2）。
         */
        const value_ref = `kol.contact.ctc_${handle}`
        kolContactPlain.set(value_ref, revealed.email)
        kolContactRefs.push({ creator: handle, value_ref })
        stored_as_ref = !JSON.stringify(kolContactRefs).includes('@')
      } catch (e) {
        ok = false
        reason = e instanceof Error ? e.message : String(e)
      }
      const afterReveal = kolWallet.balance(kolPrincipal.org_id).available
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.kol_public_revealed',
        actor: { kind: 'person', id: who },
        correlation: { trace_id: traceId() },
        // 邮箱明文一个字节都不进事件（21 §5）
        payload: {
          channel,
          handle,
          ok,
          browse_credits,
          reveal_credits,
          balance_after: afterReveal,
          ...(reason === undefined ? {} : { reason }),
        },
      })
      return {
        ok,
        ...(reason === undefined ? {} : { reason }),
        browse_credits,
        reveal_credits,
        stored_as_ref,
      }
    },
  }

  /* ── WP72：社媒运营（56 §2 / §4）────────────────────────────────────
   *
   * 走的也是真机制，三条都不是场景自己判的：
   *
   * - 发内容的"永远人审"由 **guardrail 的 `HARD_L1`** 按回来（场景故意报 L3）；
   * - 回评论的承诺扫描由 **guardrail** 拦（起草那一跳先自查一遍只是早点给反馈，
   *   `social-core` 的 `checkOutbound` 与客服回信读的是同一份词表）；
   * - "这是不是客户的问题"由 **`social-core` 的 `triageThread`** 判，判成客户问题
   *   就出一张转客服卡（`handoffOf`）——社媒运营**不答**，那是 56 的边界，
   *   不是这条场景的设定。
   *
   * 额度与等级来自那个人 `social.<channel>` 那条分配的生效配置，不是主分配的。
   */
  const socialRoleOf = (channel: string): RoleId => {
    const spec = socialChannelSpec(channel)
    if (spec === undefined) throw new SimulationError('invalid_input', `没有这条渠道：${channel}`)
    return spec.role_id
  }
  const socialLabelOf = (channel: string): string => socialChannelSpec(channel)?.zh ?? channel

  /**
   * WP73：这一轮里已经排出去的那些内容（撞车判据要它）。
   *
   * 世界里没有社媒库（那是服务进程那一侧的东西），所以这里留一份最小的：
   * 只有"哪个号、什么时候、正文是什么"三格——`scheduleConflicts` 要的就是这三格。
   */
  const socialScheduled: {
    id: string
    account_id: string
    channel: string
    kind: 'post'
    status: 'scheduled'
    body: string
    scheduled_at: string
  }[] = []

  const social: SocialOps = {
    async post({ who, channel, body, scheduled_at, level }) {
      const role_id = socialRoleOf(channel)
      const asg = assignmentFor(who, role_id)
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'social_account', id: `sa_${channel}` }
      const { mandate, level: configured } = actionOf(asg, 'stage_post')
      const level_requested = level ?? configured
      // 起草那一跳自查一遍（早点给模型反馈）；真正的拦在 guardrail
      const scan = checkOutbound(body)
      /*
       * WP73：撞车当场判（`social-core` 的那一份判据，世界里不写第二份）。
       *
       * 同渠道同一小时两条 = 后一条会被平台压下去，而关注的人只觉得被刷屏。
       * 判出来的那几句**原样写进卡面**——人按下那一下之前要看得见。
       */
      const account_id = `sa_${channel}`
      const conflictHits: ScheduleConflict[] =
        scheduled_at === undefined
          ? []
          : scheduleConflicts({ account_id, scheduled_at, body }, socialScheduled as never, {
              now: now(clock),
            })
      const conflicts = conflictHits.map((c) => c.message)
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_social_${run_id}`,
        kind: 'social_post',
        target,
        before: { status: 'draft' },
        after: {
          channel,
          channel_label: socialLabelOf(channel),
          body,
          ...(scheduled_at === undefined ? {} : { scheduled_at }),
          status: scheduled_at === undefined ? 'draft' : 'scheduled',
        },
        notes: [
          scheduled_at === undefined
            ? '没排时间：批了就发。'
            : `排在 ${scheduled_at} 自己出去——到点之后没有第二道门，所以门在这一下。`,
          ...conflicts,
        ],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        // 15 §2 hard_ceiling：报 L3 也会被按回人审
        level: level_requested,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `提一条 ${socialLabelOf(channel)} 的内容`,
        }),
        approval: {
          title: `发布：${socialLabelOf(channel)}`,
          summary:
            scheduled_at === undefined
              ? body.slice(0, 120)
              : `${body.slice(0, 100)}（排在 ${scheduled_at}）${
                  conflicts.length === 0 ? '' : ` ⚠ ${conflicts.join(' ')}`
                }`,
          recipients: [recipientOf('scope_manager')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'scope_manager',
          separation_of_duties: true,
          source_events: [],
        },
      })
      const base = {
        channel,
        level_requested,
        ...(scheduled_at === undefined ? {} : { scheduled_at }),
        commitment_hits: scan.commitment_hits,
        conflicts,
      }
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { ...base, staged: false, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_post_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          role_id: asg.role_id,
          ...(scheduled_at === undefined ? {} : { scheduled_at }),
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
          // 卡面上有没有把"什么时候发出去"写出来（36 §2：人按下那一下之前要看得见）
          stated_on_card:
            scheduled_at === undefined || outcome.approval.summary.includes(scheduled_at),
          // WP73：撞了哪几种，以及撞车那句话在不在卡面上
          conflict_kinds: conflictHits.map((c) => c.kind),
          conflict_stated_on_card:
            conflicts.length === 0 || conflicts.every((c) => outcome.approval.summary.includes(c)),
        },
      })
      // 排进去了才算占位：被 guardrail 拦下的那一条不占下一条的时间
      if (scheduled_at !== undefined)
        socialScheduled.push({
          id: outcome.change.id,
          account_id,
          channel,
          kind: 'post',
          status: 'scheduled',
          body,
          scheduled_at,
        })
      return {
        ...base,
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async reply({ who, channel, author, text, draft, surface, level }) {
      const role_id = socialRoleOf(channel)
      const asg = assignmentFor(who, role_id)
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const thread_id = `ct_${channel}_${author}`
      const target: ObjectRef = { type: 'community_thread', id: thread_id }

      /*
       * ① 先判类。**封闭六类**，判不准落 `other` 不猜（`social-core/triage.ts`）。
       *    结论里只有判据名，没有原句——评论正文是外部文本，会进事件日志。
       */
      const verdict = triageThread({
        text,
        is_dm: surface === 'dm',
        mentions_us: true,
      })
      const handoff = handoffOf(verdict, { channel: socialLabelOf(channel), author_handle: author })

      /*
       * ② 判成客户问题 → **出一张转客服卡，社媒运营不答**（56 的边界行）。
       *
       * 卡是 `claim`（"接 / 不接"）：它不是一条变更，是一件活儿交给另一条职责。
       * 收件人是**真持有那条职责的人**——没人持有就落到 owner 身上，
       * 而不是悄悄没人接。
       */
      if (handoff !== undefined && verdict.route === 'support') {
        const holderOf = roles.assignments
          .listByRole(handoff.to_role)
          .find((a) => a.workspace_id === workspace_id && a.revoked_at === undefined)
        run.finish({ seen: [target], outputs: [], summary: `判一条 ${author} 的留言` })
        const item = await txn.approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'claim',
          role_id: handoff.to_role,
          subject: { object: target },
          dedupe_key: `${workspace_id}:social_handoff:${thread_id}`,
          title: handoff.title,
          summary: handoff.reason,
          payload: {
            form: 'support_handoff',
            channel,
            thread_id,
            author,
            // 分类结论进卡，**原句不进事件日志**（21 §1）——正文在卡上给人看，
            // 那是他本来就要读的东西；进日志的只有判据名。
            triage: verdict.klass,
            route_to_role: handoff.to_role,
            route_to_label: '社群管理',
            text,
          },
          evidence: {
            source_events: [],
            run_id,
            provenance: { seen: [target] },
            precheck: { fencing: 'ok' },
          },
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          automation: {
            level_at_creation: 'L1',
            auto_approved: false,
            mandate_check: { within: true, caps_hit: [] },
            sampling: { selected: false },
          },
          routing: {
            recipients: [{ person: holderOf?.person_id ?? owner, via: 'explicit' }],
            explicit: holderOf?.person_id ?? owner,
            rule: 'explicit',
            escalation: {
              after_hours: 4,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
        await flushCards()
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'simulation.social_handoff_staged',
          actor: { kind: 'agent', id: asg.id },
          correlation: { trace_id: traceId(), run_id },
          payload: {
            channel,
            triage: verdict.klass,
            signals: verdict.signals,
            to_role: handoff.to_role,
            // 有人真持有那条职责没有：没人持有 = 这张卡落到 owner 头上，如实报
            held_by: holderOf?.person_id ?? null,
            answered_by_social: false,
          },
        })
        return {
          channel,
          triage: verdict.klass,
          routed_to: handoff.to_role,
          answered: false,
          ...(item.state === 'blocked' ? {} : { approval_item_id: item.id }),
        }
      }

      /*
       * ③ 不是客户问题 → 社媒运营自己回。
       *
       * 回一条评论**不是一条变更**（56 §2 那一列写的是 `outbound_message`），
       * 所以它不走变更账本，走出站那条路：一张 `outbound_draft` 卡 + 三道门里的
       * `commitment_scan`（48 §4 L3 #3）。词表是 `support-core` 那一份——
       * 与客服回信、与 Amazon 出站硬闸读的是同一套，不另写一张社媒版。
       *
       * 第一稿故意可以带承诺词：扫到就**打回重写**，不是静默删改后照发
       * （同开发信与 Amazon 那两条）。改写之后那一封再扫一遍才提上去。
       */
      const { mandate, level: configured } = actionOf(asg, 'reply_comment')
      const first = draft
      const scan = checkOutbound(first)
      let rewritten = false
      let body = first
      if (!scan.ok) {
        blocked.push({
          rule: 'commitment_scan',
          at: now(clock),
          run_id,
          message: scan.rewrite_instruction,
        })
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'simulation.social_reply_blocked',
          actor: { kind: 'agent', id: asg.id },
          correlation: { trace_id: traceId(), run_id },
          // 正文不进事件（21 §1）；进的是"命中了哪几条规则"
          payload: { channel, commitment_hits: scan.commitment_hits },
        })
        rewritten = true
        body = rewriteWithoutCommitment(first)
        const again = checkOutbound(body)
        if (!again.ok) throw new Error('改写之后还带承诺词，改写规则本身有问题')
      }

      const level_used = level ?? configured
      run.finish({ seen: [target], outputs: [], summary: `回 ${author} 的一条留言` })
      const item = await txn.approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'outbound_draft',
        role_id: asg.role_id,
        subject: { object: target },
        dedupe_key: `${workspace_id}:social_reply:${thread_id}`,
        title: `回评论：${author}（${socialLabelOf(channel)}）`,
        summary: body.slice(0, 120),
        payload: {
          form: 'social_reply',
          channel,
          channel_label: socialLabelOf(channel),
          to: target,
          body,
          author,
          triage: verdict.klass,
        },
        evidence: {
          source_events: [],
          run_id,
          provenance: { seen: [target] },
          precheck: {},
        },
        proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
        automation: {
          level_at_creation: level_used,
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: roleHolder, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: {
            after_hours: 12,
            business_hours: true,
            chain: ['scope_manager'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
        context: {
          // 31 §3.3 收件人门禁：回的是**这条线程里的人**，不是一个我们自己挑的地址
          thread_participants: [target.id],
          /*
           * 48 §4 L3 #3 的三道门。这里只挂 `commitment_scan` 那一条：
           * 提上去的这一稿已经扫干净了（上面那一段），所以它 `pass`——
           * 门的结论进 `precheck.commitment_scan`，是这封能不能自主发的凭据。
           */
          gates: [
            {
              gate: 'commitment_scan' as const,
              status: 'pass' as const,
              ruleset_hash: 'support-core/commitment',
              evidence: { hits: 0 },
            },
          ],
        },
      })

      const base = {
        channel,
        triage: verdict.klass,
        commitment_hits: scan.commitment_hits,
        rewritten,
      }
      if (item.state === 'blocked') {
        blocked.push({
          rule: 'precheck',
          at: now(clock),
          run_id,
          message: `前置挡下：${Object.entries(item.evidence.precheck)
            .filter(([, v]) => v !== 'ok')
            .map(([k, v]) => `${k}=${String(v)}`)
            .join('、')}`,
        })
        return { ...base, answered: false, reason: 'precheck' }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_reply_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          triage: verdict.klass,
          rewritten,
          commitment_hits: scan.commitment_hits,
          level_at_creation: item.automation.level_at_creation,
          auto_approved: item.automation.auto_approved,
          // 额度：回评论一天 50 条（56 §7）。卡上要看得见它，超了才知道是被什么拦的
          cap:
            typeof mandate.caps.max_comment_replies_per_day === 'number'
              ? mandate.caps.max_comment_replies_per_day
              : null,
        },
      })
      return { ...base, answered: true, approval_item_id: item.id }
    },

    async broadcast({ who, channel, body, members, level }) {
      const role_id = socialRoleOf(channel)
      const asg = assignmentFor(who, role_id)
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'social_account', id: `sa_${channel}` }
      const { mandate, level: configured } = actionOf(asg, 'stage_broadcast')
      const level_requested = level ?? configured

      /*
       * 受众 = 成员 − 抑制名单。用的是 `social-core` 的 `buildAudience`，
       * 而它里面调的是 `@agentsws/core` 的那一份抑制规则——与客服出站、与邮件
       * 群发是**同一个函数**。名单口径不许在两边各演化一套（51 §2.3 那一条）。
       */
      const audience = buildAudience({
        members,
        suppression_list: [...unsubscribed],
        now: now(clock),
      })
      run.tool('list_members', { channel, members: members.length })

      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_social_${run_id}`,
        kind: 'community_broadcast',
        target,
        before: { status: 'draft' },
        after: {
          channel,
          channel_label: socialLabelOf(channel),
          body,
          audience: audience.recipients,
          audience_size: audience.recipients.length,
          suppressed: audience.suppressed,
          // 15 §2：不报"查过了"就 block。这里照实报（真查过了，见上面那一跳）
          suppression_checked: true,
        },
        notes: [audience.note],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        // 15 §2 hard_ceiling：报 L3 也会被按回人审
        level: level_requested,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `提一条 ${socialLabelOf(channel)} 的群发，${audience.recipients.length} 人`,
        }),
        approval: {
          title: `群发：${socialLabelOf(channel)}（${audience.recipients.length} 人）`,
          summary: `${body.slice(0, 80)}。${audience.note}。`,
          recipients: [recipientOf('scope_manager')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'scope_manager',
          separation_of_duties: true,
          source_events: [],
        },
      })
      const base = {
        channel,
        audience: audience.recipients,
        suppressed: audience.suppressed,
        level_requested,
      }
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { ...base, staged: false, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_broadcast_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          audience_size: audience.recipients.length,
          // 查过就报一个数，**哪怕是 0**（没查与查了没人是两回事）
          suppressed_removed: audience.suppressed.length,
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
          stated_on_card: outcome.approval.summary.includes(audience.note),
        },
      })
      return {
        ...base,
        staged: true,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    /* ── WP73（56 §6）：社群组那三条写动作 ───────────────────────────── */

    async approveMember({ who, channel, member, answers, level }) {
      const asg = assignmentFor(who, socialRoleOf(channel))
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'community_member', id: `cm_${channel}_${member}` }
      const { mandate, level: configured } = actionOf(asg, 'approve_member')
      const level_requested = level ?? configured
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_member_${run_id}`,
        kind: 'community_membership',
        target,
        before: { status: 'pending' },
        after: {
          channel,
          decision: 'approve',
          status: 'active',
          member_external_id: member,
          // 一次一个人（职责 yml 的 `max_members_per_change: 1`）
          members: 1,
        },
        notes: [
          answers === undefined || answers.length === 0
            ? '他没填申请答案。'
            : `他填的答案：${answers.join('；')}`,
        ],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        level: level_requested,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `判一条 ${socialLabelOf(channel)} 的入群申请`,
        }),
        approval: {
          title: `批准入群：${member}（${socialLabelOf(channel)}）`,
          // 申请答案**原样进卡**：人就是靠那几句判"这是不是广告号"
          summary:
            answers === undefined || answers.length === 0
              ? `${member} 递了入群申请，没填答案。`
              : `${member} 递了入群申请。答案：${answers.join('；')}`,
          recipients: [recipientOf('role_holder')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'role_holder',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { channel, staged: false, level_requested, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_membership_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
          // 申请答案在不在卡面上（**答案原文不进事件日志**，只报在不在）
          answers_on_card:
            answers === undefined ||
            answers.length === 0 ||
            answers.every((a) => outcome.approval.summary.includes(a)),
        },
      })
      return {
        channel,
        staged: true,
        level_requested,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async moderate({ who, channel, target: subject, action, reason, level }) {
      const asg = assignmentFor(who, socialRoleOf(channel))
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'community_thread', id: `ct_${channel}_${subject}` }
      const { mandate, level: configured } = actionOf(asg, 'moderate')
      const level_requested = level ?? configured
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_mod_${run_id}`,
        kind: 'community_moderation',
        target,
        before: { status: 'open' },
        // 分档看的就是这一格：`ban` / `permanent_ban` 由 guardrail 升到 L1
        after: { channel, action, target_external_id: subject },
        notes: [reason ?? `${ACTION_WORDS[action]}：${subject}`],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        level: level_requested,
        provenance: run.finish({
          seen: [target],
          outputs: [],
          summary: `对 ${subject} 下一个管理动作`,
        }),
        approval: {
          title: `${ACTION_WORDS[action]}：${subject}（${socialLabelOf(channel)}）`,
          summary: reason ?? `按群规处理：${ACTION_WORDS[action]}。`,
          recipients: [recipientOf('role_holder')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'role_holder',
          separation_of_duties: false,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { channel, action, staged: false, level_requested, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_moderation_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          action,
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
        },
      })
      return {
        channel,
        action,
        staged: true,
        level_requested,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },

    async rulesEdit({ who, channel, rules, level }) {
      const asg = assignmentFor(who, socialRoleOf(channel))
      const run = await beginShopRun(asg)
      const run_id = run.run_id
      const target: ObjectRef = { type: 'social_account', id: `sa_${channel}` }
      const { mandate, level: configured } = actionOf(asg, 'stage_rules_edit')
      const level_requested = level ?? configured
      const outcome = await txn.ledger.stage({
        workspace_id,
        role_id: asg.role_id,
        assignment_id: asg.id,
        run_id,
        change_set_id: `cs_rules_${run_id}`,
        kind: 'community_rules',
        target,
        before: { rules: '（原来的群规）' },
        after: { channel, rules },
        notes: ['群规是这个群的法律：放宽一条等于把垃圾闸门打开，所以这一条永远要人点。'],
        created_by: { kind: 'agent', id: `agent_${asg.role_id}` },
        mandate,
        level: level_requested,
        provenance: run.finish({ seen: [target], outputs: [], summary: '改一次群规' }),
        approval: {
          title: `改群规：${socialLabelOf(channel)}`,
          summary: rules.slice(0, 160),
          recipients: [recipientOf('owner')],
          proposer: { kind: 'agent', id: `agent_${asg.role_id}`, assignment_id: asg.id },
          rule: 'owner',
          separation_of_duties: true,
          source_events: [],
        },
      })
      if (!outcome.ok) {
        blocked.push({ rule: 'guardrail', at: now(clock), run_id, message: outcome.message })
        return { channel, staged: false, level_requested, reason: outcome.reason }
      }
      await flushCards()
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type: 'simulation.social_rules_staged',
        actor: { kind: 'agent', id: asg.id },
        correlation: { trace_id: traceId(), run_id },
        payload: {
          channel,
          level_requested,
          level_at_creation: outcome.approval.automation.level_at_creation,
          auto_approved: outcome.approval.automation.auto_approved,
          // 新群规的正文在卡面上（人要读完那一段才点得下去）
          stated_on_card: outcome.approval.summary.length > 0,
        },
      })
      return {
        channel,
        staged: true,
        level_requested,
        change_id: outcome.change.id,
        approval_item_id: outcome.approval.id,
      }
    },
  }

  holder.stage = async (intent: StageIntent) => {
    const ctx = runContexts.get(intent.request.id)
    if (ctx === undefined) return undefined
    const action = ACTION_BY_KIND[intent.kind]
    if (action === undefined) return undefined
    const order = orderOf(intent.target.id)
    if (order === undefined) return undefined
    const facts = recordFacts(intent.target)
    const money = intent.money
    const outcome = await txn.ledger.stage({
      workspace_id,
      role_id: primary.role_id,
      assignment_id: assignment.id,
      run_id: intent.request.id,
      change_set_id: ctx.change_set_id,
      kind: intent.kind,
      target: intent.target,
      before: facts.record,
      after: { refund_amount: money?.amount ?? 0, currency: money?.currency ?? 'USD' },
      ...(facts.record_version === undefined ? {} : { record_version: facts.record_version }),
      ...(money === undefined
        ? {}
        : {
            money: {
              amount: money.amount,
              currency: money.currency,
              amount_base: money.amount,
              base_currency: pack.workspace.base_currency,
              fx_rate: 1,
              fx_at: now(clock),
            },
          }),
      notes: intent.notes,
      created_by: { kind: 'agent', id: 'agent_aftersales' },
      mandate: world.mandateFor(action),
      level: world.levelFor(action),
      provenance: world.provenanceOf(ctx),
      // 15 §6.1：requester 是**来信人**，不是订单上记的邮箱——毒样本靠这一条被挡下
      requester: {
        channel: 'email',
        external_id: ctx.inbound.actor?.external_id ?? '',
        ...(ctx.requester === undefined ? {} : { resolved: ctx.requester.ref }),
      },
      ...(ctx.order?.owner === undefined ? {} : { target_owner: ctx.order.owner }),
      connection_id: 'conn_shopify_admin',
      approval: {
        title: `退款 ${money?.amount ?? 0} ${money?.currency ?? 'USD'}（订单 ${order.name}）`,
        summary: intent.notes.join('；'),
        recipients: [{ person: owner, via: 'scope_manager' }],
        proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: assignment.id },
        rule: 'scope_manager',
        separation_of_duties: true,
        source_events: [ctx.inbound.id],
      },
    })
    if (!outcome.ok) {
      blocked.push({
        rule: outcome.reason === 'authorization_check_failed' ? 'authorization_check' : 'guardrail',
        at: now(clock),
        run_id: intent.request.id,
        message: outcome.message,
      })
      return undefined
    }
    ctx.child_approval_ids.push(outcome.approval.id)
    await flushCards()
    return { change_id: outcome.change.id }
  }

  /**
   * 36 §2.2 的业务边界选择题（WP17 留的口子，WP24 接上）。
   *
   * 第一次遇到一条管着这次变更、而商家还没答过的边界时，**不自作主张**：
   * 起草照常（回信只说"交给同事确认"），另外发一张选择题卡把口径定下来。
   * `dedupe_key` 按 (工作区, 边界 id) 定，所以同一条边界一辈子只问一次——
   * 第二次遇到时审批总线回同一张卡，不会再堆一张新的。
   */
  holder.createPolicyQuestion = async ({ request, boundary }) => {
    const ctx = runContexts.get(request.id)
    const item = await txn.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: primary.role_id,
      subject: {
        object: { type: 'policy', id: boundary.id },
        ...(ctx === undefined
          ? {}
          : { work_item_id: `wi_${ctx.run_id}`, conversation_id: ctx.thread.id }),
      },
      dedupe_key: `${workspace_id}:policy_change:${boundary.id}`,
      title: boundary.question,
      summary: `第一次碰到这一条。定个答案，以后 Agent 自己按它走，不再问你（${boundary.label}）。`,
      payload: {
        target: 'workspace_policy',
        boundary_id: boundary.id,
        before: null,
        after: { boundary_id: boundary.id },
        affected_assignments: [assignment.id],
        options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
      },
      evidence: {
        source_events: ctx === undefined ? [] : [ctx.inbound.id],
        ...(ctx === undefined ? {} : { run_id: ctx.run_id }),
        provenance: { seen: [] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: assignment.id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: owner, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
    })
    if (item.state === 'blocked') return undefined
    // 不进 `child_approval_ids`：边界问题**不是**这封回信的子项——回信照发（它只说
    // "交给同事确认"），口径那张卡另走一条线，两者没有父子顺序关系（14 §12）。
    await flushCards()
    return { approval_item_id: item.id }
  }

  holder.createDraft = async (payload: DraftPayload) => {
    const ctx = runContexts.get(payload.request.id)
    if (ctx === undefined) return undefined
    const toEmail = payload.to[0]
    const to = toEmail === undefined ? undefined : customerRefOf(toEmail)
    if (to === undefined) return undefined

    // WP55 / 48 §4 L3 #2：Amazon 站内信的出站硬闸。
    //
    // 触发条件是**收件人域**，与任何开关无关。拦下 = 打回重写：原因回给写正文的
    // 那一跳，由它重写一版再提交——绝不静默删改后照发。
    let amazonOutbound: { ok: boolean; codes?: string[]; rewrite_instruction?: string } | undefined
    if (isMarketplaceRelayAddress(toEmail ?? '')) {
      const verdict = evaluateAmazonOutbound('amazon', {
        to_address: toEmail ?? '',
        subject: payload.subject,
        original_subject: ctx.thread.subject ?? null,
        body_text: payload.body,
        is_reply_to_buyer_thread: true,
      })
      if (verdict.ok) {
        amazonOutbound = { ok: true }
      } else {
        blocked.push({
          rule: 'amazon_outbound',
          at: now(clock),
          run_id: ctx.run_id,
          message: summarizeAmazonViolations(verdict.violations),
        })
        const rewrite_instruction = buildAmazonRewriteInstruction(verdict.violations)
        // 能靠重写正文修好的：打回给起草那一跳，它重写一版再提交（**不建卡**——
        // 这一版根本没成形）。修不掉的（附件 / 主题 / 线程头）落进前置，那张卡
        // blocked，理由原样写在卡面上，等人处理。
        if (hasRewritableAmazonViolation(verdict.violations)) {
          return { rewrite: rewrite_instruction }
        }
        amazonOutbound = {
          ok: false,
          codes: verdict.violations.map((v) => v.code),
          rewrite_instruction,
        }
      }
    }

    // WP55 / 48 §4 L3 #3：三道「不自主」的门。**只记录不改状态**——门说不自主，
    // 这张卡照常建、照常进队列，只是它不能自己发出去。
    const inboundText = ctx.inbound.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const gates = evaluateAutonomyGates({
      channel: 'email',
      // 模拟回路里没有真分类器：`source: 'none'` 让 Tier-2 入站盲扫跑起来，
      // 这正是它的定位——分类器没说话时的兜底。
      classification: { source: 'none', risk_level: 'normal' },
      inbound_text: inboundText,
      proposed_reply_text: payload.body,
      draft: { generated_by: 'ai' },
    })
    const prov = world.provenanceOf(ctx)
    const seen: ObjectRef[] = []
    for (const [type, ids] of Object.entries(prov.seen))
      for (const id of ids) seen.push({ type, id })
    const item = await txn.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: primary.role_id,
      subject: {
        object: ctx.thread.ref,
        work_item_id: `wi_${ctx.run_id}`,
        conversation_id: ctx.thread.id,
      },
      dedupe_key: dedupeKey(workspace_id, 'outbound_draft', ctx.thread.ref, ctx.thread.id),
      title: `回复 ${toEmail}：${payload.subject}`,
      summary: payload.body.split('\n').filter((l) => l.trim().length > 0)[1] ?? payload.subject,
      payload: {
        channel: 'email',
        to,
        thread_ref: ctx.thread.id,
        body: { subject: payload.subject, text: payload.body },
        language: pack.workspace.locales.customers,
      },
      evidence: {
        run_id: ctx.run_id,
        source_events: [ctx.inbound.id],
        provenance: { seen },
        precheck: {},
        citations: payload.citations,
      },
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: assignment.id },
      automation: {
        level_at_creation: world.levelFor('reply_customer'),
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: roleHolder, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 8,
          business_hours: true,
          chain: ['scope_manager', 'owner'],
          escalated_at: [],
        },
        separation_of_duties: true,
      },
      priority: 'queue',
      links: { children: [...ctx.child_approval_ids] },
      context: {
        thread_participants: [to.id],
        verified_contacts: [to.id],
        connection_id: 'conn_gmail',
        ...(amazonOutbound === undefined ? {} : { amazon_outbound: amazonOutbound }),
        // 门的结论进前置、落一条 `guardrail.gate_decided`（只有门名与结论）
        gates: gates.results.map((r) => ({
          gate: r.gate,
          status: r.status,
          ruleset_hash: r.ruleset_hash,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
          ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
        })),
      },
    })
    if (item.state === 'blocked') {
      for (const note of item.evidence.precheck.notes ?? ['precheck']) {
        blocked.push({ rule: 'precheck', at: now(clock), run_id: ctx.run_id, message: note })
      }
      return undefined
    }
    // 19 §3：草稿真的引用了哪几张卡，记进 usage（"高召回低认可"要靠它）
    for (const citation of payload.citations) {
      await knowledge.retrieval.cite(citation.fact_card_id, ctx.run_id)
    }
    // 子项回指父项（14 §12）；账本 stage 时父项还不存在，只能在这里补
    for (const child_id of ctx.child_approval_ids) {
      const child = txn.runtime.store.getApproval(child_id)
      if (child !== undefined) {
        txn.runtime.store.putApproval({ ...child, links: { ...child.links, parent: item.id } })
      }
    }
    await flushCards()
    return { approval_item_id: item.id }
  }

  return world
}

/** 15 §6：只证明"读过"——从 `context.injected`（配 RunRequest 的 source_ref）与 `tool.result` 推。 */
export function provenanceFromEvents(ctx: RunContext, at: Iso8601): ProvenanceState {
  const seen: Record<string, string[]> = {}
  const read_full: string[] = []
  const push = (ref: ObjectRef, full: boolean): void => {
    const list = seen[ref.type] ?? []
    if (!list.includes(ref.id)) list.push(ref.id)
    seen[ref.type] = list
    if (full && !read_full.includes(`${ref.type}:${ref.id}`))
      read_full.push(`${ref.type}:${ref.id}`)
  }
  const byId = new Map((ctx.request?.context ?? []).map((c) => [c.id, c]))
  for (const e of ctx.events) {
    if (e.type === 'context.injected') {
      const item = byId.get(e.item_id)
      const ref = item?.source_ref
      if (ref !== undefined && typeof ref !== 'string') push(ref, false)
    }
    if (e.type === 'tool.result' && e.status === 'ok') {
      for (const ref of e.provenance_added ?? []) push(ref, true)
    }
  }
  return { run_id: ctx.run_id, seen, read_full, recorded_at: at }
}
