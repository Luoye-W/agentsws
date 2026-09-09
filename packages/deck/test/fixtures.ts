import type { ApprovalItem, ApprovalKind } from '@agentsws/contracts'
import type { DataSourceStatus, OrderRow, QueryContext } from '../src/index.js'

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
    role_id: 'dtc.aftersales',
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
]

export function queryContext(over: Partial<QueryContext> = {}): QueryContext {
  return {
    now: NOW,
    tz_offset_minutes: TZ,
    base_currency: 'USD',
    role_id: 'dtc.aftersales',
    position_id: 'asg_1',
    orders: ORDERS,
    approvals: [],
    sources: SOURCES,
    ...over,
  }
}
