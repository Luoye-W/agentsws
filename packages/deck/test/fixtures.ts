import type { ApprovalItem, ApprovalKind } from '@agentsws/contracts'
import type {
  DataSourceStatus,
  InventoryRow,
  OrderRow,
  PostRow,
  QueryContext,
} from '../src/index.js'

export const NOW = '2026-09-07T01:00:00.000Z'
/** Asia/Shanghai */
export const TZ = 480

export function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'ap_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'outbound_draft' as ApprovalKind,
    revision: 1,
    role_id: 'dtc.support',
    subject: { object: { type: 'thread', id: 'thr_1' } },
    dedupe_key: 'dk_1',
    title: '回复 Anna：确认 14 天内退货，退款 42.00',
    summary: '订单 #1001 已签收 3 天，在退货窗口内。',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_anna' },
      thread_ref: 'thr_1',
      body: { subject: 'Re: Return', text: 'Hi Anna' },
    },
    evidence: {
      run_id: 'run_1',
      source_events: ['evt_1'],
      provenance: {
        seen: [
          { type: 'order', id: 'ord_1001' },
          { type: 'customer', id: 'cus_anna' },
          { type: 'fact_card', id: 'fc_1' },
          { type: 'thread', id: 'thr_1' },
          { type: 'product', id: 'prod_1' },
        ],
      },
      precheck: { provenance: 'ok', fencing: 'ok' },
      citations: [{ fact_card_id: 'fc_1', quote: '14 days from delivery' }],
    },
    proposer: { kind: 'agent', id: 'agent_aftersales' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: 'p_wang', via: 'role_holder' }],
      rule: 'role_holder',
      escalation: {
        after_hours: 8,
        business_hours: true,
        chain: ['scope_manager', 'owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue',
    state: 'pending',
    deliveries: [],
    links: { children: [] },
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
    ...over,
  }
}

export function refundItem(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return item({
    id: 'ap_refund',
    kind: 'staged_change',
    title: '退款 42 USD（订单 #1001）',
    summary: '退货窗口内，原路退回。',
    subject: { object: { type: 'order', id: 'ord_1001' } },
    payload: {
      change_id: 'chg_1',
      kind: 'refund',
      target: { type: 'order', id: 'ord_1001' },
      before: { refunded: 0 },
      after: { refund_amount: 42, currency: 'USD' },
      money: { amount: 42, currency: 'USD', amount_base: 42 },
    },
    ...over,
  })
}

export function policyItem(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return item({
    id: 'ap_policy',
    kind: 'policy_change',
    title: '超窗一周的退货请求，怎么办？',
    summary: '第一次遇到；答案会沉淀成策略。',
    subject: { object: { type: 'policy', id: 'pol_return_grace' } },
    payload: {
      target: 'workspace_policy',
      before: { grace_days: 0 },
      after: { grace_days: 7 },
      options: [
        { id: 'grace_7', label: '宽限 7 天，照退' },
        { id: 'store_credit', label: '只给店铺余额' },
        { id: 'refuse', label: '不退' },
      ],
    },
    ...over,
  })
}

export const ORDERS: OrderRow[] = [
  {
    id: 'ord_a',
    name: '#1001',
    email: 'a@example.com',
    currency: 'USD',
    created_at: '2026-09-06T02:00:00.000Z',
    total_price: 129,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'delivered',
  },
  {
    id: 'ord_b',
    name: '#1002',
    email: 'b@example.com',
    currency: 'USD',
    created_at: '2026-09-05T02:00:00.000Z',
    total_price: 89,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'unfulfilled',
  },
  {
    id: 'ord_c',
    name: '#1003',
    email: 'c@example.com',
    currency: 'USD',
    created_at: '2026-09-02T02:00:00.000Z',
    total_price: 50,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'unfulfilled',
  },
]

export const SOURCES: DataSourceStatus[] = [
  { id: 'shop', label: '店铺后台', connected: true },
  { id: 'approvals', label: '工作队列', connected: true },
  { id: 'ga4', label: 'GA4', connected: false },
  { id: 'gsc', label: 'Search Console', connected: false },
  { id: 'ads', label: '广告后台', connected: false },
  { id: 'csat', label: '满意度调查', connected: false },
  // WP64：连接器还是骨架，这两个永远没连
  { id: 'email_marketing', label: '邮件营销后台', connected: false },
  { id: 'tracking', label: '物流追踪', connected: false },
  // WP63：评价应用的连接器还没做——永远没连，并带一句"待增加"
  { id: 'reviews', label: '评价应用', connected: false, note: '评价应用还没接上。' },
]

/** WP63：库存行。第二行故意在告急线以下、第三行故意断货。 */
export const INVENTORY: InventoryRow[] = [
  { id: 'inv_1', product_id: 'prod_1', sku: 'SKU-1', title: '快充头', quantity: 40 },
  { id: 'inv_2', product_id: 'prod_2', sku: 'SKU-2', title: '旅行插头', quantity: 2 },
  { id: 'inv_3', product_id: 'prod_3', sku: 'SKU-3', title: '编织线', quantity: 0 },
]

/** WP63：文章与页面。两篇发了、一篇还在草稿。 */
export const POSTS: PostRow[] = [
  {
    id: 'art_1',
    title: '快充头怎么挑',
    kind: 'article',
    published: true,
    updated_at: '2026-09-05T02:00:00.000Z',
    published_at: '2026-09-05T02:00:00.000Z',
    clicks: 120,
  },
  {
    id: 'art_2',
    title: '半年前那篇',
    kind: 'article',
    published: true,
    updated_at: '2026-01-05T02:00:00.000Z',
    published_at: '2026-01-05T02:00:00.000Z',
    clicks: 9,
  },
  {
    id: 'page_1',
    title: '退换货说明（改写中）',
    kind: 'page',
    published: false,
    updated_at: '2026-09-06T02:00:00.000Z',
  },
]

/** WP63：一条待审的店铺变更（车道断言用）。 */
export function storeChangeItem(kind: string, over: Partial<ApprovalItem> = {}): ApprovalItem {
  return item({
    id: `ap_${kind}`,
    kind: 'staged_change',
    role_id: 'dtc.store',
    title: `待审：${kind}`,
    summary: `待审：${kind}`,
    subject: { object: { type: 'product', id: 'prod_1' } },
    payload: { change_id: `chg_${kind}`, kind, target: { type: 'product', id: 'prod_1' } },
    state: 'pending',
    ...over,
  })
}

export function queryContext(over: Partial<QueryContext> = {}): QueryContext {
  return {
    now: NOW,
    tz_offset_minutes: TZ,
    base_currency: 'USD',
    role_id: 'dtc.support',
    position_id: 'asg_1',
    orders: ORDERS,
    approvals: [],
    sources: SOURCES,
    ...over,
  }
}
