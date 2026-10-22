/**
 * WP113（63 §4）：**分拣**。每封新来信过一次，产出
 * `{ route, labels[], needs_reply, priority, summary, confidence }`。
 *
 * **先规则后模型**，四层，前三层一个 token 都不花：
 *
 * | 层 | 判据 | 为什么在模型之前 |
 * |---|---|---|
 * | ① 线程归并 | `In-Reply-To` / `References` 命中客服或红人已有线程 | 结构事实，模型答不出比它更准的 |
 * | ② 发件人规则 | 用户教过的（"以后这个发件人都这样"） | 人教过一次就该直达，否则"我教过它"这件事看不见 |
 * | ③ 自动信头 | `List-Unsubscribe` / `noreply@` / `Auto-Submitted` | 一封退订链接俱全的群发，不需要一次模型调用来确认它是群发 |
 * | ④ 模型 | 头 + 正文前 2000 字，**不送附件** | 只有前三层都没话说时才走到这里 |
 *
 * 三条纪律：
 * - **`support` / `kol` 只在对应岗位启用时才可能出现**。没开客服岗位的工作区里，
 *   一封客户投诉照样只是收件箱里打了标签的一封信（Luoye 原话）。
 * - **把握不够就不挪信**（{@link TRIAGE_CONFIDENCE_FLOOR}）：`route` 留 `inbox`，
 *   `suggested_route` 挂上去，界面问一句"像是客服信？"。
 * - **`halt.model` 开着时只跑规则**，剩下的标「未分拣」（`by: 'halted'`）——
 *   不是猜一个，也不是卡住整条收信。
 *
 * 这个文件是**纯函数 + 一个注入口**（{@link TriageModel}）：包内不调模型
 * （22：模型只在网关后面），与 `@agentsws/support-core` 的 `classify.ts` 同一条纪律。
 */

import type {
  MessageKind,
  MessagePriority,
  MessageRoute,
  MessageRule,
  MessageSource,
  MessageTriage,
  SenderRule,
} from '@agentsws/contracts'
import { MESSAGE_KINDS, TRIAGE_CONFIDENCE_FLOOR } from '@agentsws/contracts'
import { looksLikeB2bInquiry, platformInquiryOf } from './b2b-signals.js'
import { isMessageKind, isNoticeKind, kindOfLabels, kindOfRoute } from './kind.js'
import {
  aiRulePrompts,
  applyRuleActions,
  evaluateRule,
  needsAi,
  parseRuleHits,
  type RuleMail,
  type RuleMatch,
  resolveRuleActions,
  ruleApplies,
  sortRules,
} from './message-rules.js'

/** 分拣要看的那几样（全是已解析的头与正文；判定方自己不碰 MIME）。 */
export interface TriageInput {
  from_email: string
  from_name?: string
  subject: string
  /** 纯文本正文（已去引用尾巴）。 */
  text: string
  thread_id: string
  in_reply_to?: string
  references: readonly string[]
  /** 原始头的小抄（小写键）：`list-unsubscribe` / `auto-submitted` / `precedence` … */
  headers: Readonly<Record<string, string>>
  /** 有没有附件（只影响"要不要人看一眼"，不进模型）。 */
  has_attachments: boolean
  /** WP441：收信邮箱（消息规则的「收信邮箱」条件与范围）。 */
  account?: string
  /** WP441：来源（邮件 / 网站聊天）。 */
  source?: MessageSource
  /** WP441：信上的日期（消息规则「生效只管以后进来的」）。 */
  date?: string
}

