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
 * - 收件人只从「这次运行读过的」里取（31 §3.3），拿不到 ObjectRef 就不建卡；
 * - 时间经 `Clock`、随机经注入的 `random`，没有一处 `Date.now()` / `Math.random()`；
 * - 秘密只从环境变量读，且不进事件日志。
 */
import type {
  ApprovalItem,
  AssignmentId,
  Clock,
  ComputerUseGrantPayload,
  ContextItem,
  CreateApprovalInput,
  EventEnvelope,
  GateDecision,
  Matter,
  ModelRef,
  ObjectRef,
  PersonId,
  PromptSection,
  RunBrowser,
  RunConnection,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
  StartRun,
  TodoId,
  WorkspaceVertical,
} from '@agentsws/contracts'
import { canonicalJson } from '@agentsws/core'
import { createDshRuntime, type DshRuntimeMode } from '@agentsws/dsh-adapter'
import { isKolRole, KOL_TOOL_NAMES } from '@agentsws/kol-core'
import { type SkillResolver, skillPromptSections } from '@agentsws/learning'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { personaTextIn, type RoleStore } from '@agentsws/roles'
import { createDirectRuntime, withToolChoice } from '@agentsws/runtime-direct'
import type { CreatePolicyQuestionFn, DraftPayload, ToolExecutor } from '@agentsws/stand-ins'
import { createStubRuntime } from '@agentsws/stand-ins'

import { cardRefOf, type Work } from '@agentsws/work'
import type { ComputerUseAssembly } from './computer-use.js'

/**
 * 卡片的出口。类型就是契约的 `CreateApprovalInput`——收件人门禁（31 §3.3）要的
 * `context` 已经在契约里了（WP31 补上 WP24 的后置项），这里不再借宿主包的交叉类型。
 */
export interface ApprovalSink {
  create<P>(input: CreateApprovalInput<P>): Promise<ApprovalItem<P>>
}

/** 只读目录：没接连接器时 stub / direct 也照样能走完（工具执行器缺席就是一条 error 结果）。 */
const DEFAULT_TOOLS = ['get_order', 'get_product', 'list_orders', 'search_policies'] as const

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
}

