/**
 * WP75（57 §2 / §6、04 §5）：总闸、delta、止损三件事的纯函数。
 *
 * 每一条都顺带钉住"这句话说得清楚吗"——`reason` 是要原样上卡面的，
 * 说不清等于那张卡上只写着"超额了"。
 */
import { describe, expect, it } from 'vitest'
import {
  bidDelta,
  budgetDelta,
  daySpendGate,
  deltaPct,
  resolveAdsCaps,
  stopLossVerdict,
} from '../src/index.js'

describe('deltaPct', () => {
  it('从 0 提到任何数都是 Infinity —— 那是"新开口子"不是"调整"', () => {
    expect(deltaPct(0, 50)).toBe(Number.POSITIVE_INFINITY)
    expect(deltaPct(0, 0)).toBe(0)
  })
})

describe('budgetDelta / bidDelta（57 §6：20% / 15%）', () => {
  it('+10% 在额度里', () => {
    const v = budgetDelta(100, 110)
    expect(v.within).toBe(true)
    expect(v.direction).toBe('increase')
    expect(v.pct).toBe(10)
  })

  it('+30% 超了，而且理由里带着两个数（人不用自己再算一遍）', () => {
    const v = budgetDelta(100, 130)
    expect(v.within).toBe(false)
    expect(v.reason).toContain('30')
    expect(v.reason).toContain('20%')
  })

  it('**调低**预算再狠也在额度里（04 §5：减少花钱的动作从宽）', () => {
    const v = budgetDelta(1000, 100)
    expect(v.within).toBe(true)
    expect(v.direction).toBe('decrease')
    expect(v.reason).toContain('花得更少')
  })

  it('出价用的是 15% 那条线', () => {
    expect(bidDelta(2, 2.4).within).toBe(false)
    expect(bidDelta(2, 2.2).within).toBe(true)
  })

  it('caps 配了一半就补全（缺的用 57 §6 默认值）', () => {
    expect(resolveAdsCaps({ max_budget_delta_pct: 5 }).max_daily_spend).toBe(1000)
    expect(budgetDelta(100, 110, { max_budget_delta_pct: 5 }).within).toBe(false)
  })
})

describe('daySpendGate（岗位级总闸，四个平台加起来）', () => {
  const four = ['meta', 'google', 'x', 'tiktok']

  it('四个平台的花费**加起来**判，不是各判各的', () => {
    const v = daySpendGate({
      spend_by_platform: { meta: 400, google: 400, x: 100, tiktok: 50 },
      adding: 0,
    })
    expect(v.spent).toBe(950)
    expect(v.remaining).toBe(50)
    expect(v.open).toBe(true)
  })

  it('每个平台都没越自己那条线，合起来照样撞总闸', () => {
    const v = daySpendGate({
      spend_by_platform: { meta: 300, google: 300, x: 300, tiktok: 200 },
      adding: 0,
    })
    expect(v.open).toBe(false)
    expect(v.spent).toBe(1100)
    // 剩余是负的：面板上那一格要显示真实差额，不夹到 0
    expect(v.remaining).toBe(-100)
  })

  it('要再花的那一截算进去', () => {
    expect(daySpendGate({ spend_by_platform: { meta: 900 }, adding: 50 }).open).toBe(true)
    expect(daySpendGate({ spend_by_platform: { meta: 900 }, adding: 150 }).open).toBe(false)
  })

  it('哪个平台今天还没拉到数，**在话里说出来**（不说就等于谎报宽裕）', () => {
    const v = daySpendGate({
      spend_by_platform: { meta: 200 },
      expected_platforms: four,
    })
    expect(v.reason).toContain('还没拉到数')
    expect(v.reason).toContain('google')
    // 按 0 算，但四行都在（面板点开看的就是这四行）
    expect(v.by_platform).toHaveLength(4)
  })

  it('总闸那个数可以按品牌改（`caps`）', () => {
    expect(
      daySpendGate({ spend_by_platform: { meta: 1500 }, caps: { max_daily_spend: 2000 } }).open,
    ).toBe(true)
  })
})

describe('stopLossVerdict（57 §6：ROAS < 1 **且** 花费 > 日预算 30%）', () => {
  it('两条都成立 → trigger', () => {
    const v = stopLossVerdict({ roas: 0.6, spend: 400, daily_budget: 1000 })
    expect(v.outcome).toBe('trigger')
    expect(v.spend_pct).toBe(40)
    expect(v.reason).toContain('止损')
  })

  it('ROAS 低但还没花够 → hold，而且话里说的是"样本还不够"', () => {
    const v = stopLossVerdict({ roas: 0.6, spend: 100, daily_budget: 1000 })
    expect(v.outcome).toBe('hold')
    expect(v.roas_below).toBe(true)
    expect(v.spend_over).toBe(false)
    expect(v.reason).toContain('样本')
  })

  it('花得多但 ROAS 好 → hold，而且话里说的是"该考虑加预算"', () => {
    const v = stopLossVerdict({ roas: 3.2, spend: 800, daily_budget: 1000 })
    expect(v.outcome).toBe('hold')
    expect(v.reason).toContain('加预算')
  })

  it('缺一格 → **unknown**，不是 hold 也不是 trigger', () => {
    const v = stopLossVerdict({ roas: 0.2, daily_budget: 1000 })
    expect(v.outcome).toBe('unknown')
    expect(v.roas_below).toBeUndefined()
    expect(v.reason).toContain('当日花费')
  })

  it('日预算是 0（按总预算投的）也判不了 —— 分母不能是 0', () => {
    expect(stopLossVerdict({ roas: 0.2, spend: 500, daily_budget: 0 }).outcome).toBe('unknown')
  })

  it('两条线都能按品牌改', () => {
    const v = stopLossVerdict({
      roas: 1.5,
      spend: 900,
      daily_budget: 1000,
      caps: { stop_loss_roas_below: 2, stop_loss_spend_pct: 50 },
    })
    expect(v.outcome).toBe('trigger')
  })
})
