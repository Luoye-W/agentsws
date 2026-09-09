import type { BattleReport, DeckCard, PositionTiles } from '@agentsws/deck'
import type { HomeData } from '@/lib/api'

export function draftCard(over: Partial<DeckCard> = {}): DeckCard {
  return {
    id: 'ap_1',
    kind: 'outbound_draft',
    status: 'pending',
    priority_band: 'P2',
    priority: 'queue',
    risk_class: 'medium',
    title: '回复 Anna：确认 14 天内退货，退款 42.00',
    summary: '订单 #1001 已签收 3 天，在退货窗口内。',
    content_variants: {
      zh_summary: '订单 #1001 已签收 3 天，在退货窗口内。',
      original: 'Hi, I want to return the jacket I got last week.',
    },
    position_id: 'asg_1',
    role_id: 'dtc.aftersales',
    customer_label: 'Anna Meyer',
    channel: 'email',
    source: 'conversation',
    highlights: [
      { type: 'amount', text: '42 USD' },
      { type: 'order_ref', text: '#1001' },
    ],
    evidence_chips: [
      { label_key: 'evidence.precheck.ok' },
      { label_key: 'evidence.citation', params: { count: 1 } },
      { label_key: 'evidence.order_checked', params: { order: '#1001' } },
    ],
    entity_chips: [
      { type: 'order', id: 'ord_1001', label: '订单 #1001' },
      { type: 'fact_card', id: 'fact_775c', label: '退货窗口 14 天' },
    ],
    available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
    action_labels: {
      approve: '发送',
      reject: '不发',
      instruct: '指导',
      snooze: '稍后',
      open: '打开',
    },
    detail: {
      payload: { body: { subject: 'Re', text: 'Hi Anna' } },
      precheck: { provenance: 'ok' },
      citations: [{ fact_card_id: 'fact_775c', quote: '14 days from delivery' }],
      links: { children: [] },
      created_at: '2026-09-07T00:00:00.000Z',
      updated_at: '2026-09-07T00:00:00.000Z',
      proposer: { kind: 'agent', id: '售后客服 Agent' },
      run_id: 'run_demo_42',
      enrichment: { dropped_refs: 0 },
    },
    dedupe_key: 'draft:thr_1',
    snooze_count: 0,
    merge_count: 1,
    version: 1,
    ...over,
  }
}

export function questionCard(over: Partial<DeckCard> = {}): DeckCard {
  return draftCard({
    id: 'ap_q',
    kind: 'policy_change',
    priority_band: 'P1',
    risk_class: 'high',
    title: '超窗一周的退货，怎么办？',
    summary: '第一次遇到；答案会沉淀成策略。',
    content_variants: { zh_summary: '第一次遇到；答案会沉淀成策略。' },
    dedupe_key: 'policy:return_grace',
    source: 'system',
    options: [
      { id: 'grace_7', label: '宽限 7 天，照退' },
      { id: 'refuse', label: '不退' },
    ],
    available_actions: ['approve', 'instruct', 'snooze', 'open'],
    action_labels: { approve: '就这么定', instruct: '其他…', snooze: '稍后', open: '打开' },
    ...over,
  })
}

export const TILE_BAR: PositionTiles = {
  position_id: 'asg_1',
  role_id: 'dtc.aftersales',
  role_name: '独立站售后客服',
  range: 'yesterday',
  tiles: [
    {
      id: 'pending_replies',
      label: '待回复',
      format: 'count',
      source: 'approvals',
      status: 'ok',
      range: 'yesterday',
      value: 2,
      previous: 1,
      delta_pct: 100,
      direction: 'up',
      spark: [0, 1, 0, 2, 1, 3, 2],
    },
    {
      id: 'csat',
      label: '满意度',
      format: 'ratio',
      source: 'csat',
      status: 'not_connected',
      range: 'yesterday',
      spark: [],
    },
  ],
}

export const REPORT: BattleReport = {
  date: '2026-09-07',
  ai_handled: 12,
  handled: 5,
  auto_sent: 3,
  intercepted: 7,
}

export function homeData(over: Partial<HomeData> = {}): HomeData {
  const queue = over.queue ?? [draftCard(), questionCard()]
  return {
    queue,
    alerts: [],
    tiles: [TILE_BAR],
    estimated_minutes: 6,
    range: 'yesterday',
    filters: {},
    counts: {
      total: queue.length,
      customer_waiting: queue.filter((c) => c.priority_band === 'P0').length,
      nobody_waiting: queue.filter((c) => c.priority_band === 'P3').length,
      matched: queue.length,
    },
    pinned_p0: [],
    battle_report: REPORT,
    ...over,
  }
}
