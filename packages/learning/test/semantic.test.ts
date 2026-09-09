import { describe, expect, it } from 'vitest'
import { KEY_TOKEN_CAP, keySimilarity, keyTokens, semanticKey } from '../src/index.js'

describe('语义键', () => {
  it('去停用词、去重、排序、截断到 12 个词', () => {
    const tokens = keyTokens('the refund is for the order and the order is late late late')
    expect(tokens).not.toContain('the')
    expect(tokens).toEqual([...new Set(tokens)].sort())
    expect(tokens.length).toBeLessThanOrEqual(KEY_TOKEN_CAP)
  })

  it('词序不同 → 同一把键（英文按词）', () => {
    const a = semanticKey({
      skill: 's',
      kind: 'rule',
      text: 'check the return window before refunding',
    })
    const b = semanticKey({
      skill: 's',
      kind: 'rule',
      text: 'before refunding, check the return window',
    })
    expect(a).toBe(b)
  })

  it('标点与停用词的差别不换键（中文按字）', () => {
    const a = semanticKey({ skill: 's', kind: 'rule', text: '先看退货窗口，再谈退款' })
    const b = semanticKey({ skill: 's', kind: 'rule', text: '先看退货窗口再谈退款' })
    expect(a).toBe(b)
  })

  it('技能 / 段 / 类型不同 → 不同的键', () => {
    const base = { kind: 'rule' as const, text: '退款前先看退货窗口' }
    const a = semanticKey({ skill: 's1', ...base })
    const b = semanticKey({ skill: 's2', ...base })
    const c = semanticKey({ skill: 's1', section_id: 'sec_1', ...base })
    const d = semanticKey({ skill: 's1', ...base, kind: 'anti_example' })
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('相似度：全空 = 1，全不同 = 0', () => {
    expect(keySimilarity('的 了', '是 在')).toBe(1)
    expect(keySimilarity('apple orange', 'banana grape')).toBe(0)
    expect(keySimilarity('退货窗口 14 天', '退货窗口 30 天')).toBeGreaterThan(0)
  })
})
