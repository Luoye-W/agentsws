/**
 * 运行时装配（17 §4）+ 37 §2.2b 的 `startRun`。
 *
 * 这一层做两件事，别的都不做：
 *
 * 1. **挑一个运行时适配器**：环境里配了模型 provider（`DEEPSEEK_API_KEY`）就用
 *    `@agentsws/runtime-direct` 的 turn loop（模型经 22 的网关）；没配就用
 *    `@agentsws/stand-ins` 的 stub 运行时（确定性、不叫模型，demo 与测试用它）。
 *    换运行时只换这一处——世界的其余部分原样不动（31 I6）。
 * 2. **把「委托」与「在事项里说话」接上运行时**：组 `RunRequest`（`work_item = matter`，
 *    ContextItem 注入 `matter_summary` + pinned 记录，`tools.allow` 按岗位），跑，
 *    运行事件进事项时间线与事件日志，运行结束更新事项摘要，跑出来的卡回填到待办。
 *
 * 纪律：
 * - 卡片一律经审批总线（14 §1「所有改变都以一条审批项进同一条队列」），这里不绕过预检；
 * - 收件人只从「这次运行读过的」里取（31 §3.3）；拿不到 ObjectRef 就出「收件人待定」的卡
 *   （系统不发，人复制去发——WP232），绝不替人猜一个收件人，也绝不丢草稿；
 * - 时间经 `Clock`、随机经注入的 `random`，没有一处 `Date.now()` / `Math.random()`；
 * - 秘密只从环境变量读，且不进事件日志。
 */

