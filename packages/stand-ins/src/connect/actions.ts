import type { ActionMeta, Iso8601, ProviderMeta } from '@agentsws/contracts'
import { StandInError } from '../errors.js'
import type { MockState } from './state.js'
import { bumpVersion } from './state.js'

export interface ActionContext {
  state: MockState
  now: Iso8601
  /** 确定性 id 生成（seed 决定）。 */
  nextId(prefix: string): string
}

export interface ActionDef extends ActionMeta {
  handler(input: Record<string, unknown>, ctx: ActionContext): unknown
}

export const PROVIDERS: ProviderMeta[] = [
  // 31 §3：v1 的 Shopify 走「自建应用 + Admin API 访问令牌」，不需要平台审核，所以是 api_key
  { service: 'shopify_admin', auth: 'api_key', executable: true },
  { service: 'gmail', auth: 'oauth2', executable: true },
  { service: 'meta', auth: 'oauth2', executable: true },
  { service: 'klaviyo', auth: 'api_key', executable: true },
  { service: 'whatsapp', auth: 'oauth2', executable: true },
]

// ---------- 输入校验（不引第三方 schema 库） ----------

function obj(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new StandInError('invalid_input', 'Action 输入必须是对象')
  }
  return input as Record<string, unknown>
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new StandInError('invalid_input', `缺少字符串字段 ${key}`, { key })
  }
  return v
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new StandInError('invalid_input', `${key} 必须是字符串`, { key })
  return v
}

function num(input: Record<string, unknown>, key: string): number {
  const v = input[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new StandInError('invalid_input', `缺少数值字段 ${key}`, { key })
  }
  return v
}

function optNum(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new StandInError('invalid_input', `${key} 必须是数值`, { key })
  }
  return v
}

function strList(input: Record<string, unknown>, key: string): string[] {
  const v = input[key]
  if (typeof v === 'string') return [v]
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  throw new StandInError('invalid_input', `${key} 必须是字符串或字符串数组`, { key })
}

function orderOf(ctx: ActionContext, id: string) {
  const order = ctx.state.orders.find((o) => o.id === id || o.name === id)
  if (!order) throw new StandInError('not_found', `订单不存在：${id}`, { order_id: id })
  return order
}

function productOf(ctx: ActionContext, id: string) {
  const product = ctx.state.products.find((p) => p.id === id)
  if (!product) throw new StandInError('not_found', `商品不存在：${id}`, { product_id: id })
  return product
}

/** pack 造的状态里没有 `shop` 那一格时用这份（形状与 `defaultState` 的一致）。 */
const DEFAULT_SHOP = {
  id: 'shop_stand_in',
  name: 'Stand-in Store',
  myshopify_domain: 'stand-in.myshopify.com',
  email: 'owner@example.com',
  currency: 'USD',
  iana_timezone: 'Asia/Shanghai',
} as const

const SCHEMA = (props: Record<string, string>, required: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
  required,
})

// ---------- Action 目录 ----------

/**
 * 18 §1：`side_effect` 由目录元数据 + 我们的覆盖表决定，未标的按 write。
 * 这里逐条显式标注——替身与真实实现遵守同一张表。
 */
