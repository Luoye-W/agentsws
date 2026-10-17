/**
 * WP390（docs/105 §3.3）：官网价目「钱花在哪」多一块「工坊服务」——能力名 `workshop.service.*` 归它，
 * 与 contracts 的 `pricingBlockOf` 同一条。
 */
import { describe, expect, it } from 'vitest'
import { blockOf } from '../src/lib/pricing.js'

describe('WP390 官网价目第四块', () => {
  it('workshop.service.* 归「工坊服务」，别的不动', () => {
    expect(blockOf({ capability: 'workshop.service.escrow' })).toBe('workshop_service')
    expect(blockOf({ capability: 'x', block: 'workshop_service' as never })).toBe(
      'workshop_service',
    )
    expect(blockOf({ capability: 'kol.service.monthly' })).toBe('service')
    expect(blockOf({ capability: 'ai.chat' })).toBe('ai')
  })
})