import type {
  ApprovalItem,
  ApprovalKind,
  AssignmentId,
  Clock,
  ComputerUseGrantPayload,
  ConnectNeed,
  ContextItem,
  CreateApprovalInput,
  EffectiveWeb,
  EventEnvelope,
  GateDecision,
  GenuiToolInput,
  GenuiToolOutcome,
  Matter,
  MatterEvent,
  MatterRunBlock,
  MatterRunDigest,
  MaybePromise,
  MemoryFact,
  ModelRef,
  ObjectRef,
  PersonId,
  PromptSection,
  ReasoningEffort,
  RunBrowser,
  RunBrowserGrant,
  RunConnection,
  RunEvent,
  RunId,
  RunProduce,
  RunRequest,
  RunTimeLimits,
  RuntimeAdapter,
  RunWeb,
  ServiceOffer,
  SkillRef,
  StartRun,
  StorefrontPlatform,
  TodoId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import {
  cancelReasonOf,
  cleanNextSuggestion,
  createRunWatchdog,
  GENUI_DISPLAY_RULE,
  type MatterLiveRun,
  MODEL_SOURCE_SWITCHED_STEP,
  PLATFORM_KITS,
  platformKitOf,
  platformMcpNeededBy,
  QUICK_ANSWER_RULE,
  RUN_IDLE_TIMEOUT_RANGE,
  RUN_MAX_DURATION_RANGE,
  type RunCancelReason,
  type RunWatchdog,
  resolveRunTimeLimits,
  skillOnPlatform,
  splitNextSuggestion,
  WEB_TOOL_NAMES,
} from '@agentsws/contracts'
import { canonicalJson, timeContextItem } from '@agentsws/core'
import {
  classifySideEffect,
  createDshRuntime,
  type DshRuntimeMode,
  type ToolSideEffect,
  type WebCredential,
  type WebCredentialKind,
  type WebUse,
} from '@agentsws/dsh-adapter'
import { isKolRole, KOL_TOOL_NAMES } from '@agentsws/kol-core'
import {
  onDemandSkillIndex,
  type SkillPromptActor,
  type SkillResolver,
  skillIndexSection,
  skillPromptSections,
} from '@agentsws/learning'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { isSourceFallbackOffText } from '@agentsws/model-gateway'
import {
  houseRulesSection,
  nextSuggestionSection,
  personaTextIn,
  type RoleStore,
  replyLanguageSection,
} from '@agentsws/roles'
import { createDirectRuntime, inAllowlist, withToolChoice } from '@agentsws/runtime-direct'
import type { CreatePolicyQuestionFn, DraftPayload, ToolExecutor } from '@agentsws/stand-ins'
import {
  ADS_DATA_TOOL_NAMES,
  ADS_TOOL_NAMES,
  AMAZON_COMPETITOR_ROLES,
  AMAZON_COMPETITOR_TOOL_NAMES,
  AMAZON_KEYWORD_TOOL_NAMES,
  AMAZON_LISTING_TOOL_NAMES,
  adsDataToolsFor,
  B2B_OUTBOUND_TOOL_NAMES,
  budgetStopReason,
  COMPETITOR_STORE_ROLES,
  COMPETITOR_STORE_TOOL_NAMES,
  COMPETITOR_TOOL_NAMES,
  createStubRuntime,
  DESK_TOOL_NAMES,
  DRAFT_REPLY_TOOL,
  deskToolsFor,
  FIND_SERVICE_TOOL,
  GOOGLE_ALERTS_TOOL_NAMES,
  humanizeToolNames,
  IMAGE_TOOL_NAMES,
  imageWorkSection,
  isAdsWiredRole,
  isAmazonKeywordRole,
  isAmazonListingRole,
  isB2bOutboundRole,
  isOwnerRole,
  isScheduleTool,
  isSiteHealthRole,
  isThemeRole,
  MESSAGE_RULE_TOOL_NAMES,
  OWNER_TOOL_NAMES,
  orderContextItems,
  PR_MONITOR_TOOL_NAMES,
  READ_SKILL_TOOL,
  READ_WEBPAGE_TOOL,
  RECORD_SINK_TOOL_NAMES,
  REPORT_TOOL_NAMES,
  RESEARCH_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  SETUP_REQUEST_TOOL_NAMES,
  SHOP_TOOL_NAMES,
  SITE_HEALTH_TOOL_NAMES,
  SOCIAL_WORK_TOOL_NAMES,
  socialWorkToolsFor,
  THEME_PUBLISH_TOOL,
  THEME_PUSH_TOOL,
  THEME_TOOL_NAMES,
  themeWorkSection,
  WATCH_TOOL_NAMES,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WORKSHOP_SERVICE_TOOL_NAMES,
} from '@agentsws/stand-ins'
import { cardRefOf, type Work } from '@agentsws/work'
import { type RememberItem, type RunMemoryActor, splitRememberTags } from './auto-memory.js'
import type { ComputerUseAssembly } from './computer-use.js'
import { historyBudgetFor, matterHistoryItem } from './matter-history.js'
import {
  blockedByTool,
  blockedLine,
  blockReasonOf,
  CHATGPT_SUBSCRIPTION_NEED,
  DEEPSEEK_ACCOUNT_NEED,
  DEEPSEEK_ACCOUNT_RUN_PROVIDER,
  RunBlockLog,
  setupNeedOf,
} from './run-blocked.js'
import { runFailureLine, runFailureText } from './run-failure.js'
import { RunStepLog } from './run-steps.js'
import { MODEL_FALLBACK_CLOUD_TARGET } from './setup-targets.js'

/** WP387：交代建 / 读 Google 提醒结果的那条职责（信息监控）。 */
const GOOGLE_ALERTS_ROLE = 'pr.monitoring'

import { PartialRunLog, pausedForUpdateLine, stoppedLine } from './run-stop.js'
import { createSkillToolExecutor, isReadSkillTool } from './skill-tools.js'
import { SUBSCRIPTION_SOURCE_ID } from './subscription-model.js'

/**
 * 卡片的出口。类型就是契约的 `CreateApprovalInput`——收件人门禁（31 §3.3）要的
 * `context` 已经在契约里了（WP31 补上 WP24 的后置项），这里不再借宿主包的交叉类型。
 */
export interface ApprovalSink {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
  /** WP341：查一张卡（genui 按钮出的卡挂时间线前核一下真有）；不给就信执行器回的 id。 */
  get?(id: string): Promise<ApprovalItem | undefined> | ApprovalItem | undefined
}

/** 只读目录：没接连接器时 stub / direct 也照样能走完（工具执行器缺席就是一条 error 结果）。 */
const DEFAULT_TOOLS = ['get_order', 'get_product', 'list_orders', 'search_policies'] as const

/**
 * WP179：**服务端自己的执行器**接的那几类工具，在 dsh 门禁里按什么读写分类。
 *
 * direct 那条路不给副作用表（每个放进白名单的工具都按"读"放行，真正的闸在执行器里：红人工具只动本机记录或出卡、
 * 开发信只出卡、店主工具只读）。dsh 门禁按**名字前缀**判，表外一律按"写外部"——于是 `draft_outreach`、
 * `start_outreach_round` 这些在公司端一调就被拒（`write_external_requires_executor`）。挂了网页工具的运行
 * （红人五条、主动开发都挂）改走 dsh 之后，这些工具必须与 direct 那条路一样能调，所以在这里写清：
 * 前缀判得出"读"的照旧读，其余记成 `local`（工坊本机的执行器，只动本机记录或出卡，不直接写外部）。
 * WP148 带浏览器的红人运行走 dsh 时也撞的是同一条，这一张表一并修掉。
 */
const HOST_TOOL_EFFECTS: Readonly<Record<string, ToolSideEffect>> = Object.fromEntries(
  [
    ...KOL_TOOL_NAMES,
    ...B2B_OUTBOUND_TOOL_NAMES,
    // WP316：改广告——提一批只出卡（批了插件才去做），列账本只读
    ...ADS_TOOL_NAMES,
    ...OWNER_TOOL_NAMES,
    READ_SKILL_TOOL,
    // WP220：只读 Reddit（`read_` 开头，本来就判得出「读外部」；列进来是为了表上看得见）
    ...RESEARCH_TOOL_NAMES,
    // WP181：官方「自动化任务」的四个工具——只动本机调度器、会往外发的出卡
    ...SCHEDULE_TOOL_NAMES,
    // WP253：网页模板的主题工具——只动本机工作目录 / 推未发布副本；发布只出卡（服务端执行器判）
    ...THEME_TOOL_NAMES,
    // WP261：独立站运营工具——查询只读店铺；改动只出卡（人批了服务端执行器才改）
    ...SHOP_TOOL_NAMES,
    // WP268：生图 / 改图 / 素材库——只动本机素材库、出挑图卡（花积分由执行器按上限判）
    ...IMAGE_TOOL_NAMES,
    // WP323：记录去处——读表头只读外部；配置只出「定规矩」卡（本机执行器）
    ...RECORD_SINK_TOOL_NAMES,
    // WP441：消息规则——列规则只读本机；转规则只出「要建吗」卡（本机执行器）
    ...MESSAGE_RULE_TOOL_NAMES,
    // WP331：报告积木——查巡查 / 查发出记录只读本机库；立即巡查读外部（只读）；发布只进本岗位报表区
    ...REPORT_TOOL_NAMES,
    // WP315：投放岗看数据——查数只读本机库；现在导一次排给插件（只点导出）；止损只出卡
    ...ADS_DATA_TOOL_NAMES,
    // WP396：Listing 体检——读自家前台页只读外部；看结果 / 改规则只动本机
    ...AMAZON_LISTING_TOOL_NAMES,
    // WP398：Amazon 词库——读前台联想词只读外部；看词库 / 标词只动本机
    ...AMAZON_KEYWORD_TOOL_NAMES,
    // WP334：AI 自己要卡——只回结构化缺项，卡由运行时收尾时出（本机）
    ...SETUP_REQUEST_TOOL_NAMES,
    // WP385：读网站体检结论——只读本机体检记录（不现跑体检）
    ...SITE_HEALTH_TOOL_NAMES,
    // WP387：交代建 / 读 Google 提醒的结果——只写本机信息监控库（先拉一次 feed 是读）
    ...GOOGLE_ALERTS_TOOL_NAMES,
    // WP393：店铺管理「竞品动向」——探平台 / 现在读一次只读外部公开页面；写的只是本机竞品清单
    ...COMPETITOR_STORE_TOOL_NAMES,
    // WP386：信息监控查提及——只读本机提及库
    ...PR_MONITOR_TOOL_NAMES,
    // WP390：工坊服务——查目录只读本机缓存；出卡不下单（下单永远人点）
    ...WORKSHOP_SERVICE_TOOL_NAMES,
    // WP394：亚马逊店铺运营「竞品动向」现在读一次——只读 Amazon 前台公开页面
    ...AMAZON_COMPETITOR_TOOL_NAMES,
    // WP419：社媒发帖 / Reddit 起草——查只读本机；起草只出卡（发不发永远人点）
    ...SOCIAL_WORK_TOOL_NAMES,
    // WP421：公关 / 内容与搜索 / B2B / 设计——读本机库只读；起草只出卡（人批了才算数）
    ...DESK_TOOL_NAMES,
  ].map((name) => [name, classifySideEffect(name) === 'read_external' ? 'read_external' : 'local']),
)

/** ObjectRef.type → ContextItem.kind；不认识的按摘要注入。 */
const KIND_BY_REF: Record<string, ContextItem['kind']> = {
  order: 'order',
  customer: 'customer',
  thread: 'thread',
  fact_card: 'fact_card',
  policy: 'policy',
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')

/** 全名 `service.action` 去掉服务前缀（红人工具在链里按 bare 名匹配）。 */
const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name

/** 进模型的内容先规范化（键排序），回放才是恒等变换（同 simulation 的纪律）。 */
function canonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

const refKey = (ref: ObjectRef): string => `${ref.type}:${ref.id}`

/**
 * 事项现场能提供的记录。demo 里由合成世界提供，装了真连接器后换成真的；
 * 一个都不给也能跑——那就是「只有摘要」的运行。
 */
export interface MatterRecordSource {
  /**
   * ObjectRef → 可注入模型的记录内容；不认识回 undefined（不编造）。
   *
   * WP53：可以回一个 Promise——真环境的记录源缓存没命中时要经连接器现拉一张订单，
   * `contextOf` 会 await 它（装配期的 `buildRequest` 本来就是 async）。
   */
  record?(ref: ObjectRef): unknown
  /** ObjectRef → 人话 */
  label?(ref: ObjectRef): string | undefined
  /** email → 联系人 ObjectRef；收件人门禁（31 §3.3）要它，拿不到就不建草稿卡 */
  contactOf?(email: string): ObjectRef | undefined
  /** 只读连接令牌（18）；不给就是空串，运行时拿不到写口 */
  readToken?(assignment_id: AssignmentId): Promise<string> | string
  /** 工具执行器；不给的话运行时的工具调用一律 `no_tool_executor` */
  executeTool?: ToolExecutor
  /**
   * WP236：这个记录源**真能执行**哪些工具。给了，工具面里就只摆它认的（加上别的执行器真接上的）；
   * 不给 = 老行为（不筛，替身 / 模拟世界的记录源都这样）。
   */
  executes?(tool: string): boolean
}

export interface RuntimeOptions {
  workspace_id: string
  /**
   * WP194：一次运行在这个作用域里跑（宿主用它开「这一次算在谁头上」——运行里打云的
   * 数据接口据此带归属头）。不给 = 直接跑。
   */
  aroundRun?: <T>(
    actor: { person_id: string; assignment_id: string; role_id: string },
    fn: () => Promise<T>,
  ) => Promise<T>
  clock: Clock
  random: () => number
  env: Record<string, string | undefined>
  models: ModelGatewayApi
  /** 卡片进的那条队列（demo 里是接进来的世界的总线） */
  approvals: ApprovalSink
  roles: RoleStore
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  source?: MatterRecordSource
  /**
   * WP320：记忆。`section` = 提示词里「记忆」那一段（这次运行这几层现有的记忆 + 记忆规矩，每次现取，
   * 人删掉的下一次就没有）；`afterRun` = 跑完之后自动记（`auto-memory.ts`）。答复里的
   * `<remember>…</remember>` 进时间线之前拿掉（同 `<next>`）。不给 = 与 WP320 之前逐字相同。
   */
  memory?: {
    section(
      actor: RunMemoryActor,
      loaded_skills: readonly string[],
    ): MaybePromise<PromptSection | undefined>
    afterRun(input: {
      run_id: RunId
      matter_id?: string
      actor: RunMemoryActor
      brief: string
      items: readonly RememberItem[]
      runtime?: readonly MemoryFact[]
    }): Promise<unknown>
  }
  /**
   * WP236：「设置 → 通用」里的运行时长线（空闲超时 / 总时长上限，秒）。每次运行现问；
   * 职责阈值 `run_idle_timeout_seconds` / `run_max_duration_seconds` 优先，都没有走缺省（3 / 20 分钟）。
   */
  runLimits?(): Partial<RunTimeLimits> | undefined
  /**
   * WP429：一次运行收尾（跑完 / 被停下 / 没跑成）时叫一声——宿主据此发站内通知（跑得久的跑完了、
   * 停下了、没跑成；人自己点停的不发）。不给就不叫；它抛错不影响运行。
   */
  onRunEnded?(e: {
    run_id: string
    matter_id: string
    matter_title: string
    person_id: string
    outcome: 'completed' | 'stopped' | 'failed'
    /** 停下的原因（看门狗 / 运行时报的 / 人点的；因更新暂停 = `update`）。 */
    reason?: string
    started_at: string
    ended_at: string
  }): void
  /**
   * WP251（决策 91）：这条职责现在**没连上**的连接（人话名，必需的在前；必需的全连上了才列可选的）。
   * 工具回 `not_connected` / 缺凭据时，运行时拿它说清「缺哪个连接」。不给 = 只记卡住了、不说缺哪个。
   */
  missingConnections?(role_id: string): string[]
  /**
   * WP324（决策 690）：同上，但说的是**能就地连的接法**（连接页 service）——出连接卡用。
   * 不给 = 只能说缺哪个，卡上没有就地连的按钮（连接卡也就不出）。
   */
  missingConnectionNeeds?(role_id: string): ConnectNeed[]
  /**
   * WP324（决策 690）：一轮卡在缺连接 / 缺设置上时，出一张**连接卡 / 配置卡**（同一缺项不重复出）；
   * 人补完由宿主按原话接着跑。回出的（或已经在等的）那张卡；出不了回 `undefined`（照老样子只记一句）。
   */
  setupCards?: {
    onRunBlocked(input: {
      run_id: string
      matter_id: string
      actor: RunRequest['actor']
      block: MatterRunBlock
      needs: ConnectNeed[]
      targets: string[]
      /** WP334：AI 要卡时给的那一句为什么（没有就用默认那句）。 */
      why?: string
      /** WP334：AI 给的配置卡建议值（按设置目标）。 */
      suggestions?: Record<string, Record<string, string>>
      /** WP348：每个建议值的一句理由（按设置目标、按格子）。 */
      reasons?: Record<string, Record<string, string>>
      /** WP348：这几个目标已经设好了，AI 要的是「改成这样」。 */
      changes?: string[]
    }): Promise<{ item: ApprovalItem; attach: boolean } | undefined>
  }
  /** seed 化的随机（运行时的确定性）；不给按 `random` 起一个 */
  seed?: number
  /** 运行时的名字；缺省按有没有模型 provider 配置自动选 */
  prefer?: 'stub' | 'direct'
  /**
   * WP25：这台机器上有没有能用的模型。
   *
   * 以前只看 `DEEPSEEK_API_KEY` 在不在，用户在设置页里填了 key 也没用（要重启）。
   * 现在由模型面回答（本机加密库里的配置 + 环境变量兜底）；不给就退回看环境变量。
   */
  hasModel?: () => boolean
  /**
   * WP232：按去重键查一张**还在等人答**的卡（pending / in_review / deferred）。
   *
   * 边界选择题「一辈子只问一次」：同一条边界已经有一张在等人答的卡时，**不再**交给审批总线
   * ——总线的去重是「更新原项」（revision +1、改挂到这一次的事项上），一个没变的问题被反复
   * bump，还被挂到毫不相关的运行上（10-05 dev-real）。不给就退回老行为。
   */
  activeApproval?: (dedupe_key: string, kind: ApprovalKind) => { id: string } | undefined
  /** WP25：现在生效的默认模型（进 `RunRequest.runtime.model`）。 */
  modelRef?: () => ModelRef
  /**
   * WP150：一次运行的模型请求（`purpose: 'run'`）真正会落到哪一条模型来源上——按 purpose 覆盖过
   * 就是覆盖的那条，否则是默认那条。开跑时记一次（官方同款：看"这次任务绑定的那条模型路由"），
   * 登出 DeepSeek 账号时据此认出"哪几件事正在用这个账号跑"。不给就用 {@link modelRef}。
   */
  runModelRef?: () => ModelRef
  /**
   * WP472（docs/116 §6 B / C）：某个模型的上下文窗口（token；模型目录里写了才有，没写回 `undefined`）。
   * 不用浏览器那一档按它定什么时候压历史，事项对话按它定带多少原文；拿不到都按 64K 算。
   */
  contextWindow?: (model: ModelRef) => number | undefined
  /**
   * WP342（决策 853）：事项自己选的 AI（`Matter.model`，`provider_id/model`）→ ModelRef。
   * 回 `undefined` = 认不出 / 现在不能用（删了、断了）——这次运行退回品牌默认。
   * 解析出来就进 `RunRequest.runtime.model` 并标 `model_pinned`：三个运行时都按它跑（stub 记在
   * `run.started` 上，direct / dsh 每次补全把它显式交给网关）。不给这个选项 = 不认事项上的选择（老行为）。
   */
  modelOverride?: (id: string) => ModelRef | undefined
  /**
   * WP370：事项选的思考程度（`Matter.model_effort`）这个模型现在还有没有这一档。有才进
   * `RunRequest.runtime.reasoning_effort`；没有（换了目录、删了档）就按模型默认跑，不报错。不给 = 不认思考程度。
   */
  modelEffort?: (id: string, effort: ReasoningEffort) => boolean
  /**
   * WP147（截图给 AI 看）：现在生效的默认模型**验证过能看图**吗（WP127 三步验证的结论，
   * `ModelsAssembly.visionStatus()`）。只有 `'ok'` 才让 dsh 那条路由声明图片输入——
   * 浏览器 / 电脑操控的截图才进模型；`'no'` / `'unchecked'` / 不接都不声明（截图位置是官方诊断）。
   */
  modelVision?: () => 'ok' | 'no' | 'unchecked'
  /**
   * WP54（48 v2 L2）：这个工作区卖的是什么（公司档案里的「你卖的是」）。
   *
   * 晚绑定的读法：档案在向导第 ① 步才写，而运行时比它先装配好；用户改了档案之后
   * 下一次运行就该用新的那一套，不该等重启。不给就实物。
   */
  vertical?: () => WorkspaceVertical | undefined
  /**
   * WP216（Luoye 10-05）：这个品牌的网站是用什么搭的（品牌档案的 `storefront_platform`）。
   *
   * 平台专属的官方技能与官方 MCP 工具（`@agentsws/contracts` 的 `PLATFORM_KITS`）只在平台对得上时
   * 进这次运行：技能不进提示词也不进按需索引、`read_skill` 读不到，Dev MCP 的工具不进工具面。
   * 晚绑定、每次现取（同 `vertical`：品牌改了平台，下一次运行就跟着变）。
   * 回 `undefined`（平台没设、也推断不出）= 平台专属的一样都没有。
   * 不接这个选项 = 不设闸（老行为）——存量的单测与回放一个字节不变。
   */
  storefrontPlatform?: () => StorefrontPlatform | undefined
  /**
   * WP180：公司时区（工作区档案里的 `tz`）。给了，每次运行的上下文里就写一次「现在时间 + 公司时区」
   * （`timeContextItem`：按小时取整、三个运行时同一份字节）；档案里没有 / 认不出用本机时区。
   * 晚绑定、每次现取（用户改了时区下一次运行就用新的）。不给 = 不写这一条（老的单测与回放照旧）。
   */
  timeZone?: () => string | undefined | Promise<string | undefined>
  /**
   * WP410（真机 #9）：这条职责的「当前设置快照」——连接（以插件交回 / 连接表为准）与设置原值，
   * 每次运行现取、注进上下文（排在事项材料后、时间那一条前；三个运行时同一份字节）。AI 说状态只按它，
   * 不凭记忆或旧对话。回 `undefined` = 这条职责没有要带的（上下文一个字节不变）。不给 = 老行为。
   */
  setupState?: (input: { role_id: string }) => Promise<ContextItem | undefined>
  /**
   * WP29：技能库。给了就把 `resolve` 出来的技能正文当 persona 段拼进 prompt——
   * 学习回路采纳的那条 overlay 是靠这一步生效的（"下次运行用新版本"）。
   * 不给就是老行为：prompt 里只有技能名。
   */
  skills?: SkillResolver
  /**
   * WP117（66 断点 #1）：红人那十一个工具的执行器（`kol-tools.ts` 建的那一份）。
   *
   * 给了就在工具链最前面——`kol.*` 那五条职责的运行才真有活干。不给的话红人岗位
   * 仍然会去调这些工具（工具面是按职责给的），但每一次回的是「这个进程没装红人
   * 那一摊」，界面上照实显示，而不是假装成功。
   */
  kolTools?: ToolExecutor
  /**
   * WP220（Luoye 10-05）：只读 Reddit（`read_reddit`，`research-tools.ts` 建的那一份）。
   * 工具面按职责 yml 的 grounding 给（`pr.monitoring` / `pr.reddit` / `pr.forums` / `social.reddit`）；
   * 不给的话这些职责调它会回「这个进程没装 Reddit 取数」，照实显示。
   */
  researchTools?: ToolExecutor
  /**
   * WP237（#67）：工具每条多少积分（价目表，云上那一份）。工具面里有按条计费的工具时每次运行现问，
   * 填进 `RunRequest.tool_prices`，给模型看的描述据此写现价；取不到回 `undefined`（描述里就不写数）。
   */
  toolPrice?(tool: string): Promise<number | undefined>
  /**
   * WP153（09-26 真账号冒烟 §3）：店主的两个只读工具（`list_positions` / `list_connections`，
   * `owner-tools.ts` 建的那一份）。给了才进 `common.owner` 的工具面——别的职责一律没有；
   * 执行器里还会再判一次职责。
   */
  ownerTools?: ToolExecutor
  /**
   * WP176：主动开发的三个开发信工具（`b2b-outbound-tools.ts` 建的那一份）。给了才进 `b2b.outbound`
   * 的工具面——别的职责一律没有；执行器里还会再判一次职责。
   */
  b2bOutboundTools?: ToolExecutor
  /**
   * WP421（决策 1266–1270）：公关 / 内容与搜索 / B2B / 设计的读数与起草工具（`deskToolsFor` 那一张表按职责给）。
   * 不给 = 这几条职责照旧没有这些工具。
   */
  deskTools?: ToolExecutor
  /**
   * WP316：改广告的两个工具（`ads-tools.ts` 建的那一份）。给了才进 Google / Meta 两条投放职责的工具面；
   * 执行器里还会再判一次职责。提一批只出卡，批了插件才去用户自己的后台里做。
   */
  adsTools?: ToolExecutor
  /**
   * WP253：网页模板的九个受限主题工具（`theme-tools.ts` 建的那一份）。给了才进 `site.shopify-theme`
   * 的工具面——别的职责一律没有；执行器里还会再判一次职责。发布只出卡，不直接发。
   */
  themeTools?: ToolExecutor
  /**
   * WP261（决策 175 第 1 步）：独立站运营工具（`shop-tools.ts` 建的那一份，按品牌）。工具面按
   * 「职责表 × 店铺授权里的权限」每次运行现问（`offered`）：没授权 / 过期一个都不出（岗位页引导去授权）；
   * 改动工具只出卡，人批了执行器才改。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  shopTools?: { executeTool: ToolExecutor; offered(role_id: string): Promise<string[]> }
  /**
   * WP268（决策 213）：生图 / 改图 / 素材库三个工具（`image-tools.ts` 建的那一份，按品牌）。工具面每次运行现问：
   * 设计岗五条 + 网页模板，且「生图」那一档配了才有（模型不会改图就不摆 `edit_image`）。不给 = 没有这一组。
   */
  imageTools?: { executeTool: ToolExecutor; offered(role_id: string): Promise<string[]> }
  /**
   * WP181：官方「自动化任务」的四个工具（`automation.ts` 建的那一份）。**装了那个官方插件**
   * （`enabled()`，每次运行现问）才进工具面——所有职责都有（给自己建提醒）；会往外发的周期任务
   * 由执行器出卡。没装的运行工具面与提示词字节一个不变。
   */
  automation?: { enabled(): Promise<boolean> | boolean; executeTool: ToolExecutor }
  /**
   * WP323（决策 665 / 666）：记录去处的三个工具（`outbound/tools.ts` 建的那一份）。**所有职责都有**——
   * 用户在哪个岗位说「以后每发一条记到这张表」都能配；配置只出「定规矩」卡。不给 = 没有这一组
   * （老装配、模拟世界字节不变）。
   */
  recordSinkTools?: ToolExecutor
  /**
   * WP441（docs/108 §5.1.2）：一句话写消息规则的两个工具（`message-rule-tools.ts` 建的那一份）。**所有职责都有**——
   * 用户在助理或哪个岗位里说「…的信以后都…」都能配；只出「要建这条规则吗」卡。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  messageRuleTools?: ToolExecutor
  /**
   * WP331（决策 691）：报告积木的四个工具（`report-tools.ts` 建的那一份）。查发出记录 / 发布报告给所有职责；
   * 查巡查数据 / 立即巡查只给 `watchRoles`。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  reportTools?: {
    execute: ToolExecutor
    watchRoles: ReadonlySet<string>
    /**
     * WP392：担竞品监控的职责（店铺管理、Amazon 店铺运营）：给竞品变化表，也给查巡查数据 / 立即巡查
     * （默认查的是竞品那一份）。不给 = 没人担。
     */
    competitorRoles?: ReadonlySet<string>
  }
  /** WP386：信息监控查提及（`list_mentions`，`pr-watch/tools.ts` 建的那一份）。不给 = 没有。 */
  prMonitorTools?: ToolExecutor
  /**
   * WP315（docs/101 §5.1①）：投放岗看数据的三个工具（`ads-data/tools.ts` 建的那一份）。只给 `ads.*` 职责。
   * 不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  adsDataTools?: ToolExecutor
  /**
   * WP396（docs/106 §13）：亚马逊店铺运营的 Listing 体检三个工具（`amazon-listing/tools.ts` 建的那一份）。
   * 只给 `amz.store`。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  amazonListingTools?: ToolExecutor
  /**
   * WP398（docs/106 §13 A8）：亚马逊店铺运营的 Amazon 词库三个工具（`amazon-keywords/tools.ts` 建的那一份）。
   * 只给 `amz.store`。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  amazonKeywordTools?: ToolExecutor
  /**
   * WP334（决策 724）：AI 自己要连接卡 / 配置卡的通用工具 `request_setup`（`setup-request-tool.ts` 建的那一份）。
   * **所有职责都有**；工具只回结构化缺项，卡由这一轮收尾时的 `setupCards.onRunBlocked` 出（同一缺项只一张）。
   * 不给 = 没有这个工具（老装配、模拟世界字节不变）。
   */
  setupRequestTool?: ToolExecutor
  /**
   * WP385（决策 1076）：网站运营读体检结论的只读工具 `query_site_health`（`site-health-tools.ts` 建的那一份）。
   * 只给店铺管理、SEO 与 GEO（`dtc.store` / `dtc.seo`）。不给 = 没有这个工具（老装配、模拟世界字节不变）。
   */
  siteHealthTools?: ToolExecutor
  /**
   * WP419（自查 R10 / S3）：社媒发帖 / Reddit 起草出卡的工具（`social-tools.ts` 建的那一份）。
   * Reddit 那两个给官方版块 / 外部版块，发帖那两个给社媒内容账号那几条。不给 = 没有（老装配、模拟世界字节不变）。
   */
  socialWorkTools?: ToolExecutor
  /**
   * WP387（docs/103 v2 §3.3）：浏览器建完 / 读完 Google 提醒后交代结果的 `report_google_alerts`
   * （`pr-alerts/tool.ts`）。只给信息监控那条职责；不给 = 没有这个工具（老装配、模拟世界字节不变）。
   */
  googleAlertsTool?: ToolExecutor
  /**
   * WP387：这件事这次运行带不带「可以改 Google 提醒」的凭据（`RunRequest.browser_grants`）。
   * 只有那张卡同意过、那一趟还在跑的那件事才有；不给 / 回空 = 不写这个字段（受保护页面上的写一律拦）。
   */
  browserGrants?: (input: { role_id: string; matter_id: string }) => RunBrowserGrant[]
  /**
   * WP390（docs/105 §4）：工坊服务的两个工具（`find_service` / `draft_service_order`，所有职责都有）与
   * **推荐卡**：这一轮收尾时问 `offer` 挂不挂、挂哪一项（分寸在服务里判：后台不推、同一对话一项只推一次、
   * 说过「不用」30 天不推）。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  workshopServices?: {
    execute: ToolExecutor
    offer?(input: {
      request: RunRequest
      matter_id: string
      /** 这一轮 AI 用 `find_service` 查到的第一项。 */
      found?: string
    }): Promise<ServiceOffer | undefined>
  }
  /**
   * WP393（docs/104 一期 A）：店铺管理「竞品动向」那两个工具（探平台 / 现在读一次；`competitor-watch/store-tools.ts`）。
   * 只给 `dtc.store`。不给 = 没有这一组（老装配、模拟世界字节不变）。
   */
  competitorStoreTools?: ToolExecutor
  /**
   * WP420（自查 B11）：这个品牌连上 Amazon 官方卖家连接（SP-API）没有。不给 = 没连上
   * （连接还没开放）——`amazon-sp-*` 那几本官方技能不进按需索引（正文里的工具全来自那条连接）。
   */
  amazonSellerConnected?: (workspace_id: string) => boolean | Promise<boolean>
  /**
   * WP394（docs/104 一期 B）：亚马逊店铺运营「竞品动向」现在读一次（`competitor-watch/amazon-tools.ts`）。
   * 只给 `amz.store`。不给 = 没有这一个（老装配、模拟世界字节不变）。
   */
  amazonCompetitorTools?: ToolExecutor
  /**
   * WP44：Shopify 官方 Dev MCP 的只读工具源（`shopify-devmcp.ts` 起的那个进程）。
   *
   * 给了就把它现在真能调的那几个工具加进工具面——**起不来就一个都不加**，
   * 模型不该看见调不动的工具。校验是加固不是门禁：没有它，写类变更照常能 stage。
   */
  devTools?: {
    /** 现在真能调的工具名（Dev MCP 没起来就是空数组）。 */
    toolNames(): readonly string[]
    call(name: string, input: Record<string, unknown>): Promise<{ text: string }>
  }
  /**
   * WP82（55 §3）：这台机器上的浏览器怎么配（`browser-settings.ts` 的 `forRun()`）。
   *
   * 晚绑定的读法与 `vertical` 同一条理由：用户在设置页里改了浏览器，下一次运行就该
   * 用新的那一套，不该等重启。**不给 / 回 `undefined` = 这次运行不开浏览器**——
   * 工具面里一个 `browser_*` 都不会有（`dsh-adapter` 的 `harness.ts` 连 provider 都不挂）。
   *
   * WP148：带 `browser` 的运行**改走 dsh 运行时**（浏览器提供方只在那一条路上挂，
   * 与 WP144 电脑操控同一个分流）；别的运行照旧走 direct / stub，一个字节不变。
   */
  browser?: () => RunBrowser | undefined
  /**
   * WP86（55 §4 第三层）：**这条职责挂哪几台 MCP 服务器**。
   *
   * 来自连接目录（`connection-directory.ts` 的 `roleConnections`）。晚绑定的读法与
   * `vertical` / `browser` 同一条理由：用户在连接页登记了一台，下一次运行就该用上，
   * 不该等重启。**不给 / 回空数组 = 这条职责一台都不挂**——运行时连 preset 都不装。
   *
   * 里面没有任何凭据值，只有"请求头名 → 凭据引用名"。
   */
  connections?: (role_id: string) => RunConnection[]
  /**
   * WP125（72 §P0-1 / §P0-2）：**出站草稿的判断层**。
   *
   * 每一份 `outbound_draft` 在建卡之前过这一道：先泄漏守卫（商家教 AI 的那句中文
   * 有没有被逐字抄进客户会看到的正文），再三道自主门（L3 黑名单 / 草稿来源 /
   * 承诺扫描）。回 `rewrite` 就**打回重写**——原因回到写正文的那一跳，
   * 绝不静默删改后照发（与 Amazon 出站硬闸同一条纪律，见 `channels.ts`）。
   *
   * 不接 = 老行为：草稿照常建卡，只是 `context.gates` 是空的、没有泄漏守卫。
   * 真服务进程一定接（`server.ts` 把它接到 `support-judgment.ts` 上）。
   */
  /**
   * WP417（自查客服 C2 / C24 / D9）：这件事的回复**该回到哪个渠道**。事项上钉着聊天会话 / 社群线程时，
   * 起草出来的回复要回原来那个聊天窗 / 群，而不是变成一张「收件人待定」的邮件卡。
   * 装配方认得出就自己出那张卡、回卡 id；认不出（普通邮件线程 / 没钉东西）回 `undefined`，照旧出邮件卡；
   * 那个渠道出卡被拦下回 `{ error }`（不再退回邮件卡，免得人以为发得出去）。
   */
  routeDraft?(input: {
    matter: Matter
    run_id: string
    subject: string
    body: string
    actor: { person_id: string; assignment_id: string; role_id: string }
  }): Promise<{ approval_item_id: string } | { error: string } | undefined>
  judgeDraft?(input: {
    matter: Matter
    run_id: string
    channel: 'email'
    subject: string
    body: string
    /** 被回复的来信正文（判断层只扫不存）。 */
    inbound_text: string
    thread_external_id?: string
  }): Promise<DraftVerdict | undefined> | DraftVerdict | undefined
  /**
   * WP120（69 §3）：**角色定位的那几段**（品牌 → 岗位 → 职责）。
   *
   * 晚绑定的读法与 `vertical` / `browser` 同一条理由：公司在右栏把某条 persona
   * 改写了，下一次运行就该用新的那一份，不该等重启。
   *
   * 不接 = 老行为：`persona` 段里只有职责那一节（而且是包里的原文，不叠覆盖）。
   * 真服务进程一定接（`server.ts` 把它接到 `personas.ts` 上）。
   */
  personaSections?(input: { role_id: string; position_id?: string | undefined }): PromptSection[]
  /**
   * WP284（决策 275）：**这条职责的规矩**（「以后都这样」批了落下的那几句）。没有就回 `undefined`，整节不出。
   * 同 `personaSections` 的理由：每次运行现取。
   */
  roleRules?(role_id: string): PromptSection | undefined
  /**
   * WP122b（71 §5 / §9 第 7 条）：**品牌设计规范**那一段。
   *
   * 按职责 id 问：四个吃规范的岗位族（设计 / 建站 / 社媒 / 投放）回一段
   * `PromptSection`（或 `undefined` = 这条职责不注）。取值函数 + 现取，
   * 同 `vertical` / `personaSections` 的理由：用户在设计规范页改一格，
   * 下一次运行就该照新的来，不该等重启。
   *
   * 不接 = 老行为：提示词里没有品牌令牌（WP122 合入时的状态）。
   * 真服务进程一定接（`server.ts` 接到 `BrandDesignAssembly.context()` 上）。
   */
  brandDesign?(role_id: string): PromptSection | undefined
  /**
   * WP333：**客服回信起草带上品牌语气**（`support-voice.ts`）。按职责与它挂的技能问：
   * 写客服回信的职责（挂了 `customer-care`、没挂 `brand-voice`）、这个品牌自己写过话术 → 回一段；
   * 别的一律 `undefined`（整段不出，一个字节不多）。每次现取：话术改了下一次运行就是新的。
   * 不接 = 老行为。
   */
  brandVoice?(input: {
    role_id: string
    skills: readonly SkillRef[]
    actor: SkillPromptActor
  }): Promise<PromptSection | undefined>
  /**
   * WP144（docs/80）：**电脑操控**（`computer-use.ts` 那一份，一台机器一个）。
   *
   * 三层开关的前两层（总开关、这条职责勾没勾）与「这件事有没有一次批过的授权」都在它里面，
   * `buildRequest` 每次现问（同 `browser` 的理由：设置页改了下一次运行就生效）。
   * 不接 = 老行为：`RunRequest.computer_use` 永远不给，谁都碰不到这台电脑。
   *
   * 带 `computer_use` 的运行**改走 dsh 运行时**（官方提供方只在那一条路上挂）；
   * 别的运行照旧走 direct / stub，一个字节不变。
   */
  computerUse?: Pick<ComputerUseAssembly, 'forRun' | 'remember' | 'activate' | 'deactivate'>
  /**
   * WP148：带浏览器 / 电脑操控的那几次运行，dsh 那棵树怎么装（`createDshRuntime` 的 `mode`）。
   * 不给 = `auto`（探测得到子进程入口就起子进程，否则进程内）——服务进程就是这样用的。
   * 测试钉成 `in-process`，结果才不随「dsh-adapter 编没编过」变。
   */
  dshMode?: DshRuntimeMode
  /**
   * WP290（决策 332，装包前冒烟）：**每一次**有模型的运行都走 dsh 运行时，不只带浏览器 / 电脑操控 /
   * 网页工具的那几种。只给 `scripts/preinstall-smoke.mjs` 用：它要每条职责的全部工具都过一遍
   * dsh 自己的工具编译（10-09 参数表那一类错一启动就挂）。不给 = 老行为，一个字节不变。
   */
  dshAllRuns?: boolean
  /**
   * WP179（Luoye 09-29「官方功能优先」）：**官方网页搜索与抓网页**要服务端给的那几样。
   *
   * 不接 = 老行为：`RunRequest.web` 永远不给，谁都上不了网。接了也要职责 YAML 挂了 `web_tools`
   * （`EffectiveConfig.web`）、而且有模型才给——带 `web` 的运行**改走 dsh 运行时**
   * （官方工具只在那一条路上挂），别的运行照旧 direct / stub，一个字节不变。
   */
  web?: RunWebOptions
}

