import type { DeckCard, PositionTiles } from '@agentsws/deck'

export function draftCard(over: Partial<DeckCard> = {}): DeckCard {
  return {
    id: 'ap_1',
    kind: 'outbound_draft',
    status: 'pending',
    priority_band: 'P2',
    risk_class: 'medium',
    title: '回复 Anna：确认 14 天内退货，退款 42.00',
    summary: '订单 #1001 已签收 3 天，在退货窗口内。',
    position_id: 'asg_1',
    role_id: 'dtc.aftersales',
    customer_label: 'Anna Meyer',
    channel: 'email',
    highlights: [
      { type: 'amount', text: '42 USD' },
      { type: 'order_ref', text: '#1001' },
    ],
    evidence_chips: [
      { label_key: 'evidence.precheck.ok' },
      { label_key: 'evidence.citation', ref: { type: 'fact_card', id: 'fc_1' } },
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
      citations: [{ fact_card_id: 'fc_1', quote: '14 days from delivery' }],
      links: { children: [] },
      created_at: '2026-09-07T00:00:00.000Z',
      updated_at: '2026-09-07T00:00:00.000Z',
      proposer: { kind: 'agent', id: 'agent_aftersales' },
    },
    dedupe_key: 'dk_1',
    snooze_count: 0,
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
