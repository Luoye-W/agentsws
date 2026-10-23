/**
 * WP495（1701）：`hasCommitment`——只有真写了承诺（退款 / 退货天数、保修期、赔付 / 补发、价格保证）才算。
 * 规则判，不问模型。
 */
import { describe, expect, it } from 'vitest'
import { hasCommitment } from '../src/knowledge.js'

describe('hasCommitment', () => {
  it.each([
    'Returns are accepted within 30 days of delivery.',
    'We offer a 2-year warranty on all frames.',
    'Refunds are issued within 5-7 business days.',
    'If it arrives damaged we send a free replacement.',
    'Full refund if you are not happy.',
    'Lifetime warranty on the hinge.',
    'We price match for 14 days after purchase.',
    'Late delivery? We compensate $10 in store credit.',
    'We refund 50% of the shipping fee.',
    '收到退货后 3 个工作日内原路退款。',
    '保修期一年。',
    '七天无理由退货。',
    '少发漏发我们免费补发。',
    '30 天内降价，我们退差价。',
    '质保 2 年，人为损坏除外。',
  ])('算承诺：%s', (text) => {
    expect(hasCommitment(text)).toBe(true)
  })

  it.each([
    'For returns, please contact our support team first.',
    'Orders usually ship in 2 business days.',
    'The kit costs $29.99 and comes in black.',
    'Yes, we ship to Canada.',
    '退货请先联系客服，我们会告诉你地址。',
    '一般 3 天发货。',
    '这款是 2 年前出的老款。',
    // 承诺词和数字不在同一句：不凑
    'Orders ship in 3 days. Returns: contact us.',
    '',
  ])('不算：%s', (text) => {
    expect(hasCommitment(text)).toBe(false)
  })
})
