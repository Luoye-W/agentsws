/**
 * WP397：Amazon 库存补货公式与 FBA 赔偿复核算式（docs/106 §13、A14：数由公式算，不让模型估）。
 */
import { describe, expect, it } from 'vitest'
import {
  AMAZON_STOCKOUT_RISK_DAYS,
  agedInventoryBand,
  auditReimbursements,
  daysOfCover,
  inStockVelocity,
  planningLeadTime,
  type ReimbursementRecord,
  reorderPoint,
  restockPlan,
  SERVICE_LEVEL_Z,
  safetyStock,
  stockoutBand,
} from '../src/index.js'

const day = (i: number, units: number, in_stock?: boolean) => ({
  date: `2026-09-${String(i).padStart(2, '0')}`,
  units,
  ...(in_stock === undefined ? {} : { in_stock }),
})

describe('WP397 库存公式', () => {
  it('断货线是 14 天；14–21 天是「快到了」', () => {
    expect(AMAZON_STOCKOUT_RISK_DAYS).toBe(14)
    expect(stockoutBand(13.9)).toBe('at_risk')
    expect(stockoutBand(14)).toBe('approaching')
    expect(stockoutBand(20.9)).toBe('approaching')
    expect(stockoutBand(21)).toBe('ok')
    expect(stockoutBand(undefined)).toBe('ok')
  })

  it('断货期的零销量剔除：标了 in_stock:false 的剔除；没标的连续 ≥3 天卖 0 也剔除', () => {
    const days = [
      day(1, 10),
      day(2, 0),
      day(3, 0),
      day(4, 0),
      day(5, 10),
      day(6, 0),
      day(7, 10, false),
    ]
    const v = inStockVelocity(days)
    expect(v?.excluded_dates).toEqual(['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'])
    // 剩下 1、5、6 三天：10 + 10 + 0（单独一天卖 0 不算断货）
    expect(v?.days_used).toBe(3)
    expect(v?.avg_daily_units).toBeCloseTo(20 / 3)
    expect(inStockVelocity(days, { zero_streak_as_stockout: 0 })?.days_used).toBe(6)
    expect(inStockVelocity([day(1, 0, false)])).toBeUndefined()
  })

  it('安全库存 = Z × σ × √L；补货点 = 日均 × L + 安全库存；可售天数含在途', () => {
    expect(SERVICE_LEVEL_Z['0.95']).toBe(1.65)
    expect(safetyStock({ z: 1.65, std_daily_units: 4, lead_time_days: 25 })).toBeCloseTo(33)
    expect(reorderPoint({ avg_daily_units: 10, lead_time_days: 25, safety_stock: 33 })).toBe(283)
    expect(daysOfCover({ fulfillable: 100, inbound: 40, avg_daily_units: 10 })).toBe(14)
    expect(daysOfCover({ fulfillable: 100, avg_daily_units: 0 })).toBeUndefined()
    expect(() => safetyStock({ z: 1.65, std_daily_units: -1, lead_time_days: 3 })).toThrow()
  })

  it('Lead Time 取最近 5 次的最大值再加旺季缓冲；库龄 181 / 365 分档', () => {
    expect(planningLeadTime([30, 45, 38], 10)).toBe(55)
    expect(planningLeadTime([90, 30, 31, 32, 33, 34])).toBe(34)
    expect(agedInventoryBand(180)).toBe('none')
    expect(agedInventoryBand(181)).toBe('surcharge')
    expect(agedInventoryBand(365)).toBe('surcharge_high')
  })

  it('补货建议：缺数回 missing、不按 0 顶上', () => {
    expect(restockPlan({ sku: 'A' })).toEqual({
      status: 'missing',
      sku: 'A',
      missing: ['fulfillable', 'daily', 'lead_time_days', 'cover_days_after_arrival'],
    })
    const allOut = restockPlan({
      sku: 'A',
      fulfillable: 0,
      daily: [day(1, 0, false)],
      lead_time_days: 30,
      cover_days_after_arrival: 30,
    })
    expect(allOut).toMatchObject({ status: 'missing', missing: ['in_stock_days'] })
  })

  it('补货建议：算式一步步写出来，补货量向上取整、不为负', () => {
    const daily = Array.from({ length: 10 }, (_, i) => day(i + 1, i % 2 === 0 ? 8 : 12))
    const plan = restockPlan({
      sku: 'EB-01',
      fulfillable: 100,
      inbound: 20,
      daily,
      lead_time_days: 25,
      cover_days_after_arrival: 30,
    })
    if (plan.status !== 'ok') throw new Error('should be ok')
    expect(plan.avg_daily_units).toBe(10)
    expect(plan.std_daily_units).toBe(2)
    expect(plan.days_of_cover).toBe(12)
    expect(plan.band).toBe('at_risk')
    expect(plan.safety_stock).toBeCloseTo(16.5)
    expect(plan.reorder_point).toBeCloseTo(266.5)
    expect(plan.reorder_now).toBe(true)
    // 10 × 55 + 16.5 − 100 − 20 = 446.5 → 447
    expect(plan.quantity).toBe(447)
    expect(plan.formulas).toHaveLength(5)
    expect(plan.formulas[4]).toContain('= 447')
    const flush = restockPlan({
      ...{ sku: 'X', daily, lead_time_days: 1, cover_days_after_arrival: 1 },
      fulfillable: 9999,
    })
    expect(flush.status === 'ok' && flush.quantity).toBe(0)
  })
})