/** 分拣时这台机器上的现状。 */
export interface TriageContext {
  /** 这个品牌启用了客服岗位吗。为假时 `route` 永远不会是 `support`。 */
  support_enabled: boolean
  /** 启用了红人营销岗位吗。 */
  kol_enabled: boolean
  /** 这条会话是不是客服已有线程（① 线程归并）。 */
  isSupportThread(thread_id: string, refs: readonly string[]): boolean
  /** 这条会话是不是红人合作线程。 */
  isKolThread(thread_id: string, refs: readonly string[]): boolean
  /**
   * WP172（docs/84 §5）：B2B 岗位开着、而且**这只邮箱**的「收 B2B 信」开关开着。
   * 不给 = 关（老调用方一封 B2B 都不产出，与 WP161 的预留一致）。
   */
  b2b_enabled?: boolean
  /** B2B ①：回的是我们发出去的 B2B 信（开发信 / 报价信，按 Message-ID 对线程）。 */
  isB2bThread?(thread_id: string, refs: readonly string[]): boolean
  /** B2B ②：发件人在 B2B 客户 / 联系人库里（按地址哈希或公司域名对）。 */
  isB2bSender?(from_email: string): boolean
  /** 用户教过的发件人规则（② ）。 */
  senderRules: readonly SenderRule[]
  /** `halt.model` 开着吗。 */
  model_halted: boolean
  at: string
  /**
   * WP441（docs/108 §5.1.3）：开着的**消息规则**（按清单顺序）。写死条件跑在发件人规则之后、自动信头之前；
   * AI 条件塞进第 ④ 层那一次模型调用里顺带判。不给 = 老行为。
   */
  messageRules?: readonly MessageRule[]
}

/** ④ 那一层的注入口。包内不调模型——宿主拿模型网关实现它。 */
export interface TriageModel {
  classify(input: {
    from_email: string
    from_name?: string
    subject: string
    /** **只有正文前 2000 字**，且**不含附件**（63 §10）。 */
    body: string
    /** 现在能落哪几条路（岗位没开的那条不在列表里，模型也就选不出来）。 */
    allowed_routes: readonly MessageRoute[]
    allowed_labels: readonly string[]
    /** WP212：能选的类型（docs/88 §3 的十种）。 */
    allowed_kinds?: readonly MessageKind[]
    /**
     * WP441：顺带判这几条消息规则的 AI 条件（编号 + 一句描述）。模型多回一项 `rule_hits`；
     * 不给 = 没有要判的规则（提示词与老的一样）。
     */
    rules?: readonly { id: string; text: string }[]
  }): Promise<{
    route: MessageRoute
    labels: string[]
    needs_reply: boolean
    priority: MessagePriority
    summary: string
    confidence: number
    /** WP212：模型判的类型（可不给——不给就按路由与标签推一个）。 */
    kind?: MessageKind | string
    /** WP441：符合哪几条规则（编号 + 把握）。 */
    rule_hits?: unknown
  }>
}

/** 送进模型的正文上限（63 §4 ④）。 */
export const MODEL_BODY_LIMIT = 2000

/** 摘要上限（63 §4）：一行装得下，读的人不用横向扫。 */
export const SUMMARY_LIMIT = 40

/* ── ③ 自动信头 ───────────────────────────────────────────────────────── */

const NOREPLY = /(?:^|[.\-_+])(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)@/i

/**
 * 这封信是机器发的吗（订阅 / 通知类）。
 *
 * 三个判据任一命中即可，**都是结构性的**：有退订头、发件人是 noreply、
 * 显式标了 `Auto-Submitted` / `Precedence: bulk`。这三件事没有一件需要读懂正文。
 */
export function isAutomatedMail(input: TriageInput): string | undefined {
  const h = input.headers
  if (h['list-unsubscribe'] !== undefined && h['list-unsubscribe'] !== '') return 'List-Unsubscribe'
  if (h['list-id'] !== undefined && h['list-id'] !== '') return 'List-Id'
  const auto = h['auto-submitted']
  if (auto !== undefined && auto.trim().toLowerCase() !== 'no') return 'Auto-Submitted'
  const prec = (h.precedence ?? '').trim().toLowerCase()
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return `Precedence: ${prec}`
  // WP167 修：以前拿 `x${地址}` 去配，`^` 永远配不上，光秃秃的 `noreply@…` 一次都没命中过——
  // 每封平台通知都白花一次模型，还可能被判成客服信开事项
  if (NOREPLY.test(input.from_email)) return 'noreply 发件人'
  return undefined
}

