import type {
  ChangeKind,
  ChatMessage,
  Clock,
  ContextItem,
  Iso8601,
  ObjectRef,
  RunEvent,
  RunOutput,
  RunRequest,
  RunResult,
  RuntimeAdapter,
  ToolDef,
} from '@agentsws/contracts'
import { cancelledEvent } from '@agentsws/contracts'
import { canonicalJson, Provenance, sha256 } from '@agentsws/core'
import { staticPrefixHash } from '@agentsws/model-gateway'
import { orderTools, runOntologyBrief } from '@agentsws/ontology'
import type { BoundaryItem } from '@agentsws/support-core'
import { renderReplyBody, replySubject } from '@agentsws/support-core'
import { ADS_TOOL_DEF_BY_NAME } from './ads.js'
import { ADS_DATA_TOOL_DEF_BY_NAME } from './ads-data.js'
import { AMAZON_KEYWORD_TOOL_DEF_BY_NAME } from './amazon-keywords.js'
import { AMAZON_LISTING_TOOL_DEF_BY_NAME } from './amazon-listing.js'
import {
  B2B_LIST_SEQUENCES_TOOL,
  B2B_OUTBOUND_TOOL_DEF_BY_NAME,
  B2B_START_ROUND_TOOL,
  type B2bSequencesData,
  type B2bStartRoundData,
  b2bOutboundBranch,
  renderB2bOutboundAnswer,
  sequencesOf,
  startRoundOf,
} from './b2b-outbound.js'
import { contextRoleOf, orderContextItems } from './context-order.js'
import {
  DESK_TOOL_DEF_BY_NAME,
  deskBranch,
  deskToolDataOf,
  renderDeskAnswer,
} from './desk-tools.js'
import { GOOGLE_ALERTS_TOOL_DEF_BY_NAME } from './google-alerts.js'
import { IMAGE_TOOL_DEF_BY_NAME, imageBranch, imageDataOf, renderImageAnswer } from './image.js'
import { KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME } from './knowledge-learn.js'
import {
  attributionOf,
  collabsOf,
  countOf,
  deliverablesOf,
  describeKolRun,
  foundOf,
  type KolFinding,
  kolBranch,
  kolRefs,
  parseFollowerBand,
  parseQuietDays,
  parseWantedCount,
  receiptOf,
  renderKolAnswer,
} from './kol.js'
import {
  MESSAGE_RULE_TOOL_DEF_BY_NAME,
  messageRuleBranch,
  messageRuleDataOf,
  renderMessageRuleAnswer,
} from './message-rule.js'
import {
  connectionsOf,
  OWNER_CONNECTIONS_TOOL,
  OWNER_POSITIONS_TOOL,
  OWNER_TOOL_DEF_BY_NAME,
  type OwnerConnectionsData,
  type OwnerPositionsData,
  ownerBranch,
  positionsOf,
  renderOwnerAnswer,
} from './owner.js'
import {
  isQueryBrief,
  noPlaybookAnswer,
  noPlaybookSummary,
  noSceneForQueryAnswer,
  playbookOf,
} from './playbook.js'
import { PR_MONITOR_TOOL_DEF_BY_NAME } from './pr-monitor.js'
import {
  RECORD_SINK_TOOL_DEF_BY_NAME,
  recordSinkBranch,
  recordSinkDataOf,
  renderRecordSinkAnswer,
} from './record-sink.js'
import { PUBLISH_REPORT_TOOL, REPORT_TOOL_DEF_BY_NAME, RUN_WATCH_NOW_TOOL } from './report.js'
import {
  backfillAnswer,
  backfillAsk,
  composeStubReport,
  type ReportNeed,
  reorderAsk,
  reorderNumbered,
  reportPlan,
  splitNumbered,
} from './report-playbook.js'
import { researchToolDef } from './research.js'
import {
  renderScheduleAnswer,
  SCHEDULE_CREATE_TOOL,
  SCHEDULE_LIST_TOOL,
  SCHEDULE_TOOL_DEF_BY_NAME,
  SCHEDULE_UPDATE_TOOL,
  scheduleBranch,
} from './schedule.js'
import {
  renderSetupRequestAnswer,
  SETUP_REQUEST_TOOL_DEF_BY_NAME,
  setupRequestBranch,
  setupRequestDataOf,
} from './setup-request.js'
import { setupStateBranch } from './setup-state.js'
import {
  firstProductOf,
  renderSiteChecklistAnswer,
  SHOP_GET_PRODUCT_TOOL,
  SHOP_LIST_PRODUCTS_TOOL,
  SHOP_SAVE_PRODUCT_TOOL,
  SHOP_SAVE_REDIRECTS_TOOL,
  SHOP_TOOL_DEF_BY_NAME,
  type ShopStagedData,
  type ShopStep,
  shopBranch,
  shopStagedOf,
  siteChecklistBranch,
} from './shop.js'
import {
  renderSiteHealthAnswer,
  SITE_HEALTH_TOOL_DEF_BY_NAME,
  siteHealthBranch,
  siteHealthQueryDataOf,
} from './site-health.js'
import { SKILL_TOOL_DEF_BY_NAME } from './skills.js'
import {
  demoWeekSlots,
  LIST_REDDIT_PENDING_TOOL,
  LIST_SOCIAL_POSTS_TOOL,
  redditPendingDataOf,
  renderRedditPending,
  renderStaged,
  SOCIAL_WORK_TOOL_DEF_BY_NAME,
  STAGE_REDDIT_WRITE_TOOL,
  STAGE_SOCIAL_POST_TOOL,
  socialPostsDataOf,
  socialWorkBranch,
  stagedDataOf,
} from './social-tools.js'
import {
  adsAmazonScriptOf,
  runAdsScript,
  runAmazonScript,
  type ScriptStep,
} from './stub-ads-amazon.js'
import { runAdsSkillScript } from './stub-ads-skills.js'
import {
  boundariesToAsk,
  boundaryGate,
  describeRun,
  marketplaceLinkSlip,
  rewriteForChannelGuard,
} from './support.js'
import { SUPPORT_TOOL_DEF_BY_NAME } from './support-tools.js'
import {
  checkOf,
  choiceOf,
  initOf,
  latestCopyOf,
  legacyNoticeOf,
  publishOf,
  pushedOf,
  renderThemeAnswer,
  THEME_CHECK_TOOL,
  THEME_INIT_TOOL,
  THEME_LIST_TOOL,
  THEME_PUBLISH_TOOL,
  THEME_PUSH_TOOL,
  THEME_TOOL_DEF_BY_NAME,
  type ThemeCheckData,
  type ThemeChoiceData,
  type ThemeInitData,
  type ThemeLegacyData,
  type ThemePublishData,
  type ThemePushData,
  type ThemeStep,
  themeBranch,
} from './theme.js'
import {
  renderWebAnswer,
  urlsIn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_TOOL_DEF_BY_NAME,
  type WebSource,
  WebUsageCounter,
  webResearchPlan,
} from './web.js'
import { WORKSHOP_HELP_TOOL_DEF_BY_NAME } from './workshop-help.js'
import {
  DRAFT_SERVICE_ORDER_TOOL,
  FIND_SERVICE_TOOL,
  findServiceDataOf,
  renderWorkshopServiceAnswer,
  WORKSHOP_SERVICE_TOOL_DEF_BY_NAME,
  workshopServiceBranch,
} from './workshop-service.js'
import { renderWrapUp, WEB_WRAP_UP_MISSING_FETCH, WRAP_UP_STEP, wrapUpFallback } from './wrap-up.js'

export interface ToolExecution {
  status: 'ok' | 'error' | 'blocked'
  data?: unknown
  reason?: string
  provenance?: ObjectRef[]
}

export type ToolExecutor = (call: {
  name: string
  input: Record<string, unknown>
  request: RunRequest
}) => Promise<ToolExecution>

/** 15 §5 stage 的意图：stub 只表达"要改什么"，账本与门禁由注入的回调（真实 txn 包）负责。 */
export interface StageIntent {
  request: RunRequest
  kind: ChangeKind
  target: ObjectRef
  field?: string
  before: unknown
  after: unknown
  money?: { amount: number; currency: string }
  notes: string[]
  requester?: { channel: string; external_id: string }
}

export type StageFn = (intent: StageIntent) => Promise<{ change_id: string } | undefined>

export interface DraftPayload {
  request: RunRequest
  channel: 'email'
  to: string[]
  subject: string
  body: string
  thread_external_id?: string
  child_change_ids: string[]
  citations: { fact_card_id: string; quote: string }[]
}

/**
 * 起草的回执。
 *
 * WP55 / 48 §4 L3 #2：`rewrite` = 出站硬闸把这一版**打回重写**了，里面是中文的
 * 违规原因。拦截不是静默删改后照发——原因要回到写正文的那一跳，让它重写一版。
 */
export type CreateDraftResult = { approval_item_id: string } | { rewrite: string } | undefined

export type CreateDraftFn = (payload: DraftPayload) => Promise<CreateDraftResult>

/**
 * 36 §2.2 的选择题卡：第一次遇到一条没答过的业务边界时问一次。
 * 宿主不接这个回调时什么都不会发生——起草照常，只是少了那张卡。
 */
export type CreatePolicyQuestionFn = (input: {
  request: RunRequest
  boundary: BoundaryItem
}) => Promise<{ approval_item_id: string } | undefined>