describe('WP397 FBA 赔偿复核', () => {
  const base: ReimbursementRecord = {
    event_id: 'E1',
    sku: 'EB-01',
    currency: 'USD',
    event_stage: 'before_customer_order',
    affected_units: 3,
    documented_unit_cost: 120,
    already_reimbursed_net: 200,
    policy_unit_cap: 100,
    evidence_ids: ['INV-1'],
    policy_eligibility_verified: true,
    unit_basis_verified: true,
    window: 'open',
  }

  it('核对基数 = min(成本, 上限) × 件数；差额与复核候选额', () => {
    const out = auditReimbursements('USD', [base])
    expect(out.rows[0]).toMatchObject({
      status: 'PASS',
      base: 300,
      difference: 100,
      review_candidate: 100,
    })
    expect(out.review_candidate_total_for_pass_rows).toBe(100)
    expect(out.complete).toBe(true)
  })

  it('多赔了不追回：差额为负时候选额是 0', () => {
    const out = auditReimbursements('USD', [{ ...base, already_reimbursed_net: 350 }])
    expect(out.rows[0]).toMatchObject({ difference: -50, review_candidate: 0 })
  })

  it('没核过 / 窗口没开 / 缺数 → HOLD；下单后的事件 → 人工；不进合计', () => {
    const out = auditReimbursements('USD', [
      base,
      { ...base, event_id: 'E2', policy_unit_cap: undefined, window: 'unknown' },
      { ...base, event_id: 'E3', evidence_ids: [], unit_basis_verified: false },
      { ...base, event_id: 'E4', event_stage: 'after_customer_order' },
    ])
    expect(out.rows.map((r) => r.status)).toEqual(['PASS', 'HOLD', 'HOLD', 'MANUAL'])
    expect(out.rows[1]?.reasons).toEqual(['missing_policy_unit_cap', 'window_unknown'])
    expect(out.rows[2]?.reasons).toEqual(['missing_evidence', 'unit_basis_not_verified'])
    expect(out.review_candidate_total_for_pass_rows).toBe(100)
    expect(out.complete).toBe(false)
  })

  it('币种对不上、重复事件、负数 → INVALID', () => {
    const out = auditReimbursements('USD', [
      { ...base, currency: 'EUR' },
      { ...base, event_id: 'D' },
      { ...base, event_id: 'D' },
      { ...base, event_id: 'N', documented_unit_cost: -1 },
    ])
    expect(out.rows.map((r) => r.status)).toEqual(['INVALID', 'INVALID', 'INVALID', 'INVALID'])
    expect(out.rows[0]?.reasons).toEqual(['currency_mismatch'])
    expect(out.rows[1]?.reasons).toEqual(['duplicate_event'])
    expect(out.review_candidate_total_for_pass_rows).toBe(0)
  })
})