/** 词面命中：给自动信再细分一格标签（订单 / 账单 / 平台 / 营销）。 */
const AUTOMATED_LABEL_TERMS: readonly { label: string; terms: readonly string[] }[] = [
  {
    label: 'orders',
    terms: [
      'order',
      'shipped',
      'shipment',
      'tracking',
      'delivered',
      '订单',
      '发货',
      '物流',
      '运单',
    ],
  },
  {
    label: 'billing',
    terms: [
      'invoice',
      'receipt',
      'payment',
      'billing',
      'subscription renew',
      '账单',
      '发票',
      '付款',
    ],
  },
  {
    label: 'security',
    terms: [
      'verification code',
      'security alert',
      'password',
      'sign-in',
      '验证码',
      '安全',
      '登录异常',
    ],
  },
  {
    label: 'platform',
    terms: ['policy update', 'terms of service', 'account notice', '平台', '政策', '公告'],
  },
]

const PARTNERSHIP_TERMS: readonly string[] = [
  'collaboration',
  'collab',
  'sponsorship',
  'partnership',
  'brand deal',
  'affiliate',
  '合作',
  '寄样',
  '推广',
  '带货',
]

const SUPPORT_TERMS: readonly string[] = [
  'refund',
  'return',
  'damaged',
  'broken',
  'where is my order',
  'not received',
  'cancel my order',
  'warranty',
  'exchange',
  '退款',
  '退货',
  '破损',
  '没收到',
  '换货',
  '保修',
  '投诉',
]

const SUSPICIOUS_TERMS: readonly string[] = [
  'verify your account immediately',
  'suspended',
  'wire transfer',
  'bitcoin',
  'gift card',
  '账号将被冻结',
  '立即验证',
  '汇款',
]

function hay(input: TriageInput): string {
  return `${input.subject}\n${input.text}`.toLowerCase()
}

function hits(text: string, terms: readonly string[]): string[] {
  return terms.filter((t) => text.includes(t.toLowerCase()))
}

/* ── 发件人规则 ───────────────────────────────────────────────────────── */

/** 规则命中：整地址优先于整域（更具体的赢）。 */
export function matchSenderRule(
  rules: readonly SenderRule[],
  from_email: string,
): SenderRule | undefined {
  const addr = from_email.trim().toLowerCase()
  const at = addr.lastIndexOf('@')
  const domain = at < 0 ? '' : addr.slice(at)
  const exact = rules.find((r) => r.sender.trim().toLowerCase() === addr)
  if (exact !== undefined) return exact
  return rules.find((r) => r.sender.trim().toLowerCase() === domain)
}

/** WP417：Amazon 买家消息的转发地址（与 `support-core` 的 `AMAZON_MARKETPLACE_RELAY_RE` 同口径，本包不依赖它）。 */
const AMAZON_RELAY = /^[a-z0-9]{8,32}@marketplace\.amazon\.[a-z.]{2,10}$/i

/* ── 规则层（① ② ③） ─────────────────────────────────────────────────── */

/**
 * 只跑规则。分不出来就回 `undefined`（调用方据此决定走不走模型）。
 *
 * 岗位没开时**绝不**回那条路：`support_enabled` 为假的工作区里，
 * 一条命中客服线程的规则也只会把它留在收件箱（那条线程本来也不存在）。
 */
export function triageByRules(input: TriageInput, ctx: TriageContext): MessageTriage | undefined {
  return triageLayers(input, ctx)?.verdict
}

/** WP441：规则层哪一层给的结论（消息规则跟着它决定管不管、能不能改去向）。 */
type TriageLayer = 'structural' | 'sender' | 'auto'

