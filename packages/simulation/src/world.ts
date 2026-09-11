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
  Assignment,
  ChangeKind,
  DataRecord,
  EventEnvelope,
  InboundEvent,
  Iso8601,
  JoinExportBundle,
  JoinObjectComparison,
  JoinResolution,
  Mandate,
  ModelGateway,
  ModelProvider,
  ModelRef,
  ObjectRef,
  PersonId,
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
import { companyKey, sha256 } from '@agentsws/core'
import type { DataActor, SqliteDataStore } from '@agentsws/data'
import { createDataStore, defineCollection } from '@agentsws/data'
import type { DshRuntimeMode } from '@agentsws/dsh-adapter'
import { createDshRuntime } from '@agentsws/dsh-adapter'
import type { Kernel, Random } from '@agentsws/kernel'
import { createKernel, seededRandom } from '@agentsws/kernel'
import type { Knowledge } from '@agentsws/knowledge'
import { createKnowledge } from '@agentsws/knowledge'
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
import type {
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
const APPLY_ACTIONS = [
  'shopify_admin.create_refund',
  // WP44：改价的施行口（只在 role-apply 令牌里，Agent 的读令牌拿不到）。
  // 主题不在这儿——它走 CLI，那条路根本不发连接器令牌。
  'shopify_admin.update_product_price',
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
  /** 05 §4：每个分配的有效配置快照（"不做跨 Assignment 并集"的断言读它）。 */
  assignmentSnapshots(): AssignmentSnapshot[]
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
    loadBundledRole('dtc.aftersales'),
    loadBundledRole('common.owner'),
    loadBundledRole('common.member'),
    // WP44：建站与主题（12 §2）。没人被分到它的 pack 一个字节都不变——
    // 职责定义在库里躺着不产生任何行为，只有 assignments.yml 里有人挂它才生效
    loadBundledRole('site.builder'),
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
  const data = createDataStore({ dbPath: ':memory:', clock, collections: [CUSTOMERS] })
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
  }

  // ── 替身：mock OpenConnector / stub 运行时 / 合成人 / 收件箱 ──────────
  // stage / createDraft 要接到交易控制模块，而交易控制模块又要 connect 做后端——
  // 用可变闭包打断这个环，装配完成后两侧都指向真实实现。
  const holder: {
    stage?: (i: StageIntent) => Promise<{ change_id: string } | undefined>
    createDraft?: (p: DraftPayload) => Promise<{ approval_item_id: string } | undefined>
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
  // `direct` 分支：stub provider 只出文本、不出 tool_calls，turn loop 跑不起来；
  // 换成同样确定性的"规则脑" provider（判定逻辑与 stub 运行时同一套，只是用工具协议表达）
  // realistic 档给了真模型就用它；否则按运行时选确定性的替身 provider
  const modelRef: ModelRef = opts.model?.ref ?? MODEL
  const base =
    opts.model !== undefined
      ? opts.model.provider
      : opts.runtime === 'direct'
        ? aftersalesBrainProvider({ clock, seed, ref: MODEL })
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
      k: 3,
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
  holder.executeTool = async (call) => {
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
  }

  const shop: ShopOps = {
    devMcp,
    themeCli,

    async priceChange({ who, product, price, graphql, note }) {
      const asg = assignmentFor(who, 'dtc.ops')
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