export interface StubRuntimeOptions {
  clock: Clock
  /** 26 §3：seed 决定一切随机；同 seed 同请求 → 同事件序列。 */
  seed?: number
  executeTool?: ToolExecutor
  stage?: StageFn
  createDraft?: CreateDraftFn
  createPolicyQuestion?: CreatePolicyQuestionFn
  /** policy 上下文里读不到窗口时的默认退货窗口天数。 */
  defaultReturnWindowDays?: number
  signature?: string
}

const DAY = 86_400_000

// ---------- 上下文读取 ----------

function itemsOfKind(req: RunRequest, kind: ContextItem['kind']): ContextItem[] {
  return req.context.filter((c) => c.kind === kind)
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function plainText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(plainText).join('\n')
  const o = asRecord(v)
  if (!o) return String(v)
  const preferred = ['body', 'text', 'message', 'content', 'subject', 'summary']
  const picked = preferred.filter((k) => typeof o[k] === 'string').map((k) => o[k] as string)
  if (picked.length > 0) return picked.join('\n')
  return Object.values(o).map(plainText).join('\n')
}

function refOf(item: ContextItem): ObjectRef | undefined {
  const src = item.source_ref
  if (typeof src === 'string') return undefined
  return src
}

interface OrderView {
  ref: ObjectRef
  id: string
  name: string
  email?: string
  currency: string
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
  delivered_at?: Iso8601
  customer_name?: string
  record_version?: string
}

function orderView(source: unknown, fallbackRef?: ObjectRef): OrderView | undefined {
  const o = asRecord(source)
  if (!o) return undefined
  const id = typeof o.id === 'string' ? o.id : fallbackRef?.id
  if (id === undefined) return undefined
  const address = asRecord(o.shipping_address)
  return {
    ref: { type: 'order', id },
    id,
    name: typeof o.name === 'string' ? o.name : id,
    currency: typeof o.currency === 'string' ? o.currency : 'USD',
    total_price: typeof o.total_price === 'number' ? o.total_price : 0,
    refunded_amount: typeof o.refunded_amount === 'number' ? o.refunded_amount : 0,
    financial_status: typeof o.financial_status === 'string' ? o.financial_status : 'unknown',
    fulfillment_status: typeof o.fulfillment_status === 'string' ? o.fulfillment_status : 'unknown',
    ...(typeof o.email === 'string' ? { email: o.email } : {}),
    ...(typeof o.delivered_at === 'string' ? { delivered_at: o.delivered_at } : {}),
    ...(typeof address?.name === 'string' ? { customer_name: address.name } : {}),
    ...(typeof o.record_version === 'string' ? { record_version: o.record_version } : {}),
  }
}

/** 从 policy / fact_card 里读退货窗口天数（`14 days` / `14 天` / `return_window_days: 14`）。 */
function returnWindowDays(
  req: RunRequest,
  fallback: number,
): { days: number; source?: ContextItem } {
  const candidates = [...itemsOfKind(req, 'policy'), ...itemsOfKind(req, 'fact_card')]
  for (const item of candidates) {
    const o = asRecord(item.content)
    const explicit = o?.return_window_days
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return { days: explicit, source: item }
    }
    const m = plainText(item.content).match(/(\d{1,3})\s*(?:days?|天)/i)
    if (m?.[1]) return { days: Number.parseInt(m[1], 10), source: item }
  }
  return { days: fallback }
}

function hitsRule(text: string, rule: RunRequest['grounding'][number]): boolean {
  const lower = text.toLowerCase()
  return [...rule.intent_terms, ...rule.cue_terms].some(
    (t) => t.length > 0 && lower.includes(t.toLowerCase()),
  )
}

// ---------- prompt 装配 ----------

/**
 * 17 §1 的两个产出工具：它们是宿主回调，不在 `tools.allow` 里，但模型看得见、
 * 也确实调得到——所以按岗位裁剪登记表时必须把它们算进"你能做什么"。
 *
 * 只有一处定义（`runtime-direct` 的 `outputToolDefs` 也用它），否则两边一错位，
 * 提示词里许诺的工具与真正注册的工具就对不上了。
 */
export function outputToolNames(req: RunRequest): string[] {
  const wants = new Set(req.expectations.outputs)
  const names: string[] = []
  if (wants.has('draft')) names.push(DRAFT_REPLY_TOOL)
  if (wants.has('staged_change') || req.expectations.must_stage_if_change_requested)
    names.push(STAGE_REFUND_TOOL)
  return names.sort()
}

export const DRAFT_REPLY_TOOL = 'draft_reply'
export const STAGE_REFUND_TOOL = 'stage_refund'

/**
 * 47 J3：工具面按**查对象 → 查知识 → 提议动作**三组排列。
 * 排序规则在 `@agentsws/ontology`（登记表知道每个 Action 读的是哪类对象、是读是写）；
 * 这里只负责让三个运行时用同一份顺序——名字一个字都不改，只换先后。
 */
function toolDefs(req: RunRequest): ToolDef[] {
  return orderTools(req.tools.allow).map(
    (name) =>
      // WP153：店主那两个只读工具的描述是写给模型的人话（它挑工具时读的就是这一句）；
      // 别的名字照旧是占位描述——这一行只对工具面里有它们的运行生效，老的 prompt 字节不变
      // WP162：`read_skill` 同理（只有登记了按需技能的运行才有它）
      OWNER_TOOL_DEF_BY_NAME.get(name) ??
      SKILL_TOOL_DEF_BY_NAME.get(name) ??
      // WP176：主动开发的三个开发信工具（只有那条职责的运行才有它们）
      B2B_OUTBOUND_TOOL_DEF_BY_NAME.get(name) ??
      // WP316：改广告的两个工具（只有 Google / Meta 投放职责、服务端接了插件执行的运行才有）
      ADS_TOOL_DEF_BY_NAME.get(name) ??
      // WP179：官方网页工具（只有开了网页工具的运行，工具面里才有这两个名字）
      WEB_TOOL_DEF_BY_NAME.get(name) ??
      // WP220：只读 Reddit（只有 grounding 里挂了它的那几条职责，工具面里才有这个名字）
      // WP237：单价按这次运行的价目现填（`tool_prices`），取不到就只说「按条计积分」
      researchToolDef(name, req.tool_prices) ??
      // WP181：官方「自动化任务」的四个工具（只有装了那个官方插件的运行才有）
      SCHEDULE_TOOL_DEF_BY_NAME.get(name) ??
      // WP253：网页模板的九个受限主题工具（只有那条职责、服务端接了主题工具的运行才有）
      THEME_TOOL_DEF_BY_NAME.get(name) ??
      // WP261：独立站运营工具（只有授权过店铺、职责登记了的运行才有）
      SHOP_TOOL_DEF_BY_NAME.get(name) ??
      // WP268：生图 / 改图 / 素材库（只有设计岗与网页模板、而且配了生图的运行才有）
      IMAGE_TOOL_DEF_BY_NAME.get(name) ??
      // WP323：记录去处的三个工具（服务端接了发出记录的运行才有）
      RECORD_SINK_TOOL_DEF_BY_NAME.get(name) ??
      // WP441：一句话写消息规则（服务端接了消息规则的运行才有）
      MESSAGE_RULE_TOOL_DEF_BY_NAME.get(name) ??
      // WP331：报告积木（查巡查数据 / 立即巡查 / 查发出记录 / 发布报告；服务端接了才有）
      REPORT_TOOL_DEF_BY_NAME.get(name) ??
      // WP315：投放岗看数据（查广告数据 / 现在导一次 / 提止损卡；服务端接了才有）
      ADS_DATA_TOOL_DEF_BY_NAME.get(name) ??
      // WP398：Amazon 词库（刷新 / 看词库 / 标一个词；只给亚马逊店铺运营）
      AMAZON_KEYWORD_TOOL_DEF_BY_NAME.get(name) ??
      // WP396：Listing 体检（读自家前台页 / 看最近一次 / 改规则；只给亚马逊店铺运营）
      AMAZON_LISTING_TOOL_DEF_BY_NAME.get(name) ??
      // WP334：AI 自己要连接卡 / 配置卡（服务端接了才有）
      SETUP_REQUEST_TOOL_DEF_BY_NAME.get(name) ??
      // WP385：网站运营 / 内容与搜索读体检结论（服务端接了才有）
      SITE_HEALTH_TOOL_DEF_BY_NAME.get(name) ??
      // WP488：客服知识库「学一遍」（服务端接了才有）
      KNOWLEDGE_LEARN_TOOL_DEF_BY_NAME.get(name) ??
      // WP387：浏览器建完 / 读完 Google 提醒后交代结果（只有信息监控、服务端接了才有）
      GOOGLE_ALERTS_TOOL_DEF_BY_NAME.get(name) ??
      // WP386：信息监控查提及（只有 grounding 里挂了它的那条职责才有）
      PR_MONITOR_TOOL_DEF_BY_NAME.get(name) ??
      // WP390：工坊服务的两个工具（服务端接了才有）
      WORKSHOP_SERVICE_TOOL_DEF_BY_NAME.get(name) ??
      // 教程上官网（私有 docs/113）：查工坊帮助（所有职责；服务端接了才有）
      WORKSHOP_HELP_TOOL_DEF_BY_NAME.get(name) ??
      // WP417：客服查询类工具（等着回的来信 / 聊天会话 / 社群帖子）
      SUPPORT_TOOL_DEF_BY_NAME.get(name) ??
      // WP419：社媒发帖 / Reddit 起草出卡（服务端接了才有）
      SOCIAL_WORK_TOOL_DEF_BY_NAME.get(name) ??
      // WP421：公关 / 内容与搜索 / B2B / 设计的读数与起草工具
      DESK_TOOL_DEF_BY_NAME.get(name) ?? {
        name,
        description: `stand-in tool ${name}`,
        input_schema: { type: 'object' },
      },
  )
}

