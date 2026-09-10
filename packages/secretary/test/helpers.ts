import type { CalendarItem, Clock, EventEnvelope, Iso8601 } from '@agentsws/contracts'
import type { ProfilePosition, RoleProfile } from '../src/index.js'
import { roleTermsOf } from '../src/index.js'

export const WS = 'ws_1'
/** 2026-09-07 是周一；工作区时区 +8，所以 UTC 01:00 = 本地 09:00。 */
export const T0: Iso8601 = '2026-09-07T01:00:00.000Z'
export const TZ = 480

export interface TestClock extends Clock {
  set(next: Iso8601): void
}

export function fixedClock(at: Iso8601 = T0): TestClock {
  let now = at
  return {
    now: () => now,
    set(next: Iso8601) {
      now = next
    },
  } as TestClock
}

/** 一个固定序列的伪随机（id 只要唯一，不要求不可预测）。 */
export function seeded(): () => number {
  let s = 0x1234567
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

export function collect(): {
  sink: (e: Omit<EventEnvelope, 'id' | 'at'>) => void
  events: Omit<EventEnvelope, 'id' | 'at'>[]
} {
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  return {
    events,
    sink: (e) => {
      events.push(e)
    },
  }
}

export function meeting(id: string, start: Iso8601, end: Iso8601, title = '会议'): CalendarItem {
  return {
    id: `cal_meeting_${id}`,
    source: 'meeting',
    title,
    start,
    end,
    all_day: false,
    ref: { type: 'meeting', id },
  }
}

export function position(
  position_id: string,
  role_id: string,
  role_name: string,
  ranges: ProfilePosition['ranges'] = [],
): ProfilePosition {
  return { position_id, role_id, role_name, ranges }
}

/** 售后 / 运营 / 投放三份职责的最小版本（字段取自 packs 里那三份真定义）。 */
export const AFTERSALES = {
  id: 'dtc.aftersales',
  name: { zh: '独立站售后客服', en: 'DTC After-sales Support' },
  description: '订单状态与物流、退换货、退款、改地址、漏发错发破损、拒付争议',
  grounding: [
    { intent_terms: ['订单', 'order', '包裹', 'package'], cue_terms: ['哪', '什么时候'] },
    { intent_terms: ['退', 'return', 'refund', '换', 'exchange'], cue_terms: ['可以', '政策'] },
  ],
  actions: [
    { id: 'reply_customer' },
    { id: 'stage_refund' },
    { id: 'stage_reship' },
    { id: 'stage_address_change' },
    { id: 'draft_chargeback_evidence' },
  ],
  scopes: [{ domain: 'order' }, { domain: 'shipment' }, { domain: 'customer' }],
}

export const OPS = {
  id: 'dtc.ops',
  name: { zh: '独立站运营', en: 'DTC Store Operations' },
  description: '商品与详情页、上下架、价格与促销、活动日历、店铺配置',
  actions: [{ id: 'stage_listing_edit' }, { id: 'stage_price_change' }, { id: 'stage_promotion' }],
  scopes: [{ domain: 'product' }, { domain: 'content' }, { domain: 'discount' }],
}

export const ADS = {
  id: 'ads.performance',
  name: { zh: '效果投放', en: 'Performance Ads' },
  description: '计划与预算、出价、否词、暂停低效广告、投放报表',
  actions: [
    { id: 'stage_pause_ad' },
    { id: 'stage_negative_keyword' },
    { id: 'stage_budget_change' },
  ],
  scopes: [{ domain: 'ad_account' }, { domain: 'campaign' }],
}

export function roleProfile(
  role: typeof AFTERSALES,
  positions: RoleProfile['positions'],
): RoleProfile {
  return {
    role_id: role.id,
    role_name: role.name.zh,
    terms: roleTermsOf(role),
    positions,
  }
}
