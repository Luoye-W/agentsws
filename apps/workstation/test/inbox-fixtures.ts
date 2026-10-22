/** WP459：收件箱那一份的测试数据（NordVolt Gear 那套虚构人名，和示意稿一致）。 */
import type { InboxItem, InboxView } from '@agentsws/deck'
import { inboxCounts } from '@agentsws/deck'
import { draftCard, questionCard } from './fixtures'

export const T_NOW = '2026-10-22T09:30:00.000Z'

export function inboxItems(): InboxItem[] {
  return [
    {
      id: 'card:ap_reply',
      type: 'card',
      urgency: 'urgent',
      tag: 'card',
      primary: 'approve',
      at: '2026-10-22T03:12:00.000Z',
      position: 'customer-care',
      card: draftCard({
        id: 'ap_reply',
        title: '回信 · Tom Becker',
        summary: '先要订单号，查完就退',
        priority_band: 'P0',
        content_variants: {
          zh_summary: '先要订单号，查完就退',
          original: 'Hi, I ordered a 3-port charger three weeks ago and still nothing.',
        },
        detail: {
          ...draftCard().detail,
          payload: {
            body: {
              subject: 'Re: order',
              text: 'Hi Tom, sorry about the wait. Could you send me your order number?',
            },
          },
          created_at: '2026-10-22T03:12:00.000Z',
        },
      }),
    },
    {
      id: 'mail:<t_shop@x>',
      type: 'mail',
      urgency: 'urgent',
      tag: 'only_you',
      primary: 'self',
      at: '2026-10-22T07:00:00.000Z',
      mail: {
        thread_id: '<t_shop@x>',
        message_id: 'msg_shop',
        subject: 'Payouts paused',
        from: { email: 'ops@shopify.example', name: 'Shopify 结算' },
        summary: '结算被暂停，要补一份营业执照',
        kind: 'billing_system',
        priority: 'high',
        last_at: '2026-10-22T07:00:00.000Z',
        suggest: { action: 'self' },
      },
    },
    {
      id: 'card:ap_price',
      type: 'card',
      urgency: 'today',
      tag: 'card',
      primary: 'approve',
      at: '2026-10-22T08:40:00.000Z',
      position: 'web-ops',
      card: draftCard({
        id: 'ap_price',
        kind: 'staged_change',
        layout: 'change',
        change_kind: 'price_update',
        role_id: 'dtc.store',
        position_id: 'asg_2',
        title: '3 口 GaN 充电器 $49 → $44',
        summary: '两家同款降到 $45 以下，这周转化掉了 18%',
        detail: { ...draftCard().detail, payload: { before: { price: 49 }, after: { price: 44 } } },
        dedupe_key: 'price:1',
      }),
    },
    {
      id: 'mail:<t_sam@x>',
      type: 'mail',
      urgency: 'today',
      tag: 'unsure',
      primary: 'hand',
      at: '2026-10-22T06:45:00.000Z',
      mail: {
        thread_id: '<t_sam@x>',
        message_id: 'msg_sam',
        subject: 'Samples for 3 stores',
        from: { email: 'sam@store.example', name: 'Sam Lee' },
        summary: '三家门店的店主问能不能寄样品',
        kind: 'inquiry',
        kind_confidence: 0.5,
        last_at: '2026-10-22T06:45:00.000Z',
        suggest: { action: 'hand', position: 'b2b' },
      },
    },
    {
      id: 'card:ap_jordan',
      type: 'card',
      urgency: 'later',
      tag: 'card',
      primary: 'approve',
      at: '2026-10-21T05:25:00.000Z',
      position: 'customer-care',
      guessed: { message_id: 'msg_jordan', position: 'customer-care', confidence: 0.72 },
      card: draftCard({
        id: 'ap_jordan',
        title: '回信 · Jordan Wells',
        summary: '问礼盒带不带卡片；草稿：带，可以写祝福语',
        dedupe_key: 'draft:thr_j',
        detail: {
          ...draftCard().detail,
          payload: { body: { subject: 'Re: gift', text: 'Yes, a card is included.' } },
        },
      }),
    },
    {
      id: 'card:ap_choice',
      type: 'card',
      urgency: 'later',
      tag: 'card',
      primary: 'open',
      at: '2026-10-20T05:25:00.000Z',
      position: 'web-ops',
      card: questionCard({ id: 'ap_choice', position_id: 'asg_2', role_id: 'dtc.store' }),
    },
  ]
}

export function inboxView(items: InboxItem[] = inboxItems()): InboxView {
  return {
    items,
    counts: inboxCounts(items),
    positions: [
      {
        id: 'customer-care',
        name_zh: '客服',
        name_en: 'Customer Care',
        assignment_id: 'asg_1',
        count: items.filter((i) => i.position === 'customer-care').length,
      },
      {
        id: 'web-ops',
        name_zh: '网站运营',
        name_en: 'Web Ops',
        assignment_id: 'asg_2',
        count: items.filter((i) => i.position === 'web-ops').length,
      },
      { id: 'b2b', name_zh: 'B2B', name_en: 'B2B', count: 0 },
    ],
    unassigned: items.filter((i) => i.position === undefined).length,
    guessed: [
      {
        message_id: 'msg_jordan',
        thread_id: '<t_j@x>',
        subject: '礼盒带不带卡片',
        from: { email: 'jw@buyer.example', name: 'Jordan Wells' },
        position: 'customer-care',
        confidence: 0.72,
        at: T_NOW,
        open_card_count: 1,
      },
    ],
    brief: {
      done: 31,
      auto_sent: 7,
      guessed: 1,
      notices: 17,
      top: items.find((i) => i.urgency === 'urgent')?.card?.title ?? '',
    },
  }
}