function triageLayers(
  input: TriageInput,
  ctx: TriageContext,
): { verdict: MessageTriage; layer: TriageLayer } | undefined {
  const structural = (verdict: MessageTriage) => ({ verdict, layer: 'structural' as const })
  const text = hay(input)

  // ① 线程归并——结构事实，模型答不出比它更准的
  if (ctx.support_enabled && ctx.isSupportThread(input.thread_id, input.references)) {
    return structural({
      route: 'support',
      labels: [],
      needs_reply: true,
      priority: 'high',
      summary: clip('客服线程的后续来信'),
      confidence: 1,
      by: 'rule',
      reasons: ['In-Reply-To / References 命中客服已有线程'],
      at: ctx.at,
      ...ruleKind('customer_question', 1),
    })
  }
  /*
   * WP417（自查客服 B3）：Amazon 买家消息（发件人是 marketplace relay 地址）一律是客服——
   * 这类信的信头常像自动通知，不先认出来就会被下面那一档当通知拦掉。
   */
  if (ctx.support_enabled && AMAZON_RELAY.test(input.from_email.trim())) {
    return structural({
      route: 'support',
      labels: [],
      needs_reply: true,
      priority: 'high',
      summary: clip('Amazon 买家消息'),
      confidence: 0.95,
      by: 'rule',
      reasons: ['发件人是 Amazon 买家消息的转发地址'],
      at: ctx.at,
      ...ruleKind('customer_question', 0.95),
    })
  }
  if (ctx.kol_enabled && ctx.isKolThread(input.thread_id, input.references)) {
    return structural({
      route: 'kol',
      labels: ['partnership'],
      needs_reply: true,
      priority: 'normal',
      summary: clip('红人合作线程的回信'),
      confidence: 1,
      by: 'rule',
      reasons: ['In-Reply-To / References 命中红人合作线程'],
      at: ctx.at,
      ...ruleKind('creator_reply', 1),
    })
  }

  // WP172 B2B ①：回我们发出去的开发信 / 报价信——线程对得上就是 B2B，不靠猜
  const b2b = ctx.b2b_enabled === true
  if (b2b && ctx.isB2bThread?.(input.thread_id, input.references) === true) {
    return structural({
      route: 'b2b',
      labels: [],
      needs_reply: true,
      priority: 'high',
      summary: clip('回了我们发出去的 B2B 信'),
      confidence: 1,
      by: 'rule',
      reasons: ['In-Reply-To / References 命中我们发出去的 B2B 信'],
      at: ctx.at,
      ...ruleKind('inquiry', 1),
    })
  }

  // ② 发件人规则（用户教过的）
  const rule = matchSenderRule(ctx.senderRules, input.from_email)
  if (rule !== undefined) {
    const route = allowRoute(rule.route ?? 'inbox', ctx)
    // WP212：规则教过类型就按它；只教过路由 / 标签的老规则按它们推（与回填同一张表）
    const kind =
      rule.kind ?? kindOfRoute(rule.route) ?? kindOfLabels(rule.labels) ?? 'personal_other'
    const verdict: MessageTriage = {
      route,
      labels: [...rule.labels],
      // 只教过类型的规则：要不要回按类型（通知类不用回，其余要）
      needs_reply: route !== 'inbox' || (rule.kind !== undefined && !isNoticeKind(kind)),
      priority: 'normal',
      summary: clip(
        rule.kind === undefined ? '按你教过的发件人规则' : input.subject || '按你教过的发件人规则',
      ),
      confidence: 1,
      by: 'rule',
      reasons: [`发件人规则：${rule.sender}`],
      at: ctx.at,
      kind,
      kind_by: 'sender_rule',
      kind_confidence: 1,
      ...(rule.position === undefined ? {} : { suggested_position: rule.position }),
    }
    return { verdict, layer: 'sender' }
  }

  // WP172 B2B ②：发件人已经在 B2B 客户 / 联系人库里——和客服抢的时候按库里算（docs/84 §5）
  if (b2b && ctx.isB2bSender?.(input.from_email) === true) {
    return structural({
      route: 'b2b',
      labels: [],
      needs_reply: true,
      priority: 'normal',
      summary: clip('B2B 客户的来信'),
      confidence: 1,
      by: 'rule',
      reasons: ['发件人在 B2B 客户 / 联系人库里'],
      at: ctx.at,
      ...ruleKind('inquiry', 1),
    })
  }
  // WP172 B2B ③：平台询盘通知（要在"自动信头"之前：这些通知都是 noreply 发的）
  const platform = b2b ? platformInquiryOf(input) : undefined
  if (platform !== undefined) {
    return structural({
      route: 'b2b',
      labels: ['platform'],
      needs_reply: true,
      priority: 'high',
      summary: clip('B2B 平台来了一条询盘'),
      confidence: 0.95,
      by: 'rule',
      reasons: [`B2B 平台询盘通知：${platform}`],
      at: ctx.at,
      ...ruleKind('inquiry', 0.95),
    })
  }

  // ③ 自动信头：订阅 / 通知类，不花模型
  const auto = isAutomatedMail(input)
  if (auto !== undefined) {
    const labels = new Set<string>(['newsletters'])
    for (const group of AUTOMATED_LABEL_TERMS) {
      if (hits(text, group.terms).length > 0) {
        labels.add(group.label)
        // 明确是订单 / 账单 / 安全的，就不该再顶着"营销订阅"那一格
        labels.delete('newsletters')
      }
    }
    if (hits(text, SUSPICIOUS_TERMS).length > 0) labels.add('suspicious')
    const verdict: MessageTriage = {
      route: 'inbox',
      labels: [...labels],
      needs_reply: false,
      priority: labels.has('security') ? 'high' : 'low',
      summary: clip(labels.has('orders') ? '订单 / 物流通知' : '订阅或通知类来信'),
      confidence: 0.9,
      by: 'rule',
      reasons: [auto],
      at: ctx.at,
      // WP212：自动信一律按标签定类型（账单 / 物流 / 营销），推不出就是营销订阅
      ...ruleKind(kindOfLabels([...labels]) ?? 'marketing', 0.9),
    }
    return { verdict, layer: 'auto' }
  }
  return undefined
}

