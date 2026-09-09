/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/rules.ts (emailAgent 规则 2 / 2a / 9 /
 * 10 / 21–25：先说记录、再说条款、最后说下一步；只读不改；不自拟金额) 与
 * src/lib/support/reply-prompt.ts（围栏纪律：外部文本围栏、自家草稿不围栏），
 * rewritten for agentsws contracts.
 *
 * 起草 = 模板 + 槽位。三条硬纪律：
 *   ① **数字只从传入的订单事实取**，模板里没有任何可以由模型填的数字（29 原则 ③）
 *   ② 外部文本一律经围栏清洗，且**不回显**——客户的原话不进回信
 *   ③ 政策口径只从 `policies` / `knowledge_hits` 来，读不到就说读不到，不补一个合理的说法
 *
 * 正文模板与 `@agentsws/stand-ins` 的 stub 运行时、`@agentsws/runtime-direct` 的规则脑
 * **逐字节相同**——三条路径共用这一处，改一个字三边一起变（回归基线会当场发现）。
 */
import type { ChangeKind } from '@agentsws/contracts'
import type { AnsweredBoundaryRef } from './boundaries.js'
import { findBoundary, findUnansweredBoundaries } from './boundaries.js'
import { deriveNeeds } from './entities.js'
import { sanitizeExternal } from './text.js'
import type {
  BoundaryItem,
  Classification,
  DraftedReply,
  DraftReplyInput,
  KnowledgeHit,
  OrderFacts,
  SupportPolicy,
} from './types.js'

const DAY_MS = 86_400_000

export const DEFAULT_RETURN_WINDOW_DAYS = 14

/** `14 days` / `14 天` / `return_window_days: 14`。 */
const WINDOW_RE = /(\d{1,3})\s*(?:days?|天)/i

export interface ResolvedWindow {
  days: number
  fact_card_id?: string
}

/**
 * 退货窗口天数。优先级：已确认的业务边界 > 知识层结构化值 > 知识层正文 > 兜底。
 * （KefuAgent 邮件规则 16：商户已确认的业务边界优先级高于爬来的政策页数值。）
 */
export function resolveReturnWindow(
  policies: readonly SupportPolicy[],
  knowledge_hits: readonly KnowledgeHit[],
  fallback = DEFAULT_RETURN_WINDOW_DAYS,
): ResolvedWindow {
  const answered = policies.find((p) => p.boundary_id === 'policy.refund_window')
  const days = answered?.value.days
  if (typeof days === 'number' && Number.isFinite(days)) {
    const card = answered?.value.fact_card_id
    return typeof card === 'string' ? { days, fact_card_id: card } : { days }
  }
  for (const hit of knowledge_hits) {
    const structured = hit.structured?.return_window_days
    if (typeof structured === 'number' && Number.isFinite(structured)) {
      return { days: structured, fact_card_id: hit.fact_card_id }
    }
    const m = WINDOW_RE.exec(hit.statement)
    if (m?.[1] !== undefined) {
      return { days: Number.parseInt(m[1], 10), fact_card_id: hit.fact_card_id }
    }
  }
  return { days: fallback }
}

/** 签收到现在过了几天。没有签收日期就没有天数——不猜。 */
export function daysSinceDelivery(order: OrderFacts | undefined, now: string): number | undefined {
  if (order?.delivered_at === undefined) return undefined
  return Math.floor((Date.parse(now) - Date.parse(order.delivered_at)) / DAY_MS)
}

/** 可退金额 = 订单总额 − 已退。两位小数，永远不由模型算。 */
export function refundableAmount(order: OrderFacts | undefined): number | undefined {
  if (order === undefined) return undefined
  return Math.round((order.total_price - order.refunded_amount) * 100) / 100
}

/* ------------------------------------------------------------------ */
/* 边界门（"第一次遇到就问一次"，不自作主张）                              */
/* ------------------------------------------------------------------ */

