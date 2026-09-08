import type { Iso8601 } from '@agentsws/contracts'

/**
 * 合成 provider 的内存状态（26 §2 的 pack 子集，够跑 26 §1 的"退货窗口内"场景）。
 * 写 Action 真的改这里：退款后 `refunded_amount` 增加、`financial_status` 变。
 */

export interface MockAddress {
  name: string
  address1: string
  city: string
  province?: string
  country: string
  zip: string
}

export interface MockLineItem {
  id: string
  product_id: string
  title: string
  quantity: number
  price: number
}

export interface MockOrder {
  id: string
  name: string
  email: string
  currency: string
  created_at: Iso8601
  delivered_at?: Iso8601
  total_price: number
  refunded_amount: number
  financial_status: 'paid' | 'partially_refunded' | 'refunded'
  fulfillment_status: 'unfulfilled' | 'fulfilled' | 'delivered'
  line_items: MockLineItem[]
  shipping_address: MockAddress
  record_version: string
}

export interface MockProduct {
  id: string
  title: string
  price: number
  cost: number
  currency: string
  status: 'active' | 'draft'
  record_version: string
}

export interface MockDiscountCode {
  id: string
  code: string
  percentage: number
  created_at: Iso8601
}

export interface MockEmailMessage {
  id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string[]
  subject: string
  body: string
  at: Iso8601
}

export interface MockThread {
  id: string
  subject: string
  participants: string[]
  message_ids: string[]
}

export interface MockPost {
  id: string
  page: string
  message: string
  created_at: Iso8601
}

export interface MockSegmentMember {
  segment: string
  email: string
  added_at: Iso8601
}

export interface MockWhatsappMessage {
  id: string
  to: string
  body: string
  template?: string
  template_used: boolean
  at: Iso8601
}

export interface MockState {
  orders: MockOrder[]
  products: MockProduct[]
  discounts: MockDiscountCode[]
  threads: MockThread[]
  messages: MockEmailMessage[]
  posts: MockPost[]
  segments: MockSegmentMember[]
  whatsapp: MockWhatsappMessage[]
}

const DAY = 86_400_000

function iso(base: number, offsetDays: number): Iso8601 {
  return new Date(base + offsetDays * DAY).toISOString()
}

/**
 * 默认数据集（相对 `start` 生成，好让"退货窗口内 / 外"两条都稳定）：
 * - `ord_1001` 3 天前签收 → 14 天窗口内
 * - `ord_1002` 40 天前签收 → 窗口外
 * - `ord_1003` 未发货
 */
export function defaultState(start: Iso8601): MockState {
  const base = Date.parse(start)
  if (!Number.isFinite(base)) throw new RangeError(`invalid dataset start: ${start}`)
  return {
    orders: [
      {
        id: 'ord_1001',
        name: '#1001',
        email: 'anna@example.com',
        currency: 'USD',
        created_at: iso(base, -10),
        delivered_at: iso(base, -3),
        total_price: 129,
        refunded_amount: 0,
        financial_status: 'paid',
        fulfillment_status: 'delivered',
        line_items: [
          { id: 'li_1', product_id: 'prod_1', title: 'USB-C 65W Charger', quantity: 1, price: 129 },
        ],
        shipping_address: {
          name: 'Anna Meyer',
          address1: '12 Baker Street',
          city: 'Berlin',
          country: 'DE',
          zip: '10115',
        },
        record_version: 'v1',
      },
      {
        id: 'ord_1002',
        name: '#1002',
        email: 'bob@example.com',
        currency: 'USD',
        created_at: iso(base, -48),
        delivered_at: iso(base, -40),
        total_price: 89,
        refunded_amount: 0,
        financial_status: 'paid',
        fulfillment_status: 'delivered',
        line_items: [
          { id: 'li_2', product_id: 'prod_2', title: 'GaN Travel Adapter', quantity: 1, price: 89 },
        ],
        shipping_address: {
          name: 'Bob Ellis',
          address1: '5 Harbour Road',
          city: 'Bristol',
          country: 'GB',
          zip: 'BS1 4QA',
        },
        record_version: 'v1',
      },
      {
        id: 'ord_1003',
        name: '#1003',
        email: 'cara@example.com',
        currency: 'USD',
        created_at: iso(base, -1),
        total_price: 45,
        refunded_amount: 0,
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
        line_items: [
          { id: 'li_3', product_id: 'prod_3', title: 'Braided Cable 2m', quantity: 2, price: 22.5 },
        ],
        shipping_address: {
          name: 'Cara Lopez',
          address1: '90 Alameda',
          city: 'Lisbon',
          country: 'PT',
          zip: '1100-001',
        },
        record_version: 'v1',
      },
    ],
    products: [
      {
        id: 'prod_1',
        title: 'USB-C 65W Charger',
        price: 129,
        cost: 54,
        currency: 'USD',
        status: 'active',
        record_version: 'v1',
      },
      {
        id: 'prod_2',
        title: 'GaN Travel Adapter',
        price: 89,
        cost: 33,
        currency: 'USD',
        status: 'active',
        record_version: 'v1',
      },
      {
        id: 'prod_3',
        title: 'Braided Cable 2m',
        price: 22.5,
        cost: 6,
        currency: 'USD',
        status: 'active',
        record_version: 'v1',
      },
    ],
    discounts: [],
    threads: [
      {
        id: 'thr_1',
        subject: 'Return request for #1001',
        participants: ['anna@example.com', 'support@example.com'],
        message_ids: ['msg_1'],
      },
    ],
    messages: [
      {
        id: 'msg_1',
        thread_id: 'thr_1',
        direction: 'inbound',
        from: 'anna@example.com',
        to: ['support@example.com'],
        subject: 'Return request for #1001',
        body: 'Hi, the charger arrived but I would like to return it and get a refund. Order #1001.',
        at: iso(base, -0.01),
      },
    ],
    posts: [],
    segments: [],
    whatsapp: [],
  }
}

/** 下一个记录版本号（`v1` → `v2`）；乐观锁与执行快照都靠它。 */
export function bumpVersion(v: string): string {
  const n = Number.parseInt(v.replace(/^v/, ''), 10)
  return `v${Number.isFinite(n) ? n + 1 : 1}`
}
