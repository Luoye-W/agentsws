import { describe, expect, it } from 'vitest'
import {
  bigrams,
  detectSecret,
  jaccard,
  matchExpression,
  ngramText,
  queryTerms,
  redactSecrets,
  sensitivityRank,
  structuredConflict,
  visibilityWhere,
} from '../src/index.js'
import { aftersales } from './fixtures.js'

describe('中文 2-gram 预处理（13 §2 的 FTS5 中文缺口）', () => {
  it('bigrams', () => {
    expect(bigrams('退货')).toEqual(['退货'])
    expect(bigrams('德国站')).toEqual(['德国', '国站'])
    expect(bigrams('天')).toEqual(['天'])
    expect(bigrams('')).toEqual([])
  })

  it('ngramText：CJK 段展开，拉丁词小写直通', () => {
    expect(ngramText('德国站退货 14 天')).toBe('德国 国站 站退 退货 14 天')
    expect(ngramText('SKU-A1 成本价')).toBe('sku a1 成本 本价')
  })

  it('queryTerms：人可读词 + FTS5 短语，去重', () => {
    expect(queryTerms('退货 德国站 退货')).toEqual([
      { term: '退货', phrase: '"退货"' },
      { term: '德国站', phrase: '"德国 国站"' },
    ])
    expect(queryTerms('   ')).toEqual([])
  })

  it('matchExpression 把词 OR 起来', () => {
    expect(matchExpression(queryTerms('退货 德国'))).toBe('("退货") OR ("德国")')
    expect(matchExpression([])).toBeUndefined()
  })

  it('jaccard', () => {
    expect(jaccard('偏好正式语气', '偏好正式语气')).toBe(1)
    expect(jaccard('偏好正式语气', '收货地址在慕尼黑')).toBeLessThan(0.2)
    expect(jaccard('', '')).toBe(1)
  })
})

describe('写过滤 / 脱敏形态', () => {
  it('detectSecret 按优先级给原因', () => {
    expect(detectSecret('kunde@example.de')).toBe('email_like')
    expect(detectSecret('DE89370400440532013000')).toBe('iban_like')
    expect(detectSecret('4111 1111 1111 1111')).toBe('card_number_like')
    expect(detectSecret('订单 1234567890')).toBe('long_digit_run')
    expect(detectSecret('退货窗口 14 天')).toBeUndefined()
    // 多次调用不受 /g 的 lastIndex 影响
    expect(detectSecret('kunde@example.de')).toBe('email_like')
  })

  it('redactSecrets 只遮秘密片段', () => {
    expect(redactSecrets('联系 kunde@example.de 处理')).toBe('联系 [redacted] 处理')
    expect(redactSecrets('退货窗口 14 天')).toBe('退货窗口 14 天')
  })
})

describe('可见性谓词（过滤下推）', () => {
  it('无 read scope → 恒假', () => {
    const f = visibilityWhere({ ...aftersales(), grants: [] })
    expect(f.sql).toContain('0')
    expect(f.params).toEqual(['ws_1'])
  })

  it('knowledge 域顺带覆盖 company 级知识；参数全部走占位符', () => {
    const f = visibilityWhere(aftersales())
    expect(f.sql).not.toContain("'")
    expect(f.params).toContain('company')
    expect(f.params[0]).toBe('ws_1')
  })

  it('sensitivityRank 按 SENSITIVITY_ORDER', () => {
    expect(sensitivityRank('public')).toBe(0)
    expect(sensitivityRank('restricted')).toBe(3)
    expect(sensitivityRank('不存在的级别')).toBe(4)
  })
})

describe('冲突判定', () => {
  it('同 key 不同值算冲突；缺 structured 不算', () => {
    expect(structuredConflict({ d: 14 }, { d: 30 })).toEqual({ key: 'd', a: '14', b: '30' })
    expect(structuredConflict({ d: 14 }, { d: 14 })).toBeUndefined()
    expect(structuredConflict({ d: 14 }, { other: 1 })).toBeUndefined()
    expect(structuredConflict(undefined, { d: 30 })).toBeUndefined()
  })
})