/** WP179：服务端装配给运行时的网页那一层。 */
export interface RunWebOptions {
  /** 数据接口路由里 `web.search` 那一级（设置里「联网搜索」那个开关）开着没。每次现问。 */
  searchEnabled(): boolean
  /**
   * WP179 的 DeepSeek 凭据（旧路）。WP353 起 DeepSeek 自带搜索不再挂，这两样只为老调用方留着、不再用。
   */
  credentialKind?(): WebCredentialKind | undefined
  credential?(endpoint: string): Promise<WebCredential | undefined>
  /**
   * WP353（决策 912）：联网搜索后端——工坊内置浏览器搜 Google（回退 Bing → 云端 Google → 公开搜索服务），
   * 以及 Reddit / LinkedIn 这类站用同一浏览器读正文（`apps/server/src/web-browser`）。不给 = 不给搜索。
   */
  browser?: RunWebBrowser
  /** WP353：品牌主市场与各市场语言那一行（系统提示「搜索语言」）。 */
  localeLine?(): string | undefined
  /** 搜索口地址（测试指向本机替身；缺省官方地址）。 */
  searchBaseUrl?: string
}

/** WP353：运行时用到的那几样（`BrowserWebSearch` 的子集）。 */
export interface RunWebBrowser {
  available(): boolean
  /**
   * WP355：`who` = 这次运行的模型来源 / 模型 / 人——名单里的来源（ChatGPT 订阅）先用它自带的搜索。
   * 用了自带搜索就回 `native_usage`，运行时照 `model.usage{purpose: web_search}` 记一笔（`cost_base` 0）。
   */
  search(
    query: string,
    maxResults?: number,
    who?: { source?: string; model?: string; person_id?: string },
  ): Promise<{
    sources: readonly { url: string; title?: string; snippet?: string }[]
    content?: string
    truncated: boolean
    native_usage?: {
      model: string
      input_tokens: number
      output_tokens: number
      cached_tokens: number
    }
  }>
  fetch(url: string): Promise<{
    url: string
    statusCode: number
    body: { kind: 'text'; content: string }
    truncated: boolean
  }>
  readonly fetchHosts: readonly string[]
}

/**
 * WP147：这次运行的模型要不要向 dsh 那条路由**声明图片输入**（截图进不进模型）。
 *
 * 只认 WP127 三步验证的结论：`'ok'`，而且验证的正是这次运行用的这个模型（provider + 模型名）。
 * `'no'`（看不了）/ `'unchecked'`（没验证过）/ 换了模型 / 没接，一律不声明——
 * 截图的位置是官方 MCP 桥的诊断文字，模型照样靠文字干活。
 */
export function declaresImageInput(
  vision: 'ok' | 'no' | 'unchecked' | undefined,
  current: ModelRef | undefined,
  model: ModelRef,
): boolean {
  return (
    vision === 'ok' &&
    current !== undefined &&
    current.provider === model.provider &&
    current.model === model.model
  )
}

/**
 * WP125：判断层对一份草稿的结论（形状与 `support-judgment.ts` 的 `DraftJudgment` 一致，
 * 这里只声明运行时真正要用的那几格——`runtime.ts` 不该 import 判断层，那是反向依赖）。
 */
export interface DraftVerdict {
  action: 'send' | 'rewrite' | 'card'
  rewrite_instruction?: string
  /** WP417：打回重写时时间线上那一句（不给 = 泄漏守卫那一句）。 */
  note?: string
  /** 进 `ApprovalItem.context.gates`：只有门名、结论、规则集哈希，**没有被扫的文本**。 */
  gate_context: GateDecision[]
  /**
   * WP440（docs/108 M9）：客服邮件这一封**为什么没直接回**（「把握不够」「知识库里没有」…），
   * 卡标题后面括号里那一句。只有客服判断层试过直接回、没过的那条线程才有；别的岗位、别的渠道永远没有，
   * 标题一个字节不变。
   */
  title_note?: string
}

/**
 * WP69（54 §1 / §3）：岗位那一层从哪来。
 *
 * 与 `bind(work)` 同一个套路——岗位面要 `Work`，而 `Work` 要 `startRun`，
 * 所以这一份也是**晚绑定**的（`bindPositions`）。不绑就是老行为：
 * 六层里的 `position` 那一层没有东西可叠，岗位层上下文也不注入。
 */
export interface PositionLayerSource {
  /**
   * 这条职责属于哪个岗位。挂在多个岗位里、或者一个都没有时回 `{ note }`——
   * 54 §3：**跳过 `position` 层并在时间线说明**，不猜一个。
   */
  positionOf(role_id: string, assignment_id?: string): { position_id?: string; note?: string }
  /** 岗位层上下文的三样：面板数字与告警摘要、岗位下进行中事项摘要、持有人可用时段。 */
  layerContext(
    position_id: string,
    person_id: PersonId,
  ): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

/** WP150：一次正在跑的运行（第三栏 / 登出确认框里那一行）。 */
export interface ActiveRunView {
  run_id: string
  matter_id: string
  /** 事项名（人话，登出确认框里列的就是它）。 */
  title: string
  /** 这次运行绑定的模型来源（开跑时的 `purpose: 'run'` 那一条）。 */
  model: ModelRef
  /** WP337：谁起的这一次（更新重启后按同一个人、同一条分配接着做）。 */
  person_id?: PersonId
  assignment_id?: string
}

export interface RuntimeAssembly {
  adapter: RuntimeAdapter
  /** WP150：现在正在跑的运行（跑完就不在了）。 */
  activeRuns(): ActiveRunView[]
  /**
   * WP150：停掉一次正在跑的运行：先在事项时间线上写一句为什么停（`reason`，人话），再中断它，
   * 等它收尾（最多 `waitMs`，缺省 10 秒）。找不到（已经跑完）回 `false`。
   */
  stopRun(run_id: string, reason: string, waitMs?: number): Promise<boolean>
  /**
   * WP337：因为「重启并更新」**在安全点停下**一次运行：已经说的话、取回的数据照常作为部分结果挂上，
   * 时间线那一句换成「因更新暂停」（新版起来后由 `update-pause` 接着做）。找不到回 `false`。
   */
  pauseRun?(run_id: string, waitMs?: number): Promise<boolean>
  /**
   * WP334（决策 726）：给一次正在跑的运行记一样「缺的、能就地连的」——它收尾时照 WP324 出连接卡
   * （DeepSeek 账号登录过期、停掉正在用它跑的事之前调）。找不到（已经跑完）就什么都不做。
   */
  noteNeed?(run_id: string, need: ConnectNeed): void
  /**
   * WP264：这件事上正在跑的那一次（事项页「正在做…」+ 实时步骤）。没在跑回 `undefined`。
   * 好几次同时在跑时给最近开跑的那一次。
   */
  liveRun?(matter_id: string): MatterLiveRun | undefined
  /**
   * WP341（决策 847）：对话里点了一个「调工具」的 genui 按钮——走**同一个工具执行器**：只读的当场跑；会改外部的
   * 由各执行器照旧进账本出审批卡（批了才做），卡挂进这件事的时间线（卡片流同一张）；直接写外部的不收。
   * 用出这个按钮的那一次运行的身份与「读过」记录（`run_id`；找不到用 `fallback` 那条分配新开一个）。
   */
  runHostTool?(input: {
    matter_id: string
    person_id: PersonId
    fallback_assignment_id: AssignmentId
    call: GenuiToolInput
  }): Promise<GenuiToolOutcome>
  /** 注入 `createWork`；工作模型与 startRun 互相需要，靠这一步打断环 */
  bind(work: Work): void
  /** WP69：注入岗位面（岗位层技能与岗位层上下文靠它）。 */
  bindPositions(source: PositionLayerSource): void
  startRun: StartRun
}

/**
 * 有没有配真模型 provider（22 §5：业务代码里没有 key，只看它在不在）。
 *
 * WP25 之后这是**兜底**——服务进程会传 `hasModel`，让模型面（加密库里的配置）说了算；
 * 没有界面的部署（CI、脚本）仍然靠这个环境变量。
 */
export function hasModelProvider(env: Record<string, string | undefined>): boolean {
  const key = env.DEEPSEEK_API_KEY
  return key !== undefined && key.trim() !== ''
}

interface RunScope {
  run_id: string
  matter: Matter
  /** WP125：这次运行的来信正文（判断层扫它；**只扫不存**）。 */
  brief: string
  todo_id?: TodoId
  person_id: PersonId
  assignment_id: AssignmentId
  /** 这次运行「读过」的对象（15 §6）；收件人门禁与 provenance 都从它取 */
  seen: ObjectRef[]
}

/**
 * 回信收件人：事项上钉着来信人（`contact`）就只能是他；没钉（老事项）才用模型给的地址解析出来的那个。
 * 纯函数，方便钉住"模型给别的邮箱也发不出去"这一条。
 */
export function pickDraftRecipient(input: {
  pinnedContact: ObjectRef | undefined
  resolved: ObjectRef | undefined
}): ObjectRef | undefined {
  if (input.pinnedContact !== undefined) return input.pinnedContact
  return input.resolved
}

/** WP232：收件人待定那张卡上的一句话（系统不发，人复制正文自己发）。 */
export const MANUAL_SEND_SUMMARY = '没有能替你发的收件地址：批了也不会自动发出，复制正文自己发。'

export function createRuntime(options: RuntimeOptions): RuntimeAssembly {
  const { clock, workspace_id, roles, approvals } = options
  const source = options.source ?? {}
  const seed = options.seed ?? Math.floor(options.random() * 0x7fffffff)
  let work: Work | undefined
  /** WP69：岗位面（晚绑定，见 `bindPositions`）。 */
  let positions: PositionLayerSource | undefined
  let seq = 0
  const newId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff).toString(36)
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /** 当前这次运行的现场；stub / direct 的回调是同步回到宿主的，所以一个变量够用。 */
  let scope: RunScope | undefined

  /** WP150：正在跑的运行（开跑登记、收尾摘掉）。只在内存里——重启之后本来就没有在跑的。 */
  const active = new Map<
    string,
    { view: ActiveRunView; controller: AbortController; settled: Promise<void> }
  >()
  /** WP337：因更新暂停的那几次（停下那一句换成「因更新暂停」）。 */
  const pausing = new Set<string>()

  /**
   * WP162：每次运行解析技能用的「我是谁」（带岗位层）。`read_skill` 按它叠六层——
   * 岗位不在 RunRequest 上，所以开跑前登记、收尾摘掉（与 `active` 同一个生命周期）。
   */
  const skillActors = new Map<string, SkillPromptActor>()
  /** WP341：最近几百次运行的身份（genui 按钮按出它的那次运行算）。 */
  const runActors = new Map<
    string,
    { matter_id: string; person_id: PersonId; assignment_id: AssignmentId }
  >()

  /**
   * WP236：每次运行的看门狗与现场记录（开跑登记、收尾摘掉，与 `active` 同一个生命周期）。
   * 宿主执行器每调一次工具都给看门狗续命、把回来的数据记一笔——停下来时拼「已经查到的部分」。
   */
  /** WP264：每次运行的步骤记录（开跑登记、收尾摘掉）。 */
  const runSteps = new Map<string, { matter_id: string; started_at: string; log: RunStepLog }>()
  const nowMs = (): number => Date.parse(clock.now())
  const runWatch = new Map<
    string,
    { watchdog: RunWatchdog; log: PartialRunLog; blocks: RunBlockLog }
  >()
  /** WP390：这一轮 AI 用 `find_service` 查到的第一项（收尾时据此挂推荐卡；收尾摘掉）。 */
  const foundServices = new Map<string, string>()
  /** WP251：这一轮撞上「缺连接 / 缺凭据」时记一笔（缺哪个连接按这条职责现查）。 */
  const noteBlocked = (
    blocks: RunBlockLog | undefined,
    tool: string,
    reason: MatterRunBlock['reason'],
    role_id: string,
  ): void => {
    if (blocks === undefined) return
    let connections: string[] = []
    let needs: ConnectNeed[] = []
    try {
      connections = options.missingConnections?.(role_id) ?? []
      needs = options.missingConnectionNeeds?.(role_id) ?? []
    } catch {
      // 连接目录还没装好：只记卡住了，不说缺哪个
    }
    blocks.note(tool, reason, connections, needs)
  }

  /** WP236：这条职责这一次的时长线（职责阈值 → 设置 → 缺省）。 */
  const timeLimitsFor = (role_id: string): RunTimeLimits =>
    resolveRunTimeLimits({
      thresholds: options.roles.roles?.get(role_id)?.thresholds,
      settings: options.runLimits?.(),
    })

