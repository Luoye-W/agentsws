import type {
  ContextItem,
  GroundingRule,
  Iso8601,
  ObjectRef,
  RunRequest,
} from '@agentsws/contracts'

/** 变更请求的口语线索（15 §4.4 `must_stage_if_change_requested` 靠它判断"要不要 stage"）。 */
export const CHANGE_TERMS = ['refund', 'return', 'money back', '退款', '退货', '退回'] as const

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 与 stub 运行时同一套取文本规则：结构化内容里优先取正文类字段。 */
export function plainText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(plainText).join('\n')
  const o = asRecord(v)
  if (o === undefined) return String(v)
  const preferred = ['body', 'text', 'message', 'content', 'subject', 'summary']
  const picked = preferred.filter((k) => typeof o[k] === 'string').map((k) => o[k] as string)
  if (picked.length > 0) return picked.join('\n')
  return Object.values(o).map(plainText).join('\n')
}

export function itemsOfKind(req: RunRequest, kind: ContextItem['kind']): ContextItem[] {
  return req.context.filter((c) => c.kind === kind)
}

export function refOf(item: ContextItem): ObjectRef | undefined {
  return typeof item.source_ref === 'string' ? undefined : item.source_ref
}

export function threadText(req: RunRequest): string {
  return itemsOfKind(req, 'thread')
    .map((t) => plainText(t.content))
    .join('\n')
}

export function changeRequested(text: string): boolean {
  const lower = text.toLowerCase()
  return CHANGE_TERMS.some((t) => lower.includes(t))
}

/**
 * 05 §1.8 grounding：**intent 与 cue 同时命中**才算命中（比"任一命中"严；
 * "订单到了吗"命中 order_status，"帮我改地址"不命中）。
 */
export function ruleHits(text: string, rule: GroundingRule): boolean {
  const lower = text.toLowerCase()
  const any = (terms: readonly string[]): boolean =>
    terms.some((t) => t.length > 0 && lower.includes(t.toLowerCase()))
  return any(rule.intent_terms) && any(rule.cue_terms)
}

export function groundingHits(req: RunRequest): GroundingRule[] {
  const text = threadText(req)
  return req.grounding.filter((r) => ruleHits(text, r))
}

export interface OrderView {
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

/** 工具结果 / `order` 上下文项 → 订单视图（stage 时要 before/after 与币种）。 */
export function orderView(source: unknown, fallbackRef?: ObjectRef): OrderView | undefined {
  const o = asRecord(source)
  if (o === undefined) return undefined
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

/** 正文里的订单号（`#1001` → `ord_1001`）。 */
export function orderIdFromText(text: string): string | undefined {
  const m = text.match(/#(\d{3,})/)
  return m?.[1] === undefined ? undefined : `ord_${m[1]}`
}
