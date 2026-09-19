/**
 * WP125（72 §P0-2 第一条）：敏感标识打码。
 *
 * 两组断言是这条纪律的全部：
 * - 真卡号（过 Luhn）打掉；
 * - 订单号 / 跟踪号这种**不过 Luhn**的长数字串一个字不动——误打比漏打更常见，
 *   也更难被发现（客服从此看不到客户给的订单号）。
 */
import { describe, expect, it } from 'vitest'
import { hasSensitive, luhnValid, maskSensitive } from '../src/sensitive-mask.js'

describe('maskSensitive', () => {
  it('过 Luhn 的卡号打成 [redacted:card]', () => {
    const out = maskSensitive('My card is 4111 1111 1111 1111, please charge it.')
    expect(out.text).toContain('[redacted:card]')
    expect(out.text).not.toContain('4111')
    expect(out.rules).toEqual(['card'])
  })

  it('连字符分组与无分隔一样打', () => {
    expect(maskSensitive('5500-0000-0000-0004').text).toBe('[redacted:card]')
    expect(maskSensitive('5500000000000004').text).toBe('[redacted:card]')
  })

  it('不过 Luhn 的长数字串不动（订单号 / 跟踪号）', () => {
    const out = maskSensitive('订单号 1234567890123，跟踪号 9400111899223197428490')
    expect(out.text).toContain('1234567890123')
    expect(out.rules).not.toContain('card')
  })

  it('CVV / 验证码 / 密码按上下文打，标签留着', () => {
    const out = maskSensitive('CVV: 123；验证码是 889321；password: hunter2secret')
    expect(out.text).toContain('[redacted:cvv]')
    expect(out.text).toContain('[redacted:otp]')
    expect(out.text).toContain('[redacted:password]')
    expect(out.text).not.toContain('889321')
    expect(out.text).not.toContain('hunter2secret')
    // 标签留着：模型要知道"客户贴过安全码"才可能回一句"这些我们不需要"
    expect(out.text.toLowerCase()).toContain('cvv')
    expect(out.rules).toEqual(['cvv', 'otp', 'password'])
  })

  it('光秃秃的三位数不当 CVV 打（没有上下文就不是安全码）', () => {
    const out = maskSensitive('我买了 3 件，一共 123 元')
    expect(out.rules).toEqual([])
    expect(out.text).toContain('123')
  })

  it('干净文本原样返回', () => {
    const text = 'Where is my order #1001? It has been two weeks.'
    expect(maskSensitive(text)).toEqual({ text, rules: [] })
    expect(hasSensitive(text)).toBe(false)
  })
})

describe('luhnValid', () => {
  it('认得出真卡号与假卡号', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('5500000000000004')).toBe(true)
    expect(luhnValid('1234567890123')).toBe(false)
    // 长度不在 13–19 一律不算（12 位与 20 位都不是卡号）
    expect(luhnValid('411111111111')).toBe(false)
  })
})
