/**
 * WP155（docs/81 §4）：搜索数据两条价目的口径。
 *
 * 钉的是**算法**而不是某个数：成本表里官方那一家（DataForSEO）每个动作的成本 + 云端摊销
 * ¥0.001，拿现价算毛利，必须 ≥ 80%（docs/77 §1：数据接口与体检类的目标）。价格由 Luoye 定，
 * 所以 `reviewed_at` 留空——定了以后改价、填日期，这条测试照样得过。
 */
import { describe, expect, it } from 'vitest'
import { COST_TABLE, unitCostMicros } from '../src/cost.js'
import { buildPricing, entryFor, PRICING_FILE } from '../src/pricing.js'

/** docs/77 §1.1：每次数据接口调用的云端摊销，一律按 ¥0.001 记。 */
const AMORTIZED_CNY = 0.001

function marginOf(price: number, costKey: string): number {
  const est = unitCostMicros(costKey, 1, COST_TABLE)
  expect(est.fallback, `${costKey} 应在成本表里`).toBe(false)
  const cost = est.micros / 1_000_000 + AMORTIZED_CNY
  return (price - cost) / price
}

describe('WP155 搜索数据价目', () => {
  const pricing = buildPricing()

  it('两条都在 data 块、按次、有来历、未核（等 Luoye 定）', () => {
    for (const cap of ['data.search.serp', 'data.search.ai_answer']) {
      const raw = PRICING_FILE.entries.find((e) => e.capability === cap)
      expect(raw, cap).toBeDefined()
      expect(raw?.block).toBe('data')
      expect(raw?.unit).toBe('call')
      expect(raw?.basis).toMatch(/80%/)
      expect(raw?.reviewed_at).toBeNull()
    }
  })

  it('SERP 一次：按最贵的那一档（Google + AI 概览）算，毛利 ≥ 80%', () => {
    const price = entryFor(pricing, 'data.search.serp')?.credits_per_unit as number
    expect(marginOf(price, 'dataforseo:serp')).toBeGreaterThanOrEqual(0.8)
  })

  it('AI 问答每个平台一次：四个平台逐个算，最贵的那个也 ≥ 80%', () => {
    const price = entryFor(pricing, 'data.search.ai_answer')?.credits_per_unit as number
    for (const p of ['chatgpt', 'gemini', 'perplexity', 'google_ai_overview'])
      expect(marginOf(price, `dataforseo:${p}`), p).toBeGreaterThanOrEqual(0.8)
  })
})