/**
 * 规则分不出来时的**兜底**（模型不可用 / 急停 / 调用失败都落到这里）。
 *
 * 它不猜路由——一律 `inbox`，标签只出词面命中的那几个，`by` 说清楚是
 * 「只跑了规则」。界面据此显示「未分拣」，人一眼看得出这封信没被判过。
 */
export function triageFallback(input: TriageInput, ctx: TriageContext): MessageTriage {
  const text = hay(input)
  const labels: string[] = []
  if (hits(text, PARTNERSHIP_TERMS).length > 0) labels.push('partnership')
  if (hits(text, SUSPICIOUS_TERMS).length > 0) labels.push('suspicious')
  const supportHits = hits(text, SUPPORT_TERMS)
  // 像客服信但没开客服岗位（或没把握）：**不挪**，只挂一个"像是客服信？"
  // WP172：像询盘、B2B 开着 → 挂"像是 B2B？"（客服词面优先：零售客户问退款不是询盘）
  const b2bHits =
    ctx.b2b_enabled === true && supportHits.length === 0 ? looksLikeB2bInquiry(input) : []
  const suggested: MessageRoute | undefined =
    supportHits.length > 0 && ctx.support_enabled
      ? 'support'
      : b2bHits.length > 0
        ? 'b2b'
        : undefined
  return {
    route: 'inbox',
    labels,
    needs_reply: supportHits.length > 0 || b2bHits.length > 0,
    priority: 'normal',
    summary: clip(ctx.model_halted ? '未分拣（模型已急停）' : '未分拣'),
    confidence: ctx.model_halted ? 0 : 0.3,
    by: ctx.model_halted ? 'halted' : 'rule',
    reasons: ctx.model_halted
      ? ['halt.model 开着，只跑了规则']
      : ['规则分不出来，也没有可用的模型'],
    ...(suggested === undefined ? {} : { suggested_route: suggested }),
    at: ctx.at,
    // WP212：词面像什么就先写什么，把握照实写低（界面上是「像是售后 · 把握 N%」）
    ...ruleKind(
      supportHits.length > 0
        ? 'after_sales'
        : b2bHits.length > 0
          ? 'inquiry'
          : labels.includes('partnership')
            ? 'partnership'
            : 'personal_other',
      supportHits.length > 0 || b2bHits.length > 0 ? 0.5 : 0.3,
    ),
  }
}