  const appendRunEvent = (req: RunRequest, e: RunEvent): void => {
    const { type, ...payload } = e
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'agent', id: req.actor.assignment_id, run_id: req.id },
      correlation: {
        // 请求里起的运行由网关的 traceScope 覆盖成请求 trace；渠道消费者 / 定时任务起的运行
        // 没有请求上下文，空 trace 会被内核整条顶回、整次运行报"没跑成"（09-12 真账号验收撞上）
        trace_id: `trc_run_${req.id}`,
        run_id: req.id,
        ...(req.work_item === undefined ? {} : { work_item_id: req.work_item.id }),
      },
      payload,
    })
  }

  /** 跑出来的卡：进事项时间线 + 回填到待办（37 §2.1 交点一）。 */
  const backfill = (item: ApprovalItem): void => {
    work?.onCard(cardRefOf(item))
  }

  /**
   * 起草回复 → `outbound_draft` 审批项。
   *
   * 收件人必须解析成一个 ObjectRef 且是这次运行读过的（31 §3.3），系统才会替人发。
   * WP232：解析不出来（人在任务里贴了一封信、事项上没有来信人）时**草稿照样进待批**——
   * 出一张「收件人待定」的卡（`manual_send`，系统不发，人复制正文自己发），绝不把草稿丢掉。
   * 以前这里回 `undefined`，三个运行时都把它当成「没批下来」，dsh 那一档还报成
   * 「未获批准（fail-closed）」，真模型据此编出了「审批闸没人应答」。
   */
  const createDraft = async (
    payload: DraftPayload,
  ): Promise<{ approval_item_id: string } | { rewrite: string } | undefined> => {
    const s = scope
    if (s === undefined || work === undefined) return undefined
    const email = payload.to[0]
    const resolved = email === undefined ? undefined : source.contactOf?.(email)
    // 31 §3.3 + 09-14 真店实测：模型会把订单上的客户邮箱当收件人，而来信人可能是另一个地址
    // （代下单、家人、测试账号）。回信只能回给**来信人**——事项上钉着的那个联系人；
    // 模型给的地址不一致就改指过去并在时间线上说一句，绝不按模型给的发。
    const pinnedContact = s.matter.context.pinned.find((p) => p.type === 'contact')
    const picked = pickDraftRecipient({ pinnedContact, resolved })
    const seen = [...s.seen]
    // 这次运行没读过的收件人同样不替人发（15 §6）：改出收件人待定的卡
    const to =
      picked !== undefined && seen.some((r) => refKey(r) === refKey(picked)) ? picked : undefined
    if (to !== undefined && resolved !== undefined && refKey(resolved) !== refKey(to)) {
      work.appendEvent(s.matter.id, {
        kind: 'status',
        text: `回信收件人改为来信人：模型给的地址（${email}）与来信人不一致，已按来信人处理。`,
        actor: { kind: 'system', id: 'runtime' },
        run_id: s.run_id,
      })
    }
    /*
     * WP125（72 §P0-1 / §P0-2）：**建卡之前过判断层**。
     *
     * 顺序是硬的：泄漏守卫 → 三道自主门 → 建卡。放在建卡之后就晚了——
     * 一张已经进了队列的卡再去说"其实它不该长这样"，人已经看见了。
     *
     * 判断层自己炸了按 fail-closed 处理：`catch` 之后照常建卡（**不自主**，
     * `context.gates` 留空），而不是把这封信丢掉。一个装配错误不该让客户等不到回信。
     */
    let verdict: DraftVerdict | undefined
    try {
      verdict = await options.judgeDraft?.({
        matter: s.matter,
        run_id: s.run_id,
        channel: 'email',
        subject: payload.subject,
        body: payload.body,
        inbound_text: s.brief,
        ...(payload.thread_external_id === undefined
          ? {}
          : { thread_external_id: payload.thread_external_id }),
      })
    } catch (e) {
      work.appendEvent(s.matter.id, {
        kind: 'status',
        text: `出站判断层没跑起来，这一封按"要人点头"处理：${e instanceof Error ? e.message : String(e)}`,
        actor: { kind: 'system', id: 'runtime' },
        run_id: s.run_id,
      })
    }
    if (verdict?.action === 'rewrite') {
      // 打回重写：原因回给写正文的那一跳，**不建卡**（这一版根本没成形）
      work.appendEvent(s.matter.id, {
        kind: 'status',
        text: verdict.note ?? '这一版回信照抄了内部指导的原文，已打回重写。',
        actor: { kind: 'system', id: 'runtime' },
        run_id: s.run_id,
      })
      return { rewrite: verdict.rewrite_instruction ?? '重写一版，不要引用内部指导的原文。' }
    }
    // WP417（自查 C2 / D9）：聊天会话 / 社群线程上的事——回复回原渠道（那张卡由装配方出）
    const routedAssignment = roles.assignments.get(s.assignment_id)
    const routed = await options
      .routeDraft?.({
        matter: s.matter,
        run_id: s.run_id,
        subject: payload.subject,
        body: payload.body,
        actor: {
          person_id: s.person_id,
          assignment_id: s.assignment_id,
          role_id: routedAssignment?.role_id ?? 'common.member',
        },
      })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
    if (routed !== undefined) {
      if ('error' in routed) {
        work.appendEvent(s.matter.id, {
          kind: 'status',
          text: `回复没出成卡：${routed.error}`,
          actor: { kind: 'system', id: 'runtime' },
          run_id: s.run_id,
        })
        return undefined
      }
      return { approval_item_id: routed.approval_item_id }
    }
    const subject =
      seen.find((r) => r.type === 'thread') ??
      seen.find((r) => r.type === 'order') ??
      to ??
      // 收件人待定：卡挂在这件事上（任务说明那一段注入时就记进了 seen）
      ({ type: 'matter', id: s.matter.id } satisfies ObjectRef)
    const assignment = roles.assignments.get(s.assignment_id)
    const who =
      to === undefined
        ? undefined
        : (source.label?.(to) ??
          (resolved !== undefined && refKey(resolved) === refKey(to) ? email : '来信人'))
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: assignment?.role_id ?? 'common.member',
      subject: {
        object: subject,
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
        conversation_id: s.matter.id,
      },
      dedupe_key: `${workspace_id}:outbound_draft:${s.matter.id}:${s.run_id}`,
      title: `${
        who === undefined
          ? `回复草稿（收件人待定）：${payload.subject}`
          : `回复 ${who}：${payload.subject}`
      }${verdict?.title_note === undefined ? '' : `（${verdict.title_note}）`}`,
      summary: to === undefined ? MANUAL_SEND_SUMMARY : payload.subject,
      payload: {
        channel: payload.channel,
        ...(to === undefined ? { manual_send: true } : { to }),
        body: { subject: payload.subject, text: payload.body },
        ...(payload.thread_external_id === undefined
          ? {}
          : { thread_ref: payload.thread_external_id }),
      },
      evidence: {
        run_id: s.run_id,
        source_events: [],
        provenance: { seen },
        precheck: {},
        citations: payload.citations,
      },
      proposer: { kind: 'agent', id: s.assignment_id, assignment_id: s.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: s.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 8,
          business_hours: true,
          chain: ['owner'],
          escalated_at: [],
        },
        separation_of_duties: true,
      },
      priority: 'queue',
      context: {
        thread_participants: to === undefined ? [] : [to.id],
        verified_contacts: to === undefined ? [] : [to.id],
        // WP125：三道门的结论进前置（只有门名、结论、规则集哈希；被扫的文本一个字不进）
        ...(verdict === undefined || verdict.gate_context.length === 0
          ? {}
          : { gates: verdict.gate_context }),
      },
    })
    if (item.state === 'blocked') return undefined
    backfill(item)
    /*
     * WP417（自查客服 A18）：邮箱还没连上——卡照出（草稿不丢），这一轮收尾就地出「连邮箱」的连接卡；
     * 真点「发送」时渠道照实回「没发出去：邮箱没连」，不再掉到内存桩显示发成功。
     */
    if (payload.channel === 'email' && to !== undefined) {
      const emailNeed = (options.missingConnectionNeeds?.(assignment?.role_id ?? '') ?? []).find(
        (n) => n.kind === 'email',
      )
      if (emailNeed !== undefined)
        runWatch.get(s.run_id)?.blocks.noteSetup(DRAFT_REPLY_TOOL, {
          kind: 'connect',
          need: emailNeed,
          why: '回信写好了，但邮箱还没连上，现在发不出去。连上就能发。',
        })
    }
    return { approval_item_id: item.id }
  }

  /**
   * 36 §2.2 的业务边界选择题（第一次遇到才问一次；`dedupe_key` 保证不重复问）。
   */
  const createPolicyQuestion: CreatePolicyQuestionFn = async ({ boundary }) => {
    const s = scope
    if (s === undefined) return undefined
    const dedupe_key = `${workspace_id}:policy_change:${boundary.id}`
    // WP232：已经有一张在等人答 → 指给它，不 bump、不改挂（问题没变，再问一遍只是噪声）
    const waiting = options.activeApproval?.(dedupe_key, 'policy_change')
    if (waiting !== undefined) return { approval_item_id: waiting.id }
    const assignment = roles.assignments.get(s.assignment_id)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: assignment?.role_id ?? 'common.member',
      subject: {
        object: { type: 'policy', id: boundary.id },
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
      },
      dedupe_key,
      title: boundary.question,
      summary: `定一个答案，以后 Agent 自己按它走，不再问你（${boundary.label}）`,
      payload: {
        target: 'workspace_policy',
        boundary_id: boundary.id,
        before: null,
        after: { boundary_id: boundary.id },
        affected_assignments: [s.assignment_id],
        options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
      },
      evidence: {
        run_id: s.run_id,
        source_events: [],
        provenance: { seen: [...s.seen] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: s.assignment_id, assignment_id: s.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: s.person_id, via: 'owner' }],
        rule: 'owner',
        escalation: { after_hours: 48, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: boundary.options.map((o) => ({ id: o.id, label: o.label })),
    })
    if (item.state === 'blocked') return undefined
    backfill(item)
    return { approval_item_id: item.id }
  }

  /**
   * WP144（docs/80 §3 第三层）：**电脑操控的授权卡 / 接手卡**。
   *
   * Agent 调 `request_computer_use`（没授权时）或 `computer_handoff`（遇到登录 / 密码 /
   * 支付 / 验证码）时出这一张。批了之后 `computer-use.ts` 记一次 N 分钟的授权、
   * **带着它重跑这件事**（`remember` 里存的就是那一跳）——批了才挂提供方。
   */
  const requestComputerUse = async (input: {
    request: RunRequest
    stage: 'authorize' | 'handoff'
    reason: string
  }): Promise<{ approval_item_id: string } | undefined> => {
    const s = scope
    const cu = input.request.computer_use
    if (s === undefined || cu === undefined || options.computerUse === undefined) return undefined
    const role_id = input.request.actor.role_id
    const payload: ComputerUseGrantPayload = {
      stage: input.stage,
      run_id: s.run_id,
      matter_id: s.matter.id,
      role_id,
      minutes: cu.minutes,
      reason: input.reason,
    }
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'computer_use',
      role_id,
      subject: {
        object: { type: 'matter', id: s.matter.id },
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
      },
      dedupe_key: `${workspace_id}:computer_use:${s.run_id}:${input.stage}`,
      title:
        input.stage === 'handoff'
          ? `它停下来等你接手：${input.reason}`
          : `让它在接下来 ${cu.minutes} 分钟操作这台电脑？`,
      summary:
        input.stage === 'handoff'
          ? `请你在电脑上把这一步做完（登录、密码、支付、验证码它不会替你输）。做完点「允许」，它会再用 ${cu.minutes} 分钟接着做。`
          : `它想：${input.reason}。允许后它能看屏幕、点、输入；遇到登录、密码、支付、验证码会停下请你来。截图会发给你选的 AI 模型用来看界面，不会存进 Agents 工坊的记录。运行的时候托盘会变色，随时可以点「停止」。`,
      payload,
      evidence: {
        run_id: s.run_id,
        source_events: [],
        provenance: { seen: [...s.seen] },
        precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
      },
      proposer: { kind: 'agent', id: s.assignment_id, assignment_id: s.assignment_id },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: s.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      // 桌面上等着人：进「马上」那一档，不排在队列后面
      priority: 'immediate',
    })
    if (item.state === 'blocked') return undefined
    backfill(item)
    const rerunInput = {
      matter: s.matter,
      brief: s.brief,
      actor: { person_id: s.person_id, assignment_id: s.assignment_id },
      ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
    }
    options.computerUse.remember(item.id, {
      matter_id: s.matter.id,
      minutes: cu.minutes,
      rerun: async () => startRun(rerunInput as Parameters<StartRun>[0]),
    })
    return { approval_item_id: item.id }
  }

  const hasModel = options.hasModel ?? ((): boolean => hasModelProvider(options.env))
  /*
   * 09-25（WP150 报告第 3 条，Fable 复核并修）：**每次运行现问**有没有模型，而不是装配时问一次。
   * 以前在这里算一次就定死——服务启动时还没接模型（新装的机器都是），之后在向导 / 设置里接上，
   * 不重启的话每次运行都还走替身，回复是假的。内测朋友的第一条路正好是这样。
   */
  const useDirect = (): boolean => (options.prefer ?? (hasModel() ? 'direct' : 'stub')) === 'direct'

  /**
   * WP44：把 Dev MCP 的三个只读工具并进工具执行器。
   *
   * 它们不经连接器，也就没有 provenance 可言——查一段文档不等于"读过某个订单"，
   * 所以这条路**不往 provenance 里加任何 ref**（15 §6：seen 只证明读过业务对象）。
   */
  // WP216：Dev MCP 是平台专属的官方工具——品牌的平台那一行没有 `mcp`，工具面里就一个都没有
  // 接了 `storefrontPlatform` 才有这道闸（没接 = 老行为，回放与老单测一个字节不变）；
  // 接了而平台没设 = 没有（不按 Shopify 兜底）
  /*
   * WP236：再加一道——**这条职责要不要它**（平台那一行 `mcp.roles`，建站类 `site.*`）。不要的职责
   * 连 `toolNames()` 都不问：那一问会在后台起 Dev MCP（首次就去下官方工具包）。
   * 平台没接（老装配）时按所有平台那一行的并集判。
   */
  const devMcpWanted = (role_id: string): boolean => {
    if (options.storefrontPlatform === undefined)
      return PLATFORM_KITS.some((k) => platformMcpNeededBy(k.mcp, role_id))
    return platformMcpNeededBy(platformKitOf(options.storefrontPlatform())?.mcp, role_id)
  }
  const devToolNames = (role_id: string): readonly string[] =>
    !devMcpWanted(role_id) ? [] : (options.devTools?.toolNames() ?? [])
  const executeToolRaw: ToolExecutor | undefined = (() => {
    /*
     * WP117（66 断点 #1）：**三级链**——红人工具 → dev MCP → 记录源。
     *
     * 顺序是刻意的：红人工具名（`draft_outreach` 这些）与别处不重名，先问它一句，
     * 不是它的再往下走。谁都不认才回 `unsupported_tool`——而不是静默回 `undefined`
     * 让界面显示一个空结果（66 断点 #6 的病根）。
     */
    const kol = options.kolTools
    const research = options.researchTools
    const owner = options.ownerTools
    const b2bOut = options.b2bOutboundTools
    const adsOut = options.adsTools
    const themeOut = options.themeTools
    const shopOut = options.shopTools
    const imageOut = options.imageTools
    const dev = options.devTools
    const automation = options.automation
    const sinkTools = options.recordSinkTools
    const ruleTools = options.messageRuleTools
    const reportTools = options.reportTools?.execute
    const adsDataTools = options.adsDataTools
    const amazonListingTools = options.amazonListingTools
    const amazonKeywordTools = options.amazonKeywordTools
    const setupRequest = options.setupRequestTool
    const siteHealthTools = options.siteHealthTools
    const socialWork = options.socialWorkTools
    const googleAlerts = options.googleAlertsTool
    const competitorStore = options.competitorStoreTools
    const prMonitor = options.prMonitorTools
    const workshopTools = options.workshopServices?.execute
    const amazonCompetitor = options.amazonCompetitorTools
    const deskTools = options.deskTools
    /*
     * WP162：按需技能。接了技能库才有这个工具（工具面里也只有那时才摆出 `read_skill`）；
     * 「我是谁」按这次运行开跑时登记的那一份（带岗位），登记里没有就退回 RunRequest 上的职责。
     */
    const readSkill =
      options.skills === undefined
        ? undefined
        : createSkillToolExecutor({
            registry: options.skills,
            actorOf: (req) =>
              skillActors.get(req.id) ?? {
                person_id: req.actor.person_id,
                workspace_id: req.workspace_id,
                role_id: req.actor.role_id,
              },
          })
    if (
      kol === undefined &&
      research === undefined &&
      owner === undefined &&
      b2bOut === undefined &&
      themeOut === undefined &&
      shopOut === undefined &&
      imageOut === undefined &&
      dev === undefined &&
      readSkill === undefined &&
      automation === undefined &&
      sinkTools === undefined &&
      ruleTools === undefined &&
      reportTools === undefined &&
      adsDataTools === undefined &&
      setupRequest === undefined &&
      siteHealthTools === undefined &&
      socialWork === undefined &&
      prMonitor === undefined &&
      googleAlerts === undefined &&
      workshopTools === undefined &&
      competitorStore === undefined &&
      amazonListingTools === undefined &&
      amazonKeywordTools === undefined &&
      amazonCompetitor === undefined &&
      deskTools === undefined
    )
      return source.executeTool
    return async (call) => {
      if (kol !== undefined && KOL_TOOL_NAMES.includes(bareOf(call.name))) {
        return kol(call)
      }
      if (readSkill !== undefined && isReadSkillTool(call.name)) {
        return readSkill(call)
      }
      // WP220：只读 Reddit（名字与别处不重名）
      if (research !== undefined && RESEARCH_TOOL_NAMES.includes(bareOf(call.name))) {
        return research(call)
      }
      // WP181：官方「自动化任务」的四个工具（名字与别处不重名；装没装插件在执行器里再判一次）
      if (automation !== undefined && isScheduleTool(call.name)) {
        return automation.executeTool(call)
      }
      // WP153：店主的两个只读工具（名字与别处不重名；职责在执行器里再判一次）
      if (owner !== undefined && OWNER_TOOL_NAMES.includes(bareOf(call.name))) {
        return owner(call)
      }
      // WP176：主动开发的开发信工具（名字与别处不重名；职责在执行器里再判一次）
      if (b2bOut !== undefined && B2B_OUTBOUND_TOOL_NAMES.includes(bareOf(call.name))) {
        return b2bOut(call)
      }
      // WP316：改广告的两个工具（名字与别处不重名；职责在执行器里再判一次）
      if (adsOut !== undefined && ADS_TOOL_NAMES.includes(bareOf(call.name))) {
        return adsOut(call)
      }
      // WP253：网页模板的主题工具（名字与别处不重名；职责在执行器里再判一次）
      if (themeOut !== undefined && THEME_TOOL_NAMES.includes(bareOf(call.name))) {
        return themeOut(call)
      }
      // WP261：独立站运营工具（名字与别处不重名；职责与授权在执行器里再判一次）
      if (shopOut !== undefined && SHOP_TOOL_NAMES.includes(bareOf(call.name))) {
        return shopOut.executeTool(call)
      }
      // WP268：生图 / 改图 / 素材库（名字与别处不重名；职责在执行器里再判一次）
      if (imageOut !== undefined && IMAGE_TOOL_NAMES.includes(bareOf(call.name))) {
        return imageOut.executeTool(call)
      }
      // WP323：记录去处（名字与别处不重名）
      if (sinkTools !== undefined && RECORD_SINK_TOOL_NAMES.includes(bareOf(call.name))) {
        return sinkTools(call)
      }
      // WP441：消息规则（名字与别处不重名）
      if (ruleTools !== undefined && MESSAGE_RULE_TOOL_NAMES.includes(bareOf(call.name))) {
        return ruleTools(call)
      }
      // WP331：报告积木（名字与别处不重名）
      if (reportTools !== undefined && REPORT_TOOL_NAMES.includes(bareOf(call.name))) {
        return reportTools(call)
      }
      // WP386：信息监控查提及（名字与别处不重名）
      if (prMonitor !== undefined && PR_MONITOR_TOOL_NAMES.includes(bareOf(call.name))) {
        return prMonitor(call)
      }
      // WP315：投放岗看数据（名字与别处不重名；职责在执行器里再判一次）
      if (adsDataTools !== undefined && ADS_DATA_TOOL_NAMES.includes(bareOf(call.name))) {
        return adsDataTools(call)
      }
      // WP396：Listing 体检（名字与别处不重名；职责在执行器里再判一次）
      if (
        amazonListingTools !== undefined &&
        AMAZON_LISTING_TOOL_NAMES.includes(bareOf(call.name))
      ) {
        return amazonListingTools(call)
      }
      // WP398：Amazon 词库（名字与别处不重名；职责在执行器里再判一次）
      if (
        amazonKeywordTools !== undefined &&
        AMAZON_KEYWORD_TOOL_NAMES.includes(bareOf(call.name))
      ) {
        return amazonKeywordTools(call)
      }
      // WP334：AI 自己要卡（名字与别处不重名）
      if (setupRequest !== undefined && SETUP_REQUEST_TOOL_NAMES.includes(bareOf(call.name))) {
        return setupRequest(call)
      }
      // WP385：读网站体检结论（名字与别处不重名；职责在执行器里再判一次）
      if (siteHealthTools !== undefined && SITE_HEALTH_TOOL_NAMES.includes(bareOf(call.name))) {
        return siteHealthTools(call)
      }
      // WP419：社媒发帖 / Reddit 起草（名字与别处不重名；职责在执行器里再判一次）
      if (socialWork !== undefined && SOCIAL_WORK_TOOL_NAMES.includes(bareOf(call.name))) {
        return socialWork(call)
      }
      // WP387：交代建 / 读 Google 提醒的结果（名字与别处不重名）
      if (googleAlerts !== undefined && GOOGLE_ALERTS_TOOL_NAMES.includes(bareOf(call.name))) {
        return googleAlerts(call)
      }
      // WP390：工坊服务（名字与别处不重名）
      if (workshopTools !== undefined && WORKSHOP_SERVICE_TOOL_NAMES.includes(bareOf(call.name))) {
        return workshopTools(call)
      }
      // WP393：店铺管理「竞品动向」（名字与别处不重名；职责在执行器里再判一次）
      if (
        competitorStore !== undefined &&
        COMPETITOR_STORE_TOOL_NAMES.includes(bareOf(call.name))
      ) {
        return competitorStore(call)
      }
      // WP394：亚马逊店铺运营「竞品动向」（名字与别处不重名；职责在执行器里再判一次）
      if (
        amazonCompetitor !== undefined &&
        AMAZON_COMPETITOR_TOOL_NAMES.includes(bareOf(call.name))
      ) {
        return amazonCompetitor(call)
      }
      // WP421：公关 / 内容与搜索 / B2B / 设计（名字与别处不重名；职责在执行器里再判一次）
      if (deskTools !== undefined && DESK_TOOL_NAMES.includes(bareOf(call.name))) {
        return deskTools(call)
      }
      if (dev !== undefined && devToolNames(call.request.actor.role_id).includes(call.name)) {
        try {
          const { text } = await dev.call(call.name, call.input)
          return { status: 'ok', data: { text } }
        } catch (e) {
          return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
        }
      }
      if (source.executeTool === undefined) {
        return { status: 'error', reason: 'no_tool_executor' }
      }
      return source.executeTool(call)
    }
  })()
  /*
   * WP236：所有宿主工具调用都过这一层——调用本身就是「有动静」（取一次 Reddit 要 8–12 秒，
   * 开始和结束各续一次命），回来的数据记进这次运行的现场（停下来时拼部分结果）。
   */
  /**
   * WP236：**给模型的工具只放这个进程真接上了的**。10-06 真机：社媒 Reddit 的工具面里摆着
   * `list_community_threads`（职责 grounding 写的），一调就是「这个进程没接」，白花一轮。
   *
   * 判据与上面执行链同一张表：哪个执行器接了、名字归它；剩下的问记录源（`executes`）。
   * 记录源没声明 `executes`（替身 / 模拟世界）= 老行为，不筛。
   */
  const offerable = (name: string, role_id: string): boolean => {
    if (source.executes === undefined) return true
    const bare = bareOf(name)
    if (options.kolTools !== undefined && KOL_TOOL_NAMES.includes(bare)) return true
    if (options.skills !== undefined && isReadSkillTool(name)) return true
    if (options.researchTools !== undefined && RESEARCH_TOOL_NAMES.includes(bare)) return true
    if (options.automation !== undefined && isScheduleTool(name)) return true
    if (options.ownerTools !== undefined && OWNER_TOOL_NAMES.includes(bare)) return true
    if (options.b2bOutboundTools !== undefined && B2B_OUTBOUND_TOOL_NAMES.includes(bare))
      return true
    if (options.adsTools !== undefined && ADS_TOOL_NAMES.includes(bare)) return true
    if (options.themeTools !== undefined && THEME_TOOL_NAMES.includes(bare)) return true
    if (options.shopTools !== undefined && SHOP_TOOL_NAMES.includes(bare)) return true
    if (options.imageTools !== undefined && IMAGE_TOOL_NAMES.includes(bare)) return true
    if (options.recordSinkTools !== undefined && RECORD_SINK_TOOL_NAMES.includes(bare)) return true
    if (options.messageRuleTools !== undefined && MESSAGE_RULE_TOOL_NAMES.includes(bare))
      return true
    if (options.reportTools !== undefined && REPORT_TOOL_NAMES.includes(bare)) return true
    if (options.prMonitorTools !== undefined && PR_MONITOR_TOOL_NAMES.includes(bare)) return true
    if (options.adsDataTools !== undefined && ADS_DATA_TOOL_NAMES.includes(bare)) return true
    if (options.amazonListingTools !== undefined && AMAZON_LISTING_TOOL_NAMES.includes(bare))
      return true
    if (options.amazonKeywordTools !== undefined && AMAZON_KEYWORD_TOOL_NAMES.includes(bare))
      return true
    if (options.setupRequestTool !== undefined && SETUP_REQUEST_TOOL_NAMES.includes(bare))
      return true
    if (options.siteHealthTools !== undefined && SITE_HEALTH_TOOL_NAMES.includes(bare)) return true
    if (options.socialWorkTools !== undefined && SOCIAL_WORK_TOOL_NAMES.includes(bare)) return true
    if (options.googleAlertsTool !== undefined && GOOGLE_ALERTS_TOOL_NAMES.includes(bare))
      return true
    if (options.workshopServices !== undefined && WORKSHOP_SERVICE_TOOL_NAMES.includes(bare))
      return true
    if (options.competitorStoreTools !== undefined && COMPETITOR_STORE_TOOL_NAMES.includes(bare))
      return true
    if (options.amazonCompetitorTools !== undefined && AMAZON_COMPETITOR_TOOL_NAMES.includes(bare))
      return true
    if (options.deskTools !== undefined && DESK_TOOL_NAMES.includes(bare)) return true
    // 官方网页工具由 dsh 那棵树自己挂（`dsh-tool-web`），不经宿主执行器
    if (WEB_TOOL_NAMES.includes(name)) return true
    if (options.devTools !== undefined && devToolNames(role_id).includes(name)) return true
    return source.executes(name)
  }

  const executeTool: ToolExecutor | undefined =
    executeToolRaw === undefined
      ? undefined
      : async (call) => {
          const watch = runWatch.get(call.request.id)
          watch?.watchdog.touch()
          const res = await executeToolRaw(call)
          watch?.watchdog.touch()
          // WP251（决策 91）：工具回「没连上 / 缺凭据」——在这一轮上记结构化标记
          const why = blockedByTool(res)
          if (why !== undefined)
            noteBlocked(watch?.blocks, bareOf(call.name), why, call.request.actor.role_id)
          // WP324：缺一步设置 / 缺一样能就地连的（结构化：`needs_setup` / `needs_connection` / 建站与管店的 `needs`）
          // WP390：AI 查到了哪一项工坊服务（收尾时挂推荐卡用）
          if (bareOf(call.name) === FIND_SERVICE_TOOL && res.status === 'ok') {
            const first = (res.data as { services?: { id?: unknown }[] } | undefined)?.services?.[0]
            if (typeof first?.id === 'string' && !foundServices.has(call.request.id))
              foundServices.set(call.request.id, first.id)
          }
          const setupNeed = why === undefined ? setupNeedOf(bareOf(call.name), res) : undefined
          if (setupNeed !== undefined) watch?.blocks.noteSetup(bareOf(call.name), setupNeed)
          watch?.log.hostTool({
            tool: bareOf(call.name),
            input: call.input,
            status: res.status,
            ...(res.data === undefined ? {} : { data: res.data }),
          })
          return res
        }

  /**
   * WP472：这次运行实际用的那个模型的窗口——这件事自己选了 AI 就是它，否则是 purpose `run` 那条（拿不到回 `undefined`）。
   */
  const contextWindowFor = (pinned: ModelRef | undefined): number | undefined => {
    const ref = pinned ?? options.runModelRef?.() ?? options.modelRef?.()
    return ref === undefined ? undefined : options.contextWindow?.(ref)
  }

  const directAdapter = (): RuntimeAdapter =>
    createDirectRuntime({
      gateway: withToolChoice({
        complete: (r) => options.models.complete(r),
        embed: (t, meta, model) => options.models.embed(t, meta, model),
        usage: (f) => options.models.usage(f),
        budget: (s) => options.models.budget(s),
      }),
      clock,
      seed,
      createDraft,
      // WP232：边界选择题三条运行时一致（以前 direct 这一档没接，服务端 direct 从来不问）
      createPolicyQuestion,
      // WP472（决策 1550）：压缩线按模型窗口定（拿不到按 64K）
      contextWindowOf: (req) =>
        contextWindowFor(req.runtime.model_pinned === true ? req.runtime.model : undefined),
      ...(executeTool === undefined ? {} : { executeTool }),
    })
  const stubAdapter = (): RuntimeAdapter =>
    createStubRuntime({
      clock,
      seed,
      createDraft,
      createPolicyQuestion,
      ...(executeTool === undefined ? {} : { executeTool }),
    })
  /** 两个运行时各建一次（懒），每次运行按「现在有没有模型」挑一个。 */
  const memo = <T>(make: () => T): (() => T) => {
    let v: T | undefined
    return () => {
      if (v === undefined) v = make()
      return v
    }
  }
  const direct = memo(directAdapter)
  const stub = memo(stubAdapter)
  const current = (): RuntimeAdapter => (useDirect() ? direct() : stub())
  const adapter: RuntimeAdapter = {
    get name() {
      return current().name
    },
    capabilities: () => current().capabilities(),
    run: (req, sink, signal) => current().run(req, sink, signal),
    health: () => current().health(),
  }

  /**
   * WP179：官方网页那一层交给 dsh 运行时的三样——凭据（现取）、审计、用量。
   *
   * - 审计：一次工具调用一条 `web.searched` / `web.fetched`（查询或网址、结果条数 / 状态码、成败），
   *   **正文一个字都不进**事件日志；
   * - 用量：官方搜索每真打一次 DeepSeek（一条查询 = 一次完整的模型回合）就照 `model.usage` 补记一笔
   *   （purpose `web_search`，provider 标明账号还是 key），用量页按 purpose 汇总看得到；
   *   这笔钱是用户自己的 DeepSeek 账号 / key 付的，**工坊不扣积分**（`cost_base` 0，不动预算）。
   */
  const dshWebOf = (web: RunWebOptions) => ({
    // WP353：后端 = 工坊内置浏览器（DeepSeek 自带搜索不再挂，凭据不再往下给）
    ...(web.browser === undefined
      ? {}
      : {
          backend: {
            search: async (query: string, maxResults?: number, request?: RunRequest) => {
              /*
               * WP355（决策 937）：带上这次运行的模型来源——名单里的（ChatGPT 订阅）先用它自带的搜索，
               * 不行再走 WP353 的链（判名单、退回都在 web-browser 那一层）。
               */
              const r = await (web.browser as RunWebBrowser).search(
                query,
                maxResults,
                request === undefined
                  ? undefined
                  : {
                      source: request.runtime.model.provider,
                      model: request.runtime.model.model,
                      person_id: request.actor.person_id,
                    },
              )
              const used = r.native_usage
              if (used !== undefined && request !== undefined) {
                // 订阅不按 token 收钱：照 WP179 的口径补记一笔（`cost_base` 0、不动预算），用量页看得到
                options.models.recordExternal?.({
                  meta: {
                    workspace_id,
                    assignment_id: request.actor.assignment_id,
                    role_id: request.actor.role_id,
                    run_id: request.id,
                    purpose: 'web_search',
                  },
                  model: { provider: request.runtime.model.provider, model: used.model },
                  usage: {
                    input_tokens: used.input_tokens,
                    output_tokens: used.output_tokens,
                    cached_tokens: used.cached_tokens,
                  },
                })
              }
              return {
                sources: r.sources,
                truncated: r.truncated,
                ...(r.content === undefined || r.content === '' ? {} : { content: r.content }),
              }
            },
            fetch: (url: string) => (web.browser as RunWebBrowser).fetch(url),
            fetchHosts: web.browser.fetchHosts,
          },
        }),
    ...(web.searchBaseUrl === undefined ? {} : { searchBaseUrl: web.searchBaseUrl }),
    onUse: (use: WebUse, request: RunRequest) => {
      const actor = { kind: 'agent' as const, id: request.actor.assignment_id, run_id: request.id }
      const correlation = {
        trace_id: `trc_run_${request.id}`,
        run_id: request.id,
        ...(request.work_item === undefined ? {} : { work_item_id: request.work_item.id }),
      }
      const who = { run_id: request.id, role_id: request.actor.role_id }
      if (use.kind === 'search_usage') {
        options.models.recordExternal?.({
          meta: {
            workspace_id,
            assignment_id: request.actor.assignment_id,
            role_id: request.actor.role_id,
            run_id: request.id,
            purpose: 'web_search',
          },
          model: {
            provider: use.credential === 'deepseek_api_key' ? 'deepseek' : 'deepseek-account',
            model: use.model,
          },
        })
        return
      }
      if (use.kind === 'search') {
        options.appendEvent({
          schema_version: 1,
          workspace_id,
          type: 'web.searched',
          actor,
          correlation,
          payload: {
            ...who,
            queries: use.queries,
            results: use.results,
            ok: use.ok,
            ...(request.web?.credential === undefined
              ? {}
              : { credential: request.web.credential }),
            ...(use.error === undefined ? {} : { error: use.error }),
          },
        })
        return
      }
      options.appendEvent({
        schema_version: 1,
        workspace_id,
        type: 'web.fetched',
        actor,
        correlation,
        payload: {
          ...who,
          url: use.url,
          ...(use.status === undefined ? {} : { status: use.status }),
          ...(use.truncated === undefined ? {} : { truncated: use.truncated }),
          ok: use.ok,
          ...(use.error === undefined ? {} : { error: use.error }),
        },
      })
    },
  })

  /*
   * WP144 / WP148：带 `computer_use` **或** `browser` 的运行走 **dsh 运行时**——官方电脑操控
   * 提供方与浏览器提供方（Playwright / BrowserSkill）都只在那一条路上挂（`dsh-adapter` 的
   * `harness.ts`，顺序 mount → 门禁 → 浏览器 → 电脑操控，两样都在场就同一棵树挂两样）。
   * 只在有模型时才建（没模型的 stub 档本来就驱动不了浏览器和电脑），而且只给这两种运行用：
   * 别的运行照旧 direct，一个字节不变。
   */
  const dshAdapterOnce =
    options.dshAllRuns === true ||
    options.computerUse !== undefined ||
    options.browser !== undefined ||
    options.web !== undefined
      ? memo(() =>
          createDshRuntime({
            gateway: { complete: (r) => options.models.complete(r) },
            /*
             * WP362（决策 938）：ChatGPT 订阅的运行也经网关走——网关里接了订阅那一跳（服务进程里的
             * 订阅登录树），凭据不进这次运行那棵树，子进程档也一样。
             */
            subscriptionRoute: 'gateway',
            clock,
            seed,
            ...(options.dshMode === undefined ? {} : { mode: options.dshMode }),
            /*
             * WP236：子进程档自己的看门狗只当兜底（取设置页允许的最大值）——每次运行真正的线
             * 由 `startRun` 里的看门狗按职责阈值 / 设置管，经 `signal` 带原因停。
             */
            idleTimeoutMs: RUN_IDLE_TIMEOUT_RANGE.max * 1000,
            maxDurationMs: RUN_MAX_DURATION_RANGE.max * 1000,
            createDraft,
            createPolicyQuestion,
            requestComputerUse,
            /*
             * WP147：这次运行的模型就是现在的默认模型、而且验证过能看图，才声明图片输入。
             * 换了模型名（`RunRequest.runtime.model` 与默认不是同一个）一律不声明——
             * 结论只认测的正是这个模型的那一次（WP127 同一条规矩）。
             */
            imageInput: (model) =>
              declaresImageInput(options.modelVision?.(), options.modelRef?.(), model),
            ...(executeTool === undefined ? {} : { executeTool }),
            // WP179：服务端执行器接的工具，读写分类与 direct 那条路对齐（见 HOST_TOOL_EFFECTS）
            sideEffects: HOST_TOOL_EFFECTS,
            // WP179：官方网页工具的凭据（现取）、审计与用量回报
            ...(options.web === undefined ? {} : { web: dshWebOf(options.web) }),
          }),
        )
      : undefined
  /** 有模型、且装配时给了浏览器 / 电脑操控才有 dsh 那条路（没模型的替身档驱动不了它们）。 */
  const dshAdapter = (): RuntimeAdapter | undefined =>
    dshAdapterOnce !== undefined && useDirect() ? dshAdapterOnce() : undefined

  /**
   * 事项现场 → ContextItem[]（37 §2.2b：摘要 + pinned 记录，围栏与出处照旧）。
   *
   * WP472（docs/116 §6 A / C）：按 `orderContextItems` 的先后给——之前的对话原文（只往后加）→ 钉住的记录 →
   * 事项摘要 → 岗位状态 → 这一次的话；设置快照、时间由 `buildRequest` 接在后面。三个运行时都按同一张表排，
   * 每次都变的（摘要、岗位状态、时间）排在后面、走用户消息那一层，前面那些字节才吃得上缓存。
   */
  const contextOf = async (
    matter: Matter,
    brief: string,
    position: { position_id?: string; person_id: PersonId },
    historyBudget: number,
  ): Promise<ContextItem[]> => {
    const items: ContextItem[] = []
    // WP472（决策 1551）：这件事之前的对话原文（人的话 + 岗位的回复；附件只留占位；太长一次折一大截）。
    // 读不出时间线（没接事项库）就不带——历史是锦上添花，不拦这次运行
    let events: MatterEvent[] = []
    try {
      events = work?.store.listMatterEvents(matter.id) ?? []
    } catch {
      events = []
    }
    const history = matterHistoryItem({
      matter_id: matter.id,
      events,
      budgetTokens: historyBudget,
    })
    if (history !== undefined) items.push(history)
    for (const ref of matter.context.pinned) {
      // WP53：真环境的记录源可能要现去拉一张订单，回的是 Promise——等它
      const record = await source.record?.(ref)
      const label = source.label?.(ref)
      const content = canonical(record ?? { ref, label })
      items.push({
        id: `pin_${ref.type}_${ref.id}`,
        kind: KIND_BY_REF[ref.type] ?? 'summary',
        source_ref: ref,
        sensitivity: 'internal',
        content,
        bytes: bytesOf(content),
      })
    }
    const summary = matter.context.summary.trim()
    // WP259：「交给它」那一大段原文既是事项描述又是这次的任务文本——一样的就只给一份（下面 brief 那条）
    if (summary !== '' && summary !== brief.trim()) {
      const content = canonical({ title: matter.title, status: matter.status, summary })
      items.push({
        id: `matter_${matter.id}`,
        kind: 'matter_summary',
        source_ref: { type: 'matter', id: matter.id },
        sensitivity: 'internal',
        content,
        bytes: bytesOf(content),
      })
    }
    /*
     * WP69（54 §3）岗位层上下文："这个岗位现在什么情况"（数字块与告警的结论、岗位下进行中事项的标题与阶段）。
     * WP472：它几乎每次运行都变（待定的卡数、进行中的事），所以排在事项摘要**后面**、时间之前（以前排第一条，
     * 一变后面全不命中）。
     *
     * 19 §3 的过滤照旧：`layerContext` 只看**这个岗位**下的分配，别的岗位的数据
     * 一个字都进不来。
     */
    if (position.position_id !== undefined && positions !== undefined) {
      const layer = await positions.layerContext(position.position_id, position.person_id)
      if (layer !== undefined) {
        const content = canonical(layer)
        items.push({
          id: `position_${position.position_id}`,
          kind: 'summary',
          source_ref: { type: 'position', id: position.position_id },
          // 21 §3：岗位层只到 internal（54 安全纪律的最后一条）
          sensitivity: 'internal',
          content,
          bytes: bytesOf(content),
        })
      }
    }
    const brief_content = canonical({ subject: matter.title, participants: [], text: brief })
    items.push({
      id: `brief_${matter.id}`,
      kind: 'thread',
      source_ref: { type: 'matter', id: matter.id },
      sensitivity: 'internal',
      content: brief_content,
      bytes: bytesOf(brief_content),
    })
    return items
  }

  /** WP179：这条职责这一次的 `RunRequest.web`（不给 = 没有网页工具）。 */
  const webFor = (roleWeb: EffectiveWeb | undefined): RunWeb | undefined => {
    const opt = options.web
    if (roleWeb === undefined || opt === undefined || !useDirect()) return undefined
    // WP353：搜索要有内置浏览器那一套后端（DeepSeek 自带搜索不再挂，没后端就不摆 web_search）
    const search =
      roleWeb.tools.includes('web_search') &&
      opt.searchEnabled() &&
      opt.browser?.available() === true
    const fetch = roleWeb.tools.includes('web_fetch')
    if (!search && !fetch) return undefined
    const locale = search ? opt.localeLine?.() : undefined
    return {
      search,
      fetch,
      max_searches: roleWeb.max_searches,
      max_fetches: roleWeb.max_fetches,
      ...(locale === undefined ? {} : { search_locale: locale }),
    }
  }

  const buildRequest = async (input: {
    run_id: string
    matter: Matter
    brief: string
    person_id: PersonId
    assignment_id: AssignmentId
  }): Promise<RunRequest> => {
    const effective = roles.effectiveConfig(input.assignment_id)
    // WP342：这件事自己选的 AI（输入框左下角那个钮）；认不出就跟品牌默认走
    const pinnedModel =
      input.matter.model === undefined ? undefined : options.modelOverride?.(input.matter.model)
    // WP370：连同模型一起选的思考程度（模型现在还有这一档才带上）
    const pinnedEffort =
      pinnedModel === undefined ||
      input.matter.model === undefined ||
      input.matter.model_effort === undefined ||
      options.modelEffort?.(input.matter.model, input.matter.model_effort) !== true
        ? undefined
        : input.matter.model_effort
    /*
     * WP216：平台专属的官方技能只在品牌平台对得上时留下（每次现取档案）。
     * 一本都没被滤掉时 `config` 就是原来那一份——非平台技能的职责字节一个不变。
     */
    const gatePlatform = options.storefrontPlatform
    const platform = gatePlatform?.()
    const skillsHere =
      gatePlatform === undefined
        ? effective.skills
        : effective.skills.filter((s) => skillOnPlatform(s.name, platform))
    const config =
      skillsHere.length === effective.skills.length
        ? effective
        : { ...effective, skills: skillsHere }
    /*
     * WP69（54 §1 / §3）：这次运行属于哪个岗位。
     *
     * 事项上显式记了就用它（岗位入口开的那些）；没记就按职责反查——
     * **一条职责挂在多个岗位里、或者一个岗位都不挂时反查不出来**，那就跳过
     * `position` 层并在时间线说一句（54 §3 原话）。不猜一个：猜错了等于把
     * 别的岗位攒的规矩喂给这次运行。
     */
    const positionHit =
      input.matter.position_template_id !== undefined
        ? { position_id: input.matter.position_template_id }
        : // WP234：带上分配 id——安放了就按安放算（docs/54 §6.1）
          (positions?.positionOf(config.role_id, input.assignment_id) ?? {})
    if (positionHit.position_id === undefined && positionHit.note !== undefined) {
      work?.appendEvent(input.matter.id, {
        kind: 'status',
        text: positionHit.note,
        actor: { kind: 'system', id: 'runtime' },
        run_id: input.run_id,
      })
    }
    /*
     * WP117（66 断点 #1）：红人那五条职责的**工具面**。
     *
     * 以前 `allow` 只有 grounding 点名的那两个（`search_creators` / `search_policies`）
     * 加四个客服默认工具——于是「让红人岗位找人」这件事，模型手里一个能干活的工具
     * 都没有，只能拿客服的凑。十一个红人工具在 `kol-core` 的目录里，
     * 判据只有 `role_id`（`kol.*`），所以回放时算得出同一份清单。
     */
    /*
     * WP162：解析技能的「我是谁」（always 正文、按需索引、`read_skill` 三处用同一份），
     * 以及这条职责登记的**按需**技能索引。索引里有东西，工具面里才摆出 `read_skill`——
     * 模型不该看见调不动的工具；一本都没有的职责，工具面与提示词字节一个不变。
     */
    const skillActor: SkillPromptActor = {
      person_id: input.person_id,
      workspace_id,
      ...(positionHit.position_id === undefined ? {} : { position_id: positionHit.position_id }),
      role_id: config.role_id,
    }
    const skillIndex =
      options.skills === undefined
        ? []
        : await onDemandSkillIndex({
            // WP420（自查 B11）：要 Amazon 官方卖家连接（SP-API）的那几本，没连上就不进可加载清单
            skills: usableSkills(config.skills, {
              amazonSeller: (await options.amazonSellerConnected?.(workspace_id)) === true,
            }),
            actor: skillActor,
            registry: options.skills,
          })
    skillActors.set(input.run_id, skillActor)
    /** WP320：「记忆」那一段（技能正文里已有的不重复列；取不到就不出，不让整次运行失败）。 */
    const memorySection =
      options.memory === undefined
        ? undefined
        : await Promise.resolve(
            options.memory.section(
              {
                person_id: input.person_id,
                workspace_id,
                ...(positionHit.position_id === undefined
                  ? {}
                  : { position_id: positionHit.position_id }),
                role_id: config.role_id,
              },
              config.skills.filter((s) => s.load !== 'on_demand').map((s) => s.name),
            ),
          ).catch(() => undefined)
    /*
     * WP179：这条职责的官方网页工具（职责 YAML 的 `web_tools`）。三件事都成立才给：
     * 服务端接了网页那一层、有模型（没模型的替身档驱动不了它）、职责挂了；
     * 搜索另要两件：设置里「用你的 DeepSeek 账号搜索」没关、手上有凭据（账号登录优先，其次官方 key）。
     */
    const web = webFor(config.web)
    // WP181：装了官方「自动化任务」插件才挂那四个工具（每次运行现问）
    const automationOn =
      options.automation === undefined ? false : await options.automation.enabled()
    /** WP253：网页模板（带主题工具）的运行。WP260：它是「要产出东西」的长活（见 `THEME_PRODUCE`）。 */
    const themeRun = isThemeRole(config.role_id) && options.themeTools !== undefined
    /** WP261：店铺授权过、这条职责登记了的运营工具（每次运行现问：授权过期了下一次运行就没有）。 */
    const shopNames =
      options.shopTools === undefined
        ? []
        : await options.shopTools.offered(config.role_id).catch(() => [] as string[])
    /** WP268：生图配了、这条职责能出图（设计岗 / 网页模板）才有（每次运行现问）。 */
    const imageNames =
      options.imageTools === undefined
        ? []
        : await options.imageTools.offered(config.role_id).catch(() => [] as string[])
    const allow = [
      ...new Set([
        ...config.grounding.map((g) => g.tool),
        // WP162：有按需技能可读，才有读技能的工具
        ...(skillIndex.length > 0 ? [READ_SKILL_TOOL] : []),
        /*
         * WP260（10-07 真机 ci.16）：网页模板不摆订单 / 商品那四个只读工具——店铺没连时一调就是
         * `not_connected`，白花一轮；搭页面时主推商品先放占位，由人在主题编辑器里挑。
         */
        ...(themeRun ? [] : DEFAULT_TOOLS),
        ...devToolNames(config.role_id),
        ...(isKolRole(config.role_id) ? KOL_TOOL_NAMES : []),
        // WP153：店主才有「列岗位 / 列连接」这两个只读工具
        ...(isOwnerRole(config.role_id) && options.ownerTools !== undefined
          ? OWNER_TOOL_NAMES
          : []),
        // WP176：主动开发才有开发信那三个工具（列序列 / 开一轮 / 分回信）
        ...(isB2bOutboundRole(config.role_id) && options.b2bOutboundTools !== undefined
          ? B2B_OUTBOUND_TOOL_NAMES
          : []),
        // WP316：Google / Meta 投放职责才有改广告那两个工具（提一批只出卡 / 列账本）
        ...(isAdsWiredRole(config.role_id) && options.adsTools !== undefined ? ADS_TOOL_NAMES : []),
        // WP253：网页模板才有那九个受限主题工具（不是终端；发布只出卡）
        ...(isThemeRole(config.role_id) && options.themeTools !== undefined
          ? THEME_TOOL_NAMES
          : []),
        // WP261：独立站运营工具（授权过才有；网页模板只给读商品 / 合集，选合集 / 挂商品用）
        ...shopNames,
        // WP268：生图 / 改图 / 素材库
        ...imageNames,
        // WP179：官方网页工具（只有真给了的那几个）
        ...(web?.search === true ? [WEB_SEARCH_TOOL] : []),
        ...(web?.fetch === true ? [WEB_FETCH_TOOL] : []),
        // WP246：能抓网页的职责也能要「干净正文」（本机抽取，不经第三方；接了研究工具执行器才给）
        ...(web?.fetch === true && options.researchTools !== undefined ? [READ_WEBPAGE_TOOL] : []),
        ...(automationOn ? SCHEDULE_TOOL_NAMES : []),
        // WP323：记录去处（所有职责；接了发出记录才有）
        ...(options.recordSinkTools === undefined ? [] : RECORD_SINK_TOOL_NAMES),
        // WP441：一句话写消息规则（所有职责；接了消息规则才有）
        ...(options.messageRuleTools === undefined ? [] : MESSAGE_RULE_TOOL_NAMES),
        // WP331：报告积木（查发出记录 / 发布报告所有职责；查巡查 / 立即巡查只给担巡查的职责）
        ...(options.reportTools === undefined
          ? []
          : REPORT_TOOL_NAMES.filter((n) => {
              const competitor = options.reportTools?.competitorRoles?.has(config.role_id) === true
              // WP392：竞品变化表只给担竞品监控的职责
              if (COMPETITOR_TOOL_NAMES.includes(n)) return competitor
              return (
                !WATCH_TOOL_NAMES.includes(n) ||
                competitor ||
                options.reportTools?.watchRoles.has(config.role_id) === true
              )
            })),
        // WP315：投放岗看数据（只给 `ads.*`；服务端接了才有）
        // WP447：只读的六个新平台只给两个只读工具（不给插件导出、不给止损）
        ...(options.adsDataTools !== undefined ? adsDataToolsFor(config.role_id) : []),
        // WP396：Listing 体检（只给亚马逊店铺运营；服务端接了才有）
        ...(isAmazonListingRole(config.role_id) && options.amazonListingTools !== undefined
          ? AMAZON_LISTING_TOOL_NAMES
          : []),
        // WP398：Amazon 词库（只给亚马逊店铺运营；服务端接了才有）
        ...(isAmazonKeywordRole(config.role_id) && options.amazonKeywordTools !== undefined
          ? AMAZON_KEYWORD_TOOL_NAMES
          : []),
        // WP334：AI 自己要连接卡 / 配置卡（所有职责）
        ...(options.setupRequestTool === undefined ? [] : SETUP_REQUEST_TOOL_NAMES),
        // WP385：读网站体检结论（只给店铺管理、内容与搜索；服务端接了才有）
        ...(isSiteHealthRole(config.role_id) && options.siteHealthTools !== undefined
          ? SITE_HEALTH_TOOL_NAMES
          : []),
        // WP419：社媒发帖 / Reddit 起草出卡（按职责：Reddit 两条、社媒内容账号几条；服务端接了才有）
        ...(options.socialWorkTools === undefined ? [] : socialWorkToolsFor(config.role_id)),
        // WP387：信息监控交代建 / 读 Google 提醒的结果（服务端接了才有）
        ...(config.role_id === GOOGLE_ALERTS_ROLE && options.googleAlertsTool !== undefined
          ? GOOGLE_ALERTS_TOOL_NAMES
          : []),
        // WP390：工坊服务（所有职责）
        ...(options.workshopServices === undefined ? [] : WORKSHOP_SERVICE_TOOL_NAMES),
        // WP393：店铺管理「竞品动向」（探平台 / 现在读一次；只给店铺管理）
        ...(options.competitorStoreTools !== undefined &&
        COMPETITOR_STORE_ROLES.includes(config.role_id)
          ? COMPETITOR_STORE_TOOL_NAMES
          : []),
        // WP394：亚马逊店铺运营「竞品动向」（现在读一次；只给亚马逊店铺运营）
        ...(options.amazonCompetitorTools !== undefined &&
        AMAZON_COMPETITOR_ROLES.includes(config.role_id)
          ? AMAZON_COMPETITOR_TOOL_NAMES
          : []),
        // WP421：公关 / 内容与搜索 / B2B / 设计的读数与起草工具（按职责那一张表给；服务端接了才有）
        ...(options.deskTools === undefined ? [] : deskToolsFor(config.role_id)),
      ]),
    ]
      .filter((name) => offerable(name, config.role_id))
      .sort()
    const connect_token = (await source.readToken?.(input.assignment_id)) ?? ''
    const vertical = options.vertical?.()
    // WP82：这条职责的域名白名单（职责模板的 `browser_scope`）。岗位路由已经把
    // 这次运行落到**一条**职责上了，所以这里就是那一条的白名单，不做并集。
    const allowed_hosts = [...new Set(config.browser_scope)]
    // WP86：这条职责登记了哪几台 MCP 服务器（凭据只有引用名，没有值）
    const connections = options.connections?.(config.role_id) ?? []
    const browser = allowed_hosts.length === 0 ? undefined : options.browser?.()
    // WP144：这条职责能不能操作电脑、这件事有没有一次批过的授权（有就当场用掉）
    const computer_use = options.computerUse?.forRun({
      role_id: config.role_id,
      matter_id: input.matter.id,
    })
    const granted = computer_use?.granted_until !== undefined
    // WP387：这件事有没有一趟同意过、还在跑的「改 Google 提醒」（有才给凭据）
    const browser_grants =
      options.browserGrants?.({ role_id: config.role_id, matter_id: input.matter.id }) ?? []
    // WP237（#67）：按条计费的工具（现在只有 read_reddit）每次运行按价目现填单价
    const tool_prices: Record<string, number> = {}
    if (options.toolPrice !== undefined)
      for (const name of allow.filter((n) => RESEARCH_TOOL_NAMES.includes(n))) {
        const price = await options.toolPrice(name).catch(() => undefined)
        if (price !== undefined && Number.isFinite(price) && price > 0) tool_prices[name] = price
      }
    return {
      id: input.run_id,
      schema_version: 1,
      workspace_id,
      kind: 'work_item',
      actor: {
        person_id: input.person_id,
        assignment_id: input.assignment_id,
        role_id: config.role_id,
      },
      // 17 §1：`work_item` 就是这个 Matter（37 §2.2b 正名）
      work_item: {
        id: input.matter.id,
        conversation_id: input.matter.id,
        role_id: config.role_id,
      },
      trigger: { event_id: input.run_id, source: 'manual' },
      // WP472：先后按 `orderContextItems`（三个运行时同一张表；请求里也照它排，事件与回放一眼看得出）
      context: orderContextItems([
        ...(await contextOf(
          input.matter,
          input.brief,
          {
            ...(positionHit.position_id === undefined
              ? {}
              : { position_id: positionHit.position_id }),
            person_id: input.person_id,
          },
          // 替身档不问模型窗口（没接模型，不该去碰「这次落到哪条来源」）
          historyBudgetFor(useDirect() ? contextWindowFor(pinnedModel) : undefined),
        )),
        /*
         * WP180：「现在时间 + 公司时区」，每次运行写一次（排在事项材料后面：它每小时一变，
         * 放后面让前面那些字节稳定的部分多吃缓存）。为什么不挂官方 `dsh-time-context` 见 `@agentsws/core` 的
         * `time-context.ts` 头注释。
         */
        // WP410：当前设置快照（这条职责登记了才有；读不出就不带，不拦这次运行）
        ...[await options.setupState?.({ role_id: config.role_id }).catch(() => undefined)].filter(
          (c): c is ContextItem => c !== undefined,
        ),
        ...(options.timeZone === undefined
          ? []
          : [timeContextItem({ now: clock.now(), companyTz: await options.timeZone() })]),
      ]),
      // WP236：没接上的工具，grounding 提示里也不提
      grounding: config.grounding.filter((g) => offerable(g.tool, config.role_id)),
      // 16 §3：公司端 write_external 一律经执行器，运行时拿不到写口
      tools: { allow, connect_token, side_effect_policy: 'executor' },
      skills: config.skills,
      persona: {
        sections: [
          /*
           * WP122b（71 §5 / §9 第 7 条）：**品牌设计规范**——设计 / 建站 / 社媒 /
           * 投放四族职责出活时注进提示词的那一段。取值口是注入的、**每次现取**
           * （同 `images?()` 的理由：用户在设计规范页改一格，下一次运行就得照新的来）；
           * 没有规范（`present: false`）就整段不出，**不注一个空节**。
           * 出图那条路（`design.ts` 的 `generateVariants`）另有逐图注入，那里已通电，
           * 所以这一段只补建站 / 社媒 / 投放三条。
           */
          ...(options.brandDesign === undefined
            ? []
            : [options.brandDesign(config.role_id)].filter(
                (s): s is PromptSection => s !== undefined,
              )),
          // WP333：客服回信起草带上品牌话术（与社媒同一个 `voicePrompt`；没写过话术就不出）
          ...[
            await options
              .brandVoice?.({ role_id: config.role_id, skills: config.skills, actor: skillActor })
              .catch(() => undefined),
          ].filter((s): s is PromptSection => s !== undefined),
          /*
           * WP120（69 §3）：**角色定位**——品牌 → 岗位 → 职责，排在技能正文前面。
           *
           * 接了 `personaSections` 就走它（叠过公司层覆盖、空段不出、三个运行时
           * 拿到逐字相同的那几段）。没接时退回老行为：只有职责那一节，取包里的原文。
           *
           * 岗位那一节用的是上面 `positionHit` 算出来的那一个——反查不出唯一岗位时
           * 它是 `undefined`，于是整段不出（54 §3「不猜一个」）。
           */
          ...(options.personaSections !== undefined
            ? options.personaSections({
                role_id: config.role_id,
                ...(positionHit.position_id === undefined
                  ? {}
                  : { position_id: positionHit.position_id }),
              })
            : config.persona === undefined
              ? []
              : [
                  {
                    id: 'role',
                    name: config.role_id,
                    order: 20,
                    text: personaTextIn(config.persona, 'zh'),
                  },
                ]),
          // WP284（决策 275）：这条职责的规矩（人点过通过的「以后都这样」），紧跟职责角色定位（order 21）
          ...[options.roleRules?.(config.role_id)].filter(
            (s): s is PromptSection => s !== undefined,
          ),
          /*
           * WP226（69 §3.3）：**回复语言**——persona 一律送中文那份（中文是唯一手写的真源），
           * 紧跟一句「对外用对方来信的语言、对内用界面语言」（order 22）。服务端还没有
           * "工作区界面语言"这一格（69 §3.3），所以按中文界面送中文那句。
           * 三个运行时拿到同一份字节：stub / direct 走 `assemblePrompt`，dsh 写进唯一的 complete 段。
           */
          replyLanguageSection('zh'),
          /*
           * WP153（09-26 真账号冒烟）：**所有职责的公共段**——对人说话不提工具名、函数名、内部 id。
           * 排在职责那一节后面、技能前面（order 25）。三个运行时拿到的是同一份字节。
           */
          houseRulesSection('zh'),
          // WP320：记忆（这几层现有的 + 记忆规矩，order 26）。没装配记忆就一个字节不多
          ...(memorySection === undefined ? [] : [memorySection]),
          /*
           * WP264（决策 179）：**下一步建议**——交代末尾有明确下一步就单独一行 `<next>…</next>`，
           * 宿主进时间线前取出来记在 `next_suggestion` 上（事项页按 Tab 收下）。所有职责同一份，紧跟公共段。
           */
          // WP407（决策 1179）：原文在公共规矩表（`section: next_step`），与契约 NEXT_SUGGESTION_RULE 逐字节相同
          nextSuggestionSection('zh'),
          /*
           * WP291（决策 356）：**当场问答**——岗位页上一问一答就完的那一次：只查只答，末尾附 ```answer
           * 组件段（宿主取出来按契约校验，岗位页画成「一句话 + 表格 / 数字」）。别的运行一个字节不多。
           */
          /*
           * WP336（Luoye 10-15 扩大范围）：**所有**事项 / 线程运行都带一段精简的 ```dsh-ui 写法（回给人看的正文
           * 里可以放组件，对外内容里不用）；当场问答那次换成它自己那段完整的。三个运行时拿到同一份字节。
           */
          /*
           * WP472（docs/116 §2 第 7 条）：这两段二选一，在当场问答和交办之间来回切——排在技能正文前面时一切换
           * 后面的技能正文、索引全不命中，所以挪到技能索引（90）之后（`GENUI_SECTION_ORDER`），内容不变。
           */
          ...(input.matter.ask?.quick === true
            ? []
            : [
                {
                  id: 'genui_display',
                  name: '回话里的组件',
                  order: GENUI_SECTION_ORDER,
                  text: GENUI_DISPLAY_RULE,
                },
              ]),
          ...(input.matter.ask?.quick === true
            ? [
                {
                  id: 'quick_answer',
                  name: '当场问答',
                  order: GENUI_SECTION_ORDER,
                  // WP336：教 ```dsh-ui（dsh-genui 写法；决策 823 不留 ```answer 回退）
                  text: QUICK_ANSWER_RULE,
                },
              ]
            : []),
          // WP260：网页模板的做法（读一次 → 改模板与设置 → 检查 → 推未发布；中途不汇报）。只给带主题工具的运行
          ...(themeRun ? [themeWorkSection({ shopRead: shopNames.length > 0 })] : []),
          // WP268：网页模板摆了生图工具时多一段「配图的做法」（没摆的运行一个字节不多）
          ...(themeRun && imageNames.length > 0 ? [imageWorkSection()] : []),
          /*
           * 24 §1 + WP69（54 §1）：解析后的技能正文——**六层**叠加完的那一份
           * （包 → 公司 → 部门 → 岗位 → 职责 → 个人）。
           *
           * 岗位入口的 Run 带岗位层 + 被路由到的那条职责层；职责入口的 Run 也带
           * 它所属岗位的岗位层（`positionHit` 上面算好了）。哪一层没有东西，
           * 那一层就是空的——`resolve` 查不到就跳过，不报错。
           */
          ...(options.skills === undefined
            ? []
            : await skillPromptSections({
                skills: config.skills,
                actor: skillActor,
                registry: options.skills,
              })),
          /*
           * WP162：**可用技能索引**——按需技能只列名字 + 一句说明（排在全部技能正文之后，
           * order 90）；要用哪一本由模型调 `read_skill` 读。没有一本可读就整段不出。
           */
          ...[skillIndexSection(skillIndex, READ_SKILL_TOOL)].filter(
            (x): x is PromptSection => x !== undefined,
          ),
        ],
      },
      /*
       * WP144：批过授权的那一次运行，工具调用上限从 12 放到 40——操作桌面是"看一眼、点一下、
       * 再看一眼"，12 次连一个小任务都做不完。时间与花费上限不动。
       * 09-24（WP148 报告第 1 条，Fable 定）：真挂了浏览器的运行同理，放到 30——
       * 打开、截图、翻页、再截图，12 次不够一个小任务；比电脑操控低，因为它不需要逐像素找按钮。
       */
      budget: {
        // token / 工具调用上限按运行挂了什么定（见 `runBudgetCaps`）
        ...runBudgetCaps({
          themeRun,
          granted,
          browsing: (browser !== undefined && allowed_hosts.length > 0) || web !== undefined,
        }),
        // WP236：与看门狗的总时长线对齐（原来固定 120 秒，direct 档跑满就收）
        max_seconds: timeLimitsFor(config.role_id).max_duration_seconds,
        max_cost_base: 5,
      },
      // 变更仍走各自的管线（渠道 / 执行器）；事项里的一次运行只出草稿与提案
      expectations: { outputs: ['draft', 'answer'], must_stage_if_change_requested: false },
      runtime: {
        preset: config.role_id,
        profile: 'server',
        plugins: [],
        model:
          pinnedModel ??
          (useDirect()
            ? (options.modelRef?.() ?? { provider: 'deepseek', model: 'default', region: 'cn' })
            : { provider: 'stub', model: 'default', region: 'cn' }),
        seed,
        ...(pinnedModel === undefined ? {} : { model_pinned: true as const }),
        ...(pinnedEffort === undefined ? {} : { reasoning_effort: pinnedEffort }),
      },
      // 48 v2 L2：客服共享包按它取人设、词表、业务边界与追问措辞
      ...(vertical === undefined ? {} : { vertical }),
      /*
       * WP82（55 §3）：浏览器。两件事都得成立才真开——
       *
       * 1. **这台机器配了浏览器**（设置页那一节；没配就是 `undefined`）；
       * 2. **这条职责填了 `browser_scope`**（白名单是"允许"表，空 = 开不了）。
       *
       * 少一件就不给 `browser`，于是 provider 根本不挂、工具面里一个 `browser_*`
       * 都没有。这比"挂上了但每次都拒"好：模型看不见调不动的工具（同 WP44 的
       * Dev MCP 那条纪律）。
       */
      ...(browser === undefined || allowed_hosts.length === 0 ? {} : { browser, allowed_hosts }),
      /*
       * WP86（55 §4 第三层）：这条职责的 MCP 连接。空数组不写进去——
       * 老的运行记录里没有这个字段，回放出来必须还是"一台都没有"。
       */
      ...(connections.length === 0 ? {} : { connections }),
      // WP144：不给就不写这个字段——老的运行记录回放出来仍是「碰不到电脑」
      ...(computer_use === undefined ? {} : { computer_use }),
      // WP387：只有挂了浏览器、这件事有同意过的卡时才写（不写 = 受保护页面上的写一律拦）
      ...(browser === undefined || browser_grants.length === 0 ? {} : { browser_grants }),
      // WP179：同上——不给就不写，没挂网页工具的运行 RunRequest 一个字节不变
      ...(web === undefined ? {} : { web }),
      // WP237：取不到价就不写这个字段（描述里只说「按条计积分」），老运行的请求一个字节不变
      ...(Object.keys(tool_prices).length === 0 ? {} : { tool_prices }),
      // WP260：网页模板是要产出东西的长活（没产出就续跑、压缩按 token 阈值）；别的运行不写这个字段
      ...(themeRun ? { produce: THEME_PRODUCE } : {}),
      idempotency_key: `idem_${input.run_id}`,
    }
  }

  const startRun: StartRun = async (input) => {
    const run_id = newId('run')
    const request = await buildRequest({
      run_id,
      matter: input.matter,
      brief: input.brief,
      person_id: input.actor.person_id,
      assignment_id: input.actor.assignment_id,
    }).catch((err: unknown) => {
      // WP162：装配半路失败，开跑前登记的「我是谁」也要摘掉（收尾那一段走不到）
      skillActors.delete(run_id)
      throw err
    })
    /*
     * WP150：登记成「正在跑」。controller 以前只给电脑操控的「停止」用，现在任何一次运行都能被停
     * （DeepSeek 账号登出 / 登录失效时停掉正在用这个账号跑的那几件事）。
     */
    const controller = new AbortController()
    let settle: () => void = () => undefined
    // WP341：记下这次运行是谁、哪条分配（之后对话里点它出的按钮按这次的身份与读过的算）
    runActors.set(run_id, {
      matter_id: input.matter.id,
      person_id: input.actor.person_id,
      assignment_id: input.actor.assignment_id,
    })
    if (runActors.size > 500) runActors.delete(runActors.keys().next().value ?? '')
    active.set(run_id, {
      view: {
        run_id,
        matter_id: input.matter.id,
        title: input.matter.title,
        person_id: input.actor.person_id,
        assignment_id: input.actor.assignment_id,
        // 没接模型（stub）时就是 stub：不会被当成"在用某个账号跑"
        // WP342：这件事自己选了 AI 就是它（不是 purpose 那条）
        model:
          useDirect() && request.runtime.model_pinned !== true
            ? (options.runModelRef?.() ?? request.runtime.model)
            : request.runtime.model,
      },
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
    })
    /** WP373（决策 978）：这次是哪个模型答的（进 `agent_message`；替身档不记）。 */
    const used = active.get(run_id)?.view.model
    const replyModel = (): { model?: string } =>
      used === undefined || used.provider === 'stub'
        ? {}
        : { model: `${used.provider}/${used.model}` }
    const byId = new Map(request.context.map((c) => [c.id, c]))
    const seen: ObjectRef[] = []
    scope = {
      run_id,
      matter: input.matter,
      brief: input.brief,
      person_id: input.actor.person_id,
      assignment_id: input.actor.assignment_id,
      seen,
      ...(input.todo_id === undefined ? {} : { todo_id: input.todo_id }),
    }
    const answers: string[] = []
    /*
     * WP117b（66 复测 #16）：**同一句话只进时间线一次**。
     *
     * 一次运行的答复会从两个口子回来：`run.completed` 事件里的 `outputs`（sink 收到的）
     * 与 `adapter.run` 的返回值（`result.outputs`）。三个运行时都是两边都给同一份，
     * 于是两边都 push 的话，时间线上那条 `agent_message` 里同一段话会出现两遍
     * ——用户看到的就是"Agent 把话说了两遍"。
     *
     * 不改成只认其中一边：哪一边都有适配器可能不给（回放档只走事件、直连档只给返回值）。
     * 收口在这里：**逐字相同的一段只留第一次**。
     */
    /** WP320：答复里模型写的 `<remember>`（进时间线之前从正文里拿掉，跑完交给自动记忆）。 */
    const remembered: RememberItem[] = []
    const addAnswer = (raw: string): void => {
      const split = options.memory === undefined ? { text: raw, items: [] } : splitRememberTags(raw)
      for (const item of split.items)
        if (!remembered.some((r) => r.text === item.text)) remembered.push(item)
      const text = split.text
      if (answers.includes(text)) return
      answers.push(text)
    }
    /** WP320：摘要里也不留 `<remember>`（摘要会落到事项的「到哪了」上）。 */
    const cleanSummary = (raw: string): string =>
      options.memory === undefined ? raw : splitRememberTags(raw).text
    let summary = ''
    /*
     * WP236：**没动静才停**。三个运行时档都认 `signal`，所以看门狗放在这一层统一管：每个事件、
     * 每次宿主工具调用都续命；连续空闲到线、或跑满总时长，就带着原因 abort（`run.cancelled.reason`）。
     */
    const limits = timeLimitsFor(request.actor.role_id)
    const runLog = new PartialRunLog()
    const runBlocks = new RunBlockLog()
    /** WP251：`tool.result` 只带 call_id——按 `tool.call` 认回是哪个工具。 */
    const callTools = new Map<string, string>()
    const watchdog = createRunWatchdog({
      idleMs: limits.idle_timeout_seconds * 1000,
      maxMs: limits.max_duration_seconds * 1000,
      onFire: (reason) => controller.abort(reason),
    })
    runWatch.set(run_id, { watchdog, log: runLog, blocks: runBlocks })
    // WP264：步骤记录（事项页「正在做…」与跑完那一行灰字）
    const steps = new RunStepLog(nowMs())
    const runStartedAt = clock.now()
    runSteps.set(run_id, { matter_id: input.matter.id, started_at: runStartedAt, log: steps })
    /** WP423：这次是哪一项预算到了（`budget.exhausted`；第一次那条为准）。 */
    let budgetHit: MatterRunDigest['budget']
    /** WP264：跑完 / 停下 / 没跑成都记一条运行摘要（排在 AI 那段话前面）。 */
    const recordDigest = (outcome: 'completed' | 'stopped' | 'failed', budget?: boolean): void => {
      try {
        const byBudget = budget === true && budgetHit !== undefined ? budgetHit : undefined
        // 记成 `status`（不是 `run`）：「跑了几次」仍只数开跑那一条
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text:
            outcome === 'completed'
              ? '跑完了'
              : outcome === 'stopped'
                ? pausing.has(run_id)
                  ? '因更新暂停'
                  : byBudget !== undefined
                    ? // WP423：预算停的说人话原因（「查的东西太多，这一轮先停在这里」）
                      budgetStopReason(byBudget)
                    : '这次被停下了'
                : '这次没跑成',
          actor: { kind: 'agent', id: input.actor.assignment_id },
          run_id,
          run_digest: {
            ...steps.digest(outcome, nowMs()),
            ...(byBudget === undefined ? {} : { budget: byBudget }),
          },
        })
      } catch {
        // 事项已经没了：摘要只是给人看的一行，少一条不影响别的
      }
      // WP429：告诉跑它的人一声（站内通知；跑得久的跑完了、停下了、没跑成）
      try {
        const reason =
          outcome !== 'stopped'
            ? undefined
            : pausing.has(run_id)
              ? 'update'
              : budgetHit !== undefined
                ? 'budget'
                : (watchdog.fired() ?? cancelledReason ?? cancelReasonOf(controller.signal))
        options.onRunEnded?.({
          run_id,
          matter_id: input.matter.id,
          matter_title: input.matter.title,
          person_id: input.actor.person_id,
          outcome,
          ...(reason === undefined ? {} : { reason }),
          started_at: runStartedAt,
          ended_at: clock.now(),
        })
      } catch {
        // 通知发不出不影响运行
      }
    }
    /** WP251：这一轮卡住了就在时间线上记一条带结构化标记的（收尾时调一次）。 */
    const recordBlocked = async (): Promise<void> => {
      const raw = runBlocks.block()
      if (raw === undefined) return
      // WP324（决策 690）：出一张连接卡 / 配置卡（同一缺项不重复出），补完由宿主按原话接着跑
      let out: { item: ApprovalItem; attach: boolean } | undefined
      try {
        out = await options.setupCards?.onRunBlocked({
          run_id,
          matter_id: input.matter.id,
          actor: request.actor,
          block: raw,
          needs: runBlocks.connectNeeds(),
          targets: runBlocks.setupTargets(),
          ...runBlocks.asked(),
        })
      } catch {
        // 出卡没成：照老样子只记一句（人仍能在第三栏 / 连接页补上）
      }
      const card = out?.item
      const block = card === undefined ? raw : { ...raw, card_id: card.id }
      try {
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text: blockedLine(
            block,
            card === undefined ? undefined : (card.payload as { research_failed?: string }),
          ),
          actor: { kind: 'system', id: 'runtime' },
          run_id,
          blocked: block,
        })
      } catch {
        // 事项已经没了
      }
      // 卡挂进事项时间线（排在那一句后面）；这件事已经挂着这张卡就不再挂
      if (card === undefined || out?.attach !== true) return
      if (card.subject.matter_id === input.matter.id) backfill(card)
      else
        work?.appendEvent(input.matter.id, {
          kind: 'card',
          text: card.title,
          actor: { kind: 'agent', id: run_id },
          approval_item_id: card.id,
          run_id,
        })
    }
    let cancelledReason: RunCancelReason | undefined
    /** WP287：运行时报的失败（`run.failed`）——收尾时据此在时间线上说「没跑成」，不再写「跑完了」。 */
    let failure: { code: string; message: string; retryable: boolean } | undefined
    /** WP287：没跑成的那一句（人话 + 结构化标记，界面据此出「重试」）。原始错误只在事件日志里。 */
    const recordFailure = (error: { code: string; message: string; retryable: boolean }): void => {
      recordDigest('failed')
      try {
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text: runFailureLine(error),
          actor: { kind: 'system', id: 'runtime' },
          run_id,
          failed: { code: error.code, retryable: error.retryable },
        })
      } catch {
        // 事项已经没了
      }
    }
    const sink = (e: RunEvent): void => {
      watchdog.touch()
      if (e.type === 'text.delta') runLog.text(e.text)
      // WP251：不经宿主执行器的工具（底座自己挂的）回「没连上 / 缺凭据」也记一笔
      if (e.type === 'tool.call') {
        callTools.set(e.call_id, bareOf(e.tool))
        steps.call(e.call_id, e.tool, e.input, nowMs())
      }
      if (e.type === 'tool.result') steps.result(e.call_id, e.status, nowMs())
      if (e.type === 'tool.result' && e.status !== 'ok') {
        const why = blockReasonOf(e.reason)
        if (why !== undefined)
          noteBlocked(runBlocks, callTools.get(e.call_id) ?? 'tool', why, request.actor.role_id)
        else {
          const tool = callTools.get(e.call_id) ?? 'tool'
          const setupNeed = setupNeedOf(tool, {
            status: e.status,
            ...(e.reason === undefined ? {} : { reason: e.reason }),
          })
          if (setupNeed !== undefined) runBlocks.noteSetup(tool, setupNeed)
        }
      }
      if (e.type === 'run.cancelled')
        cancelledReason = e.reason ?? cancelReasonOf(controller.signal)
      if (e.type === 'run.failed') failure ??= e.error
      if (e.type === 'budget.exhausted') budgetHit ??= e.which
      /*
       * WP425：这一轮从自己的 AI 切到了工坊积分——对话（事项时间线）里照实一行
       * 「你的 ChatGPT 额度用完了，这一轮用工坊积分」；运行记录（事件日志）里那条 progress 照记。
       */
      if (e.type === 'progress' && e.step === MODEL_SOURCE_SWITCHED_STEP && e.note !== undefined) {
        try {
          work?.appendEvent(input.matter.id, {
            kind: 'status',
            text: e.note,
            actor: { kind: 'system', id: 'runtime' },
            run_id,
          })
        } catch {
          // 事项已经没了
        }
      }
      appendRunEvent(request, e)
      // 15 §6 provenance：只证明「读过」——注入的记录与工具真回来的实体
      if (e.type === 'context.injected') {
        const ref = byId.get(e.item_id)?.source_ref
        if (
          ref !== undefined &&
          typeof ref !== 'string' &&
          !seen.some((r) => refKey(r) === refKey(ref))
        )
          seen.push(ref)
      }
      if (e.type === 'tool.result' && e.status === 'ok') {
        for (const ref of e.provenance_added ?? [])
          if (!seen.some((r) => refKey(r) === refKey(ref))) seen.push(ref)
      }
      if (e.type === 'run.completed') {
        summary = cleanSummary(e.summary)
        for (const out of e.outputs) if (out.kind === 'answer') addAnswer(out.text)
      }
    }
    try {
      /*
       * WP144：批过授权的这一次运行登记成「正在操作这台电脑」——托盘变色、第三栏一行；
       * 点「停止」就中断这次运行（dsh 那棵树 dispose，驱动随之断开）。
       */
      const cu = request.computer_use
      // WP148：开了浏览器的运行同样走 dsh（只有那棵树上挂得了浏览器提供方）
      // WP179：挂了官方网页工具的运行也走 dsh（官方 `web_search` / `web_fetch` 只在那棵树上挂）
      // WP290：装包前冒烟要每一次都走 dsh（`dshAllRuns`）
      const needsDsh =
        options.dshAllRuns === true ||
        cu !== undefined ||
        request.browser !== undefined ||
        request.web !== undefined
      const dsh = needsDsh ? dshAdapter() : undefined
      const runner = dsh ?? adapter
      if (cu?.granted_until !== undefined) {
        options.computerUse?.activate(
          {
            run_id,
            role_id: request.actor.role_id,
            matter_id: input.matter.id,
            until: cu.granted_until,
            ...(cu.grant_id === undefined ? {} : { grant_id: cu.grant_id }),
          },
          () => controller.abort('user' satisfies RunCancelReason),
        )
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text: `AI 正在操作这台电脑（授权到 ${cu.granted_until.slice(11, 16)}，随时可以点「停止」）`,
          actor: { kind: 'system', id: 'runtime' },
          run_id,
        })
      }
      let result: Awaited<ReturnType<RuntimeAdapter['run']>>
      try {
        result =
          options.aroundRun === undefined
            ? await runner.run(request, sink, controller.signal)
            : await options.aroundRun(request.actor, () =>
                runner.run(request, sink, controller.signal),
              )
      } finally {
        options.computerUse?.deactivate(run_id)
        watchdog.stop()
      }
      summary = cleanSummary(result.summary)
      for (const out of result.outputs) if (out.kind === 'answer') addAnswer(out.text)
      /*
       * WP236：**停下来要让人看见、已经干的不丢**。原因按看门狗 → 运行时报的 → signal 的顺序认；
       * 时间线先一句人话，再把模型说过的话 + 已经取回的数据摘要作为部分结果挂上（带「接着跑」）。
       * 摘要也写进事项（下一次「接着跑」的上下文里就有已经查到的东西）。
       */
      // 运行时自己报「做完了」（停的信号到之前最后一跳刚好收完）就照做完算
      const stoppedReason =
        result.status === 'cancelled' ||
        (controller.signal.aborted && result.status !== 'completed')
          ? (watchdog.fired() ?? cancelledReason ?? cancelReasonOf(controller.signal))
          : undefined
      if (stoppedReason !== undefined) {
        // 过程话已经在 `text.delta` 里攒着；答复只在它没覆盖到时补上（不说两遍）
        const said = runLog.said()
        const extra = answers
          .filter((a) => !said.includes(a.trim()))
          .join('\n')
          .trim()
        const digest = runLog.digest()
        const partial =
          digest === undefined
            ? extra === ''
              ? undefined
              : extra
            : extra === ''
              ? digest
              : `${extra}\n\n${digest}`
        const line = pausing.has(run_id)
          ? pausedForUpdateLine(partial !== undefined)
          : stoppedLine(stoppedReason, limits, partial !== undefined)
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text: line,
          actor: { kind: 'system', id: 'runtime' },
          run_id,
          ...(partial === undefined ? { stopped: { reason: stoppedReason } } : {}),
        })
        // WP264：停下的原因那一句在前，做到哪几步的摘要紧跟着（部分结果在后）
        recordDigest('stopped')
        if (partial !== undefined) {
          work?.appendEvent(input.matter.id, {
            kind: 'agent_message',
            // WP264：停下来的那段话不给下一步建议，标记照样拿掉
            text: splitNextSuggestion(humanizeToolNames(partial, request.tools.allow)).text,
            actor: { kind: 'agent', id: input.actor.assignment_id },
            run_id,
            stopped: { reason: stoppedReason },
            ...replyModel(),
          })
        }
        await recordBlocked()
        work?.onRunCompleted({
          matter_id: input.matter.id,
          run_id,
          summary:
            partial === undefined
              ? line
              : `${line}\n${humanizeToolNames(partial, request.tools.allow).slice(0, 1200)}`,
          session_ref: result.session_ref,
        })
        return { run_id }
      }
      /*
       * WP287（Luoye 10-09 真机）：运行时回 `failed`（工具参数表不认、模型调不通、格式异常…）时
       * 以前照「跑完了」记——界面上看不出失败。现在说「没跑成：<人话>」+ 重试；摘要不落到事项上。
       */
      if (result.status === 'failed') {
        const error = failure ?? { code: 'internal', message: result.summary, retryable: true }
        /*
         * WP334（决策 726）：用 DeepSeek 账号跑、账号登录过期 / 没登录（`unauthenticated`）→ 出连接卡，
         * 卡里就地重新登录，登好按原话接着做（不再叫人去「设置 → 模型」）。
         */
        if (
          error.code === 'unauthenticated' &&
          active.get(run_id)?.view.model.provider === DEEPSEEK_ACCOUNT_RUN_PROVIDER
        )
          runBlocks.noteSetup('model', { kind: 'connect', need: DEEPSEEK_ACCOUNT_NEED })
        /*
         * WP362（决策 938）：用 ChatGPT 订阅跑、没登录 / 登录过期 / 被限流 → 同样出连接卡，卡里就地
         * 重新登录（或换个账号），登好按原话接着做。dsh 那一档的模型错不带码，认网关那几句人话。
         */
        if (
          active.get(run_id)?.view.model.provider === SUBSCRIPTION_SOURCE_ID &&
          (error.code === 'unauthenticated' ||
            error.code === 'rate_limited' ||
            error.message.includes('ChatGPT 订阅'))
        )
          runBlocks.noteSetup('model', { kind: 'connect', need: CHATGPT_SUBSCRIPTION_NEED })
        /*
         * WP425：自己的 AI 用不了、开关「自己的用不了时用工坊积分接着做」关着——照实停下，并在对话里出
         * 「用工坊积分接着做」那张卡（配置卡：点一下打开开关、按原话接着做；决策 690）。三个运行时同一句话。
         */
        if (isSourceFallbackOffText(error.message))
          runBlocks.noteSetup('model', { kind: 'setup', target: MODEL_FALLBACK_CLOUD_TARGET })
        recordFailure(error)
        await recordBlocked()
        // 事项的「到哪了」：运行时写的那句（登录过期、格式异常…本来就是人话）；内部错的原文可能带
        // 参数表 / 堆栈，换成通用人话。会话引用照落，「接着跑」续得上
        work?.onRunCompleted({
          matter_id: input.matter.id,
          run_id,
          summary: error.code === 'internal' ? runFailureText(error) : result.summary,
          session_ref: result.session_ref,
        })
        return { run_id }
      }
      // 37 §2.2b：Agent 说的话进时间线；摘要与会话引用由 onRunCompleted 落到事项上
      // WP287：额度 / 回合用完停下的，摘要那一行写「被停下了」，不写「跑完了」
      // WP423：预算停的那一行写人话原因，收尾那段话下面出「接着做」（`run_digest.budget`）
      recordDigest(result.status === 'budget_exhausted' ? 'stopped' : 'completed', true)
      /*
       * WP264（决策 179）：下一步建议——运行时结构化给的优先，否则取答复末尾的 `<next>…</next>`；
       * 标记从正文里拿掉。没有就没有，不从正文里猜。
       */
      const said = splitNextSuggestion(humanizeToolNames(answers.join('\n'), request.tools.allow))
      const next = cleanNextSuggestion(result.next_suggestion) ?? said.next
      if (answers.length > 0 && said.text.trim() !== '') {
        /*
         * WP390（docs/105 §4）：推荐卡——挂不挂、挂哪一项问服务（后台不推、同一对话一项只推一次、说过「不用」不推）。
         * 取不到就不挂，不影响这一段话。
         */
        const found = foundServices.get(run_id)
        const offer = await options.workshopServices
          ?.offer?.({
            request,
            matter_id: input.matter.id,
            ...(found === undefined ? {} : { found }),
          })
          .catch(() => undefined)
        work?.appendEvent(input.matter.id, {
          kind: 'agent_message',
          ...(offer === undefined ? {} : { service_offer: offer }),
          /*
           * WP153（09-26 真账号冒烟）：**兜底**——提示词公共段已经叫模型别提工具名，万一还是说了
           * （「我用 `search_policies` 查了三轮」），进时间线之前按那张统一的「工具名 → 人话」表换掉；
           * 这次运行摆出来的、表里没有的工具名也不露（说「一个工具」）。事件日志里的原文不动。
           */
          text: said.text,
          actor: { kind: 'agent', id: input.actor.assignment_id },
          run_id,
          ...(next === undefined ? {} : { next_suggestion: next }),
          ...replyModel(),
        })
      }
      await recordBlocked()
      work?.onRunCompleted({
        matter_id: input.matter.id,
        run_id,
        summary: splitNextSuggestion(summary).text,
        session_ref: result.session_ref,
      })
      /*
       * WP320：跑完了才记（停下 / 失败的不记）。记忆写不进去不影响这次运行的结果——
       * 小提醒那边照实没有，事件日志里也没有那一条。
       */
      const memoryActor = skillActors.get(run_id)
      if (
        options.memory !== undefined &&
        memoryActor !== undefined &&
        result.status === 'completed'
      )
        await options.memory
          .afterRun({
            run_id,
            matter_id: input.matter.id,
            actor: {
              person_id: memoryActor.person_id,
              workspace_id: memoryActor.workspace_id,
              ...(memoryActor.position_id === undefined
                ? {}
                : { position_id: memoryActor.position_id }),
              role_id: memoryActor.role_id ?? request.actor.role_id,
            },
            brief: input.brief,
            items: remembered,
            // 替身 / 回放档可能根本不给这一格
            ...(Array.isArray(result.memory_candidates) && result.memory_candidates.length > 0
              ? { runtime: result.memory_candidates }
              : {}),
          })
          .catch(() => undefined)
    } catch (err) {
      // WP287：原始错误进本机事件日志（排障用），时间线上只说人话 + 重试
      const raw = {
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      }
      try {
        appendRunEvent(request, { type: 'run.failed', error: raw })
      } catch {
        // 事件日志写不进去也不影响给人看的那一句
      }
      recordFailure(raw)
      await recordBlocked()
    } finally {
      watchdog.stop()
      scope = undefined
      active.delete(run_id)
      pausing.delete(run_id)
      skillActors.delete(run_id)
      runWatch.delete(run_id)
      foundServices.delete(run_id)
      runSteps.delete(run_id)
      settle()
    }
    return { run_id }
  }

  /** WP341：工具结果里出的审批卡 id（各执行器回的形状不一：顶层 / `data` 里、单个 / 一串）。 */
  const approvalIdsOf = (x: unknown, depth = 0): string[] => {
    if (depth > 3 || x === null || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const own = [o.approval_item_id, o.approval_id, o.card_id].filter(
      (v): v is string => typeof v === 'string',
    )
    const many = Array.isArray(o.approval_item_ids)
      ? o.approval_item_ids.filter((v): v is string => typeof v === 'string')
      : []
    const nested = Object.values(o).flatMap((v) => approvalIdsOf(v, depth + 1))
    return [...new Set([...own, ...many, ...nested])]
  }

  const runHostTool: NonNullable<RuntimeAssembly['runHostTool']> = async ({
    matter_id,
    person_id,
    fallback_assignment_id,
    call,
  }) => {
    const refused = (message: string): GenuiToolOutcome => ({
      effect: 'refused',
      status: 'blocked',
      message,
    })
    const matter = work?.getMatter(matter_id)
    if (matter === undefined || executeTool === undefined) return refused('这里点不了这个。')
    const from = call.run_id === undefined ? undefined : runActors.get(call.run_id)
    const own = from !== undefined && from.matter_id === matter_id ? from : undefined
    const run_id = own === undefined ? newId('run') : (call.run_id as string)
    const assignment_id = own?.assignment_id ?? fallback_assignment_id
    const request = await buildRequest({
      run_id,
      matter,
      brief: call.label,
      person_id: own?.person_id ?? person_id,
      assignment_id,
    }).finally(() => {
      if (!active.has(run_id)) skillActors.delete(run_id)
    })
    const role_id = request.actor.role_id
    const bare = bareOf(call.tool)
    if (!inAllowlist(call.tool, request.tools.allow) || !offerable(call.tool, role_id))
      return refused('这条职责没有这一步，交给 AI 去做吧。')
    // 直接写外部的不收（各执行器自己出卡的那些是 local / staged：只动本机或出卡）
    const effect = HOST_TOOL_EFFECTS[bare] ?? classifySideEffect(bare)
    if (effect === 'write_external')
      return refused('这一步会直接改外部，交给 AI 去做（它会先出卡）。')
    const res = await executeTool({ name: call.tool, input: call.args, request })
    const found = await Promise.all(
      approvalIdsOf(res.data).map(async (id) => ({
        id,
        item: approvals.get === undefined ? null : await approvals.get(id),
      })),
    )
    const cards = found.filter((f) => f.item !== undefined)
    const ids = cards.map((f) => f.id)
    const said = (text: string): void => {
      try {
        work?.appendEvent(matter_id, {
          kind: 'status',
          text,
          actor: { kind: 'system', id: 'runtime' },
          run_id,
        })
      } catch {
        // 事项已经没了
      }
    }
    if (ids.length > 0) {
      said(`你点了「${call.label}」：出了 ${String(ids.length)} 张卡，批了才做。`)
      const onLine = new Set(
        work?.store
          .listMatterEvents(matter_id, { limit: 500 })
          .map((e) => e.approval_item_id)
          .filter((id) => id !== undefined),
      )
      for (const { id, item } of cards) {
        if (onLine.has(id)) continue
        work?.appendEvent(matter_id, {
          kind: 'card',
          text: item?.title ?? call.label,
          actor: { kind: 'agent', id: run_id },
          approval_item_id: id,
          run_id,
        })
      }
      return { effect: 'staged', status: res.status, approval_item_ids: ids }
    }
    if (res.status === 'ok') said(`你点了「${call.label}」，查好了。`)
    return {
      effect: 'read',
      status: res.status,
      ...(res.data === undefined ? {} : { data: res.data }),
      ...(res.reason === undefined ? {} : { message: res.reason }),
    }
  }

  return {
    adapter,
    runHostTool,
    activeRuns: () => [...active.values()].map((r) => ({ ...r.view })),
    noteNeed(run_id, need) {
      runWatch.get(run_id)?.blocks.noteSetup('model', { kind: 'connect', need })
    },
    async stopRun(run_id, reason, waitMs = 10_000) {
      const hit = active.get(run_id)
      if (hit === undefined) return false
      work?.appendEvent(hit.view.matter_id, {
        kind: 'status',
        text: reason,
        actor: { kind: 'system', id: 'runtime' },
        run_id,
      })
      hit.controller.abort('user' satisfies RunCancelReason)
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        hit.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs)
          timer.unref()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return true
    },
    async pauseRun(run_id, waitMs = 10_000) {
      const hit = active.get(run_id)
      if (hit === undefined) return false
      pausing.add(run_id)
      hit.controller.abort('user' satisfies RunCancelReason)
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        hit.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs)
          timer.unref()
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return true
    },
    liveRun(matter_id) {
      const hits = [...runSteps.entries()].filter(([, r]) => r.matter_id === matter_id)
      const last = hits[hits.length - 1]
      if (last === undefined) return undefined
      const [run_id, r] = last
      // WP287：AI 到现在说了的话（流式出现在会话线程里；跑完以时间线上那条为准）
      const said = runWatch.get(run_id)?.log.said().trim() ?? ''
      return {
        run_id,
        started_at: r.started_at,
        steps: r.log.live(),
        ...(said === '' ? {} : { text: splitNextSuggestion(humanizeToolNames(said, [])).text }),
      }
    },
    bind(w) {
      work = w
    },
    bindPositions(source) {
      positions = source
    },
    startRun,
  }
}