export interface RuntimeOptions {
  workspace_id: string
  clock: Clock
  random: () => number
  env: Record<string, string | undefined>
  models: ModelGatewayApi
  /** 卡片进的那条队列（demo 里是接进来的世界的总线） */
  approvals: ApprovalSink
  roles: RoleStore
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  source?: MatterRecordSource
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
  /** WP25：现在生效的默认模型（进 `RunRequest.runtime.model`）。 */
  modelRef?: () => ModelRef
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
  positionOf(role_id: string): { position_id?: string; note?: string }
  /** 岗位层上下文的三样：面板数字与告警摘要、岗位下进行中事项摘要、持有人可用时段。 */
  layerContext(
    position_id: string,
    person_id: PersonId,
  ): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export interface RuntimeAssembly {
  adapter: RuntimeAdapter
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
   * 收件人必须解析成一个 ObjectRef 且是这次运行读过的，否则宁可不建卡（31 §3.3）。
   */
  const createDraft = async (
    payload: DraftPayload,
  ): Promise<{ approval_item_id: string } | { rewrite: string } | undefined> => {
    const s = scope
    if (s === undefined || work === undefined) return undefined
    const email = payload.to[0]
    if (email === undefined) return undefined
    const resolved = source.contactOf?.(email)
    // 31 §3.3 + 09-14 真店实测：模型会把订单上的客户邮箱当收件人，而来信人可能是另一个地址
    // （代下单、家人、测试账号）。回信只能回给**来信人**——事项上钉着的那个联系人；
    // 模型给的地址不一致就改指过去并在时间线上说一句，绝不按模型给的发。
    const pinnedContact = s.matter.context.pinned.find((p) => p.type === 'contact')
    const to = pickDraftRecipient({ pinnedContact, resolved })
    if (to === undefined) return undefined
    if (resolved !== undefined && refKey(resolved) !== refKey(to)) {
      work.appendEvent(s.matter.id, {
        kind: 'status',
        text: `回信收件人改为来信人：模型给的地址（${email}）与来信人不一致，已按来信人处理。`,
        actor: { kind: 'system', id: 'runtime' },
        run_id: s.run_id,
      })
    }
    const seen = [...s.seen]
    if (!seen.some((r) => refKey(r) === refKey(to))) return undefined
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
    const subject = seen.find((r) => r.type === 'thread') ?? seen.find((r) => r.type === 'order')
    const assignment = roles.assignments.get(s.assignment_id)
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: assignment?.role_id ?? 'common.member',
      subject: {
        object: subject ?? to,
        matter_id: s.matter.id,
        work_item_id: s.matter.id,
        ...(s.todo_id === undefined ? {} : { todo_id: s.todo_id }),
        conversation_id: s.matter.id,
      },
      dedupe_key: `${workspace_id}:outbound_draft:${s.matter.id}:${s.run_id}`,
      title: `回复 ${source.label?.(to) ?? (resolved !== undefined && refKey(resolved) === refKey(to) ? email : '来信人')}：${payload.subject}`,
      summary: payload.subject,
      payload: {
        channel: payload.channel,
        to,
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
        thread_participants: [to.id],
        verified_contacts: [to.id],
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
      dedupe_key: `${workspace_id}:policy_change:${boundary.id}`,
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
  const useDirect = (options.prefer ?? (hasModel() ? 'direct' : 'stub')) === 'direct'

  /**
   * WP44：把 Dev MCP 的三个只读工具并进工具执行器。
   *
   * 它们不经连接器，也就没有 provenance 可言——查一段文档不等于"读过某个订单"，
   * 所以这条路**不往 provenance 里加任何 ref**（15 §6：seen 只证明读过业务对象）。
   */
  const devToolNames = (): readonly string[] => options.devTools?.toolNames() ?? []
  const executeTool: ToolExecutor | undefined = (() => {
    /*
     * WP117（66 断点 #1）：**三级链**——红人工具 → dev MCP → 记录源。
     *
     * 顺序是刻意的：红人工具名（`draft_outreach` 这些）与别处不重名，先问它一句，
     * 不是它的再往下走。谁都不认才回 `unsupported_tool`——而不是静默回 `undefined`
     * 让界面显示一个空结果（66 断点 #6 的病根）。
     */
    const kol = options.kolTools
    const dev = options.devTools
    if (kol === undefined && dev === undefined) return source.executeTool
    return async (call) => {
      if (kol !== undefined && KOL_TOOL_NAMES.includes(bareOf(call.name))) {
        return kol(call)
      }
      if (dev !== undefined && devToolNames().includes(call.name)) {
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

  const adapter: RuntimeAdapter = useDirect
    ? createDirectRuntime({
        gateway: withToolChoice({
          complete: (r) => options.models.complete(r),
          embed: (t, meta, model) => options.models.embed(t, meta, model),
          usage: (f) => options.models.usage(f),
          budget: (s) => options.models.budget(s),
        }),
        clock,
        seed,
        createDraft,
        ...(executeTool === undefined ? {} : { executeTool }),
      })
    : createStubRuntime({
        clock,
        seed,
        createDraft,
        createPolicyQuestion,
        ...(executeTool === undefined ? {} : { executeTool }),
      })

  /*
   * WP144 / WP148：带 `computer_use` **或** `browser` 的运行走 **dsh 运行时**——官方电脑操控
   * 提供方与浏览器提供方（Playwright / BrowserSkill）都只在那一条路上挂（`dsh-adapter` 的
   * `harness.ts`，顺序 mount → 门禁 → 浏览器 → 电脑操控，两样都在场就同一棵树挂两样）。
   * 只在有模型时才建（没模型的 stub 档本来就驱动不了浏览器和电脑），而且只给这两种运行用：
   * 别的运行照旧 direct，一个字节不变。
   */
  const dshAdapter: RuntimeAdapter | undefined =
    useDirect && (options.computerUse !== undefined || options.browser !== undefined)
      ? createDshRuntime({
          gateway: { complete: (r) => options.models.complete(r) },
          clock,
          seed,
          ...(options.dshMode === undefined ? {} : { mode: options.dshMode }),
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
        })
      : undefined

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

  const buildRequest = async (input: {
    run_id: string
    matter: Matter
    brief: string
    person_id: PersonId
    assignment_id: AssignmentId
  }): Promise<RunRequest> => {
    const config = roles.effectiveConfig(input.assignment_id)
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
        : (positions?.positionOf(config.role_id) ?? {})
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
    const allow = [
      ...new Set([
        ...config.grounding.map((g) => g.tool),
        ...DEFAULT_TOOLS,
        ...devToolNames(),
        ...(isKolRole(config.role_id) ? KOL_TOOL_NAMES : []),
      ]),
    ].sort()
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
      context: await contextOf(input.matter, input.brief, {
        ...(positionHit.position_id === undefined ? {} : { position_id: positionHit.position_id }),
        person_id: input.person_id,
      }),
      grounding: config.grounding,
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
                actor: {
                  person_id: input.person_id,
                  workspace_id,
                  ...(positionHit.position_id === undefined
                    ? {}
                    : { position_id: positionHit.position_id }),
                  role_id: config.role_id,
                },
                registry: options.skills,
              })),
        ],
      },
      /*
       * WP144：批过授权的那一次运行，工具调用上限从 12 放到 40——操作桌面是"看一眼、点一下、
       * 再看一眼"，12 次连一个小任务都做不完。时间与花费上限不动。
       */
      budget: {
        max_tokens: 60_000,
        max_tool_calls: granted ? 40 : 12,
        max_seconds: 120,
        max_cost_base: 5,
      },
      // 变更仍走各自的管线（渠道 / 执行器）；事项里的一次运行只出草稿与提案
      expectations: { outputs: ['draft', 'answer'], must_stage_if_change_requested: false },
      runtime: {
        preset: config.role_id,
        profile: 'server',
        plugins: [],
        model: useDirect
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
    const sink = (e: RunEvent): void => {
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
      const controller = new AbortController()
      const cu = request.computer_use
      // WP148：开了浏览器的运行同样走 dsh（只有那棵树上挂得了浏览器提供方）
      const needsDsh = cu !== undefined || request.browser !== undefined
      const runner = needsDsh && dshAdapter !== undefined ? dshAdapter : adapter
      if (cu?.granted_until !== undefined) {
        options.computerUse?.activate(
          {
            run_id,
            role_id: request.actor.role_id,
            matter_id: input.matter.id,
            until: cu.granted_until,
            ...(cu.grant_id === undefined ? {} : { grant_id: cu.grant_id }),
          },
          () => controller.abort(),
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
        result = await runner.run(request, sink, controller.signal)
      } finally {
        options.computerUse?.deactivate(run_id)
      }
      summary = result.summary
      for (const out of result.outputs) if (out.kind === 'answer') addAnswer(out.text)
      // 37 §2.2b：Agent 说的话进时间线；摘要与会话引用由 onRunCompleted 落到事项上
      if (answers.length > 0) {
        work?.appendEvent(input.matter.id, {
          kind: 'agent_message',
          text: answers.join('\n'),
          actor: { kind: 'agent', id: input.actor.assignment_id },
          run_id,
        })
      }
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
    } finally {
      scope = undefined
    }
    return { run_id }
  }

  return {
    adapter,
    bind(w) {
      work = w
    },
    bindPositions(source) {
      positions = source
    },
    startRun,
  }
}
