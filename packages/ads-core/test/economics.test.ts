/**
 * WP224（docs/91 §2.2 #3）：盈亏线、两条线的对照、毛利瀑布。
 *
 * 钉住三件事：没填毛利率就是没填（不拿 1 顶上）；两条线只比 ROAS 那一条、花费那条一样；
 * 对照只记账、不改现在的止损线。
 */
import type { AdsLineCompareRow } from '@agentsws/contracts'
import { ADS_DEFAULT_CAPS, GROSS_MARGIN_FILL_PATH } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  betweenLines,
  breakEvenRoas,
  breakEvenView,
  compareLines,
  marginWaterfall,
  resolveGrossMargin,
  stopLossVerdict,
  summarizeLineCompare,
} from '../src/index.js'

describe('breakEvenRoas = 1 / 毛利率', () => {
  it('毛利 40% → 2.5；毛利 25% → 4；毛利 100% → 1', () => {
    expect(breakEvenRoas(40)).toBe(2.5)
    expect(breakEvenRoas(25)).toBe(4)
    expect(breakEvenRoas(100)).toBe(1)
    expect(breakEvenRoas(33)).toBe(3.03)
  })

  it('没填 / 填错（0、负数、超过 100）就是没有——不拿 1 顶上', () => {
    for (const m of [undefined, 0, -5, 4000, Number.NaN]) expect(breakEvenRoas(m)).toBeUndefined()
  })

  it('卡面那一格：没填写「没填毛利率」并给去填的入口', () => {
    expect(breakEvenView(undefined)).toEqual({
      note: '没填毛利率',
      fill_url: GROSS_MARGIN_FILL_PATH,
    })
    expect(breakEvenView(40)).toEqual({
      margin_pct: 40,
      break_even_roas: 2.5,
      note: '盈亏线 ROAS 2.5（毛利率 40%）',
    })
  })
})

describe('resolveGrossMargin：SKU 盖品类、品类盖品牌', () => {
  const entries = [
    { scope: 'brand' as const, margin_pct: 40 },
    { scope: 'category' as const, key: '耳机', margin_pct: 30 },
    { scope: 'sku' as const, key: 'EB-01', margin_pct: 55 },
    { scope: 'sku' as const, key: 'BAD', margin_pct: 0 },
  ]
  it('按小的取', () => {
    expect(resolveGrossMargin(entries, { sku: 'eb-01', category: '耳机' })?.margin_pct).toBe(55)
    expect(resolveGrossMargin(entries, { sku: 'X', category: '耳机' })?.margin_pct).toBe(30)
    expect(resolveGrossMargin(entries, {})?.margin_pct).toBe(40)
  })
  it('填错的那一格当没填，退到上一层', () => {
    expect(resolveGrossMargin(entries, { sku: 'BAD' })?.margin_pct).toBe(40)
  })
  it('一格都没有就是没有', () => {
    expect(resolveGrossMargin([], { sku: 'EB-01' })).toBeUndefined()
  })
})

describe('betweenLines：高于 1、低于盈亏线才标', () => {
  it('ROAS 1.8、线 2.5 → 标；0.8 / 3 / 缺数 → 不标', () => {
    expect(betweenLines(1.8, 2.5)).toBe(true)
    expect(betweenLines(1, 2.5)).toBe(true)
    expect(betweenLines(0.8, 2.5)).toBe(false)
    expect(betweenLines(3, 2.5)).toBe(false)
    expect(betweenLines(undefined, 2.5)).toBe(false)
    expect(betweenLines(1.8, undefined)).toBe(false)
  })
})