/**
 * 一次职责运行的 token / 工具调用上限（时间与花费另算）。
 *
 * - 缺省 15 万 token、12 次（WP423：原来 6 万）；
 * - WP144：批过电脑操控授权的 40 次、60 万 token；WP148 / WP179：真挂了浏览器或网页工具的 30 次、40 万 token（WP423）；
 * - 10-07 真机（Fable）：网页模板（带主题工具）一轮读主题规矩 / 目录 / 模板 / 区块就十几次调用、
 *   七万多 token，旧上限连第一页都没改到就「预算不够」停了——放到 40 万 token、60 次；
 *   WP260：再放到 80 万 token、40 回合（见下）。
 */
/**
 * WP472：「回话里的组件 / 当场问答」那一段的排序号——技能索引（90）、记忆（92）之后，
 * 让会切换的段落排在不变的技能正文后面（以前是 28）。
 */
export const GENUI_SECTION_ORDER = 95

export function runBudgetCaps(input: { themeRun: boolean; granted: boolean; browsing: boolean }): {
  max_tokens: number
  max_tool_calls: number
  max_turns?: number
} {
  /*
   * WP260（ci.16）：工具调用放到 60 次之后，真正先到的是**回合**上限（运行时缺省 8 回合，一回合读三四个文件）
   * ——8 回合到了就停在一句「现在读…」。网页模板的回合放到 40（一回合至少一次调用，60 次调用的上限仍在）。
   * token 放到 80 万：这是**累计**输入（每回合把整段历史再送一遍，大半是缓存命中）。WP260 回放一轮 10 回合
   * 约 16 万、历史峰值 2.2 万；真模型回合多一倍、历史压到 4.8 万阈值附近时，40 万会在推预览之前用完。
   * 花费另有 `max_cost_base` 兜底。
   */
  if (input.themeRun) return { max_tokens: 800_000, max_tool_calls: 60, max_turns: 40 }
  /*
   * WP423（10-19 Mac 自测）：查 subreddit 的运行 12 步、累计 6.96 万 token 就撞上 6 万停了（实际只花了约 0.012 元，
   * 缓存命中 4.99 万）——这一格是**累计**输入（每回合把整段历史再送一遍），不是「这次读了多少」。
   * 照 WP260 的算法按「步数 × 每步历史」估：
   *
   * - 查资料 / 浏览（30 次调用、约 31 步）：每步历史从提示词的 6 千左右涨到二三万（网页摘要、帖子列表），
   *   平均按 1.2 万算 ≈ 37 万——放到 **40 万**；
   * - 批过授权的电脑操控（40 次、41 步，带截图）：平均按 1.4 万算 ≈ 57 万——放到 **60 万**；
   * - 其余（12 次调用、8 回合）：8 步 × 每步一万出头就过了 6 万（自测里普通问答 5 步就到 3 万）——放到 **15 万**。
   *
   * 真正的护栏是花费（`max_cost_base`，按价目表算、命中缓存的那部分很便宜）：40 万 token 在 DeepSeek 上大半是缓存，
   * 约一两毛钱；token 上限只防「死循环把历史越滚越大」。到了也不是白停——运行时再跑一次收尾，把查到的交出来。
   */
  if (input.granted) return { max_tokens: 600_000, max_tool_calls: 40 }
  if (input.browsing) return { max_tokens: 400_000, max_tool_calls: 30 }
  return { max_tokens: 150_000, max_tool_calls: 12 }
}