/** 客户声称"物流说送到了，我没收到"。两个线索都要有，只有一个不算。 */
const DELIVERED_CLAIM_TERMS = [
  'marked as delivered',
  'says delivered',
  'shows delivered',
  'tracking says it was delivered',
  'was delivered',
  '显示已签收',
  '显示已送达',
  '物流显示',
] as const
const NOT_RECEIVED_TERMS = [
  'never arrived',
  'not arrived',
  'never received',
  'did not receive',
  "didn't receive",
  'nothing arrived',
  'lost in transit',
  '没有收到',
  '未收到',
  '没收到',
] as const

export function lostPackageSignal(text: string): boolean {
  const lower = sanitizeExternal(text).toLowerCase()
  return (
    DELIVERED_CLAIM_TERMS.some((t) => lower.includes(t)) &&
    NOT_RECEIVED_TERMS.some((t) => lower.includes(t))
  )
}

/** 提出某一类变更之前，哪几条边界必须先有答案。 */
export const GOVERNING_BOUNDARIES: Readonly<Partial<Record<ChangeKind, readonly string[]>>> = {
  refund: ['policy.refund_window'],
  reship: ['policy.replacement_first'],
  address_change: ['policy.cancel_change_window'],
  discount_code: ['policy.compensation_cap'],
}

export interface ChangeGateInput {
  change_kind: ChangeKind
  classification: Classification
  policies: readonly AnsweredBoundaryRef[]
  /** 来信正文（判断丢件这类"额外需要一条边界"的情形）。 */
  text?: string
}

export interface ChangeGateResult {
  allowed: boolean
  /** 还没答过的、挡着这次变更的边界，按注册表顺序。 */
  missing: BoundaryItem[]
}

/**
 * 变更门：**只有管着这次变更的那几条边界**没答过才拦。
 *
 * 不是"任何一条相关边界没答就不动"——那会让 AI 在开箱第一天什么都做不了。
 * 拦下来之后不是拒绝客户，而是照常起草一封"交给同事确认"的回信，
 * 同时给商家一张选择题卡（36 §2.2）。这就是"第一次遇到，问一次"。
 */
export function gateChange(input: ChangeGateInput): ChangeGateResult {
  const required = [...(GOVERNING_BOUNDARIES[input.change_kind] ?? [])]
  if (
    input.change_kind === 'refund' &&
    input.text !== undefined &&
    lostPackageSignal(input.text) &&
    !required.includes('policy.lost_package_liability')
  ) {
    required.push('policy.lost_package_liability')
  }
  const missing: BoundaryItem[] = []
  for (const id of required) {
    if (input.policies.some((p) => p.boundary_id === id)) continue
    const boundary = findBoundary(id)
    if (boundary !== undefined) missing.push(boundary)
  }
  return { allowed: missing.length === 0, missing }
}

/* ------------------------------------------------------------------ */
/* 正文模板                                                             */
/* ------------------------------------------------------------------ */

export interface ReplyTemplateInput {
  order?: OrderFacts
  windowDays: number
  withinWindow: boolean
  daysSinceDelivery?: number
  /** 只有真的提出了退款才填；填了正文才会写"已经准备好一笔退款"。 */
  refundAmount?: number
  signature: string
  customer: string
}

/**
 * 固定模板：引用政策 + 订单状态；窗口内且已提出退款时附带金额。
 * 不回显任何外部原文（围栏纪律）。
 */
