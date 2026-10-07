/**
 * WP244（Fable 10-07 真机，rolloutgear.com）：刚开的 Shopify 空店不该被读成「品牌名 = My Store」。
 *
 * 夹具 = Shopify 默认店：店名 My Store、首页默认主题（Image banner / Talk about your brand）、
 * 只有 Shopify 自动生成的那份隐私政策。另一条：政策摘要只取正文（不带页头导航）、实体解码。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeBrand,
  analyzeSite,
  decodeEntities,
  isFreshShopifyStore,
  looksLikeDefaultPolicy,
  mainText,
} from '../src/index.js'
import { fixture, replayFetch, SHOP, SHOP_PAGES } from './fixtures.js'

const FRESH = 'https://rollout.example'

const FRESH_PAGES: Record<string, string> = {
  [`${FRESH}/`]: 'fresh-home.html',
  [`${FRESH}/policies/privacy-policy`]: 'fresh-privacy.html',
}

describe('WP244 · 刚开的 Shopify 空店', () => {
  it('认得出来：店名 My Store + 默认首页', () => {
    expect(isFreshShopifyStore(fixture('fresh-home.html'), 'My Store')).toBe(true)
    // 正式店（Nordvik）不是
    expect(isFreshShopifyStore(fixture('shop-home.html'), 'Nordvik Supply')).toBe(false)
    // 只有一句「Welcome to our store」的正式店也不算（要对上两句默认文字）
    const one =
      '<script src="https://cdn.shopify.com/x.js"></script><main><h2>Welcome to our store</h2><p>Hand-made tea.</p></main>'
    expect(isFreshShopifyStore(one, 'Leafwise')).toBe(false)
  })

  it('品牌名 / 一句话不填，默认隐私政策不进，结果标 fresh_store', async () => {
    const { fetch } = replayFetch(FRESH_PAGES)
    const out = await analyzeSite(fetch, `${FRESH}/`)
    expect(out.fresh_store).toBe(true)
    expect(out.profile.brand_name).toBeUndefined()
    expect(out.profile.one_liner).toBeUndefined()
    expect(out.profile.policies).toBeUndefined()
    // 平台照样认（Shopify），这一格是真的
    expect(out.profile.storefront_platform?.value).toBe('shopify')
    // 首页确实读到了（不是失败）
    expect(out.pages.some((p) => p.kind === 'home' && p.ok)).toBe(true)
  })

  it('analyzeBrand 把 fresh_store 带出去', async () => {
    const { fetch } = replayFetch(FRESH_PAGES)
    const out = await analyzeBrand(fetch, [`${FRESH}/`])
    expect(out.fresh_store).toBe(true)
  })

  it('认得出 Shopify 替空店生成的政策；正式店那份不算', () => {
    expect(looksLikeDefaultPolicy(mainText(fixture('fresh-privacy.html')))).toBe(true)
    expect(looksLikeDefaultPolicy(mainText(fixture('shop-refund.html')))).toBe(false)
  })

  it('正式店不受影响：品牌名、一句话、政策照旧', async () => {
    const { fetch } = replayFetch(SHOP_PAGES)
    const out = await analyzeSite(fetch, `${SHOP}/`)
    expect(out.fresh_store).toBeUndefined()
    expect(out.profile.brand_name?.value).toBe('Nordvik Supply')
    expect(out.profile.one_liner?.value).toBe('Everyday carry gear, built to last a decade.')
    expect(out.profile.policies?.value.length).toBe(2)
  })
})

describe('WP244 · 政策摘要只取正文、实体解码', () => {
  it('摘要不带 Skip to content / 导航 / Cart 0，`&ndash;` 解成 –', async () => {
    const policy = fixture('fresh-privacy.html').replace(/My Store/g, 'Rollout Gear')
    const home = fixture('shop-home.html')
    const fetch = async (url: string) => {
      if (url === `${SHOP}/`) return { ok: true, status: 200, text: async () => home }
      if (url === `${SHOP}/policies/privacy-policy`)
        return { ok: true, status: 200, text: async () => policy }
      return { ok: false, status: 404, text: async () => '' }
    }
    // 关于 / 联系都 404，页数预算放宽一点，让探针走到隐私政策那一条
    const out = await analyzeSite(fetch, `${SHOP}/`, { maxPages: 30 })
    const privacy = out.profile.policies?.value.find((p) => p.kind === 'privacy')
    expect(privacy).toBeDefined()
    const summary = privacy?.summary ?? ''
    expect(summary.startsWith('Privacy policy')).toBe(true)
    expect(summary).not.toMatch(/Skip to content|Catalog|Cart 0/)
    expect(summary).not.toContain('&ndash;')
    expect(summary).not.toContain('&ldquo;')
    expect(summary).toContain('“Services”')
  })

  it('常见命名实体与十六进制写法都解', () => {
    expect(decodeEntities('A &ndash; B &mdash; C&rsquo;s &hellip; &#x2013; &#8212; &copy;')).toBe(
      'A – B — C’s … – — ©',
    )
    // 认不出来的原样留着
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;')
  })

  it('没有 <main> 的页面：去掉 header / nav / footer 再取', () => {
    const html =
      '<body><a href="#c">Skip to content</a><header><nav>Home Catalog</nav></header><h1>Refund policy</h1><p>Returns within 30 days.</p><footer>© Shop</footer></body>'
    expect(mainText(html)).toBe('Refund policy Returns within 30 days.')
  })
})