/**
 * 17 §1 装配顺序：静态前缀（persona 段 + skills 索引行 + 登记表那一段 + 工具定义）→
 * 策略层 → 工作项上下文 → 用户消息。静态前缀只由请求里稳定的部分构成，字节稳定。
 *
 * 导出给模拟回路（17 §6.1、26 §6）：回放事件日志时用同一个函数重组 prompt，
 * 与 `prompt.assembled.hash` 比对——同一个定义，不允许两处实现。
 *
 * **47 J3 那一段"你能查什么、能做什么"从本体登记表生成**，不手写：它是纯函数
 * （输入只有 `actor` 与 `tools.allow`），所以回放照样重组得出同一份字节。
 */
export function assemblePrompt(req: RunRequest): { messages: ChatMessage[]; tools: ToolDef[] } {
  const persona = [...req.persona.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
  const skills = req.skills
    .map((s) => `- ${s.name}${s.min_version ? `@${s.min_version}` : ''} (${s.tier}/${s.load})`)
    .join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: persona },
    { role: 'system', content: `# skills\n${skills}` },
  ]
  const brief = ontologyBriefOf(req)
  if (brief !== '') messages.push({ role: 'system', content: brief })
  /*
   * WP472（docs/116 §6 A）：上下文按 `orderContextItems` 排——政策 / 边界走系统提示、紧跟静态前缀；
   * 其余（之前的对话原文 → 记录 → 事项摘要 → 岗位状态 → 设置快照 → app 事件 → 时间 → 这一次的话）
   * 一律按 user 消息发。每次都变的东西不再混进系统提示（DeepSeek 账号口会把系统消息并成开头一段）。
   * 时间仍在这一次的话之前、静态前缀之外（WP180：每小时一变）。三个运行时同一份顺序与层级。
   */
  for (const item of orderContextItems(req.context)) {
    messages.push({
      role: contextRoleOf(item.kind),
      content: `[${item.kind}:${item.id}]\n${plainText(item.content)}`,
    })
  }
  return { messages, tools: toolDefs(req) }
}

/** 47 J3 的那一段（按这次运行的工具面裁剪登记表）。 */
export function ontologyBriefOf(req: RunRequest): string {
  return runOntologyBrief({
    assignment_id: req.actor.assignment_id,
    role_id: req.actor.role_id,
    tools: [...req.tools.allow, ...outputToolNames(req)],
  })
}

/**
 * WP473（docs/116 §4）：一次运行的**静态前缀**有几条消息——`assemblePrompt` 开头的岗位说明、技能索引、
 * 登记表（有才算）。前缀指纹与缓存断点（`cache_breakpoints`）就打在它们之后：后面的上下文（政策、
 * 记录、事项摘要、岗位状态……）每次可能都不同，混进指纹就等于没有指纹。
 */
export function runStaticPrefixCount(req: RunRequest): number {
  return ontologyBriefOf(req) === '' ? 2 : 3
}

/**
 * `prompt.assembled.hash` 的计算式（17 §2）。运行时发事件与回放校验共用这一处。
 */
export function promptHash(prompt: { messages: ChatMessage[]; tools: ToolDef[] }): string {
  return sha256(canonicalJson(prompt))
}

/** 从 RunRequest 直接算出 `prompt.assembled.hash`（装配 + 哈希）。 */
export function assemblePromptHash(req: RunRequest): string {
  return promptHash(assemblePrompt(req))
}

/** 单个 ContextItem 的 `context.injected.hash` 计算式（17 §2）。 */
export function contextItemHash(item: ContextItem): string {
  return sha256(canonicalJson(item.content))
}

function estimateTokens(messages: ChatMessage[], tools: ToolDef[]): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length + m.role.length, 0) + canonicalJson(tools).length
  return Math.ceil(chars / 4)
}

// ---------- 适配器 ----------

/**
 * 26 §3 / 17 §4 `stub` 运行时：按规则出草稿（fast 档）。
 * 读 RunRequest 的 context 与 grounding，先调工具、再起草回复、需要改动就 stage，
 * 全程发 17 §2 的事件；预算是硬的；同 seed 同请求 → 逐条相同的事件序列。
 */
