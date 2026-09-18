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

import type { MessagePriority, MessageRoute, MessageTriage, SenderRule } from '@agentsws/contracts'
import { TRIAGE_CONFIDENCE_FLOOR } from '@agentsws/contracts'

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
  /** 用户教过的发件人规则（② ）。 */
  senderRules: readonly SenderRule[]
  /** `halt.model` 开着吗。 */
  model_halted: boolean
  at: string
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
  }): Promise<{
    route: MessageRoute
    labels: string[]
    needs_reply: boolean
    priority: MessagePriority
    summary: string
    confidence: number
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
  if (NOREPLY.test(`x${input.from_email}`)) return 'noreply 发件人'
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

/* ── 规则层（① ② ③） ─────────────────────────────────────────────────── */

/**
 * 只跑规则。分不出来就回 `undefined`（调用方据此决定走不走模型）。
 *
 * 岗位没开时**绝不**回那条路：`support_enabled` 为假的工作区里，
 * 一条命中客服线程的规则也只会把它留在收件箱（那条线程本来也不存在）。
 */
export function triageByRules(input: TriageInput, ctx: TriageContext): MessageTriage | undefined {
  const text = hay(input)

  // ① 线程归并——结构事实，模型答不出比它更准的
  if (ctx.support_enabled && ctx.isSupportThread(input.thread_id, input.references)) {
    return {
      route: 'support',
      labels: [],
      needs_reply: true,
      priority: 'high',
      summary: clip('客服线程的后续来信'),
      confidence: 1,
      by: 'rule',
      reasons: ['In-Reply-To / References 命中客服已有线程'],
      at: ctx.at,
    }
  }
  if (ctx.kol_enabled && ctx.isKolThread(input.thread_id, input.references)) {
    return {
      route: 'kol',
      labels: ['partnership'],
      needs_reply: true,
      priority: 'normal',
      summary: clip('红人合作线程的回信'),
      confidence: 1,
      by: 'rule',
      reasons: ['In-Reply-To / References 命中红人合作线程'],
      at: ctx.at,
    }
  }

  // ② 发件人规则（用户教过的）
  const rule = matchSenderRule(ctx.senderRules, input.from_email)
  if (rule !== undefined) {
    const route = allowRoute(rule.route ?? 'inbox', ctx)
    return {
      route,
      labels: [...rule.labels],
      needs_reply: route !== 'inbox',
      priority: 'normal',
      summary: clip('按你教过的发件人规则'),
      confidence: 1,
      by: 'rule',
      reasons: [`发件人规则：${rule.sender}`],
      at: ctx.at,
    }
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
    return {
      route: 'inbox',
      labels: [...labels],
      needs_reply: false,
      priority: labels.has('security') ? 'high' : 'low',
      summary: clip(labels.has('orders') ? '订单 / 物流通知' : '订阅或通知类来信'),
      confidence: 0.9,
      by: 'rule',
      reasons: [auto],
      at: ctx.at,
    }
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
  const suggested =
    supportHits.length > 0 && ctx.support_enabled ? ('support' as MessageRoute) : undefined
  return {
    route: 'inbox',
    labels,
    needs_reply: supportHits.length > 0,
    priority: 'normal',
    summary: clip(ctx.model_halted ? '未分拣（模型已急停）' : '未分拣'),
    confidence: ctx.model_halted ? 0 : 0.3,
    by: ctx.model_halted ? 'halted' : 'rule',
    reasons: ctx.model_halted
      ? ['halt.model 开着，只跑了规则']
      : ['规则分不出来，也没有可用的模型'],
    ...(suggested === undefined ? {} : { suggested_route: suggested }),
    at: ctx.at,
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
  const byRule = triageByRules(input, ctx)
  if (byRule !== undefined) return byRule
  if (ctx.model_halted || model === undefined) return triageFallback(input, ctx)
  try {
    const out = await model.classify({
      from_email: input.from_email,
      ...(input.from_name === undefined ? {} : { from_name: input.from_name }),
      subject: input.subject,
      body: input.text.slice(0, MODEL_BODY_LIMIT),
      allowed_routes: allowedRoutes(ctx),
      allowed_labels: BUILTIN_LABEL_ORDER,
    })
    return normalizeVerdict(out, ctx)
  } catch {
    // 模型挂了不该让这封信进不来：落兜底，界面显示「未分拣」
    return triageFallback(input, ctx)
  }
}

/** 这台机器上现在允许的路由。 */
export function allowedRoutes(ctx: TriageContext): MessageRoute[] {
  const out: MessageRoute[] = ['inbox']
  if (ctx.support_enabled) out.push('support')
  if (ctx.kol_enabled) out.push('kol')
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
 * ② 把握不够的 support / kol **不挪**，降回 `inbox` 并挂 `suggested_route`；
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
  }
}

/** 岗位没开就落回收件箱。**这一条不许绕过**（Luoye 原话的直译）。 */
export function allowRoute(route: MessageRoute, ctx: TriageContext): MessageRoute {
  if (route === 'support') return ctx.support_enabled ? 'support' : 'inbox'
  if (route === 'kol') return ctx.kol_enabled ? 'kol' : 'inbox'
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

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > SUMMARY_LIMIT ? `${t.slice(0, SUMMARY_LIMIT - 1)}…` : t
}
