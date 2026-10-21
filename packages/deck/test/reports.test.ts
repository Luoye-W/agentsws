import { describe, expect, it } from 'vitest'
import {
  computeReport,
  DEFAULT_REPORTS,
  defaultReport,
  matchRecipe,
  type OrderRow,
  orderChannel,
  type RankPayload,
  type ReportSpec,
  reportWindows,
  specFromRecipe,
  summarizeReport,
  type TrendPayload,
  validateReportSpec,
} from '../src/index.js'
import { item, NOW, queryContext, TZ } from './fixtures.js'

const DAY = 86_400_000

function order(over: Partial<OrderRow> & { at: string; total: number }): OrderRow {
  return {
    id: `ord_${over.at}_${over.total}_${over.email ?? ''}`,
    name: '#1',
    email: over.email ?? 'x@example.com',
    currency: 'USD',
    created_at: over.at,
    total_price: over.total,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    ...(over.referring_site === undefined ? {} : { referring_site: over.referring_site }),
    ...(over.landing_site === undefined ? {} : { landing_site: over.landing_site }),
    ...(over.line_items === undefined ? {} : { line_items: over.line_items }),
  }
}

const business = (): ReportSpec => {
  const spec = defaultReport('web-ops.business')
  if (spec === undefined) throw new Error('缺默认报表')
  return spec
}

describe('WP438 报表窗口', () => {
  it('30 天 = 到昨天为止 30 个完整自然日，对比期紧挨着往前', () => {
    const w = reportWindows('30d', NOW, TZ)
    expect(w.daily).toHaveLength(30)
    expect(w.current.to - w.current.from).toBe(30 * DAY)
    expect(w.previous.to).toBe(w.current.from)
    // NOW = 09-07 09:00（+8）→ 今天 0 点是 09-07，这一段到 09-06 为止
    expect(new Date(w.current.to - 1 + TZ * 60_000).toISOString().slice(0, 10)).toBe('2026-09-06')
  })
})

