import { describe, expect, it } from 'vitest'
import {
  companyEmailSuffix,
  isCompanyEmailSuffix,
  isPlaceholderOwnerEmail,
  PLACEHOLDER_OWNER_EMAIL,
  suggestCompanyEmailSuffix,
} from '../src/index.js'

describe('WP233 公司邮箱后缀', () => {
  it('误填整个邮箱时截 @ 后面那段；顺手去掉空白、协议、www、路径', () => {
    expect(companyEmailSuffix('Wang@InmoXR.com')).toBe('inmoxr.com')
    expect(companyEmailSuffix('  @inmoxr.com ')).toBe('inmoxr.com')
    expect(companyEmailSuffix('https://www.inmoxr.com/about')).toBe('inmoxr.com')
    expect(companyEmailSuffix('inmoxr.com')).toBe('inmoxr.com')
    expect(companyEmailSuffix('')).toBe('')
  })

  it('公共邮箱、占位、不像域名的不算公司后缀', () => {
    for (const d of ['gmail.com', 'qq.com', '163.com', 'outlook.com', 'localhost', 'foo', ''])
      expect(isCompanyEmailSuffix(d)).toBe(false)
    expect(isCompanyEmailSuffix('inmoxr.com')).toBe(true)
  })

  it('建议值：按顺序挑第一个公司邮箱；全是公共邮箱就不带', () => {
    expect(suggestCompanyEmailSuffix(['a@gmail.com', 'support@inmoxr.com'])).toBe('inmoxr.com')
    expect(suggestCompanyEmailSuffix(['me@corp.cn', 'support@inmoxr.com'])).toBe('corp.cn')
    expect(suggestCompanyEmailSuffix([PLACEHOLDER_OWNER_EMAIL, 'x@qq.com', undefined])).toBe(
      undefined,
    )
    expect(suggestCompanyEmailSuffix([])).toBe(undefined)
  })

  it('占位邮箱认得出（大小写与空白不敏感）', () => {
    expect(isPlaceholderOwnerEmail(' Owner@Localhost ')).toBe(true)
    expect(isPlaceholderOwnerEmail('owner@inmoxr.com')).toBe(false)
    expect(isPlaceholderOwnerEmail(undefined)).toBe(false)
  })
})
