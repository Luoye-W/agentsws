/** WP165：公开价目的几个小工具——拿不到就是空的、一个数都不编；坏数据当没取到。 */
import { describe, expect, it } from 'vitest'
import {
  catalogCreditsFor,
  isPricingCatalog,
  PRICING_CATALOG_PATH,
  PRICING_UNAVAILABLE_REASON,
  unavailablePricing,
  unavailableTopupTiers,
} from '../src/index.js'

describe('公开价目', () => {
  it('路径固定是 /v1/pricing', () => {
    expect(PRICING_CATALOG_PATH).toBe('/v1/pricing')
  })

  it('拿不到时：列表是空的、带一句人话、没有编出来的价钱', () => {
    const p = unavailablePricing()
    expect(p.entries).toEqual([])
    expect(p.source).toBe('unavailable')
    expect(p.unavailable_reason).toBe(PRICING_UNAVAILABLE_REASON)
    const t = unavailableTopupTiers('云上说不行')
    expect(t.tiers).toEqual([])
    expect(t.unavailable_reason).toBe('云上说不行')
  })

  it('像不像一份价目只查骨架；坏的一律不认', () => {
    expect(isPricingCatalog(null)).toBe(false)
    expect(isPricingCatalog({ pricing: { entries: [] } })).toBe(false)
    expect(
      isPricingCatalog({
        version: 1,
        pricing: { as_of: '2026-09-27', entries: [] },
        topup_tiers: { tiers: [] },
      }),
    ).toBe(true)
  })

  it('按能力算积分：四位小数；价目里没有就 undefined', () => {
    const pricing = {
      entries: [
        {
          capability: 'ai.image',
          unit: 'image',
          credits_per_unit: 0.35,
          label_zh: '',
          label_en: '',
        },
      ],
    }
    expect(catalogCreditsFor(pricing, 'ai.image', 3)).toBe(1.05)
    expect(catalogCreditsFor(pricing, 'nope')).toBeUndefined()
    expect(catalogCreditsFor(undefined, 'ai.image')).toBeUndefined()
  })
})