/* ── 全流程 ───────────────────────────────────────────────────────────── */

/**
 * 分拣一封信：规则 → 模型 → 兜底。
 *
 * 模型那一跳**只送头 + 正文前 2000 字，不送附件**，而且 `allowed_routes` 里
 * 只有已启用的岗位——模型选不出一条这台机器上不存在的路。
 */
export async function triageMessage(
  input: TriageInput,
  ctx: TriageContext,
  model?: TriageModel,
): Promise<MessageTriage> {
  const layered = triageLayers(input, ctx)
  const rules = activeRules(input, ctx)
  // ① 线程归并 / B2B 结构事实：消息规则不管（这几封的主人是确定的）
  if (layered?.layer === 'structural' || rules.length === 0) {
    if (layered !== undefined) return layered.verdict
    return modelVerdict(input, ctx, model, [])
  }
  const mail = ruleMailOf(input)
  // ② 发件人规则：人明确教过的，去向听它的；AI 条件不再问模型，写死条件的其余动作照做
  if (layered?.layer === 'sender') {
    const v = layered.verdict
    return withRules(v, matchAll(rules, { ...mail, kind: v.kind }, new Map()), ctx, false)
  }
  // ②' 消息规则（写死条件）：带去向的命中了就不再问模型（先写死、后 AI）
  const early = matchAll(rules, mail, new Map())
  const earlyDest = resolveRuleActions(early).destination
  if (earlyDest !== undefined) {
    const base = layered?.verdict ?? ruleOnlyVerdict(input, ctx)
    return withRules(base, matchAll(rules, { ...mail, kind: base.kind }, new Map()), ctx)
  }
  const pending = rules.filter((r) => needsAi(r, mail))
  // ③ 自动信头：结论听信头的；有开着的 AI 条件规则要判，就问一次模型（只取它判的规则）
  if (layered?.layer === 'auto') {
    const v = layered.verdict
    let ai = new Map<string, number>()
    if (pending.length > 0 && !ctx.model_halted && model !== undefined) {
      try {
        const out = await model.classify(modelInput(input, ctx, pending))
        ai = hitMap(out.rule_hits, pending)
      } catch {
        ai = new Map()
      }
    }
    return withRules(v, matchAll(rules, { ...mail, kind: v.kind }, ai), ctx)
  }
  // ④ 模型：一次调用，顺带判 AI 条件
  const ai = new Map<string, number>()
  const v = await modelVerdict(input, ctx, model, pending, ai)
  return withRules(v, matchAll(rules, { ...mail, kind: v.kind }, ai), ctx)
}

/** ④ 那一层（与 WP441 之前同一套：急停 / 没模型 / 调用失败都落兜底）。`ai` 收模型判的规则。 */
async function modelVerdict(
  input: TriageInput,
  ctx: TriageContext,
  model: TriageModel | undefined,
  pending: readonly MessageRule[],
  ai?: Map<string, number>,
): Promise<MessageTriage> {
  if (ctx.model_halted || model === undefined) return triageFallback(input, ctx)
  try {
    const out = await model.classify(modelInput(input, ctx, pending))
    if (ai !== undefined) for (const [id, c] of hitMap(out.rule_hits, pending)) ai.set(id, c)
    return normalizeVerdict(out, ctx)
  } catch {
    // 模型挂了不该让这封信进不来：落兜底，界面显示「未分拣」
    return triageFallback(input, ctx)
  }
}

