/**
 * 从 RunRequest 的上下文里读出这次运行需要的事实（订单、退货窗口、线程）。
 *
 * 与 `@agentsws/stand-ins` 的 stub 运行时读的是同一批字段，但**各写各的**：
 * 17 §4 的五种运行时是同一契约的独立实现，共享读逻辑会让"换运行时"变成"换分支"。
 */
import type { ContextItem, Iso8601, ObjectRef, RunRequest } from '@agentsws/contracts'

export const DAY_MS = 86_400_000

const RETURN_TERMS = ['refund', 'return', 'money back', '退款', '退货', '退回']

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** 把任意上下文内容压成一段可读文本（注入模型与关键词匹配都用它）。 */
export function plainText(v: unknown): string {
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

export function itemsOfKind(req: RunRequest, kind: ContextItem['kind']): ContextItem[] {
  return req.context.filter((c) => c.kind === kind)
}

export function refOf(item: ContextItem | undefined): ObjectRef | undefined {
  if (item === undefined) return undefined
  const src = item.source_ref
  return typeof src === 'string' ? undefined : src
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
}

export function orderView(source: unknown, fallbackRef?: ObjectRef): OrderView | undefined {
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
  }
}

/** 退货窗口只来自知识层（policy / fact_card），不来自模型也不来自外部文本。 */
export function returnWindowDays(
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
    if (m?.[1] !== undefined) return { days: Number.parseInt(m[1], 10), source: item }
  }
  return { days: fallback }
}

export function hitsRule(text: string, rule: RunRequest['grounding'][number]): boolean {
  const lower = text.toLowerCase()
  return [...rule.intent_terms, ...rule.cue_terms].some(
    (t) => t.length > 0 && lower.includes(t.toLowerCase()),
  )
}

export function looksLikeChangeRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return RETURN_TERMS.some((t) => lower.includes(t))
}

/** 工具结果里认得出的实体 → provenance（15 §6 只证明"读过"）。 */
export function inferRefs(data: unknown): ObjectRef[] {
  const o = asRecord(data)
  if (!o) return []
  const refs: ObjectRef[] = []
  if (typeof o.id === 'string') {
    if ('financial_status' in o || 'line_items' in o) refs.push({ type: 'order', id: o.id })
    else if ('price' in o && 'title' in o) refs.push({ type: 'product', id: o.id })
  }
  if (Array.isArray(o.orders)) {
    for (const item of o.orders) {
      const r = asRecord(item)
      if (typeof r?.id === 'string') refs.push({ type: 'order', id: r.id })
    }
  }
  if (Array.isArray(o.hits)) {
    for (const item of o.hits) {
      const r = asRecord(item)
      if (typeof r?.id === 'string' && typeof r.statement === 'string') {
        refs.push({ type: 'fact_card', id: r.id })
      }
    }
  }
  return refs
}

export function threadSubject(item?: ContextItem): string | undefined {
  const o = asRecord(item?.content)
  const subject = o?.subject
  if (typeof subject !== 'string') return undefined
  return subject.startsWith('Re:') ? subject : `Re: ${subject}`
}

export function threadParticipants(item?: ContextItem): string[] {
  const o = asRecord(item?.content)
  const p = o?.participants
  if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string')
  const from = o?.from
  return typeof from === 'string' ? [from] : []
}

export function threadRecipient(item?: ContextItem): string | undefined {
  return threadParticipants(item)[0]?.split('@')[0]
}

export function orderIdFromText(text: string): string | undefined {
  const m = text.match(/#(\d{3,})/)
  return m?.[1] === undefined ? undefined : `ord_${m[1]}`
}

export interface DraftInput {
  order?: OrderView
  windowDays: number
  withinWindow: boolean
  daysSinceDelivery?: number
  refundAmount?: number
  signature: string
  customer: string
}

/**
 * 固定模板：引用政策 + 订单状态；窗口内附带退款意图。
 * 不回显任何外部原文（围栏纪律），不发明补偿。
 */
export function draftBody(d: DraftInput): string {
  const lines: string[] = [`Hi ${d.customer},`, '']
  if (d.order) {
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
  if (d.withinWindow && d.refundAmount !== undefined && d.order) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so we have prepared a refund of ${d.refundAmount} ${d.order.currency} to your original payment method. It is waiting for a colleague to confirm and will be issued right after.`,
    )
  } else if (d.withinWindow && d.order) {
    lines.push(
      `That is inside the ${d.windowDays}-day window, so a return is possible. A colleague will confirm the next step with you.`,
    )
  } else if (d.order) {
    lines.push(
      `That is outside the ${d.windowDays}-day window, so a refund is not available for this order. Tell us what went wrong and we will look at the options that do apply.`,
    )
  } else {
    lines.push('Tell us the order number and we will check what applies.')
  }
  lines.push('', 'Kind regards,', d.signature)
  return lines.join('\n')
}

/** 工具入参：与 stub 运行时一致，保证同一条场景两种运行时的 `tool.call.input` 可比。 */
export function toolInput(
  tool: string,
  ctx: {
    order?: OrderView
    orderItem?: ContextItem
    threadItem?: ContextItem
    threadText: string
  },
): Record<string, unknown> {
  const orderId = ctx.order?.id ?? refOf(ctx.orderItem)?.id ?? orderIdFromText(ctx.threadText)
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  switch (bare) {
    case 'get_order':
      return orderId === undefined ? {} : { order_id: orderId }
    case 'list_orders':
      return ctx.order?.email === undefined ? {} : { email: ctx.order.email }
    case 'search_policies':
      return { query: 'return window' }
    case 'list_threads':
      return ctx.threadItem === undefined ? {} : { thread_id: ctx.threadItem.id }
    default:
      return {}
  }
}