export function renderReplyBody(d: ReplyTemplateInput): string {
  const lines: string[] = [`Hi ${d.customer},`, '']
  if (d.order !== undefined) {
    lines.push(
      `Thanks for reaching out about order ${d.order.name}. Its payment status is "${d.order.financial_status}" and its fulfillment status is "${d.order.fulfillment_status}".`,
    )
  } else {
    lines.push('Thanks for reaching out.')
  }
  lines.push('')
  lines.push(`Our return policy allows returns within ${d.windowDays} days of delivery.`)
  if (d.order?.delivered_at !== undefined && d.daysSinceDelivery !== undefined) {
    lines.push(
      `Your order was delivered on ${d.order.delivered_at.slice(0, 10)}, ${d.daysSinceDelivery} day(s) ago.`,
    )
  }
  lines.push('')
  if (d.withinWindow && d.refundAmount !== undefined && d.order !== undefined) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so we have prepared a refund of ${d.refundAmount} ${d.order.currency} to your original payment method. It is waiting for a colleague to confirm and will be issued right after.`,
    )
  } else if (d.withinWindow && d.order !== undefined) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so a return is possible. A colleague will confirm the next step with you.`,
    )
  } else if (d.order !== undefined) {
    lines.push(
      `That is outside the ${d.windowDays}-day window, so a refund is not available for this order. Tell us what went wrong and we will look at the options that do apply.`,
    )
  } else {
    lines.push('Tell us the order number and we will check what applies.')
  }
  lines.push('', 'Kind regards,', d.signature)
  return lines.join('\n')
}

/** 回信主题：已经是 `Re:` 就不再加一层。 */
export function replySubject(subject: string | undefined, order?: OrderFacts): string {
  const raw = subject?.trim()
  if (raw !== undefined && raw.length > 0) {
    return raw.startsWith('Re:') ? raw : `Re: ${raw}`
  }
  return order === undefined ? 'Re: your message' : `Re: order ${order.name}`
}

/** 称呼：订单上的名字 > 订单邮箱前缀 > 来信邮箱前缀 > `there`。 */
export function greetingName(order: OrderFacts | undefined, from: string | undefined): string {
  return order?.customer_name ?? order?.email?.split('@')[0] ?? from?.split('@')[0] ?? 'there'
}

/**
 * 起草一封回信。
 *
 * 返回的 `body` 与两个运行时的模板逐字节相同；`needs` / `risk_flags` 是给卡片与门禁看的，
 * 不进正文。调用方拿到 `risk_flags` 里的 `boundary_unanswered:*` 就该去发一张选择题卡。
 */
export function draftReply(input: DraftReplyInput): DraftedReply {
  const {
    inbound,
    classification,
    order,
    policies,
    knowledge_hits,
    persona,
    now,
    default_return_window_days,
  } = input
  const text = sanitizeExternal(inbound.text)
  const window = resolveReturnWindow(policies, knowledge_hits, default_return_window_days)
  const daysSince = daysSinceDelivery(order, now)
  const withinWindow = daysSince !== undefined && daysSince <= window.days && order !== undefined

  const gate = gateChange({
    change_kind: 'refund',
    classification,
    policies,
    text,
  })
  const refundAmount = refundableAmount(order)
  const proposesRefund =
    gate.allowed &&
    withinWindow &&
    order !== undefined &&
    refundAmount !== undefined &&
    refundAmount > 0 &&
    classification.intent === 'returns_refunds'

  const body = renderReplyBody({
    windowDays: window.days,
    withinWindow,
    signature: persona.signature,
    customer: persona.customer_name ?? greetingName(order, inbound.from),
    ...(order === undefined ? {} : { order }),
    ...(daysSince === undefined ? {} : { daysSinceDelivery: daysSince }),
    ...(proposesRefund && refundAmount !== undefined ? { refundAmount } : {}),
  })

  const citations =
    window.fact_card_id === undefined
      ? []
      : [
          {
            fact_card_id: window.fact_card_id,
            quote: `returns within ${window.days} days of delivery`,
          },
        ]

  const needs = deriveNeeds(text)
  if (order === undefined && classification.entities.order_ref === undefined) {
    if (!needs.includes('order_ref')) needs.push('order_ref')
  }

  const risk_flags = classification.entities.risk_terms.map((t) => `risk:${t}`)
  for (const boundary of gate.missing) risk_flags.push(`boundary_unanswered:${boundary.id}`)
  for (const boundary of findUnansweredBoundaries(classification, policies)) {
    const flag = `boundary_unanswered:${boundary.id}`
    if (!risk_flags.includes(flag)) risk_flags.push(flag)
  }

  return {
    subject: replySubject(inbound.subject, order),
    body,
    citations,
    needs,
    risk_flags,
    return_window: window,
  }
}
