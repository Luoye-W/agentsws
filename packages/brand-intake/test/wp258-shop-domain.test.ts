/**
 * WP258：官网页面自己漏出来的 Shopify 店铺地址（`Shopify.shop = "xxx.myshopify.com"`）——
 * 品牌分析时顺手取下来存进档案，建站岗位登录 Shopify 后拿它和账号下的店对一下。
 *
 * 密码页上也有这一行：开着访问密码、解不开的店照样取得到。
 */
import { describe, expect, it } from 'vitest'
import type { PageFetch } from '../src/fetch.js'
import { analyzeSite, shopifyShopDomain } from '../src/index.js'
import { fixture } from './fixtures.js'

const SHOP_LINE =
  '<script>var Shopify = Shopify || {};\nShopify.shop = "6suegp-md.myshopify.com";</script>'

const pagesFetch =
  (pages: Record<string, string>): PageFetch =>
  async (url) => {
    const html = pages[url]
    if (html === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => html }
  }

describe('WP258 · 官网里的 myshopify 地址', () => {
  it('认 Shopify.shop 那一行、主题里的 myshopify_domain；都没有就不猜', () => {
    expect(shopifyShopDomain(SHOP_LINE)).toBe('6suegp-md.myshopify.com')
    expect(shopifyShopDomain("Shopify.shop='Rollout-Gear.myshopify.com';")).toBe(
      'rollout-gear.myshopify.com',
    )
    expect(shopifyShopDomain('{"myshopifyDomain":"abc-1.myshopify.com"}')).toBe(
      'abc-1.myshopify.com',
    )
    expect(shopifyShopDomain('{"myshopify_domain": "abc-2.myshopify.com"}')).toBe(
      'abc-2.myshopify.com',
    )
    // 自家域名、cdn 链接都不是它
    expect(
      shopifyShopDomain(
        '<a href="https://rolloutgear.com">x</a><script src="https://cdn.shopify.com/a.js"></script>',
      ),
    ).toBeUndefined()
    expect(shopifyShopDomain('Shopify.shop = "evil.example.com";')).toBeUndefined()
  })

  it('analyzeSite 把它记进档案（带出处）', async () => {
    const home = `<html><head><meta property="og:site_name" content="Rollout Gear"><script src="https://cdn.shopify.com/s/x.js"></script>${SHOP_LINE}</head><body><main><h1>Rollout Gear</h1></main></body></html>`
    const out = await analyzeSite(
      pagesFetch({ 'https://rolloutgear.com/': home }),
      'https://rolloutgear.com/',
      {
        maxPages: 1,
      },
    )
    expect(out.profile.shopify_domain).toMatchObject({
      value: '6suegp-md.myshopify.com',
      evidence: [expect.objectContaining({ locator: 'script:Shopify.shop' })],
    })
  })

  it('开着访问密码、没填密码：提前收尾也带着店铺地址', async () => {
    const locked = fixture('shop-password.html').replace('</head>', `${SHOP_LINE}</head>`)
    const out = await analyzeSite(
      pagesFetch({ 'https://rolloutgear.com/': locked }),
      'https://rolloutgear.com/',
    )
    expect(out.password_protected).toBe(true)
    expect(out.failure_kind).toBe('password')
    expect(out.profile.shopify_domain?.value).toBe('6suegp-md.myshopify.com')
  })

  it('不是 Shopify 的站没有这一格', async () => {
    const out = await analyzeSite(
      pagesFetch({
        'https://plain.example/': '<html><head><title>Plain</title></head><body>hi</body></html>',
      }),
      'https://plain.example/',
      { maxPages: 1 },
    )
    expect(out.profile.shopify_domain).toBeUndefined()
  })
})