/**
 * WP260：网页模板这类「读一批文件再改」的运行怎么跑（`RunRequest.produce`，三个运行时同一口径）。
 *
 * - 成功推出未发布预览（`theme_push_unpublished`）或出了发布卡（`theme_publish`）= 产出了；之前模型回一句
 *   「我接下来要…」不算完成，追加「接着做」再跑一回合，最多 3 次；
 * - 模型面前的历史超过 4.8 万 token 才压（以前是 min(上限×0.6, 1.2 万)，几乎每步都压），压到七成为止；
 *   最近 6 条工具结果不压（刚读完、马上要照着改的那几份），压掉的换成「读过哪个文件 + 要点」。
 *   4.8 万：真主题一轮要读的（AGENTS.md ≈ 3 千、目录页 ≈ 4 千、几项完整设置 ≈ 8 千、模板 / 设置 ≈ 1 千 token）
 *   （WP301 起是店里的 Horizon：没有 AGENTS.md，瘦目录 CATALOG.index.json ≈ 3 千、几项完整设置 ≈ 1 万 token，量级不变）
 *   加上提示词，正常一轮不会压；也远在模型的上下文窗口之内。
 */
export const THEME_PRODUCE: RunProduce = {
  deliver_tools: [THEME_PUSH_TOOL, THEME_PUBLISH_TOOL],
  max_nudges: 3,
  compact_at_tokens: 48_000,
  keep_recent_results: 6,
}

/** WP420（自查 B11）：要 Amazon 官方卖家连接（SP-API）的技能（官方 12 本，统一 `amazon-sp-` 前缀）。 */
export const SP_API_SKILL_RE = /^amazon-sp-/u

/** 这次运行能读的技能：要 SP-API 的那几本，没连上就拿掉（工具不在手边，读了只能说做不了）。 */
export function usableSkills<T extends { name: string }>(
  skills: readonly T[],
  ctx: { amazonSeller: boolean },
): T[] {
  return ctx.amazonSeller ? [...skills] : skills.filter((s) => !SP_API_SKILL_RE.test(s.name))
}
