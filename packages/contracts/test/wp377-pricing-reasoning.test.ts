import { describe, expect, it } from 'vitest'
import { type PricingModelEntry, pricingReasoningOf } from '../src/index.js'

const row = (reasoning: unknown): Pick<PricingModelEntry, 'reasoning'> =>
  ({ reasoning }) as Pick<PricingModelEntry, 'reasoning'>

describe('WP377 价目里的思考档', () => {
  it('没声明就没有', () => {
    expect(pricingReasoningOf({})).toBeUndefined()
    expect(pricingReasoningOf(row(null))).toBeUndefined()
    expect(pricingReasoningOf(row({ efforts: 'high' }))).toBeUndefined()
  })

  it('照声明给，按由浅到深排、去重、认不得的丢掉', () => {
    expect(
      pricingReasoningOf(row({ efforts: ['max', 'off', 'high', 'high', 'ultra'], default: 'high' })),
    ).toEqual({ efforts: ['off', 'high', 'max'], default: 'high' })
  })

  it('只有 off（没有能想的档）当没声明', () => {
    expect(pricingReasoningOf(row({ efforts: ['off'] }))).toBeUndefined()
  })

  it('默认档不在声明里就不带', () => {
    expect(pricingReasoningOf(row({ efforts: ['off', 'high'], default: 'max' }))).toEqual({
      efforts: ['off', 'high'],
    })
  })
})
