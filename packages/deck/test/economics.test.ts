/**
 * WP224（docs/91 §2.2 #1 / #3）：盈亏线并排显示、两条止损线对照、本周经营一页纸。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { WEEKLY_REVIEW_MAX_LENGTH } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AdsDeckData,
  blocksForRole,
  composeWeeklyReview,
  mondayOf,
  projectCard,
  type QueryContext,
  reviewLength,
  runQuery,
  type TableResult,
} from '../src/index.js'
import { item, NOW, ORDERS, queryContext, SOURCES } from './fixtures.js'

const withAds = SOURCES.map((s) => (s.id === 'ads' ? { ...s, connected: true } : s))

function ads(over: Partial<AdsDeckData> = {}): AdsDeckData {
  return {
    spend_gate: { spent: 0, cap: 1000, remaining: 1000, by_platform: [], missing: [] },
    campaigns: [
      {
        campaign_id: 'c1',
        platform: 'meta',
        account: 'A',
        name: '新品',
        status: 'active',
        roas: 1.8,
        spend: 400,
        daily_budget: 1000,
      },
      {
        campaign_id: 'c2',
        platform: 'meta',
        account: 'A',
        name: '爆款',
        status: 'active',
        roas: 3.2,
      },
      {
        campaign_id: 'c3',
        platform: 'meta',
        account: 'A',
        name: '烧钱',
        status: 'active',
        roas: 0.6,
      },
    ],
    pending: [],
    stop_losses: [],
    pixels: [],
    attribution: [
      {
        platform: 'meta',
        campaign: '新品',
        platform_roas: 2.4,
        order_roas: 1.8,
        platform_conversions: 10,
        order_conversions: 7,
      },
    ],
    ...over,
  }
}

const metaCtx = (a: AdsDeckData): QueryContext =>
  queryContext({ role_id: 'ads.meta', sources: withAds, ads: a })

const table = (name: string, ctx: QueryContext): TableResult => {
  const r = runQuery(name, ctx, 'last_7d')
  if (r.status !== 'ok') throw new Error(`${name} not ok`)
  return r.data as TableResult
}

describe('盈亏线并排显示（campaign 表与日报）', () => {
  const filled = ads({
    break_even: {
      margin_pct: 40,
      break_even_roas: 2.5,
      note: '盈亏线 ROAS 2.5（毛利率 40%）',
      fixed_line: 1,
    },
  })

  it('ROAS 旁边一格盈亏线；高于 1 低于盈亏线的那条标提示图标，别的不标', () => {
    const t = table('ads.campaigns', metaCtx(filled))
    const keys = t.columns.map((c) => c.key)
    expect(keys.indexOf('break_even')).toBe(keys.indexOf('roas') + 1)
    expect(t.columns.find((c) => c.key === 'roas')?.format).toBe('ratio')
    expect(t.columns.find((c) => c.key === 'below_break_even')?.format).toBe('flag')
    const byName = Object.fromEntries(t.rows.map((r) => [r.name, r]))
    expect(byName['新品']?.break_even).toBe(2.5)
    expect(String(byName['新品']?.below_break_even)).toContain('低于盈亏线 2.5')
    expect(byName['爆款']?.below_break_even).toBe('')
    // 低于 1 的那条归现在的止损管，不在这一段
    expect(byName['烧钱']?.below_break_even).toBe('')
    expect(t.footer?.text).toContain('自动止损仍按 ROAS < 1')
  })

  it('日报：两口径各一列（不合并），盈亏线按订单口径标', () => {
    const t = table('ads.daily_report', metaCtx(filled))
    expect(t.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(['platform_roas', 'order_roas', 'break_even', 'below_break_even']),
    )
    expect(t.rows[0]).toMatchObject({ platform_roas: 2.4, order_roas: 1.8, break_even: 2.5 })
    expect(String(t.rows[0]?.below_break_even)).not.toBe('')
  })

  it('没填毛利率：那一格空着、不标图标，表下一行「没填毛利率 · 去填」', () => {
    const t = table(
      'ads.campaigns',
      metaCtx(
        ads({
          break_even: {
            note: '没填毛利率',
            fill_url: '/org?tab=brands&focus=gross-margin',
            fixed_line: 1,
          },
        }),
      ),
    )
    expect(t.rows.every((r) => r.break_even === '' && r.below_break_even === '')).toBe(true)
    expect(t.footer).toEqual({
      text: '没填毛利率，算不出盈亏线',
      href: '/org?tab=brands&focus=gross-margin',
      link_label: '去填',
    })
  })

  it('宿主没装毛利率那一层（老测试 / 模拟世界）：一个字不多', () => {
    const t = table('ads.campaigns', metaCtx(ads()))
    expect(t.footer).toBeUndefined()
    expect(t.rows[0]?.break_even).toBe('')
  })
})

describe('两条止损线对照（老板那一面）', () => {
  it('老板面板上有这一块；按 campaign 汇，四个平台一张表', () => {
    expect(blocksForRole('common.owner').map((b) => b.id)).toContain('owner.line_compare')
    const t = table(
      'ads.line_compare',
      queryContext({
        role_id: 'common.owner',
        sources: withAds,
        ads: ads({
          line_compare: {
            started_on: '2026-09-01',
            days: 3,
            complete: false,
            rows: [],
            summary: [
              {
                campaign_id: 'c1',
                platform: 'meta',
                name: '新品',
                days: 3,
                fixed_stop_days: 0,
                break_even_stop_days: 2,
                only_break_even_days: 2,
                no_margin_days: 0,
              },
              {
                campaign_id: 'g1',
                platform: 'google',
                name: '搜索',
                days: 3,
                fixed_stop_days: 1,
                break_even_stop_days: 1,
                only_break_even_days: 0,
                no_margin_days: 0,
              },
            ],
          },
        }),
      }),
    )
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]).toMatchObject({ name: '新品', only_break_even_days: 2 })
    expect(t.footer?.text).toContain('从 2026-09-01 起记了 3 天')
    expect(t.footer?.text).toContain('不改止损')
  })
})

describe('止损卡上的盈亏线那一格', () => {
  it('判据旁边并排一颗 break_even 芯片', () => {
    const card = projectCard(
      item({
        kind: 'staged_change',
        payload: {
          kind: 'pause_ad',
          target: { type: 'campaign', id: 'c1' },
          after: {
            status: 'paused',
            stop_loss_reason: '两条判据都成立，止损：ROAS 0.6（线是 1）…',
            break_even_note: '盈亏线 ROAS 2.5（毛利率 40%）',
          },
        },
      }),
      { now: NOW, position_id: 'asg_1' },
    )
    const types = card.highlights.map((h) => h.type)
    expect(types.indexOf('break_even')).toBe(types.indexOf('stop_loss') + 1)
    expect(card.highlights.find((h) => h.type === 'break_even')?.text).toBe(
      '盈亏线 ROAS 2.5（毛利率 40%）',
    )
  })
})

describe('本周经营一页纸', () => {
  const report = (rows: object[]): ApprovalItem =>
    ({
      id: 'ap_rev',
      kind: 'seo_report',
      state: 'auto_approved',
      created_at: NOW,
      payload: { variant: 'weekly_revenue', rows },
    }) as unknown as ApprovalItem

  it('有数的块出发现（一个数 + 出处），没人担的写「没接」不估', () => {
    const base = queryContext({
      role_id: 'common.owner',
      sources: withAds,
      ads: ads({
        break_even: {
          margin_pct: 40,
          break_even_roas: 2.5,
          note: '盈亏线 ROAS 2.5（毛利率 40%）',
          fixed_line: 1,
        },
      }),
    })
    const content = queryContext({
      role_id: 'dtc.content',
      approvals: [
        report([{ page: 'https://x.test/blogs/a', revenue: 300, orders: 2, clicks: 50 }]),
      ],
    })
    const p = composeWeeklyReview({
      now: NOW,
      brand: '测试品牌',
      base,
      content,
      held: ['common.owner', 'ads.meta', 'dtc.content'],
    })
    expect(p.kind).toBe('weekly_review')
    expect(p.situation).toContain('测试品牌')
    const panels = p.findings.map((f) => f.panel)
    expect(panels).toEqual(
      expect.arrayContaining(['store_sales', 'ads_break_even', 'content_revenue']),
    )
    for (const f of p.findings) {
      expect(f.value).not.toBe('')
      expect(f.source).not.toBe('')
    }
    expect(p.findings.find((f) => f.panel === 'ads_break_even')?.value).toBe('1 条')
    expect(p.findings.find((f) => f.panel === 'content_revenue')?.value).toBe('USD 300')
    // 没人担的三块：照样列出来，理由写清
    const gaps = Object.fromEntries(p.not_connected.map((g) => [g.panel, g.reason]))
    expect(gaps.social_30d).toBe('没人担社媒')
    expect(gaps.kol_attribution).toBe('没人担红人营销')
    expect(gaps.support_volume).toBe('没人担客服')
    expect(p.impact.join('')).toContain('按毛利算在亏钱')
    expect(p.recommendations.join('')).toContain('不会自动停')
    expect(p.length).toBeLessThanOrEqual(WEEKLY_REVIEW_MAX_LENGTH)
  })

  it('没填毛利率：盈亏线那块写「没填毛利率」，建议去公司页填', () => {
    const p = composeWeeklyReview({
      now: NOW,
      base: queryContext({
        role_id: 'common.owner',
        sources: withAds,
        ads: ads({ break_even: { note: '没填毛利率', fixed_line: 1 } }),
      }),
      held: ['common.owner', 'ads.meta'],
    })
    expect(p.not_connected.find((g) => g.panel === 'ads_break_even')?.reason).toBe('没填毛利率')
    expect(p.recommendations.join('')).toContain('填毛利率')
  })

  it('店铺没连：销售那块是「没接」，不是 0', () => {
    const p = composeWeeklyReview({
      now: NOW,
      base: queryContext({
        role_id: 'common.owner',
        sources: SOURCES.map((s) => ({ ...s, connected: false })),
      }),
      held: ['common.owner'],
    })
    expect(p.findings.find((f) => f.panel === 'store_sales')).toBeUndefined()
    expect(p.not_connected.find((g) => g.panel === 'store_sales')?.reason).toBe('店铺没连')
  })

  it('「影响」里的销售下滑门槛从公司层阈值来；没配阈值就不写这一条', () => {
    const orders = [
      { ...ORDERS[0], id: 'o_now', created_at: '2026-09-06T02:00:00.000Z', total_price: 50 },
      { ...ORDERS[0], id: 'o_before', created_at: '2026-08-29T02:00:00.000Z', total_price: 200 },
    ] as typeof ORDERS
    const base = (thresholds?: Record<string, number>) =>
      queryContext({
        role_id: 'common.owner',
        orders,
        ...(thresholds === undefined ? {} : { thresholds }),
      })
    const withLine = composeWeeklyReview({
      now: NOW,
      base: base({ weekly_sales_drop_pct: 20 }),
      held: ['common.owner'],
    })
    expect(withLine.impact.join('')).toContain('销售额比前 7 天少了 75%')
    const without = composeWeeklyReview({ now: NOW, base: base(), held: ['common.owner'] })
    expect(without.impact.join('')).not.toContain('销售额')
  })

  it('长度：汉字按字、英文按词；周一按工作区时区算', () => {
    expect(reviewLength('销售额 USD 1,200，比前 7 天 +20%')).toBe(3 + 2 + 3 + 1 + 1 + 1)
    // 2026-09-07 01:00Z = 上海周一 09:00
    expect(mondayOf('2026-09-07T01:00:00.000Z', 480)).toBe('2026-09-07')
    expect(mondayOf('2026-09-06T15:00:00.000Z', 480)).toBe('2026-08-31')
  })
})