describe('compareLines：只换 ROAS 那条线，花费那条一样', () => {
  it('ROAS 1.8、花了日预算 40%：现在的线不停，盈亏线（毛利 40%）会停', () => {
    expect(compareLines({ roas: 1.8, spend: 400, daily_budget: 1000, margin_pct: 40 })).toEqual({
      fixed: 'hold',
      break_even: 'trigger',
      break_even_roas: 2.5,
    })
  })
  it('花得还不够（20%）两条线都不停——样本不够这条照旧', () => {
    const v = compareLines({ roas: 1.8, spend: 200, daily_budget: 1000, margin_pct: 40 })
    expect(v.fixed).toBe('hold')
    expect(v.break_even).toBe('hold')
  })
  it('没填毛利率：盈亏线那一边是 no_margin，现在那条照算', () => {
    expect(compareLines({ roas: 0.5, spend: 400, daily_budget: 1000 })).toEqual({
      fixed: 'trigger',
      break_even: 'no_margin',
    })
  })
  it('现在的止损线一个数没动：同一组数，stopLossVerdict 的结论与 compareLines 的 fixed 一致', () => {
    const input = { roas: 1.8, spend: 400, daily_budget: 1000 }
    expect(stopLossVerdict(input).outcome).toBe(compareLines({ ...input, margin_pct: 40 }).fixed)
    expect(stopLossVerdict(input).caps.stop_loss_roas_below).toBe(
      ADS_DEFAULT_CAPS.stop_loss_roas_below,
    )
  })
})

describe('summarizeLineCompare：两周的对照表', () => {
  const row = (
    date: string,
    id: string,
    fixed: AdsLineCompareRow['fixed'],
    be: AdsLineCompareRow['break_even'],
  ): AdsLineCompareRow => ({
    date,
    campaign_id: id,
    platform: 'meta',
    name: id,
    fixed,
    break_even: be,
    recorded_at: `${date}T23:30:00Z`,
  })
  it('按 campaign 汇：两条线各停几天、只有盈亏线会停几天、没填毛利率几天', () => {
    const view = summarizeLineCompare([
      row('2026-10-06', 'c1', 'hold', 'trigger'),
      row('2026-10-07', 'c1', 'trigger', 'trigger'),
      row('2026-10-07', 'c2', 'hold', 'no_margin'),
    ])
    expect(view.started_on).toBe('2026-10-06')
    expect(view.days).toBe(2)
    expect(view.complete).toBe(false)
    expect(view.summary[0]).toMatchObject({
      campaign_id: 'c1',
      days: 2,
      fixed_stop_days: 1,
      break_even_stop_days: 2,
      only_break_even_days: 1,
    })
    expect(view.summary[1]).toMatchObject({ campaign_id: 'c2', no_margin_days: 1 })
  })
  it('只取最先的 14 天；满 14 天算完整', () => {
    const rows = Array.from({ length: 16 }, (_, i) =>
      row(`2026-10-${String(i + 1).padStart(2, '0')}`, 'c1', 'hold', 'hold'),
    )
    const view = summarizeLineCompare(rows)
    expect(view.days).toBe(14)
    expect(view.complete).toBe(true)
    expect(view.rows.at(-1)?.date).toBe('2026-10-14')
  })
  it('一行都没有：没有开始日期', () => {
    expect(summarizeLineCompare([])).toEqual({ days: 0, complete: false, rows: [], summary: [] })
  })
})

describe('marginWaterfall：八项成本逐项扣', () => {
  it('给全了：落地成本、毛利、毛利率、算式', () => {
    const w = marginWaterfall({
      price: 100,
      costs: {
        procurement: 30,
        first_mile: 5,
        storage: 3,
        platform_fee: 15,
        ads: 20,
        last_mile: 6,
        returns: 2,
        fx: 1,
      },
    })
    expect(w.landed_cost).toBe(82)
    expect(w.margin).toBe(18)
    expect(w.margin_pct).toBe(18)
    expect(w.missing).toEqual([])
    expect(w.formula).toContain('100 − (采购 30 + 头程 5')
  })
  it('没给的项列进 missing，不装作算全了', () => {
    const w = marginWaterfall({ price: 50, costs: { procurement: 20 } })
    expect(w.missing).toHaveLength(7)
    expect(w.margin_pct).toBe(60)
  })
})
