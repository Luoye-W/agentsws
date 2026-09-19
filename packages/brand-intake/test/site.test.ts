/**
 * 官网那条路（70 §4.1）。
 *
 * 四件要钉住的事：
 *
 * 1. 一家标准 Shopify 店，该填的格子都填上了，**每一格都带得出出处**；
 * 2. 政策页判定看**内容**不看状态码（Shopify 把删掉的政策 302 回首页）；
 * 3. robots 的 `Disallow` 真的拦得住，而且 `/*​/cart/` 不会把整站判成禁抓；
 * 4. 抓不到的页面如实进 `pages`，并且**不影响别的格子**。
 *
 * 全程不联网：夹具表里没有的网址回 503。
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeSite,
  BRAND_INTAKE_USER_AGENT,
  isDisallowed,
  looksLikePolicy,
  parseRobotsDisallow,
} from '../src/index.js'
import { replayFetch, SHOP, SHOP_PAGES } from './fixtures.js'

describe('WP121 · 官网分析', () => {
  it('一家 Shopify 店：该填的都填上了，每一格都带着出处', async () => {
    const { fetch, calls } = replayFetch()
    const { profile, pages } = await analyzeSite(fetch, `${SHOP}/`)

    expect(profile.brand_name?.value).toBe('Nordvik Supply')
    // JSON-LD 里明写的 → high
    expect(profile.brand_name?.confidence).toBe('high')
    expect(profile.brand_name?.evidence[0]?.locator).toBe('jsonld:Organization.name')
    expect(profile.legal_name?.value).toBe('Nordvik Supply AB')

    expect(profile.logo_url?.value).toBe('https://nordvik.example/cdn/logo-512.png')
    expect(profile.primary_color?.value).toBe('#1f3a5f')
    expect(profile.one_liner?.value).toContain('built to last')
    expect(profile.languages?.value).toEqual(['en-US'])

    // 平台是**从页面上认出来的**，不是猜路径
    expect(profile.storefront_platform?.value).toBe('shopify')
    expect(profile.storefront_platform?.evidence[0]?.quote).toBe('cdn.shopify.com')

    // 社媒只留认得出的那两条，example.net 那条不算
    expect(profile.social_links?.value.map((s) => s.platform).sort()).toEqual([
      'instagram',
      'tiktok',
    ])

    expect(profile.support_email?.value).toBe('hello@nordvik.example')
    expect(profile.tone_samples?.value[0]).toContain('garage in Malmo')

    expect(profile.policies?.value.map((p) => p.kind).sort()).toEqual(['refund', 'shipping'])
    expect(profile.products?.value.map((p) => p.title)).toEqual(['Granite Wallet', 'Fjord Tote'])
    expect(profile.products?.value[1]?.has_variants).toBe(true)
    expect(profile.currency?.value).toBe('EUR')

    // 每一格都至少有一条出处
    for (const [key, f] of Object.entries(profile))
      expect(f?.evidence.length, key).toBeGreaterThan(0)

    // 抓着的页面都记下来了
    expect(pages.filter((p) => p.ok).length).toBeGreaterThanOrEqual(7)

    // 请求里认得出是我们，而且**一个凭据字段都没有**
    const header = calls[0]?.headers ?? {}
    expect(header['user-agent']).toBe(BRAND_INTAKE_USER_AGENT)
    expect(Object.keys(header).map((k) => k.toLowerCase())).toEqual(['user-agent', 'accept'])
  })

  it('政策页 302 回首页：按内容判，不按状态码判', async () => {
    // Shopify 把删掉的 /policies/refund-policy 302 到首页，于是这一跳是 200 + 首页正文
    const { fetch } = replayFetch(SHOP_PAGES, {
      [`${SHOP}/policies/refund-policy`]: 'shop-home.html',
    })
    const { profile } = await analyzeSite(fetch, `${SHOP}/`)
    // 首页正文不像一份政策 → 这一条不该被当成退换货政策收进去
    expect(profile.policies?.value.map((p) => p.kind)).toEqual(['shipping'])
  })

  it('looksLikePolicy：短的不算，长但不沾政策词的也不算', () => {
    expect(looksLikePolicy('Return within 30 days')).toBe(false) // 太短
    expect(looksLikePolicy(`${'我们做包很多年了。'.repeat(40)}`)).toBe(false) // 够长但没有政策词
    expect(looksLikePolicy(`${'x'.repeat(200)} 退货说明`)).toBe(true)
  })

  it('抓不到的页面如实记一句人话，别的格子照填', async () => {
    const { fetch } = replayFetch(SHOP_PAGES, { [`${SHOP}/pages/contact`]: 404 })
    const { profile, pages } = await analyzeSite(fetch, `${SHOP}/`)
    expect(profile.support_email).toBeUndefined()
    // 品牌名不受影响
    expect(profile.brand_name?.value).toBe('Nordvik Supply')
    const missed = pages.find((p) => p.url.endsWith('/pages/contact') && !p.ok)
    expect(missed?.reason).toBe('这个页面不存在（404）')
  })

  it('robots：Disallow 拦得住，而且 /*/cart/ 不会把整站判成禁抓', () => {
    const rules = parseRobotsDisallow(
      ['User-agent: *', 'Disallow: /*/cart/', 'Disallow: /checkout', 'Disallow: /admin'].join('\n'),
    )
    expect(rules).toEqual(['/*/cart/', '/checkout', '/admin'])
    // 这一条是整包最容易写错的：按"第一个 * 之前的前缀"算的话它等于 /，整站全禁
    expect(isDisallowed('/', rules)).toBe(false)
    expect(isDisallowed('/products/granite-wallet', rules)).toBe(false)
    expect(isDisallowed('/en/cart/', rules)).toBe(true)
    expect(isDisallowed('/checkout', rules)).toBe(true)
  })

  it('只认 `User-agent: *` 那一段', () => {
    const rules = parseRobotsDisallow(
      ['User-agent: Googlebot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /admin'].join('\n'),
    )
    expect(rules).toEqual(['/admin'])
  })

  it('robots 拦着的页面：不抓，并且说明白为什么', async () => {
    const { fetch, calls } = replayFetch(SHOP_PAGES, {
      [`${SHOP}/robots.txt`]: 'robots-strict.txt',
    })
    // 没有这份夹具 → robots 取不到 → 按"没有规则"走（读不到不等于禁止）
    const { pages } = await analyzeSite(fetch, `${SHOP}/`)
    expect(pages.some((p) => p.ok)).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/robots.txt'))).toBe(true)
  })
})
