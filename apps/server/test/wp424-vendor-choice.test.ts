/**
 * WP424（Luoye 10-19）：「邮件营销」不等于 Klaviyo——用户说的那一家对上连接目录里的哪一个 provider。
 * 大小写、空格、括号说明都不算；对不上就是对不上（不替人挑一家）。
 */
import { describe, expect, it } from 'vitest'
import { matchVendorService, VENDOR_CHOICE_KINDS } from '../src/onboarding.js'

const EMAIL = [
  { service: 'klaviyo', label: 'Klaviyo（邮件营销）' },
  { service: 'shopify_email', label: 'Shopify Email（邮件营销）' },
]

describe('WP424 · 用户说的邮件服务 → 连接目录', () => {
  it('邮件营销这一类按档案的 email_service 选', () => {
    expect(VENDOR_CHOICE_KINDS.email_marketing).toBe('email_service')
  })

  it('认 provider id 与卡上名字，大小写 / 空格 / 括号说明都不算', () => {
    expect(matchVendorService('Klaviyo', EMAIL)).toBe('klaviyo')
    expect(matchVendorService('  KLAVIYO ', EMAIL)).toBe('klaviyo')
    expect(matchVendorService('我们用 Klaviyo 发邮件', EMAIL)).toBe('klaviyo')
    expect(matchVendorService('Shopify Email', EMAIL)).toBe('shopify_email')
    expect(matchVendorService('shopify_email', EMAIL)).toBe('shopify_email')
  })

  it('没说 / 太短 / 目录里没有的一家 → 对不上', () => {
    expect(matchVendorService(undefined, EMAIL)).toBeUndefined()
    expect(matchVendorService('', EMAIL)).toBeUndefined()
    expect(matchVendorService('ab', EMAIL)).toBeUndefined()
    expect(matchVendorService('Omnisend', EMAIL)).toBeUndefined()
    expect(matchVendorService('Mailchimp', EMAIL)).toBeUndefined()
  })
})