export function actionCatalog(): ActionDef[] {
  return [
    {
      id: 'shopify_admin.get_order',
      service: 'shopify_admin',
      side_effect: 'read',
      required_scopes: ['read_orders'],
      input_schema: SCHEMA({ order_id: 'string' }, ['order_id']),
      handler(input, ctx) {
        return { ...orderOf(ctx, str(input, 'order_id')) }
      },
    },
    {
      // WP46：工作台的活数据源拿它算币种与日界线；试连也优先挑它（目录的 smoke_hints）
      id: 'shopify_admin.get_shop',
      service: 'shopify_admin',
      side_effect: 'read',
      required_scopes: [],
      input_schema: SCHEMA({}, []),
      handler(_input, ctx) {
        return { shop: { ...(ctx.state.shop ?? DEFAULT_SHOP) } }
      },
    },
    {
      id: 'shopify_admin.list_orders',
      service: 'shopify_admin',
      side_effect: 'read',
      required_scopes: ['read_orders'],
      input_schema: SCHEMA({ email: 'string', financial_status: 'string', limit: 'number' }, []),
      handler(input, ctx) {
        const email = optStr(input, 'email')
        const financial = optStr(input, 'financial_status')
        const limit = optNum(input, 'limit') ?? 50
        const orders = ctx.state.orders
          .filter((o) => email === undefined || o.email === email)
          .filter((o) => financial === undefined || o.financial_status === financial)
          .slice(0, limit)
          .map((o) => ({ ...o }))
        return { orders, count: orders.length }
      },
    },
    {
      id: 'shopify_admin.get_product',
      service: 'shopify_admin',
      side_effect: 'read',
      required_scopes: ['read_products'],
      input_schema: SCHEMA({ product_id: 'string' }, ['product_id']),
      handler(input, ctx) {
        return { ...productOf(ctx, str(input, 'product_id')) }
      },
    },
    {
      id: 'shopify_admin.create_refund',
      service: 'shopify_admin',
      side_effect: 'write',
      required_scopes: ['write_orders'],
      input_schema: SCHEMA({ order_id: 'string', amount: 'number', reason: 'string' }, [
        'order_id',
        'amount',
      ]),
      handler(input, ctx) {
        const order = orderOf(ctx, str(input, 'order_id'))
        const amount = num(input, 'amount')
        if (amount <= 0) throw new StandInError('invalid_input', '退款金额必须为正')
        const remaining = order.total_price - order.refunded_amount
        if (amount > remaining + 1e-9) {
          throw new StandInError('invalid_input', `退款金额超过可退余额 ${remaining}`, {
            amount,
            remaining,
          })
        }
        order.refunded_amount = Math.round((order.refunded_amount + amount) * 100) / 100
        order.financial_status =
          order.refunded_amount >= order.total_price - 1e-9 ? 'refunded' : 'partially_refunded'
        order.record_version = bumpVersion(order.record_version)
        return {
          refund_id: ctx.nextId('rfnd'),
          order_id: order.id,
          amount,
          reason: optStr(input, 'reason') ?? null,
          refunded_amount: order.refunded_amount,
          financial_status: order.financial_status,
          record_version: order.record_version,
          created_at: ctx.now,
        }
      },
    },
    {
      id: 'shopify_admin.update_order_shipping_address',
      service: 'shopify_admin',
      side_effect: 'write',
      required_scopes: ['write_orders'],
      input_schema: SCHEMA({ order_id: 'string', address: 'object' }, ['order_id', 'address']),
      handler(input, ctx) {
        const order = orderOf(ctx, str(input, 'order_id'))
        if (order.fulfillment_status !== 'unfulfilled') {
          throw new StandInError('conflict', '已发货订单不能改地址', { order_id: order.id })
        }
        const address = obj(input.address)
        const before = { ...order.shipping_address }
        order.shipping_address = {
          name: optStr(address, 'name') ?? before.name,
          address1: optStr(address, 'address1') ?? before.address1,
          city: optStr(address, 'city') ?? before.city,
          country: optStr(address, 'country') ?? before.country,
          zip: optStr(address, 'zip') ?? before.zip,
          ...(optStr(address, 'province') === undefined
            ? before.province === undefined
              ? {}
              : { province: before.province }
            : { province: optStr(address, 'province') as string }),
        }
        order.record_version = bumpVersion(order.record_version)
        return {
          order_id: order.id,
          before,
          after: { ...order.shipping_address },
          record_version: order.record_version,
        }
      },
    },
    {
      id: 'shopify_admin.update_product_price',
      service: 'shopify_admin',
      side_effect: 'write',
      required_scopes: ['write_products'],
      input_schema: SCHEMA({ product_id: 'string', price: 'number' }, ['product_id', 'price']),
      handler(input, ctx) {
        const product = productOf(ctx, str(input, 'product_id'))
        const price = num(input, 'price')
        if (price <= 0) throw new StandInError('invalid_input', '价格必须为正')
        const before = product.price
        product.price = price
        product.record_version = bumpVersion(product.record_version)
        return {
          product_id: product.id,
          before,
          after: price,
          record_version: product.record_version,
        }
      },
    },
    {
      id: 'shopify_admin.create_discount_code',
      service: 'shopify_admin',
      side_effect: 'write',
      required_scopes: ['write_discounts'],
      input_schema: SCHEMA({ code: 'string', percentage: 'number' }, ['code', 'percentage']),
      handler(input, ctx) {
        const code = str(input, 'code')
        const percentage = num(input, 'percentage')
        if (percentage <= 0 || percentage > 100) {
          throw new StandInError('invalid_input', '折扣百分比必须在 (0, 100]')
        }
        if (ctx.state.discounts.some((d) => d.code === code)) {
          throw new StandInError('conflict', `折扣码已存在：${code}`, { code })
        }
        const discount = { id: ctx.nextId('disc'), code, percentage, created_at: ctx.now }
        ctx.state.discounts.push(discount)
        return { ...discount }
      },
    },
    {
      id: 'gmail.list_threads',
      service: 'gmail',
      side_effect: 'read',
      required_scopes: ['gmail.readonly'],
      input_schema: SCHEMA({ participant: 'string', limit: 'number' }, []),
      handler(input, ctx) {
        const participant = optStr(input, 'participant')
        const limit = optNum(input, 'limit') ?? 20
        const threads = ctx.state.threads
          .filter((t) => participant === undefined || t.participants.includes(participant))
          .slice(0, limit)
          .map((t) => ({
            ...t,
            messages: ctx.state.messages.filter((m) => m.thread_id === t.id).map((m) => ({ ...m })),
          }))
        return { threads, count: threads.length }
      },
    },
    {
      id: 'gmail.send_message',
      service: 'gmail',
      side_effect: 'write',
      required_scopes: ['gmail.send'],
      input_schema: SCHEMA(
        { thread_id: 'string', to: 'array', subject: 'string', body: 'string' },
        ['to', 'body'],
      ),
      handler(input, ctx) {
        const to = strList(input, 'to')
        const body = str(input, 'body')
        const threadId = optStr(input, 'thread_id')
        let thread = threadId ? ctx.state.threads.find((t) => t.id === threadId) : undefined
        if (threadId !== undefined && !thread) {
          throw new StandInError('not_found', `线程不存在：${threadId}`, { thread_id: threadId })
        }
        const subject = optStr(input, 'subject') ?? thread?.subject ?? '(no subject)'
        if (!thread) {
          thread = { id: ctx.nextId('thr'), subject, participants: [...to], message_ids: [] }
          ctx.state.threads.push(thread)
        }
        const message = {
          id: ctx.nextId('msg'),
          thread_id: thread.id,
          direction: 'outbound' as const,
          from: 'support@example.com',
          to,
          subject,
          body,
          at: ctx.now,
        }
        ctx.state.messages.push(message)
        thread.message_ids.push(message.id)
        return { message_id: message.id, thread_id: thread.id, at: ctx.now }
      },
    },
    {
      id: 'meta.publish_post',
      service: 'meta',
      side_effect: 'write',
      required_scopes: ['pages_manage_posts'],
      input_schema: SCHEMA({ page: 'string', message: 'string' }, ['page', 'message']),
      handler(input, ctx) {
        const post = {
          id: ctx.nextId('post'),
          page: str(input, 'page'),
          message: str(input, 'message'),
          created_at: ctx.now,
        }
        ctx.state.posts.push(post)
        return { ...post }
      },
    },
    {
      id: 'klaviyo.add_to_segment',
      service: 'klaviyo',
      side_effect: 'write',
      required_scopes: ['segments:write'],
      input_schema: SCHEMA({ segment: 'string', email: 'string' }, ['segment', 'email']),
      handler(input, ctx) {
        const segment = str(input, 'segment')
        const email = str(input, 'email')
        const existing = ctx.state.segments.find((s) => s.segment === segment && s.email === email)
        if (existing) return { segment, email, added: false, added_at: existing.added_at }
        ctx.state.segments.push({ segment, email, added_at: ctx.now })
        return { segment, email, added: true, added_at: ctx.now }
      },
    },
    {
      id: 'whatsapp.send_message',
      service: 'whatsapp',
      side_effect: 'write',
      required_scopes: ['whatsapp_business_messaging'],
      input_schema: SCHEMA({ to: 'string', body: 'string' }, ['to', 'body']),
      handler(input, ctx) {
        const message = {
          id: ctx.nextId('wa'),
          to: str(input, 'to'),
          body: str(input, 'body'),
          template_used: false,
          at: ctx.now,
        }
        ctx.state.whatsapp.push(message)
        return { message_id: message.id, to: message.to, template_used: false, at: ctx.now }
      },
    },
    {
      id: 'whatsapp.send_template',
      service: 'whatsapp',
      side_effect: 'write',
      required_scopes: ['whatsapp_business_messaging'],
      input_schema: SCHEMA({ to: 'string', template: 'string', variables: 'array' }, [
        'to',
        'template',
      ]),
      handler(input, ctx) {
        const template = str(input, 'template')
        const variables = input.variables === undefined ? [] : strList(input, 'variables')
        const message = {
          id: ctx.nextId('wa'),
          to: str(input, 'to'),
          body: `[${template}] ${variables.join(' | ')}`.trim(),
          template,
          template_used: true,
          at: ctx.now,
        }
        ctx.state.whatsapp.push(message)
        return { message_id: message.id, to: message.to, template_used: true, at: ctx.now }
      },
    },
  ]
}

/** 输入必须是对象——所有 handler 的公共前置。 */
export function asInputObject(input: unknown): Record<string, unknown> {
  return obj(input)
}
