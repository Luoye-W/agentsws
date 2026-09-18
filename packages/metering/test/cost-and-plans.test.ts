/**
 * WP115（65 §3 / §7）：我方成本表与会员 term / cycle 的算术。
 *
 * 这一组全是纯函数，钉的是三个具体的历史事故：
 * - 成本四舍五入到分 → 便宜模型成本恒为 0（KefuAgent）；
 * - 最长前缀没优先 → nano 按 gpt-5 记，贵 25 倍；
 * - grant_key 里带时间戳 → 定时任务每跑一次重发一次（KefuAgent）。
 */

import { COST_MICRO_UNIT } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  addCalendarMonths,
  COST_TABLE,
  cnyToMicros,
  costTableNeedsReview,
  dueCycles,
  grantKeyOf,
  matchTokenCost,
  mostExpensiveTokenCost,
  planById,
  planCycles,
  providerOfModel,
  shanghaiDate,
  termEndsAt,
  tokenCostMicros,
  unitCostMicros,
} from '../src/index.js'

describe('成本表', () => {
  it('最长前缀优先：gpt-5-nano 不会被按 gpt-5 记', () => {
    expect(matchTokenCost('gpt-5-nano')?.prefix).toBe('gpt-5-nano')
    expect(matchTokenCost('gpt-5')?.prefix).toBe('gpt-5')
    expect(matchTokenCost('gpt-5.4-mini')?.prefix).toBe('gpt-5.4-mini')
    expect(matchTokenCost('deepseek-v4-pro')?.prefix).toBe('deepseek-v4-pro')
  })

  it('认不出的模型落最贵档，而最贵档是**算出来的**（不是写死的）', () => {
    const worst = mostExpensiveTokenCost()
    expect(worst).toBeDefined()
    const unknown = tokenCostMicros('some-brand-new-model-2027', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(unknown.fallback).toBe(true)
    const known = tokenCostMicros('gpt-5-nano', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    // 兜底一定不比任何一档便宜——估便宜了会让真亏本的调用显示赚钱
    expect(unknown.micros).toBeGreaterThan(known.micros)
  })

  it('微单位：最便宜的模型跑 200 token 也不是 0', () => {
    const tiny = tokenCostMicros('gpt-5-nano', { input_tokens: 200, output_tokens: 0 })
    expect(tiny.micros).toBeGreaterThan(0)
    // 换算成"分"的话就是 0 —— 这正是 KefuAgent 踩过的那个坑
    expect(Math.round((tiny.micros / COST_MICRO_UNIT) * 100)).toBe(0)
  })

  it('币种折算用的是与 pricing.json 同一张汇率表', () => {
    const usd = tokenCostMicros('gpt-5', { input_tokens: 1_000_000, output_tokens: 0 })
    // 1.25 USD × 7.1 = 8.875 元
    expect(usd.micros).toBe(cnyToMicros(1.25 * 7.1))
    expect(usd.currency).toBe('USD')
    expect(COST_TABLE.fx.USD).toBe(7.1)
  })

  it('非 token 的按 provider:unit 记；认不出就是「不知道」，不落最贵档', () => {
    const apify = unitCostMicros('apify:call', 1)
    expect(apify.fallback).toBe(false)
    expect(apify.micros).toBeGreaterThan(0)
    const unknown = unitCostMicros('someoneelse:call', 1)
    expect(unknown.fallback).toBe(true)
    expect(unknown.micros).toBe(0)
  })

  it('成本表还没有人核对过（这件事必须在界面上说出来）', () => {
    expect(costTableNeedsReview()).toBe(true)
    expect(COST_TABLE.last_verified_at).toBeNull()
  })

  it('猜供应商：认得的按表，斜杠风格取前半段，再猜不出回 unknown（不回模型名）', () => {
    expect(providerOfModel('glm-5.3-flash')).toBe('zhipu')
    expect(providerOfModel('vendorx/model-y')).toBe('vendorx')
    expect(providerOfModel('model-y')).toBe('unknown')
  })
})

describe('会员 term / cycle', () => {
  it('日历月按 Asia/Shanghai，日号超界收回来', () => {
    // 1/31 12:00 北京 → +1 个月 = 2/28 12:00，不是 3/3
    expect(shanghaiDate(addCalendarMonths('2026-01-31T04:00:00.000Z', 1))).toBe('2026-02-28')
    expect(shanghaiDate(addCalendarMonths('2026-01-31T04:00:00.000Z', 2))).toBe('2026-03-31')
    // 闰年 2/29 也要对
    expect(shanghaiDate(addCalendarMonths('2028-01-31T04:00:00.000Z', 1))).toBe('2028-02-29')
    expect(shanghaiDate(addCalendarMonths('2026-12-15T16:00:00.000Z', 1))).toBe('2027-01-16')
  })

  it('grant_key 只由 (term_id, cycle 起始日) 决定——同一个 cycle 永远同一串', () => {
    const a = grantKeyOf('mst_1', '2026-03-05T04:00:00.000Z')
    const b = grantKeyOf('mst_1', '2026-03-05T09:30:00.000Z')
    expect(a).toBe(b)
    expect(a).not.toContain(String(Date.now()).slice(0, 6))
    expect(grantKeyOf('mst_2', '2026-03-05T04:00:00.000Z')).not.toBe(a)
  })

  it('term 拆 cycle：最后一个被 term 末尾封顶', () => {
    const plan = planById('beta-tester')
    expect(plan).toBeDefined()
    const anchor_at = '2026-03-05T04:00:00.000Z'
    const ends_at = '2026-05-20T04:00:00.000Z'
    const cycles = planCycles({ term_id: 'mst_1', plan: plan!, anchor_at, ends_at })
    expect(cycles).toHaveLength(3)
    expect(cycles[2]?.ends_at).toBe(ends_at)
    expect(new Set(cycles.map((c) => c.grant_key)).size).toBe(3)
  })

  it('termEndsAt：绝对日期优先于月数；月数超过 60 抛', () => {
    const anchor = '2026-03-05T04:00:00.000Z'
    expect(termEndsAt(anchor, { months: 2, until: '2027-01-01T00:00:00.000Z' })).toBe(
      '2027-01-01T00:00:00.000Z',
    )
    expect(shanghaiDate(termEndsAt(anchor, { months: 12 }))).toBe('2027-03-05')
    expect(() => termEndsAt(anchor, { months: 61 })).toThrow()
    expect(() => termEndsAt(anchor, {})).toThrow()
  })

  it('dueCycles：到点且没发过的才算', () => {
    const plan = planById('beta-tester')!
    const cycles = planCycles({
      term_id: 'mst_1',
      plan,
      anchor_at: '2026-03-05T04:00:00.000Z',
      ends_at: '2026-06-05T04:00:00.000Z',
    })
    const now = '2026-04-10T00:00:00.000Z'
    expect(dueCycles(cycles, now, new Set())).toHaveLength(2)
    expect(dueCycles(cycles, now, new Set([cycles[0]!.grant_key]))).toHaveLength(1)
  })
})