function modelInput(
  input: TriageInput,
  ctx: TriageContext,
  pending: readonly MessageRule[],
): Parameters<TriageModel['classify']>[0] {
  return {
    from_email: input.from_email,
    ...(input.from_name === undefined ? {} : { from_name: input.from_name }),
    subject: input.subject,
    body: input.text.slice(0, MODEL_BODY_LIMIT),
    allowed_routes: allowedRoutes(ctx),
    allowed_labels: BUILTIN_LABEL_ORDER,
    allowed_kinds: MESSAGE_KINDS,
    ...(pending.length === 0 ? {} : { rules: aiRulePrompts(pending) }),
  }
}

function hitMap(raw: unknown, pending: readonly MessageRule[]): Map<string, number> {
  return new Map(
    parseRuleHits(
      raw,
      pending.map((r) => r.id),
    ).map((h) => [h.id, h.confidence]),
  )
}

/** WP441：这封信能用的规则（开着、不是系统规则、信是规则建好之后来的），按清单顺序。 */
function activeRules(input: TriageInput, ctx: TriageContext): MessageRule[] {
  const all = ctx.messageRules ?? []
  if (all.length === 0) return []
  return sortRules(all.filter((r) => ruleApplies(r, input.date)))
}

function ruleMailOf(input: TriageInput): RuleMail {
  return {
    from_email: input.from_email,
    ...(input.from_name === undefined ? {} : { from_name: input.from_name }),
    subject: input.subject,
    text: input.text,
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(input.source === undefined ? {} : { source: input.source }),
    has_attachments: input.has_attachments,
  }
}

function matchAll(
  rules: readonly MessageRule[],
  mail: RuleMail,
  ai: ReadonlyMap<string, number>,
): RuleMatch[] {
  const out: RuleMatch[] = []
  for (const rule of rules) {
    const r = evaluateRule(rule, mail, ai.get(rule.id))
    if (r.hit)
      out.push({
        rule,
        by: r.by,
        ...(r.confidence === undefined ? {} : { confidence: r.confidence }),
      })
  }
  return out
}

function withRules(
  verdict: MessageTriage,
  matches: readonly RuleMatch[],
  ctx: TriageContext,
  allowDestination = true,
): MessageTriage {
  if (matches.length === 0) return verdict
  return applyRuleActions(verdict, resolveRuleActions(matches, allowDestination), ctx)
}

/**
 * 写死条件的规则定了去向、又没有信头可依（不是自动信）：不问模型，按规则给一份结论——
 * 类型按规则里写的类型条件、再按标签推，推不出就是「个人与其他」；摘要用主题。
 */
function ruleOnlyVerdict(input: TriageInput, ctx: TriageContext): MessageTriage {
  const kindCond = (ctx.messageRules ?? [])
    .flatMap((r) => r.when.conditions)
    .find((c) => c.type === 'kind')
  const kind = kindCond?.type === 'kind' ? kindCond.value : 'personal_other'
  return {
    route: 'inbox',
    labels: [],
    needs_reply: true,
    priority: 'normal',
    summary: clip(input.subject || '按消息规则处理'),
    confidence: 1,
    by: 'rule',
    reasons: ['消息规则（写死条件）命中，没问模型'],
    at: ctx.at,
    ...ruleKind(kind, kindCond === undefined ? 0.6 : 1),
  }
}

