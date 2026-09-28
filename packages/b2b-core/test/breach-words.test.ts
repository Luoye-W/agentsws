import { QUOTE_MANDATE_RULES } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { QUOTE_BREACH_WORDS, quoteBreaches, quoteBreachText } from '../src/index.js'

describe('WP174：超授权的那几条说人话（卡面不露字段名）', () => {
  it('四条授权规则一条不漏，中英各一套', () => {
    for (const r of QUOTE_MANDATE_RULES) {
      expect(QUOTE_BREACH_WORDS[r.rule]?.zh).toBeTruthy()
      expect(QUOTE_BREACH_WORDS[r.rule]?.en).toBeTruthy()
    }
    expect(Object.keys(QUOTE_BREACH_WORDS).sort()).toEqual(
      QUOTE_MANDATE_RULES.map((r) => r.rule).sort(),
    )
  })

  it('超了金额与毛利 → 「金额、毛利」 / "amount, margin"；没登记的规则名不硬印', () => {
    const breaches = quoteBreaches({
      amount_usd: 18400,
      margin_pct: 18.5,
      discount_pct: 0,
      payment_terms_days: 30,
    })
    expect(quoteBreachText(breaches)).toBe('金额、毛利')
    expect(quoteBreachText(breaches, 'en')).toBe('amount, margin')
    const all = quoteBreachText(QUOTE_MANDATE_RULES.map((r) => r.rule))
    expect(all).toBe('金额、毛利、折扣、账期')
    expect(all).not.toMatch(/[a-z_]/)
    expect(quoteBreachText(['quote_new_rule_over_mandate'])).toBe('其他条件')
  })
})