describe('WP438 默认报表', () => {
  it('每一份规格的指标与数据集都在表里', () => {
    for (const spec of DEFAULT_REPORTS) expect(validateReportSpec(spec), spec.id).toEqual([])
  })

  it('网站运营 4 份、顺序照设计稿', () => {
    expect(DEFAULT_REPORTS.filter((r) => r.position === 'web-ops').map((r) => r.title)).toEqual([
      '网站经营数据报表',
      '流量报表',
      'SEO 与 AI 搜索',
      '邮件营销报表',
    ])
  })

  it('经营报表：店铺的数照算；GA4 没连 → 那几格是 not_connected，不出 0', () => {
    const data = computeReport(business(), queryContext(), '30d')
    const kpis = data.blocks.find((b) => b.kind === 'kpis')?.payload as {
      items: { key: string; status: string; value?: number }[]
    }
    const sales = kpis.items.find((i) => i.key === 'sales')
    expect(sales?.status).toBe('ok')
    expect(sales?.value).toBe(268)
    const conversion = kpis.items.find((i) => i.key === 'conversion')
    expect(conversion?.status).toBe('not_connected')
    expect(conversion?.value).toBeUndefined()
    // 漏斗要 GA4、广告那块要广告后台：原位占位
    expect(data.blocks.find((b) => b.id === 'funnel')?.status).toBe('not_connected')
    const ads = data.blocks.find((b) => b.id === 'ads')
    expect(ads?.status).toBe('not_connected')
    expect(ads?.needs?.map((n) => n.label)).toEqual(['Meta Ads', 'Google Ads'])
  })

  it('订单没带来源 → 「订单从哪来」照实说为什么，不编', () => {
    const data = computeReport(business(), queryContext(), '30d')
    const block = data.blocks.find((b) => b.id === 'order-sources')
    expect(block?.status).toBe('empty')
    expect(block?.note).toContain('没带进店来源')
  })

  it('订单带了来源就分得出：AI 回答 / 自然搜索 / 邮件 / 付费', () => {
    expect(orderChannel(order({ at: NOW, total: 1, referring_site: 'https://chatgpt.com/' }))).toBe(
      'ai',
    )
    expect(
      orderChannel(order({ at: NOW, total: 1, referring_site: 'https://www.google.com/' })),
    ).toBe('search')
    expect(
      orderChannel(order({ at: NOW, total: 1, landing_site: '/products/a?utm_source=klaviyo' })),
    ).toBe('email')
    expect(orderChannel(order({ at: NOW, total: 1, landing_site: '/?gclid=abc' }))).toBe('paid')
    expect(orderChannel(order({ at: NOW, total: 1, landing_site: '/' }))).toBe('direct')
    expect(orderChannel(order({ at: NOW, total: 1 }))).toBeUndefined()
    const orders = [
      order({ at: '2026-09-01T02:00:00Z', total: 100, referring_site: 'https://www.google.com/' }),
      order({ at: '2026-09-02T02:00:00Z', total: 50, referring_site: 'https://www.google.com/' }),
      order({ at: '2026-09-03T02:00:00Z', total: 80, referring_site: 'https://perplexity.ai/' }),
    ]
    const data = computeReport(business(), queryContext({ orders }), '30d')
    const rank = data.blocks.find((b) => b.id === 'order-sources')?.payload as RankPayload
    expect(rank.rows.map((r) => [r.label, r.value])).toEqual([
      ['自然搜索', 2],
      ['AI 回答里点进来', 1],
    ])
  })

  it('趋势图：每天一格、上一段对齐；蓝点是这一段真做成的改动', () => {
    const applied = item({
      id: 'ap_price',
      kind: 'staged_change',
      title: 'Nano Brew 降价 10%',
      state: 'applied',
      payload: { change_id: 'c1', kind: 'price', target: { type: 'product', id: 'p' } },
      apply: { attempts: [{ at: '2026-08-30T03:00:00.000Z', result: 'ok' }] },
    } as never)
    const data = computeReport(business(), queryContext({ approvals: [applied] }), '30d')
    const trend = data.blocks.find((b) => b.kind === 'trend')?.payload as TrendPayload
    expect(trend.x).toHaveLength(30)
    expect(trend.previous).toHaveLength(30)
    expect(trend.events).toEqual([{ date: '2026-08-30', label: 'Nano Brew 降价 10%' }])
  })

  it('结论三句由数拼出来，最后一句是「要留意」', () => {
    const data = computeReport(business(), queryContext(), '30d')
    expect(data.conclusion?.by).toBe('rules')
    expect(data.conclusion?.lines).toHaveLength(3)
    expect(data.conclusion?.lines[0]).toContain('销售额 **$268**')
    expect(data.conclusion?.lines[2]?.startsWith('要留意')).toBe(true)
  })

  it('看板那一行：头条数 + 近 30 天每天的小走势', () => {
    const row = summarizeReport(business(), queryContext())
    expect(row.headline_label).toBe('近 30 天销售额')
    expect(row.headline.value).toBe(268)
    expect(row.spark).toHaveLength(30)
  })

  it('邮件报表：邮件后台没连 → 活动 / 流程两块原位占位', () => {
    const spec = defaultReport('web-ops.email') as ReportSpec
    const data = computeReport(spec, queryContext(), '30d')
    expect(data.blocks.find((b) => b.id === 'campaigns')?.status).toBe('not_connected')
    expect(data.blocks.find((b) => b.id === 'flows')?.needs?.[0]?.label).toBe('邮件营销后台')
  })
})

describe('WP438 跟 AI 说想看什么', () => {
  it('认得出说的是什么；认不出回 undefined（退回经营概览）', () => {
    expect(matchRecipe('近 8 周邮件活动对复购有没有用，按周看')?.id).toBe('email_repeat')
    expect(matchRecipe('订单都从哪来')?.id).toBe('sources')
    expect(matchRecipe('随便看看')).toBeUndefined()
  })

  it('配方 → AI 做的规格：3 个数 + 1 张图，指标都在表里', () => {
    const recipe = matchRecipe('哪几个商品卖得最好')
    if (recipe === undefined) throw new Error('应认得出')
    const spec = specFromRecipe(recipe, { id: 'rpt_ai_1', prompt: '哪几个商品卖得最好', at: NOW })
    expect(spec.origin).toBe('ai')
    expect(spec.blocks).toHaveLength(2)
    expect(validateReportSpec(spec)).toEqual([])
    expect(spec.created?.prompt).toBe('哪几个商品卖得最好')
  })
})
