/**
 * WP488（决策 1682）：FAQ 表导入的卡带上售前 / 售后（规则判，只认强信号；判不出不写 = 公共）。
 */
import { describe, expect, it } from 'vitest'
import { faqCard } from '../src/index.js'

const ctx = {
  workspace_id: 'ws_1',
  owner: 'p_1',
  by: 'p_1',
  at: '2026-10-23T00:00:00.000Z',
  source_ref: 'blob://k/1.csv',
  filename: 'faq.csv',
}
const row = (question: string) => ({ question, answer: '见说明。', sheet: '', row: 2 })

describe('FAQ 卡的范围', () => {
  it('问价 / 选型 → 售前；订单 / 物流 → 售后；政策类 → 不写（公共）', () => {
    expect(faqCard(row('How much is the 2-pack?') as never, ctx).stage).toBe('presales')
    expect(faqCard(row('Where is my order? It has not arrived') as never, ctx).stage).toBe(
      'postsales',
    )
    expect(faqCard(row('What is your return policy?') as never, ctx).stage).toBeUndefined()
  })
})
