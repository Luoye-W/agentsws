/**
 * WP251（决策 106）：政策字数门槛按文字类型分——中日韩 80 字，其他照旧 200 字符。
 *
 * 起因（WP250）：中文政策页八十来个字就把「七天无理由退货」说完了，按 200 个字符卡会被当成
 * 「不够长、不像政策」丢掉。
 */
import { describe, expect, it } from 'vitest'
import { looksLikePolicy, POLICY_MIN_CHARS_CJK, policyLength } from '../src/index.js'

/** 正好 n 个汉字的退货政策（带标点与空白，标点空白不算字）。 */
function zhPolicy(n: number): string {
  const head = '退货政策：'
  const body = '自签收之日起七天内可申请无理由退货商品需保持完好包装齐全运费由买家承担'
  let out = head
  while ((out.match(/[一-鿿]/g)?.length ?? 0) < n) out += body
  // 截到正好 n 个汉字
  let count = 0
  let cut = ''
  for (const ch of out) {
    if (/[一-鿿]/.test(ch)) count += 1
    if (count > n) break
    cut += ch
  }
  return `${cut}。 `
}

describe('WP251 政策门槛按文字类型分', () => {
  it('中文政策 80 字就算，79 字不算', () => {
    expect(POLICY_MIN_CHARS_CJK).toBe(80)
    const ok = zhPolicy(80)
    const short = zhPolicy(79)
    expect(policyLength(ok)).toMatchObject({ cjk: true, min: 80, length: 80 })
    expect(looksLikePolicy(ok)).toBe(true)
    expect(looksLikePolicy(short)).toBe(false)
    // 以前按 200 个字符卡：同一段中文在旧门槛下不够长
    expect(ok.length).toBeLessThan(200)
  })

  it('空白与标点不算字（中文那一档只数字母数字与汉字）', () => {
    const padded = `${zhPolicy(60)}${'，。 '.repeat(40)}`
    expect(padded.length).toBeGreaterThan(80)
    expect(policyLength(padded).length).toBe(60)
    expect(looksLikePolicy(padded)).toBe(false)
  })

  it('日文、韩文也按 80 字', () => {
    const ja = `返品について。${'商品到着後七日以内であれば返品を受け付けますが送料はお客様のご負担となります'.repeat(2)}`
    const ko = `반품 및 환불 안내. ${'상품 수령 후 칠일 이내에 반품 신청이 가능하며 배송비는 고객 부담입니다'.repeat(3)}`
    expect(policyLength(ja).cjk).toBe(true)
    expect(policyLength(ko).cjk).toBe(true)
    expect(looksLikePolicy(ja)).toBe(true)
    expect(looksLikePolicy(ko)).toBe(true)
  })

  it('英文照旧 200 字符', () => {
    const line = 'Refund policy: items may be returned within 30 days of delivery. '
    const short = line.repeat(2) // ~130 字符
    const long = line.repeat(4) // ~260 字符
    expect(policyLength(short)).toMatchObject({ cjk: false, min: 200 })
    expect(looksLikePolicy(short)).toBe(false)
    expect(looksLikePolicy(long)).toBe(true)
  })

  it('英文页里夹几个汉字仍按英文算（中日韩不过半）', () => {
    const mixed = `${'Shipping policy: we deliver worldwide within 7 business days. '.repeat(2)}运费`
    expect(policyLength(mixed).cjk).toBe(false)
    expect(looksLikePolicy(mixed)).toBe(false)
  })

  it('够长但不像政策（没有政策词）照样不算', () => {
    const story = '我们是一家做户外装备的小团队，'.repeat(10)
    expect(policyLength(story).length).toBeGreaterThanOrEqual(80)
    expect(looksLikePolicy(story)).toBe(false)
  })
})