/** 这台机器上现在允许的路由。 */
export function allowedRoutes(ctx: TriageContext): MessageRoute[] {
  const out: MessageRoute[] = ['inbox']
  if (ctx.support_enabled) out.push('support')
  if (ctx.kol_enabled) out.push('kol')
  if (ctx.b2b_enabled === true) out.push('b2b')
  return out
}

const BUILTIN_LABEL_ORDER: readonly string[] = [
  'orders',
  'suppliers',
  'platform',
  'billing',
  'partnership',
  'newsletters',
  'hiring',
  'legal',
  'security',
  'personal',
  'suspicious',
]

/**
 * 模型的结论落地前的三道收口：
 * ① 岗位没开的路一律降回 `inbox`；
 * ② 把握不够的 support / kol / b2b **不挪**，降回 `inbox` 并挂 `suggested_route`；
 * ③ 摘要裁到 40 字、标签只留认得的那几个。
 */
export function normalizeVerdict(
  out: {
    route: MessageRoute
    labels: string[]
    needs_reply: boolean
    priority: MessagePriority
    summary: string
    confidence: number
    kind?: MessageKind | string
  },
  ctx: TriageContext,
): MessageTriage {
  const wanted = allowRoute(out.route, ctx)
  const confidence = Math.max(0, Math.min(1, out.confidence))
  const shy = wanted !== 'inbox' && confidence < TRIAGE_CONFIDENCE_FLOOR
  const labels = out.labels.filter((l) => BUILTIN_LABEL_ORDER.includes(l))
  const reasons = ['模型分拣（便宜档，只送头与正文前 2000 字）']
  if (wanted !== out.route) reasons.push(`${out.route} 岗位没启用，降回收件箱`)
  if (shy) reasons.push(`把握 ${confidence.toFixed(2)} < ${TRIAGE_CONFIDENCE_FLOOR}，不挪信`)
  return {
    route: shy ? 'inbox' : wanted,
    ...(shy ? { suggested_route: wanted } : {}),
    labels,
    needs_reply: out.needs_reply,
    priority: out.priority,
    summary: clip(out.summary),
    confidence,
    by: 'model',
    reasons,
    at: ctx.at,
    // WP212：模型给了认得的类型就用；没给（或给了个不认得的）按路由与标签推
    kind: isMessageKind(out.kind)
      ? out.kind
      : (kindOfRoute(shy ? wanted : out.route) ?? kindOfLabels(labels) ?? 'personal_other'),
    kind_by: 'model',
    kind_confidence: confidence,
  }
}

/** 岗位没开就落回收件箱。**这一条不许绕过**（Luoye 原话的直译）。 */
export function allowRoute(route: MessageRoute, ctx: TriageContext): MessageRoute {
  if (route === 'support') return ctx.support_enabled ? 'support' : 'inbox'
  if (route === 'kol') return ctx.kol_enabled ? 'kol' : 'inbox'
  // WP172：B2B 岗位没开、或这只邮箱不收 B2B 信 → 落回收件箱（不挪、不开事项）
  if (route === 'b2b') return ctx.b2b_enabled === true ? 'b2b' : 'inbox'
  return 'inbox'
}

/** 人自己挪的那一条（纠错）。`by: 'user'`、把握 1——不许再被下一轮分拣改回去。 */
export function userVerdict(route: MessageRoute, at: string, labels: string[] = []): MessageTriage {
  return {
    route,
    labels,
    needs_reply: route !== 'inbox',
    priority: 'normal',
    summary: clip('你挪过这封信'),
    confidence: 1,
    by: 'user',
    reasons: ['人工纠错'],
    at,
  }
}

/** 规则层给的类型（`kind_by: 'rule'`）。 */
function ruleKind(
  kind: MessageKind,
  confidence: number,
): Pick<MessageTriage, 'kind' | 'kind_by' | 'kind_confidence'> {
  return { kind, kind_by: 'rule', kind_confidence: confidence }
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > SUMMARY_LIMIT ? `${t.slice(0, SUMMARY_LIMIT - 1)}…` : t
}
