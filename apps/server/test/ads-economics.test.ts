/**
 * WP224：广告库这一侧的三件小事——两条止损线的逐日对照（只记账）、日报那张表（归因两列）
 * 终于有数、盈亏线那一格原样递进面板投影。
 */
import type { WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { adsAttribution, adsDeckData, createAdsStore, snapshotLineCompare } from '../src/ads.js'

const NOW = '2026-10-05T10:00:00.000Z'

function store() {
  const s = createAdsStore({ workspace_id: 'ws_1' as WorkspaceId })
  s.saveAccount({
    id: 'aa_1',
    workspace_id: 'ws_1' as WorkspaceId,
    platform: 'meta',
    external_id: 'act_1',
    name: '账户',
    currency: 'USD',
    status: 'active',
    observed_at: NOW,
  })
  s.saveCampaign({
    id: 'c1',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '1',
    name: 'oct-launch',
    status: 'active',
    daily_budget: 1000,
    metrics: { spend: 400, roas: 1.8, conversions: 3, conversion_value: 720, observed_at: NOW },
  })
  s.saveCampaign({
    id: 'c2',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '2',
    name: 'no-metrics',
    status: 'paused',
  })
  return s
}

describe('两条止损线的逐日对照', () => {
  it('有表现数的 campaign 记一行；同一天再记是覆盖不是多一行', () => {
    const s = store()
    const rows = snapshotLineCompare(s, { date: '2026-10-05', now: NOW, marginFor: () => 40 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      campaign_id: 'c1',
      fixed: 'hold',
      break_even: 'trigger',
      break_even_roas: 2.5,
      margin_pct: 40,
    })
    snapshotLineCompare(s, { date: '2026-10-05', now: NOW, marginFor: () => undefined })
    const all = s.lineCompareRows()
    expect(all).toHaveLength(1)
    expect(all[0]?.break_even).toBe('no_margin')
  })

  it('现在那条线按这条分配的额度算（caps 递进来）', () => {
    const s = store()
    const [row] = snapshotLineCompare(s, {
      date: '2026-10-05',
      now: NOW,
      caps: { stop_loss_roas_below: 2 },
      marginFor: () => 40,
    })
    expect(row?.fixed).toBe('trigger')
  })
})

describe('日报那张表：归因两列', () => {
  it('平台口径取 campaign 表现，订单口径只认今天、带广告 UTM 的单；两列不合并', () => {
    const out = adsAttribution(store(), {
      now: NOW,
      tz_offset_minutes: 0,
      orders: [
        {
          id: 'o1',
          created_at: '2026-10-05T08:00:00.000Z',
          total_price: 300,
          landing_site: 'https://x.test/p?utm_source=meta&utm_medium=cpc&utm_campaign=oct-launch',
        },
        // 昨天的单不算进今天的日报
        {
          id: 'o2',
          created_at: '2026-10-04T08:00:00.000Z',
          total_price: 300,
          landing_site: 'https://x.test/p?utm_source=meta&utm_medium=cpc&utm_campaign=oct-launch',
        },
        // 红人那条口径不认
        {
          id: 'o3',
          created_at: '2026-10-05T09:00:00.000Z',
          total_price: 90,
          landing_site: 'https://x.test/p?utm_source=youtube&utm_medium=kol&utm_campaign=oct',
        },
      ],
    })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).toMatchObject({
      platform: 'meta',
      campaign: 'oct-launch',
      platform_conversions: 3,
      order_conversions: 1,
      platform_roas: 1.8,
      order_roas: 0.75,
    })
    expect(out.unmatched_orders).toBe(1)
  })

  it('一条有表现数的 campaign 都没有：空表，不编', () => {
    const s = createAdsStore({ workspace_id: 'ws_1' as WorkspaceId })
    expect(adsAttribution(s, { now: NOW, tz_offset_minutes: 0, orders: [] })).toEqual({
      rows: [],
      unmatched_orders: 0,
    })
  })
})

describe('面板投影', () => {
  it('盈亏线与对照表原样递进去；不给就不出这两格', () => {
    const s = store()
    const plain = adsDeckData(s)
    expect(plain.break_even).toBeUndefined()
    expect(plain.line_compare).toBeUndefined()
    const view = adsDeckData(s, {
      break_even: { note: '没填毛利率', fill_url: '/org', fixed_line: 1 },
      line_compare: { days: 0, complete: false, rows: [], summary: [] },
    })
    expect(view.break_even?.note).toBe('没填毛利率')
    expect(view.line_compare?.days).toBe(0)
  })
})
