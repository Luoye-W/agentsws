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
  ContextItem,
  CreateApprovalInput,
  EffectiveWeb,
  EventEnvelope,
  GateDecision,
  Matter,
  MatterRunBlock,
  ModelRef,
  ObjectRef,
  PersonId,
  PromptSection,
  RunBrowser,
  RunConnection,
  RunEvent,
  RunRequest,
  RunTimeLimits,
  RuntimeAdapter,
  RunWeb,
  StartRun,
  StorefrontPlatform,
  TodoId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import {
  cancelReasonOf,
  createRunWatchdog,
  PLATFORM_KITS,
  platformKitOf,
  platformMcpNeededBy,
  RUN_IDLE_TIMEOUT_RANGE,
  RUN_MAX_DURATION_RANGE,
  type RunCancelReason,
  type RunWatchdog,
  resolveRunTimeLimits,
  skillOnPlatform,
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
import {
  houseRulesSection,
  personaTextIn,
  type RoleStore,
  replyLanguageSection,
} from '@agentsws/roles'
import { createDirectRuntime, withToolChoice } from '@agentsws/runtime-direct'
import type { CreatePolicyQuestionFn, DraftPayload, ToolExecutor } from '@agentsws/stand-ins'
import {
  B2B_OUTBOUND_TOOL_NAMES,
  createStubRuntime,
  humanizeToolNames,
  isB2bOutboundRole,
  isOwnerRole,
  isScheduleTool,
  OWNER_TOOL_NAMES,
  READ_SKILL_TOOL,
  READ_WEBPAGE_TOOL,
  RESEARCH_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
} from '@agentsws/stand-ins'

import { cardRefOf, type Work } from '@agentsws/work'
import type { ComputerUseAssembly } from './computer-use.js'
import { blockedByTool, blockedLine, blockReasonOf, RunBlockLog } from './run-blocked.js'
import { PartialRunLog, stoppedLine } from './run-stop.js'
import { createSkillToolExecutor, isReadSkillTool } from './skill-tools.js'

/**
 * 卡片的出口。类型就是契约的 `CreateApprovalInput`——收件人门禁（31 §3.3）要的
 * `context` 已经在契约里了（WP31 补上 WP24 的后置项），这里不再借宿主包的交叉类型。
 */
export interface ApprovalSink {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
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
    ...OWNER_TOOL_NAMES,
    READ_SKILL_TOOL,
    // WP220：只读 Reddit（`read_` 开头，本来就判得出「读外部」；列进来是为了表上看得见）
    ...RESEARCH_TOOL_NAMES,
    // WP181：官方「自动化任务」的四个工具——只动本机调度器、会往外发的出卡
    ...SCHEDULE_TOOL_NAMES,
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
   * WP236：「设置 → 通用」里的运行时长线（空闲超时 / 总时长上限，秒）。每次运行现问；
   * 职责阈值 `run_idle_timeout_seconds` / `run_max_duration_seconds` 优先，都没有走缺省（3 / 20 分钟）。
   */
  runLimits?(): Partial<RunTimeLimits> | undefined
  /**
   * WP251（决策 91）：这条职责现在**没连上**的连接（人话名，必需的在前；必需的全连上了才列可选的）。
   * 工具回 `not_connected` / 缺凭据时，运行时拿它说清「缺哪个连接」。不给 = 只记卡住了、不说缺哪个。
   */
  missingConnections?(role_id: string): string[]
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
   * WP181：官方「自动化任务」的四个工具（`automation.ts` 建的那一份）。**装了那个官方插件**
   * （`enabled()`，每次运行现问）才进工具面——所有职责都有（给自己建提醒）；会往外发的周期任务
   * 由执行器出卡。没装的运行工具面与提示词字节一个不变。
   */
  automation?: { enabled(): Promise<boolean> | boolean; executeTool: ToolExecutor }
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
  /** 数据接口路由里 `web.search` 那一级（「用你的 DeepSeek 账号搜索」）开着没。每次现问。 */
  searchEnabled(): boolean
  /** 现在搜索用哪种凭据：登录了 DeepSeek 账号 → 账号；否则有 DeepSeek 官方 key → key；都没有 → 不给搜索。 */
  credentialKind(): WebCredentialKind | undefined
  /** 真要搜的那一刻现取凭据值（账号令牌只对官方推理源给值）。 */
  credential(endpoint: string): Promise<WebCredential | undefined>
  /** 搜索口地址（测试指向本机替身；缺省官方地址）。 */
  searchBaseUrl?: string
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
  /** 进 `ApprovalItem.context.gates`：只有门名、结论、规则集哈希，**没有被扫的文本**。 */
  gate_context: GateDecision[]
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

  /**
   * WP162：每次运行解析技能用的「我是谁」（带岗位层）。`read_skill` 按它叠六层——
   * 岗位不在 RunRequest 上，所以开跑前登记、收尾摘掉（与 `active` 同一个生命周期）。
   */
  const skillActors = new Map<string, SkillPromptActor>()

  /**
   * WP236：每次运行的看门狗与现场记录（开跑登记、收尾摘掉，与 `active` 同一个生命周期）。
   * 宿主执行器每调一次工具都给看门狗续命、把回来的数据记一笔——停下来时拼「已经查到的部分」。
   */
  const runWatch = new Map<
    string,
    { watchdog: RunWatchdog; log: PartialRunLog; blocks: RunBlockLog }
  >()
  /** WP251：这一轮撞上「缺连接 / 缺凭据」时记一笔（缺哪个连接按这条职责现查）。 */
  const noteBlocked = (
    blocks: RunBlockLog | undefined,
    tool: string,
    reason: MatterRunBlock['reason'],
    role_id: string,
  ): void => {
    if (blocks === undefined) return
    let connections: string[] = []
    try {
      connections = options.missingConnections?.(role_id) ?? []
    } catch {
      // 连接目录还没装好：只记卡住了，不说缺哪个
    }
    blocks.note(tool, reason, connections)
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
        text: '这一版回信照抄了内部指导的原文，已打回重写。',
        actor: { kind: 'system', id: 'runtime' },
        run_id: s.run_id,
      })
      return { rewrite: verdict.rewrite_instruction ?? '重写一版，不要引用内部指导的原文。' }
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
      title:
        who === undefined
          ? `回复草稿（收件人待定）：${payload.subject}`
          : `回复 ${who}：${payload.subject}`,
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
          : `它想：${input.reason}。允许后它能看屏幕、点、输入；遇到登录、密码、支付、验证码会停下请你来。截图会发给你选的 AI 模型用来看界面，不会存进 Agents 工坊的记录。运行时托盘会变色，随时可以点「停止」。`,
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
    const dev = options.devTools
    const automation = options.automation
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
      dev === undefined &&
      readSkill === undefined &&
      automation === undefined
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
          watch?.log.hostTool({
            tool: bareOf(call.name),
            input: call.input,
            status: res.status,
            ...(res.data === undefined ? {} : { data: res.data }),
          })
          return res
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
    credential: (endpoint: string) => web.credential(endpoint),
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
    options.computerUse !== undefined || options.browser !== undefined || options.web !== undefined
      ? memo(() =>
          createDshRuntime({
            gateway: { complete: (r) => options.models.complete(r) },
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

  /** 事项现场 → ContextItem[]（37 §2.2b：摘要 + pinned 记录，围栏与出处照旧）。 */
  const contextOf = async (
    matter: Matter,
    brief: string,
    position: { position_id?: string; person_id: PersonId },
  ): Promise<ContextItem[]> => {
    const items: ContextItem[] = []
    /*
     * WP69（54 §3）岗位层上下文，排在事项摘要**前面**：它是"这个岗位现在什么情况"，
     * 是背景；事项摘要是"这件事到哪了"，是前景。三样都是摘要级——数字块与告警的
     * 结论、岗位下进行中事项的标题与阶段、持有人忙不忙。
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
    const summary = matter.context.summary.trim()
    if (summary !== '') {
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
    const kind =
      roleWeb.tools.includes('web_search') && opt.searchEnabled() ? opt.credentialKind() : undefined
    const search = kind !== undefined
    const fetch = roleWeb.tools.includes('web_fetch')
    if (!search && !fetch) return undefined
    return {
      search,
      fetch,
      max_searches: roleWeb.max_searches,
      max_fetches: roleWeb.max_fetches,
      ...(kind === undefined ? {} : { credential: kind }),
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
            skills: config.skills,
            actor: skillActor,
            registry: options.skills,
          })
    skillActors.set(input.run_id, skillActor)
    /*
     * WP179：这条职责的官方网页工具（职责 YAML 的 `web_tools`）。三件事都成立才给：
     * 服务端接了网页那一层、有模型（没模型的替身档驱动不了它）、职责挂了；
     * 搜索另要两件：设置里「用你的 DeepSeek 账号搜索」没关、手上有凭据（账号登录优先，其次官方 key）。
     */
    const web = webFor(config.web)
    // WP181：装了官方「自动化任务」插件才挂那四个工具（每次运行现问）
    const automationOn =
      options.automation === undefined ? false : await options.automation.enabled()
    const allow = [
      ...new Set([
        ...config.grounding.map((g) => g.tool),
        // WP162：有按需技能可读，才有读技能的工具
        ...(skillIndex.length > 0 ? [READ_SKILL_TOOL] : []),
        ...DEFAULT_TOOLS,
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
        // WP179：官方网页工具（只有真给了的那几个）
        ...(web?.search === true ? [WEB_SEARCH_TOOL] : []),
        ...(web?.fetch === true ? [WEB_FETCH_TOOL] : []),
        // WP246：能抓网页的职责也能要「干净正文」（本机抽取，不经第三方；接了研究工具执行器才给）
        ...(web?.fetch === true && options.researchTools !== undefined ? [READ_WEBPAGE_TOOL] : []),
        ...(automationOn ? SCHEDULE_TOOL_NAMES : []),
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
      context: [
        ...(await contextOf(input.matter, input.brief, {
          ...(positionHit.position_id === undefined
            ? {}
            : { position_id: positionHit.position_id }),
          person_id: input.person_id,
        })),
        /*
         * WP180：「现在时间 + 公司时区」，每次运行写一次（排在事项材料后面：它每小时一变，
         * 放后面让前面那些字节稳定的部分多吃缓存）。为什么不挂官方 `dsh-time-context` 见 `@agentsws/core` 的
         * `time-context.ts` 头注释。
         */
        ...(options.timeZone === undefined
          ? []
          : [timeContextItem({ now: clock.now(), companyTz: await options.timeZone() })]),
      ],
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
        max_tokens: 60_000,
        /*
         * WP179：挂了网页工具的运行同理放到 30——搜一次、抓两三页、再搜一次，12 次不够；
         * 次数上限另在门禁里按职责阈值管（搜索缺省 5、抓取 10）。
         */
        max_tool_calls: granted
          ? 40
          : (browser !== undefined && allowed_hosts.length > 0) || web !== undefined
            ? 30
            : 12,
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
        model: useDirect()
          ? (options.modelRef?.() ?? { provider: 'deepseek', model: 'default', region: 'cn' })
          : { provider: 'stub', model: 'default', region: 'cn' },
        seed,
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
      // WP179：同上——不给就不写，没挂网页工具的运行 RunRequest 一个字节不变
      ...(web === undefined ? {} : { web }),
      // WP237：取不到价就不写这个字段（描述里只说「按条计积分」），老运行的请求一个字节不变
      ...(Object.keys(tool_prices).length === 0 ? {} : { tool_prices }),
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
    active.set(run_id, {
      view: {
        run_id,
        matter_id: input.matter.id,
        title: input.matter.title,
        // 没接模型（stub）时就是 stub：不会被当成"在用某个账号跑"
        model: useDirect()
          ? (options.runModelRef?.() ?? request.runtime.model)
          : request.runtime.model,
      },
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve
      }),
    })
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
    const addAnswer = (text: string): void => {
      if (answers.includes(text)) return
      answers.push(text)
    }
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
    /** WP251：这一轮卡住了就在时间线上记一条带结构化标记的（收尾时调一次）。 */
    const recordBlocked = (): void => {
      const block = runBlocks.block()
      if (block === undefined) return
      work?.appendEvent(input.matter.id, {
        kind: 'status',
        text: blockedLine(block),
        actor: { kind: 'system', id: 'runtime' },
        run_id,
        blocked: block,
      })
    }
    let cancelledReason: RunCancelReason | undefined
    const sink = (e: RunEvent): void => {
      watchdog.touch()
      if (e.type === 'text.delta') runLog.text(e.text)
      // WP251：不经宿主执行器的工具（底座自己挂的）回「没连上 / 缺凭据」也记一笔
      if (e.type === 'tool.call') callTools.set(e.call_id, bareOf(e.tool))
      if (e.type === 'tool.result' && e.status !== 'ok') {
        const why = blockReasonOf(e.reason)
        if (why !== undefined)
          noteBlocked(runBlocks, callTools.get(e.call_id) ?? 'tool', why, request.actor.role_id)
      }
      if (e.type === 'run.cancelled')
        cancelledReason = e.reason ?? cancelReasonOf(controller.signal)
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
        summary = e.summary
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
      const needsDsh =
        cu !== undefined || request.browser !== undefined || request.web !== undefined
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
      summary = result.summary
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
        const line = stoppedLine(stoppedReason, limits, partial !== undefined)
        work?.appendEvent(input.matter.id, {
          kind: 'status',
          text: line,
          actor: { kind: 'system', id: 'runtime' },
          run_id,
          ...(partial === undefined ? { stopped: { reason: stoppedReason } } : {}),
        })
        if (partial !== undefined) {
          work?.appendEvent(input.matter.id, {
            kind: 'agent_message',
            text: humanizeToolNames(partial, request.tools.allow),
            actor: { kind: 'agent', id: input.actor.assignment_id },
            run_id,
            stopped: { reason: stoppedReason },
          })
        }
        recordBlocked()
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
      // 37 §2.2b：Agent 说的话进时间线；摘要与会话引用由 onRunCompleted 落到事项上
      if (answers.length > 0) {
        work?.appendEvent(input.matter.id, {
          kind: 'agent_message',
          /*
           * WP153（09-26 真账号冒烟）：**兜底**——提示词公共段已经叫模型别提工具名，万一还是说了
           * （「我用 `search_policies` 查了三轮」），进时间线之前按那张统一的「工具名 → 人话」表换掉；
           * 这次运行摆出来的、表里没有的工具名也不露（说「一个工具」）。事件日志里的原文不动。
           */
          text: humanizeToolNames(answers.join('\n'), request.tools.allow),
          actor: { kind: 'agent', id: input.actor.assignment_id },
          run_id,
        })
      }
      recordBlocked()
      work?.onRunCompleted({
        matter_id: input.matter.id,
        run_id,
        summary,
        session_ref: result.session_ref,
      })
    } catch (err) {
      work?.appendEvent(input.matter.id, {
        kind: 'status',
        text: `这次运行没跑成：${err instanceof Error ? err.message : String(err)}`,
        actor: { kind: 'system', id: 'runtime' },
        run_id,
      })
      recordBlocked()
    } finally {
      watchdog.stop()
      scope = undefined
      active.delete(run_id)
      skillActors.delete(run_id)
      runWatch.delete(run_id)
      settle()
    }
    return { run_id }
  }

  return {
    adapter,
    activeRuns: () => [...active.values()].map((r) => ({ ...r.view })),
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
    bind(w) {
      work = w
    },
    bindPositions(source) {
      positions = source
    },
    startRun,
  }
}