export function createStubRuntime(options: StubRuntimeOptions): RuntimeAdapter {
  const { clock } = options
  const seed = options.seed ?? 1
  const defaultWindow = options.defaultReturnWindowDays ?? 14
  const signature = options.signature ?? 'Customer Care'
  const seenPrefixes = new Set<string>()

  return {
    name: 'stub',

    capabilities() {
      return { tool_choice: true, streaming: false, followup: false, seedable: true }
    },

    async health() {
      return { ok: true }
    },

    async run(
      req: RunRequest,
      sink: (e: RunEvent) => void,
      signal: AbortSignal,
    ): Promise<RunResult> {
      const startedMs = Date.parse(clock.now())
      const prov = new Provenance(req.id)
      const outputs: RunOutput[] = []
      let toolCalls = 0
      let exhausted: { which: keyof RunRequest['budget']; used: number; cap: number } | undefined

      const finish = (
        status: RunResult['status'],
        summary: string,
        extra?: { no_stage?: boolean },
      ): RunResult => {
        const seconds = Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000)
        const result: RunResult = {
          request_id: req.id,
          status,
          outputs,
          provenance: prov.toState(clock.now()),
          memory_candidates: [],
          lessons: [],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cached_tokens: usage.cached_tokens,
            tool_calls: toolCalls,
            seconds,
            cost_base: 0,
          },
          session_ref: {
            runtime: 'stub',
            session_id: sha256(canonicalJson({ request: req.id, seed })).slice(0, 26),
            log_uri: `memory://stub/${req.id}`,
          },
          summary,
          ...(extra?.no_stage === true ? { no_stage: true } : {}),
        }
        return result
      }

      const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 }

      sink({ type: 'run.started', request_id: req.id, runtime: 'stub', model: req.runtime.model })
      if (signal.aborted) {
        sink(cancelledEvent(signal))
        return finish('cancelled', '运行开始前即被中断')
      }

      // 1) 逐项注入上下文（Model-visible ⟺ logged）
      for (const item of req.context) {
        sink({
          type: 'context.injected',
          item_id: item.id,
          kind: item.kind,
          bytes: item.bytes,
          hash: contextItemHash(item),
        })
        const ref = refOf(item)
        if (ref) prov.see([ref])
      }

      // 2) 装配 prompt
      const { messages, tools } = assemblePrompt(req)
      const prefixHash = staticPrefixHash(messages, tools)
      const total_tokens = estimateTokens(messages, tools)
      usage.input_tokens = total_tokens
      if (seenPrefixes.has(prefixHash)) {
        usage.cached_tokens = estimateTokens(
          messages.filter((m, i) => i < 2 && m.role === 'system'),
          tools,
        )
      } else {
        seenPrefixes.add(prefixHash)
      }
      sink({
        type: 'prompt.assembled',
        hash: promptHash({ messages, tools }),
        static_prefix_hash: prefixHash,
        total_tokens,
      })

      if (total_tokens > req.budget.max_tokens) {
        sink({
          type: 'budget.exhausted',
          which: 'max_tokens',
          used: total_tokens,
          cap: req.budget.max_tokens,
        })
        sink({
          type: 'run.completed',
          usage: { ...usage, tool_calls: 0, seconds: 0, cost_base: 0 },
          outputs,
          summary: 'max_tokens 预算耗尽',
        })
        return finish('budget_exhausted', 'max_tokens 预算耗尽')
      }

      // 3) 定位订单 / 线程 / 政策
      const readTools: string[] = []
      const threadItem = itemsOfKind(req, 'thread')[0]
      const threadText = threadItem ? plainText(threadItem.content) : ''

      /*
       * WP179：**去网上查一下**。这次运行开了官方网页搜索（`RunRequest.web`）、问的又是"搜 / 查 / 调研"，
       * 就走这段剧本：搜一条查询 → 开了抓网页就抓第一条来源 → 把来源列成一段话。
       * 次数上限与另外两个运行时同一份判定（`WebUsageCounter`）；没开网页工具的运行一个字节不变。
       */
      const webPlan = webResearchPlan(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (webPlan !== undefined) {
        const counter = new WebUsageCounter(req)
        let sources: WebSource[] = []
        let fetched: { url: string; status: number } | undefined
        let failed: string | undefined
        const calls: { tool: string; input: Record<string, unknown> }[] = [
          { tool: WEB_SEARCH_TOOL, input: { queries: [webPlan.query] } },
        ]
        for (let i = 0; i < calls.length; i += 1) {
          const call = calls[i] as { tool: string; input: Record<string, unknown> }
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool: call.tool, input: call.input })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            break
          }
          const denial = counter.take(call.tool, call.input)
          const res =
            denial !== undefined
              ? { status: 'blocked' as const, reason: denial }
              : options.executeTool === undefined
                ? { status: 'error' as const, reason: 'no_tool_executor' }
                : await options.executeTool({ name: call.tool, input: call.input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status !== 'ok') {
            if (call.tool === WEB_SEARCH_TOOL) failed = res.reason ?? '这一步没走通'
            continue
          }
          readTools.push(call.tool)
          if (call.tool === WEB_SEARCH_TOOL) {
            sources = webSourcesOf(res.data)
            const first = sources[0]?.url ?? urlsIn(JSON.stringify(res.data ?? ''))[0]
            if (webPlan.fetch && first !== undefined) {
              calls.push({ tool: WEB_FETCH_TOOL, input: { url: first } })
            }
          } else {
            const url = typeof call.input.url === 'string' ? call.input.url : ''
            fetched = { url, status: webStatusOf(res.data) }
          }
        }
        const found = renderWebAnswer({
          query: webPlan.query,
          sources,
          ...(fetched === undefined ? {} : { fetched }),
          ...(failed === undefined ? {} : { failed }),
        })
        /*
         * WP423：预算到了也要交东西——收尾那一段（为什么停 + 已经查到的 + 还差什么 + 接着做），
         * 与 direct / dsh 的替身规则脑在收尾回合拼出同一段话。
         */
        if (exhausted !== undefined)
          sink({ type: 'progress', step: WRAP_UP_STEP, note: exhausted.which })
        const answer =
          exhausted === undefined
            ? found
            : renderWrapUp({
                which: exhausted.which,
                body: found,
                ...(webPlan.fetch && fetched === undefined
                  ? { missing: WEB_WRAP_UP_MISSING_FETCH }
                  : {}),
              })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP117（66 断点 #1）：**红人的岔口**。
       *
       * 这条职责是 `kol.*` 的话，下面客服那一整套（订单 → 退货窗口 → 回信）一行都不跑。
       * 意图判定与工具计划在 `kol-core` 的剧本里（三个运行时同一份），
       * 这里只负责按计划调工具、把回执翻成事件、最后说一段人话。
       */
      const kol = kolBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (kol !== undefined) {
        const findings: KolFinding[] = []
        for (const call of kol.calls) {
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool: call.tool, input: call.input })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            break
          }
          const exec = options.executeTool
          if (exec === undefined) {
            sink({ type: 'tool.result', call_id, status: 'error', reason: 'no_tool_executor' })
            findings.push({ tool: call.tool, status: 'error', reason: '这个进程没接工具执行器' })
            toolCalls += 1
            continue
          }
          const res = await exec({ name: call.tool, input: call.input, request: req })
          toolCalls += 1
          const refs = res.status === 'ok' ? (res.provenance ?? kolRefs(res.data)) : []
          if (refs.length > 0) prov.see(refs, { full: true })
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
            ...(refs.length > 0 ? { provenance_added: refs } : {}),
          })
          if (res.status === 'ok') readTools.push(call.tool)
          const receipt = res.status === 'ok' ? receiptOf(res.data) : {}
          if (receipt.change_id !== undefined) {
            sink({ type: 'change.staged', change_id: receipt.change_id })
            outputs.push({ kind: 'staged_change', change_id: receipt.change_id })
          }
          if (receipt.approval_item_id !== undefined) {
            sink({
              type: 'proposal.created',
              approval_item_id: receipt.approval_item_id,
              kind: receipt.kind ?? 'proposal',
            })
            outputs.push(
              call.tool === 'draft_outreach'
                ? { kind: 'draft', approval_item_id: receipt.approval_item_id }
                : { kind: 'proposal', approval_item_id: receipt.approval_item_id },
            )
          }
          const count = countOf(res.data)
          // WP142：找人那一步把找到的是谁带上（回话里点名前 5 个）
          const found =
            call.tool === 'search_creators' && res.status === 'ok' ? foundOf(res.data) : {}
          // WP295：合作清单那一步读到的是谁（「谁还没回」回话里点名）
          const collabs =
            call.tool === 'list_collaborations' && res.status === 'ok'
              ? collabsOf(res.data)
              : undefined
          // WP295：归因那一步读到的链接（「哪几个真带货了」那张表）
          const attribution =
            call.tool === 'list_tracked_links' && res.status === 'ok'
              ? attributionOf(res.data)
              : undefined
          findings.push({
            tool: call.tool,
            status: res.status,
            ...found,
            ...(collabs === undefined ? {} : { collabs }),
            ...(attribution ?? {}),
            ...(call.tool === 'list_deliverables' && res.status === 'ok'
              ? { deliverables: deliverablesOf(res.data) ?? [] }
              : {}),
            ...(count === undefined ? {} : { count }),
            ...(res.reason === undefined ? {} : { reason: res.reason }),
            ...(receipt.approval_item_id === undefined && receipt.change_id === undefined
              ? {}
              : { receipt }),
          })
        }
        const band = parseFollowerBand(kol.ctx.text)
        const wanted = parseWantedCount(kol.ctx.text)
        /*
         * WP142：回话里的站内链接。岗位页按**分配 id** 开（`/positions/<分配>`），
         * 候选池与导入都是那一页的子视图；关联官方数据接口在「账号与积分」。
         */
        const home = `/positions/${encodeURIComponent(req.actor.assignment_id)}?tab=view`
        const answer = renderKolAnswer({
          intent: kol.intent,
          channel: kol.channel,
          findings,
          ...(band === undefined ? {} : { band }),
          ...(wanted === undefined ? {} : { wanted }),
          links: {
            pool: `${home}&kol=pool`,
            linkAccount: '/settings/credits',
            importTable: `${home}&kol=campaign`,
            threads: `${home}&kol=threads`,
          },
          quietDays: parseQuietDays(kol.ctx.text),
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const found = findings.find((f) => f.tool === 'search_creators')?.count
        const summary = describeKolRun({
          intent: kol.intent,
          readTools,
          ...(found === undefined ? {} : { found }),
          drafted: findings.some((f) => f.tool === 'draft_outreach' && f.status === 'ok'),
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP418（自查 A8 / A20）：**上线检查单**（演示用剧本）。工具面里有 site_checklist_run、话里问「还差什么才能开门」
       * → 真跑一遍检查单（服务端那一份，读不到的照实写「没读到」），把结论念出来。别的问法一个字节不变。
       */
      const checklistStep = siteChecklistBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (checklistStep !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: checklistStep.tool, input: checklistStep.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: checklistStep.tool,
                input: checklistStep.input,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(checklistStep.tool)
        const answer = renderSiteChecklistAnswer(
          res.status === 'ok' ? res.data : undefined,
          res.reason === 'no_tool_executor' ? '这个进程没接工具' : res.reason,
        )
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP421（决策 1266–1270）：公关 / 内容与搜索 / B2B / 设计的读数与起草工具（演示用剧本）。
       * 工具面里有、话对得上才走：调一次工具，把它回的那句结论 + 明细照抄成回话；别的问法一个字节不变。
       */
      const deskText = [
        threadText,
        plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? ''),
      ].join('\n')
      const deskStep = deskBranch(req, deskText)
      if (deskStep !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: deskStep.tool, input: deskStep.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: deskStep.tool,
                input: deskStep.input,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(deskStep.tool)
        const answer = renderDeskAnswer(
          res.status === 'ok' ? deskToolDataOf(res.data) : undefined,
          res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? ''),
        )
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP385（决策 1076）：**网站体检**（演示用剧本）。工具面里有 query_site_health：
       * 话里给了商品 feed / 平台上架页网址 → 要一张体检设置卡（已经是这样了就读一次体检结论接着说）；
       * 问体检 / AI 爬虫 / AI 带来的成交 → 读体检结论。别的问法一个字节不变。
       */
      const healthStep = siteHealthBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (healthStep !== undefined) {
        const callHost = async (
          tool: string,
          input: Record<string, unknown>,
        ): Promise<{ status: string; data?: unknown; reason?: string }> => {
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input })
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: tool, input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status === 'ok') readTools.push(tool)
          return res
        }
        const failedOf = (res: { reason?: string }): string =>
          res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? '')
        let answer: string
        if (healthStep.kind === 'setup') {
          const res = await callHost(healthStep.tool, healthStep.input)
          const data = res.status === 'ok' ? setupRequestDataOf(res.data) : undefined
          if (data?.already === true) {
            // 设好了（或本来就是这样）：读一次体检结论（正在按新设置体检就等它跑完）
            const q = await callHost('query_site_health', {})
            answer = `设好了。${renderSiteHealthAnswer(
              q.status === 'ok' ? siteHealthQueryDataOf(q.data) : undefined,
              failedOf(q),
            )}`
          } else
            answer = renderSetupRequestAnswer({
              ...(data === undefined ? {} : { data }),
              ...(res.status === 'ok' ? {} : { failed: failedOf(res) }),
            })
        } else {
          const res = await callHost(healthStep.tool, healthStep.input)
          answer = renderSiteHealthAnswer(
            res.status === 'ok' ? siteHealthQueryDataOf(res.data) : undefined,
            failedOf(res),
          )
        }
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP419：**社媒发帖 / Reddit 起草出卡**（演示用剧本）。工具面里有这几个工具、话里是「有哪些等着回」→ 列出来、
       * 给前三条出回复卡；「发一条 / 置顶公告」→ 按原话当要点出一张发帖卡；「排下周」→ 看一眼日历、排三条；「起草一条」→ 一条。
       */
      const socialStep = socialWorkBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (socialStep !== undefined) {
        const callHost = async (
          tool: string,
          input: Record<string, unknown>,
        ): Promise<{ status: string; data?: unknown; reason?: string }> => {
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input })
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: tool, input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status === 'ok') readTools.push(tool)
          return res
        }
        const failedOf = (res: { reason?: string }): string =>
          res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? '')
        let answer: string
        if (socialStep.kind === 'reddit_pending') {
          const res = await callHost(LIST_REDDIT_PENDING_TOOL, { state: 'all' })
          const data = res.status === 'ok' ? redditPendingDataOf(res.data) : undefined
          answer = renderRedditPending(data, failedOf(res))
          const waiting = (data?.rows ?? []).filter((r) => r.state === 'waiting').slice(0, 3)
          if (waiting.length > 0 && req.tools.allow.includes(STAGE_REDDIT_WRITE_TOOL)) {
            const staged = []
            for (const r of waiting) {
              const s = await callHost(STAGE_REDDIT_WRITE_TOOL, {
                mode: 'reply',
                item_id: r.item_id,
              })
              staged.push(s.status === 'ok' ? stagedDataOf(s.data) : undefined)
            }
            answer = `${answer}\n${renderStaged(staged)}`
          }
        } else if (socialStep.kind === 'reddit_post') {
          const res = await callHost(STAGE_REDDIT_WRITE_TOOL, socialStep.input)
          answer = renderStaged(
            [res.status === 'ok' ? stagedDataOf(res.data) : undefined],
            failedOf(res),
          )
        } else {
          const look = await callHost(LIST_SOCIAL_POSTS_TOOL, {})
          const cal = look.status === 'ok' ? socialPostsDataOf(look.data) : undefined
          if (cal !== undefined && cal.accounts.length === 0)
            answer = cal.note ?? '这条渠道还没登记要发帖的号，先连上再排。'
          else {
            const slots =
              socialStep.kind === 'social_week'
                ? demoWeekSlots(clock.now())
                : [demoWeekSlots(clock.now())[0] ?? clock.now()]
            const staged = []
            for (const [i, at] of slots.entries()) {
              const body =
                socialStep.kind === 'social_one'
                  ? `【演示草稿】${socialStep.text.slice(0, 200)}`
                  : `【演示草稿 ${i + 1}/${slots.length}】这周的新内容（演示里没有真文案，接上真模型会按素材和表现写）`
              const s = await callHost(STAGE_SOCIAL_POST_TOOL, { body, scheduled_at: at })
              staged.push(s.status === 'ok' ? stagedDataOf(s.data) : undefined)
            }
            answer = renderStaged(staged, failedOf(look))
          }
        }
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP390（docs/105 §4）：**工坊服务**（演示用剧本）。点了「看看」（话里是「我想看看「X」（工坊服务）」）→ 查一次、
       * 出价目单 / 需求单；话里有找人代办的意向 → 查一次（推荐卡由宿主挂在回答末尾），正常回答。
       */
      const svcStep = workshopServiceBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (svcStep !== undefined && options.executeTool !== undefined) {
        const exec = options.executeTool
        const call = async (tool: string, input: Record<string, unknown>) => {
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input })
          const res = await exec({ name: tool, input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status === 'ok') readTools.push(tool)
          return res
        }
        const intent = svcStep.kind === 'start' ? svcStep.name : svcStep.intent
        const found = await call(FIND_SERVICE_TOOL, { intent })
        const data = found.status === 'ok' ? findServiceDataOf(found.data) : undefined
        let answer: string
        if (found.status !== 'ok')
          answer = renderWorkshopServiceAnswer({ failed: found.reason ?? '' })
        else if (svcStep.kind === 'start' && data?.services[0] !== undefined) {
          const drafted = await call(DRAFT_SERVICE_ORDER_TOOL, { service_id: data.services[0].id })
          const d = (drafted.data ?? {}) as { ok?: boolean; form?: string; message?: string }
          answer =
            drafted.status === 'ok'
              ? renderWorkshopServiceAnswer({
                  drafted: {
                    ok: d.ok === true,
                    ...(d.form === 'service_menu' || d.form === 'service_requirements'
                      ? { form: d.form }
                      : {}),
                    message: d.message ?? '',
                  },
                })
              : renderWorkshopServiceAnswer({ failed: drafted.reason ?? '' })
        } else answer = renderWorkshopServiceAnswer(data === undefined ? {} : { found: data })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP334（决策 724）：**AI 自己要卡**（演示用剧本）。工具面里有 request_setup、话里明说「先连上 X / 先填好 Y」，
       * 就要一张卡（运行时收尾出卡、补完按原话接着做）；已经连上 / 设好了，工具说一声、这一轮照实说。
       * 排在「店主问岗位 / 连接」前面：明说「先连上 X」是要连，不是问连了哪些。
       */
      const setupStep = setupRequestBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (setupStep !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: setupStep.tool, input: setupStep.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: setupStep.tool,
                input: setupStep.input,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(setupStep.tool)
        const data = res.status === 'ok' ? setupRequestDataOf(res.data) : undefined
        const answer = renderSetupRequestAnswer({
          ...(data === undefined ? {} : { data }),
          ...(res.status === 'ok'
            ? {}
            : {
                failed: res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? ''),
              }),
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP410（真机 #9）：**问连接 / 设置现在怎样**（演示用剧本）。上下文里有「当前设置快照」
       * （服务端每次运行现取：插件交回的连接、设置原值、最近一轮）就照它原样说，不靠记忆。
       * 没有快照的职责 / 别的问法一个字节不变。
       */
      const stateAnswer = setupStateBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (stateAnswer !== undefined) {
        outputs.push({ kind: 'answer', text: stateAnswer })
        usage.output_tokens = Math.ceil(stateAnswer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: stateAnswer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP153（09-26 真账号冒烟 §3）：**店主问岗位 / 连接**。
       *
       * 店主职责、工具面里有 `list_positions` / `list_connections`、问的又是岗位或连接，
       * 就去调这两个只读工具，把结果说成人话（粗体、列表、编号：时间线会渲染出来），
       * 最后排出「最该先处理的三件事」。别的问法照旧往下走（一个字节不变）。
       */
      const ownerCalls = ownerBranch(
        req,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (ownerCalls !== undefined) {
        let positions: OwnerPositionsData | undefined
        let connections: OwnerConnectionsData | undefined
        const failed: Record<string, string> = {}
        for (const tool of ownerCalls) {
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input: {} })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            break
          }
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: tool, input: {}, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status !== 'ok') {
            failed[tool] = res.reason === 'no_tool_executor' ? '这个进程没接工具' : '这一步没走通'
            continue
          }
          readTools.push(tool)
          if (tool === OWNER_POSITIONS_TOOL) positions = positionsOf(res.data)
          if (tool === OWNER_CONNECTIONS_TOOL) connections = connectionsOf(res.data)
        }
        const answer = renderOwnerAnswer({
          ...(positions === undefined ? {} : { positions }),
          ...(connections === undefined ? {} : { connections }),
          failed,
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        // 摘要：回话的第一句（与 direct / dsh 同一份拼法，WP153 §2）
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP331：**报告剧本**（两段，见 `report-playbook.ts`）。都放在定时那一段前面：
       * 到点那次运行（外框 `[SCHEDULE REMINDER`）在要报告 → 取数 → 按提示词里的顺序拼 → 发布；
       * 「把第三节放最前面」→ 列这件事里的定时 → 改那条的提示词（下一次就按新顺序出）。
       * 工具面里没有 `publish_report` / `schedule_update` 的运行一个字节不变。
       */
      const plan = reportPlan(req.tools.allow, threadText)
      // WP411（#13）：「把 10-11 到 10-16 补一下」→ 先看计划、说一句，再照做
      const fill =
        plan === undefined ? backfillAsk(req.tools.allow, threadText, clock.now()) : undefined
      const reorder =
        plan === undefined &&
        fill === undefined &&
        req.tools.allow.includes(SCHEDULE_UPDATE_TOOL) &&
        req.tools.allow.includes(SCHEDULE_LIST_TOOL)
          ? reorderAsk(threadText)
          : undefined
      if (
        (plan !== undefined && req.tools.allow.includes(PUBLISH_REPORT_TOOL)) ||
        fill !== undefined ||
        reorder !== undefined
      ) {
        const callTool = async (
          tool: string,
          input: Record<string, unknown>,
        ): Promise<ToolExecution> => {
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            return { status: 'blocked', reason: 'budget_exhausted' }
          }
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: tool, input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status === 'ok') readTools.push(tool)
          return res
        }
        let answer: string
        if (plan !== undefined) {
          const results = new Map<ReportNeed, unknown>()
          for (const c of plan.calls) {
            if (signal.aborted) {
              sink(cancelledEvent(signal))
              return finish('cancelled', '运行被中断')
            }
            const res = await callTool(c.tool, c.input)
            if (res.status === 'ok' && c.need !== undefined) results.set(c.need, res.data)
          }
          const doc = composeStubReport(plan, results)
          const res = await callTool(PUBLISH_REPORT_TOOL, { ...doc })
          const data = (res.data ?? {}) as { version?: unknown }
          answer =
            res.status === 'ok'
              ? `已发布「${doc.title}」${typeof data.version === 'number' && data.version > 1 ? `（第 ${data.version} 版）` : ''}，在报表区。`
              : `报告没发出去：${res.reason ?? '这一步没走通'}`
        } else if (fill !== undefined) {
          const reddit = /reddit|(^|[\s（(])r\//iu.test(threadText) ? { platform: 'reddit' } : {}
          const preview = await callTool(RUN_WATCH_NOW_TOOL, { ...reddit, ...fill, preview: true })
          const p = (preview.data ?? {}) as { ok?: boolean }
          const done =
            p.ok === true ? await callTool(RUN_WATCH_NOW_TOOL, { ...reddit, ...fill }) : undefined
          answer = backfillAnswer(preview.data, done?.data)
        } else {
          const ask = reorder as { from: number; to: 'first' | 'last' }
          const listed = await callTool(SCHEDULE_LIST_TOOL, {})
          const views = Array.isArray(listed.data)
            ? (listed.data as { id?: unknown; title?: unknown; prompt?: unknown }[])
            : []
          const target = views.find(
            (v) =>
              typeof v.prompt === 'string' &&
              (splitNumbered(v.prompt)?.items.length ?? 0) > ask.from,
          )
          const prompt = typeof target?.prompt === 'string' ? target.prompt : undefined
          const count = prompt === undefined ? 0 : (splitNumbered(prompt)?.items.length ?? 0)
          const next =
            prompt === undefined
              ? undefined
              : reorderNumbered(prompt, ask.from, ask.to === 'first' ? 0 : count - 1)
          if (target === undefined || next === undefined) {
            answer = '这件事里没找到能改顺序的那条定时（要有编了号的几节）。'
          } else {
            const res = await callTool(SCHEDULE_UPDATE_TOOL, { id: target.id, prompt: next })
            const order = splitNumbered(next)?.items ?? []
            answer =
              res.status === 'ok'
                ? `改好了，以后按这个顺序出：\n${order.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
                : `没改成：${res.reason ?? '这一步没走通'}`
          }
        }
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP181：官方「自动化任务」。工具面里有 `schedule_create`（装了那个官方插件）、话里在要提醒 / 定时，
       * 就调一次 `schedule_create`，把结果说成人话。别的运行一个字节不变。
       */
      const scheduleInput = scheduleBranch(
        req.tools.allow,
        [threadText, plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? '')].join('\n'),
      )
      if (scheduleInput !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: SCHEDULE_CREATE_TOOL, input: scheduleInput })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: SCHEDULE_CREATE_TOOL,
                input: scheduleInput,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        const answer =
          res.status === 'ok'
            ? renderScheduleAnswer(res.data)
            : `这条定时没设成：${res.reason ?? '这一步没走通'}`
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools: res.status === 'ok' ? [SCHEDULE_CREATE_TOOL] : [],
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP176：**主动开发问开发信**。工具面里有开发信工具、问的是起草 / 开一轮 / 进度 / 回信，
       * 就去调：先列序列（看还差什么），要开一轮再开（出卡，不直接发），把结果说成人话。
       * 别的问法照旧往下走（一个字节不变）。
       */
      const b2bText = [
        threadText,
        plainText(itemsOfKind(req, 'matter_summary')[0]?.content ?? ''),
      ].join('\n')
      const b2bCalls = b2bOutboundBranch(req, b2bText)
      if (b2bCalls !== undefined) {
        let sequences: B2bSequencesData | undefined
        let started: B2bStartRoundData | undefined
        const failed: Record<string, string> = {}
        for (const tool of b2bCalls) {
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool, input: {} })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            break
          }
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: tool, input: {}, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status !== 'ok') {
            failed[tool] =
              res.reason === 'no_tool_executor'
                ? '这个进程没接工具'
                : (res.reason ?? '这一步没走通')
            continue
          }
          readTools.push(tool)
          if (tool === B2B_LIST_SEQUENCES_TOOL) sequences = sequencesOf(res.data)
          if (tool === B2B_START_ROUND_TOOL) started = startRoundOf(res.data)
        }
        const answer = renderB2bOutboundAnswer({
          ...(sequences === undefined ? {} : { sequences }),
          ...(started === undefined ? {} : { started }),
          replies: !b2bCalls.includes(B2B_START_ROUND_TOOL) && /回信|回复|分类|repl/i.test(b2bText),
          failed,
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP253：**网页模板做主题**。工具面里有主题工具、说的是搭 / 改 / 预览 / 发布，就去调：
       * 起底（说了 Horizon / 从头搭才起：在店里复制一份 Horizon）→ 官方检查 → 推一份未发布副本（预览链接）；说发布 →
       * 列一次、对最新那份副本出发布卡（不直接发）。stub 不会写 Liquid，改文件留给真模型。
       * WP301：工具回话说工作目录是旧的自带主题 → 当场插一步起底，在 Horizon 上新起一份再接着检查、推预览。
       */
      /*
       * WP268：**出图**（演示用剧本）。工具面里有生图、说的是出图，就调一次 generate_image：
       * 出一批进素材库、事项里出挑图卡（不在这里定稿）。放在主题那一段前面：「出首页横幅图」两边都认得。
       */
      /*
       * WP323：**记录去处**（演示用剧本）。工具面里有它、话里有一张在线表格的链接、说的是「记到 / 写进」，
       * 就调一次 propose_record_sink（按表头自动对列、出「定规矩」卡；不直接生效）。
       */
      const sinkStep = recordSinkBranch(req, b2bText)
      if (sinkStep !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: sinkStep.tool, input: sinkStep.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: sinkStep.tool,
                input: sinkStep.input,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(sinkStep.tool)
        const data = res.status === 'ok' ? recordSinkDataOf(res.data) : undefined
        const answer = renderRecordSinkAnswer({
          ...(data === undefined ? {} : { data }),
          ...(res.status === 'ok'
            ? {}
            : {
                failed: res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? ''),
              }),
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP441：**一句话写消息规则**（演示用剧本）。工具面里有它、话里像是在给一类来信定规矩（「…的都告诉我」
       * 「…打标签、别烦我」），就调一次 propose_message_rule（服务端转规则、试跑、出「要建吗」卡；不直接生效）。
       */
      const ruleStep = messageRuleBranch(req, b2bText)
      if (ruleStep !== undefined) {
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: ruleStep.tool, input: ruleStep.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({
                name: ruleStep.tool,
                input: ruleStep.input,
                request: req,
              })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(ruleStep.tool)
        const data = res.status === 'ok' ? messageRuleDataOf(res.data) : undefined
        const answer = renderMessageRuleAnswer({
          ...(data === undefined ? {} : { data }),
          ...(res.status === 'ok'
            ? {}
            : {
                failed: res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? ''),
              }),
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      const imageCalls = imageBranch(req, b2bText)
      if (imageCalls !== undefined) {
        const step = imageCalls[0] as { tool: string; input: Record<string, unknown> }
        const call_id = `call_${toolCalls + 1}`
        sink({ type: 'tool.call', call_id, tool: step.tool, input: step.input })
        const res =
          options.executeTool === undefined
            ? { status: 'error' as const, reason: 'no_tool_executor' }
            : await options.executeTool({ name: step.tool, input: step.input, request: req })
        toolCalls += 1
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
        })
        if (res.status === 'ok') readTools.push(step.tool)
        const data = res.status === 'ok' ? imageDataOf(res.data) : undefined
        const answer = renderImageAnswer({
          ...(data === undefined ? {} : { data }),
          ...(res.status === 'ok'
            ? {}
            : {
                failed: res.reason === 'no_tool_executor' ? '这个进程没接工具' : (res.reason ?? ''),
              }),
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      const themeCalls = themeBranch(req, b2bText)
      if (themeCalls !== undefined) {
        const failed: Record<string, string> = {}
        let initialized = false
        let check: ThemeCheckData | undefined
        let pushed: ThemePushData | undefined
        let published: ThemePublishData | undefined
        let legacy: ThemeLegacyData | undefined
        let init: ThemeInitData | undefined
        let choice: ThemeChoiceData | undefined
        const queue: ThemeStep[] = [...themeCalls]
        while (queue.length > 0) {
          const step = queue.shift() as ThemeStep
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool: step.tool, input: step.input })
          if (toolCalls >= req.budget.max_tool_calls) {
            exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
            sink({ type: 'budget.exhausted', ...exhausted })
            sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
            break
          }
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: step.tool, input: step.input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          const old = legacyNoticeOf(res.data)
          legacy = old ?? legacy
          // WP301：旧的自带主题那一份 → 先在 Horizon 上新起一份（只插一次），再检查、推预览
          if (
            old !== undefined &&
            !initialized &&
            step.tool !== THEME_INIT_TOOL &&
            req.tools.allow.includes(THEME_INIT_TOOL) &&
            [step, ...queue].some((q) => q.tool === THEME_PUSH_TOOL)
          ) {
            const rest = queue.filter(
              (q) => q.tool !== THEME_CHECK_TOOL && q.tool !== THEME_INIT_TOOL,
            )
            queue.splice(
              0,
              queue.length,
              { tool: THEME_INIT_TOOL, input: {} },
              { tool: THEME_CHECK_TOOL, input: {} },
              ...rest.filter((q) => q.tool !== THEME_PUSH_TOOL),
              ...(step.tool === THEME_PUSH_TOOL
                ? [step]
                : rest.filter((q) => q.tool === THEME_PUSH_TOOL)),
            )
            continue
          }
          if (res.status !== 'ok') {
            failed[step.tool] =
              res.reason === 'no_tool_executor'
                ? '这个进程没接工具'
                : // 旧的自带主题那一句开头已经说过了，原因里不再重复
                  (res.reason ?? '这一步没走通').replace(
                    legacy === undefined ? /$^/ : `\n${legacy.message}`,
                    '',
                  )
            // 前一步没走通，后面的推送 / 发布不再接着做（不在没检查过的东西上出预览）
            break
          }
          readTools.push(step.tool)
          if (step.tool === THEME_INIT_TOOL) {
            // WP304：出了一张选主题卡 → 这次就停在这儿（人选了服务端起底、按原话再跑一次）
            choice = choiceOf(res.data)
            if (choice !== undefined) break
            initialized = true
            init = initOf(res.data)
          }
          if (step.tool === THEME_CHECK_TOOL) {
            check = checkOf(res.data)
            if (check !== undefined && check.errors > 0) break
          }
          if (step.tool === THEME_PUSH_TOOL) pushed = pushedOf(res.data)
          if (step.tool === THEME_LIST_TOOL) {
            const copy = latestCopyOf(res.data)
            if (copy === undefined)
              failed[THEME_PUBLISH_TOOL] = '店里还没有未发布的副本，先推一份预览'
            else queue.push({ tool: THEME_PUBLISH_TOOL, input: { theme_id: copy.id } })
          }
          if (step.tool === THEME_PUBLISH_TOOL) {
            published = publishOf(res.data)
            if (published?.change_id !== undefined) {
              sink({ type: 'change.staged', change_id: published.change_id })
              outputs.push({ kind: 'staged_change', change_id: published.change_id })
            }
          }
        }
        const answer = renderThemeAnswer({
          initialized,
          ...(check === undefined ? {} : { check }),
          ...(pushed === undefined ? {} : { pushed }),
          ...(published === undefined ? {} : { published }),
          ...(legacy === undefined ? {} : { legacy }),
          ...(init === undefined ? {} : { init }),
          ...(choice === undefined ? {} : { choice }),
          failed,
        })
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
          ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish(exhausted ? 'budget_exhausted' : 'completed', summary)
      }

      /*
       * WP261：**独立站运营**（演示用剧本）。工具面里有改商品的工具、说的是改商品，就：列商品 → 读第一件 →
       * 出一张改标题的卡（不直接改；人批了执行器才去店里改）。stub 不会写文案，标题只加「（新版）」。
       */
      /*
       * WP420（自查 ads-amazon A11 / B2）：**投放**与 **Amazon 运营**的演示剧本（查数 → 止损卡；Listing 体检 / 词库）。
       * 工具面里没有那几个工具（托管实例、别的职责）就不进来，一个字节不变。
       */
      const adsAmazon = adsAmazonScriptOf(req)
      if (adsAmazon !== undefined) {
        const exec = async (step: ScriptStep): Promise<ToolExecution> => {
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool: step.tool, input: step.input })
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: step.tool, input: step.input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          return res
        }
        const out =
          adsAmazon === 'ads'
            ? // WP452：话里点到体检 / 保本线 / 落地页 / 实验结果就走那一样，否则照旧查数 → 止损
              ((await runAdsSkillScript(exec, b2bText, req.tools.allow)) ??
              (await runAdsScript(exec)))
            : await runAmazonScript(exec, b2bText, req.tools.allow)
        for (const change_id of out.staged) {
          sink({ type: 'change.staged', change_id })
          outputs.push({ kind: 'staged_change', change_id })
        }
        readTools.push(...out.readTools)
        outputs.push({ kind: 'answer', text: out.answer })
        usage.output_tokens = Math.ceil(out.answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: out.answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      const shopCalls = shopBranch(req, b2bText)
      if (shopCalls !== undefined) {
        const failed: string[] = []
        let staged: ShopStagedData | undefined
        const queue: ShopStep[] = [...shopCalls]
        while (queue.length > 0) {
          const step = queue.shift() as ShopStep
          if (signal.aborted) {
            sink(cancelledEvent(signal))
            return finish('cancelled', '运行被中断')
          }
          const call_id = `call_${toolCalls + 1}`
          sink({ type: 'tool.call', call_id, tool: step.tool, input: step.input })
          const res =
            options.executeTool === undefined
              ? { status: 'error' as const, reason: 'no_tool_executor' }
              : await options.executeTool({ name: step.tool, input: step.input, request: req })
          toolCalls += 1
          sink({
            type: 'tool.result',
            call_id,
            status: res.status,
            ...(res.reason === undefined ? {} : { reason: res.reason }),
          })
          if (res.status !== 'ok') {
            failed.push(res.reason ?? '这一步没走通')
            break
          }
          readTools.push(step.tool)
          if (step.tool === SHOP_LIST_PRODUCTS_TOOL) {
            const first = firstProductOf(res.data)
            if (first === undefined) failed.push('店里还没有商品')
            else queue.push({ tool: SHOP_GET_PRODUCT_TOOL, input: { id: first.id } })
          } else if (step.tool === SHOP_GET_PRODUCT_TOOL) {
            const p = res.data as { id?: unknown; title?: unknown }
            if (typeof p.id === 'string' && typeof p.title === 'string')
              queue.push({
                tool: SHOP_SAVE_PRODUCT_TOOL,
                input: { id: p.id, title: `${p.title}（新版）` },
              })
          } else if (
            step.tool === SHOP_SAVE_PRODUCT_TOOL ||
            step.tool === SHOP_SAVE_REDIRECTS_TOOL
          ) {
            // WP446：改跳转那条剧本一步就出卡
            staged = shopStagedOf(res.data)
            if (staged?.change_id !== undefined) {
              sink({ type: 'change.staged', change_id: staged.change_id })
              outputs.push({ kind: 'staged_change', change_id: staged.change_id })
            }
          }
        }
        const answer =
          staged !== undefined ? staged.message : `没出成卡：${failed[0] ?? '这一步没走通'}`
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = describeRun({
          readTools,
          drafted: false,
          reply: answer,
          tools: req.tools.allow,
        })
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: toolCalls,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP120（69 §3 第 3 条）：**没有剧本的域到此为止**。
       *
       * WP117 给红人开了岔口，但剩下三十多条职责仍然往下掉进客服那条路——
       * 于是投放岗位在演示里也会去问一句退货窗口。那与 69 §0 那条亲测记录
       * 是同一个毛病，只是还没有人去点它。
       *
       * 所以：这条职责在 `playbookOf` 里查不到剧本，就回一句人话然后结束。
       * **不调工具、不 stage、不起草、不出一张卡**——桩根本没做的事，
       * 出一张"请批准"的卡比什么都不做糟得多。
       */
      if (playbookOf(req.actor.role_id) === undefined) {
        const answer = noPlaybookAnswer(req.actor.role_id)
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = noPlaybookSummary(req.actor.role_id)
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: 0,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      /*
       * WP415（自查 R8）：客服剧本只会照着一封来信写回信。没有真来信（只有这件事的原话）、
       * 原话又是一句查询时，不再把问题本身当成要回的信——照实说演示里没有这段，不起草、不出卡。
       */
      const realThread = itemsOfKind(req, 'thread').find(
        (i) => typeof i.source_ref === 'string' || i.source_ref.type !== 'matter',
      )
      if (
        realThread === undefined &&
        itemsOfKind(req, 'order').length === 0 &&
        isQueryBrief(threadText)
      ) {
        const answer = noSceneForQueryAnswer()
        outputs.push({ kind: 'answer', text: answer })
        usage.output_tokens = Math.ceil(answer.length / 4) + (seed % 7)
        const summary = '演示里没有这段（查询类）：没有调工具、没有起草、没有出卡'
        sink({
          type: 'run.completed',
          usage: {
            ...usage,
            tool_calls: 0,
            seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
            cost_base: 0,
          },
          outputs,
          summary,
        })
        return finish('completed', summary)
      }

      const orderItem = itemsOfKind(req, 'order')[0]
      let order = orderItem ? orderView(orderItem.content, refOf(orderItem)) : undefined
      const policy = returnWindowDays(req, defaultWindow)

      // 4) grounding：命中即先调工具；没命中但有订单 → 默认 get_order
      const hitRules = req.grounding.filter((r) => hitsRule(threadText, r))
      const plannedTools =
        hitRules.length > 0 ? hitRules.map((r) => r.tool) : order || orderItem ? ['get_order'] : []

      for (const tool of plannedTools) {
        if (signal.aborted) {
          sink(cancelledEvent(signal))
          return finish('cancelled', '运行被中断')
        }
        const call_id = `call_${toolCalls + 1}`
        const input = toolInput(tool, { order, orderItem, threadItem, threadText })
        sink({ type: 'tool.call', call_id, tool, input })

        if (toolCalls >= req.budget.max_tool_calls) {
          exhausted = { which: 'max_tool_calls', used: toolCalls, cap: req.budget.max_tool_calls }
          sink({ type: 'budget.exhausted', ...exhausted })
          // 17 §5.3：补齐未闭合的工具调用再结束
          sink({ type: 'tool.result', call_id, status: 'blocked', reason: 'budget_exhausted' })
          break
        }
        if (toolCalls + 1 === req.budget.max_tool_calls) {
          sink({
            type: 'budget.warning',
            which: 'max_tool_calls',
            used: toolCalls + 1,
            cap: req.budget.max_tool_calls,
          })
        }

        const exec = options.executeTool
        if (!exec) {
          sink({ type: 'tool.result', call_id, status: 'error', reason: 'no_tool_executor' })
          toolCalls += 1
          continue
        }
        const res = await exec({ name: tool, input, request: req })
        toolCalls += 1
        if (res.status === 'ok') readTools.push(tool)
        const refs = res.status === 'ok' ? (res.provenance ?? inferRefs(res.data)) : []
        if (refs.length > 0) prov.see(refs, { full: true })
        if (res.status === 'ok' && !order) order = orderView(res.data)
        sink({
          type: 'tool.result',
          call_id,
          status: res.status,
          ...(res.reason === undefined ? {} : { reason: res.reason }),
          ...(refs.length > 0 ? { provenance_added: refs } : {}),
        })
      }

      // 5) 起草回复（+ 窗口内的 stage_refund 意图）
      // 1c：分类与边界判定都交给共享判定（`support.ts`），三个运行时同一份口径
      const subjectLine = threadSubject(threadItem)
      const gate = boundaryGate({
        request: req,
        now: clock.now(),
        defaultReturnWindowDays: defaultWindow,
      })
      const wantsChange = gate.wantsChange
      const deliveredMs = order?.delivered_at ? Date.parse(order.delivered_at) : undefined
      const nowMs = Date.parse(clock.now())
      const daysSince =
        deliveredMs === undefined ? undefined : Math.floor((nowMs - deliveredMs) / DAY)
      const withinWindow =
        !exhausted && daysSince !== undefined && daysSince <= policy.days && order !== undefined
      const refundAmount =
        order === undefined
          ? undefined
          : Math.round((order.total_price - order.refunded_amount) * 100) / 100

      const childChangeIds: string[] = []
      let staged = false
      if (
        !exhausted &&
        wantsChange &&
        gate.allowed &&
        withinWindow &&
        order &&
        refundAmount !== undefined &&
        refundAmount > 0 &&
        options.stage &&
        (req.expectations.outputs.includes('staged_change') ||
          req.expectations.must_stage_if_change_requested)
      ) {
        if (prov.has(order.ref)) {
          const intent: StageIntent = {
            request: req,
            kind: 'refund',
            target: order.ref,
            field: 'refunded_amount',
            before: order.refunded_amount,
            after: order.refunded_amount + refundAmount,
            money: { amount: refundAmount, currency: order.currency },
            notes: [
              `退货窗口 ${policy.days} 天内（签收 ${daysSince ?? '?'} 天）`,
              // WP457：来源说人话（原来写「由 stub 运行时按政策提出」，内部词上了卡）
              '照退货政策提出',
            ],
            ...(order.email === undefined
              ? {}
              : { requester: { channel: 'email', external_id: order.email } }),
          }
          const res = await options.stage(intent)
          if (res) {
            staged = true
            childChangeIds.push(res.change_id)
            sink({ type: 'change.staged', change_id: res.change_id })
            outputs.push({ kind: 'staged_change', change_id: res.change_id })
          }
        }
      }

      const askedBoundaries: string[] = []
      // WP232：只有这件事真在要一笔变更才问（`boundariesToAsk`，三个运行时同一份）
      const toAsk = boundariesToAsk(gate)
      if (!exhausted && toAsk.length > 0 && options.createPolicyQuestion) {
        for (const boundary of toAsk) {
          const asked = await options.createPolicyQuestion({ request: req, boundary })
          if (asked === undefined) continue
          askedBoundaries.push(boundary.label)
          sink({
            type: 'proposal.created',
            approval_item_id: asked.approval_item_id,
            kind: 'policy_change',
          })
          outputs.push({ kind: 'proposal', approval_item_id: asked.approval_item_id })
        }
      }

      let body = ''
      if (!exhausted && req.expectations.outputs.includes('draft') && options.createDraft) {
        const customer =
          order?.customer_name ??
          order?.email?.split('@')[0] ??
          threadRecipient(threadItem) ??
          'there'
        const subject = subjectLine ?? replySubject(undefined, order, req.vertical)
        body = renderReplyBody({
          windowDays: policy.days,
          withinWindow,
          windowFromFact: policy.source !== undefined,
          signature,
          customer,
          ...(req.vertical === undefined ? {} : { vertical: req.vertical }),
          ...(order === undefined ? {} : { order }),
          ...(daysSince === undefined ? {} : { daysSinceDelivery: daysSince }),
          ...(staged && refundAmount !== undefined ? { refundAmount } : {}),
        })
        const to = order?.email ? [order.email] : threadParticipants(threadItem)
        // WP55：Amazon 站内信上，真模型最常见的那一次违规就是把知识库里的官网
        // 链接原样抄进正文（1% 的概率落在真账号上就是不可逆的处置）。三个运行时
        // 共用同一份复现（`marketplaceLinkSlip`），好让硬闸 → 打回重写 → 再提交
        // 这条路在每个运行时下都真的走一遍。
        body = marketplaceLinkSlip(body, to)
        const payload: DraftPayload = {
          request: req,
          channel: 'email',
          to,
          subject,
          body,
          child_change_ids: childChangeIds,
          citations: policy.source
            ? [
                {
                  fact_card_id: policy.source.id,
                  quote: `returns within ${policy.days} days of delivery`,
                },
              ]
            : [],
          ...(threadItem === undefined ? {} : { thread_external_id: threadItem.id }),
        }
        // WP55 / 48 §4 L3 #2：出站硬闸的重写循环。
        //
        // 真模型最常见的那一次违规是「把知识库里的官网链接原样抄进正文」——
        // 桩在 `renderReplyBody` 之后照着写一遍（见下），被闸拦下之后按原因重写。
        // 只重写一次：修不好的那几类（附件 / 主题）本来就不该进重写循环。
        let draft = await options.createDraft(payload)
        if (draft !== undefined && 'rewrite' in draft) {
          // 出站硬闸把这一版打回了：原因进进度流（人能看见「为什么重写了一次」）
          sink({
            type: 'progress',
            step: 'channel_guard_rewrite',
            note: draft.rewrite.split('\n')[1] ?? '',
          })
          body = rewriteForChannelGuard(body)
          draft = await options.createDraft({ ...payload, body })
        }
        if (draft !== undefined && 'approval_item_id' in draft) {
          sink({
            type: 'proposal.created',
            approval_item_id: draft.approval_item_id,
            kind: 'outbound_draft',
          })
          outputs.push({ kind: 'draft', approval_item_id: draft.approval_item_id })
        }
      }

      usage.output_tokens = Math.ceil(body.length / 4) + (seed % 7)

      /*
       * WP423：预算到了也要交东西（与 direct / dsh 同口径）——要答复的运行交一段照实拼的收尾：
       * 为什么停、已经做了什么、还差什么、点「接着做」。只要草稿 / 变更的运行（客服回信）一个字节不变。
       */
      if (exhausted !== undefined && req.expectations.outputs.includes('answer')) {
        sink({ type: 'progress', step: WRAP_UP_STEP, note: exhausted.which })
        outputs.push({
          kind: 'answer',
          text: wrapUpFallback({ which: exhausted.which, readTools }),
        })
      }

      const noStage = req.expectations.must_stage_if_change_requested && wantsChange && !staged
      // 17 §3：摘要是给下一次运行与人看的，写成一句人话（三个运行时同一份拼法）
      const summary = describeRun({
        readTools,
        drafted: body.length > 0,
        askedBoundaries,
        ...(order === undefined ? {} : { orderName: order.name }),
        ...(staged && refundAmount !== undefined && order !== undefined
          ? { staged: { kind: 'refund', amount: refundAmount, currency: order.currency } }
          : {}),
        ...(exhausted === undefined ? {} : { exhausted: exhausted.which }),
      })
      sink({
        type: 'run.completed',
        usage: {
          ...usage,
          tool_calls: toolCalls,
          seconds: Math.max(0, (Date.parse(clock.now()) - startedMs) / 1000),
          cost_base: 0,
        },
        outputs,
        summary,
      })
      return finish(
        exhausted ? 'budget_exhausted' : 'completed',
        summary,
        noStage ? { no_stage: true } : undefined,
      )
    },
  }
}

function toolInput(
  tool: string,
  ctx: {
    order: OrderView | undefined
    orderItem: ContextItem | undefined
    threadItem: ContextItem | undefined
    threadText: string
  },
): Record<string, unknown> {
  const orderId = ctx.order?.id ?? refOfMaybe(ctx.orderItem)?.id ?? orderIdFromText(ctx.threadText)
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  switch (bare) {
    case 'get_order':
      return orderId === undefined ? {} : { order_id: orderId }
    case 'list_orders':
      return ctx.order?.email === undefined ? {} : { email: ctx.order.email }
    case 'get_product':
      return {}
    case 'search_policies':
      return { query: 'return window' }
    case 'list_threads':
      return ctx.threadItem === undefined ? {} : { thread_id: ctx.threadItem.id }
    default:
      return {}
  }
}

function refOfMaybe(item?: ContextItem): ObjectRef | undefined {
  return item === undefined ? undefined : refOf(item)
}

function orderIdFromText(text: string): string | undefined {
  const m = text.match(/#(\d{3,})/)
  return m?.[1] === undefined ? undefined : `ord_${m[1]}`
}

/** 工具结果里认得出的实体 → provenance（15 §6 只证明"读过"）。 */
function inferRefs(data: unknown): ObjectRef[] {
  const o =
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  if (!o) return []
  const refs: ObjectRef[] = []
  if (typeof o.id === 'string') {
    if ('financial_status' in o || 'line_items' in o) refs.push({ type: 'order', id: o.id })
    else if ('price' in o && 'title' in o) refs.push({ type: 'product', id: o.id })
  }
  if (Array.isArray(o.orders)) {
    for (const item of o.orders) {
      const r =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
      if (typeof r?.id === 'string') refs.push({ type: 'order', id: r.id })
    }
  }
  return refs
}

function threadSubject(item?: ContextItem): string | undefined {
  const o = item === undefined ? undefined : asRecord(item.content)
  const subject = o?.subject
  return typeof subject === 'string'
    ? subject.startsWith('Re:')
      ? subject
      : `Re: ${subject}`
    : undefined
}

function threadParticipants(item?: ContextItem): string[] {
  const o = item === undefined ? undefined : asRecord(item.content)
  const p = o?.participants
  if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  const from = o?.from
  return typeof from === 'string' ? [from] : []
}

function threadRecipient(item?: ContextItem): string | undefined {
  return threadParticipants(item)[0]?.split('@')[0]
}

/** WP179：`web_search` 回来的来源（官方值形状 `{ sources }`；形状不对就当没有）。 */
function webSourcesOf(data: unknown): WebSource[] {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (!Array.isArray(o.sources)) return []
  return o.sources.filter(
    (s): s is WebSource =>
      s !== null && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string',
  )
}

/** WP179：`web_fetch` 回来的状态码（官方值形状 `{ statusCode }`）。 */
function webStatusOf(data: unknown): number {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return typeof o.statusCode === 'number' ? o.statusCode : 0
}
