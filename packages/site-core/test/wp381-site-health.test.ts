/**
 * WP381：网站 / 商品体检的纯逻辑，全用录好的样本（robots / 原始与渲染后的商品页 / JSON-LD / 店铺公开商品数据 /
 * Google 商品 feed / 平台上架页 / 退货政策页），不联网。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assessChatGptShopping,
  availabilityExpectation,
  checkAiCrawlers,
  checkProductFacts,
  compareRawRendered,
  crawlerVerdictIsProblem,
  DEFAULT_AI_CRAWLERS,
  effectiveCrawlers,
  feedSnapshotFor,
  freeShippingOverIn,
  issueLine,
  jsonLdSnapshot,
  type ProductTruth,
  pageAmounts,
  pageSnapshot,
  parseMerchantFeed,
  priceExpectation,
  returnDaysExpectation,
  returnDaysIn,
  type StoreTruth,
  sellingPointExpectation,
  shopifyProductJsSnapshot,
  validGtin,
} from '../src/index.js'

const fx = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'wp381', name), 'utf8')

const ORIGIN = 'https://nordvolt.example'

const PRODUCT: ProductTruth = {
  id: 'gid://shopify/Product/1001',
  title: 'NordVolt Power Bank 20000',
  handle: 'power-bank-20000',
  url: `${ORIGIN}/products/power-bank-20000`,
  description:
    '<p>Charge a laptop and two phones at once with 100W USB-C output. Weighs 380 g and fits in a jacket pocket.</p>',
  vendor: 'NordVolt',
  product_type: 'Power banks',
  image: 'https://cdn.shopify.example/pb.jpg',
  options: ['Color'],
  variants: [
    {
      id: 'gid://shopify/ProductVariant/2001',
      title: 'Black',
      sku: 'NV-PB20-BK',
      price: '49.99',
      available: true,
      barcode: '4006381333931',
    },
    {
      id: 'gid://shopify/ProductVariant/2002',
      title: 'White',
      sku: 'NV-PB20-WH',
      price: '49.99',
      available: false,
    },
  ],
}

const STORE: StoreTruth = {
  currency: 'USD',
  name: 'NordVolt',
  return_days: 30,
  free_shipping_over: '50.00',
  policy_urls: {
    refund: `${ORIGIN}/policies/refund-policy`,
    privacy: `${ORIGIN}/policies/privacy-policy`,
  },
}

describe('WP381 ② AI 爬虫（robots.txt）', () => {
  const crawlers = effectiveCrawlers()
  const verdicts = checkAiCrawlers({ origin: ORIGIN, robots: fx('robots.txt'), crawlers })
  const by = (t: string) => verdicts.find((v) => v.token === t)

  it('整站挡、部分挡、放行分得开，挡住它的那一行写出来', () => {
    expect(by('GPTBot')).toMatchObject({
      state: 'blocked',
      purpose: 'training',
      rule: '#15 Disallow: /',
    })
    expect(by('PerplexityBot')).toMatchObject({ state: 'partial', blocked_paths: ['/products/'] })
    expect(by('OAI-SearchBot')?.state).toBe('allowed')
    expect(by('ChatGPT-User')?.state).toBe('allowed')
    // `User-agent: *` 只挡后台 / 购物车，不算挡 AI
    expect(by('ClaudeBot')?.state).toBe('allowed')
  })

  it('搜索 / 替用户打开的被挡才算问题；训练用的被挡是品牌自己的选择', () => {
    expect(crawlerVerdictIsProblem(by('PerplexityBot') as never)).toBe(true)
    expect(crawlerVerdictIsProblem(by('GPTBot') as never)).toBe(false)
    expect(crawlerVerdictIsProblem(by('CCBot') as never)).toBe(false)
  })

  it('没读到 robots 记「没读到」，不当放行；站上没有 robots = 全放行', () => {
    for (const v of checkAiCrawlers({ origin: ORIGIN, robots: undefined, crawlers }))
      expect(v.state).toBe('unknown')
    for (const v of checkAiCrawlers({ origin: ORIGIN, robots: '', crawlers }))
      expect(v.state).toBe('allowed')
  })

  it('清单是数据：品牌加一个、减一个，默认清单其余照旧', () => {
    const list = effectiveCrawlers({
      crawlers_add: [{ token: 'NewAIBot', vendor: 'New', purpose: 'search', platform: 'New AI' }],
      crawlers_remove: ['bytespider'],
    })
    expect(list.some((c) => c.token === 'NewAIBot')).toBe(true)
    expect(list.some((c) => c.token === 'Bytespider')).toBe(false)
    expect(list.length).toBe(DEFAULT_AI_CRAWLERS.length)
    const brief = DEFAULT_AI_CRAWLERS.map((c) => c.token)
    for (const t of [
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'ClaudeBot',
      'Google-Extended',
      'Applebot-Extended',
      'CCBot',
    ])
      expect(brief).toContain(t)
  })
})

describe('WP381 ② 原始 HTML vs 渲染后', () => {
  it('价格与库存只靠 JS 才出现、卖点与退货天数原始里就有', () => {
    const sp = sellingPointExpectation(PRODUCT.description)
    expect(sp).toBeDefined()
    const rows = compareRawRendered({
      url: PRODUCT.url as string,
      page: 'product',
      raw: fx('product-raw.html'),
      rendered: fx('product-rendered.html'),
      expectations: [
        priceExpectation('49.99'),
        availabilityExpectation(true),
        sp as never,
        returnDaysExpectation(30),
      ],
    })
    const of = (f: string) => rows.find((r) => r.fact === f)
    expect(of('price')).toMatchObject({ raw: 'absent', rendered: 'present', verdict: 'js_only' })
    // 原始里 JSON-LD 写着 InStock——不跑 JS 的爬虫读得到，算有
    expect(of('availability')?.verdict).toBe('ok')
    expect(of('selling_point')?.verdict).toBe('ok')
    expect(of('return_policy')?.verdict).toBe('ok')
  })

  it('没渲染成：只看原始；原始也没有 = 没写；原始没抓到 = 没读到', () => {
    const [noRender] = compareRawRendered({
      url: ORIGIN,
      page: 'product',
      raw: fx('product-raw.html'),
      expectations: [priceExpectation('49.99')],
    })
    expect(noRender).toMatchObject({ rendered: 'not_checked', verdict: 'missing' })
    const [unread] = compareRawRendered({
      url: ORIGIN,
      page: 'home',
      raw: undefined,
      expectations: [priceExpectation('49.99')],
    })
    expect(unread?.verdict).toBe('unknown')
  })
})

describe('WP381 ① 商品信息机器可读体检', () => {
  const feed = parseMerchantFeed(fx('merchant-feed.xml'))
  const sources = [
    pageSnapshot(fx('product-rendered.html')),
    jsonLdSnapshot(fx('product-raw.html')),
    shopifyProductJsSnapshot(fx('product.js')),
    feedSnapshotFor(feed, PRODUCT),
    jsonLdSnapshot(fx('listing-marketplace.html'), 'platform', 'Amazon'),
  ]
  const { issues, dating } = checkProductFacts([{ product: PRODUCT, sources }], STORE, '2026-10-17')

  it('读样本：feed 三条按链接 / 商品号认出两条；公开商品数据按分换算', () => {
    expect(feed.items).toHaveLength(3)
    expect(feed.updated).toContain('06 Oct 2026')
    expect(sources[3]?.offers.map((o) => o.price)).toEqual(['49.99', '39.99'])
    expect(sources[2]?.offers.map((o) => o.price)).toEqual(['49.99', '49.99'])
    expect(sources[0]?.amounts).toEqual(['49.99'])
  })

  it('结构化数据价格过时、feed 一个规格价错、平台价不一样、平台价格有效期已过——都列出来', () => {
    const find = (source: string, field: string, kind: string) =>
      issues.find((i) => i.source === source && i.field === field && i.kind === kind)
    expect(find('jsonld', 'price', 'mismatch')).toMatchObject({
      found: '44.99',
      expected: '49.99',
      severity: 'high',
    })
    expect(find('feed', 'price', 'mismatch')).toMatchObject({
      source_label: 'merchant_feed',
      found: '39.99',
    })
    expect(find('platform', 'price', 'mismatch')).toMatchObject({
      source_label: 'Amazon',
      found: '54.99',
    })
    expect(find('platform', 'date', 'expired')).toMatchObject({ found: '2026-09-30' })
    expect(find('jsonld', 'date', 'undated')).toBeDefined()
    // 页面上就是 49.99、店铺公开数据也对：这两处不出价格问题
    expect(issues.some((i) => i.source === 'page')).toBe(false)
    expect(issues.some((i) => i.source_label === 'store_json' && i.field === 'price')).toBe(false)
    // 高的排前面
    expect(issues[0]?.severity).toBe('high')
  })

  it('每处带日期的件数；一行人话能直接交给网站运营', () => {
    const jsonld = dating.find((d) => d.source === 'jsonld')
    expect(jsonld).toMatchObject({ checked: 1, dated: 0 })
    expect(dating.find((d) => d.source_label === 'merchant_feed')?.dated).toBe(1)
    const line = issueLine(
      issues.find((i) => i.source === 'jsonld' && i.field === 'price') as never,
    )
    expect(line).toBe('「NordVolt Power Bank 20000」结构化数据的价格写的是 44.99，后台是 49.99')
  })

  it('读不到的一处不出不一致；退货天数与政策不同才出', () => {
    const r = checkProductFacts(
      [
        {
          product: PRODUCT,
          sources: [
            { source: 'feed', read: false, offers: [] },
            { source: 'page', read: true, offers: [], amounts: ['49.99'], return_days: 14 },
          ],
        },
      ],
      STORE,
      '2026-10-17',
    )
    expect(r.issues).toEqual([
      expect.objectContaining({
        field: 'return_policy',
        kind: 'mismatch',
        expected: '30',
        found: '14',
      }),
    ])
  })

  it('政策页 / 页面文字里的退货天数与包邮门槛；包邮门槛不当商品价', () => {
    expect(returnDaysIn('We have a 30-day return policy')).toBe(30)
    expect(returnDaysIn('Returns accepted within 14 days of delivery')).toBe(14)
    expect(returnDaysIn('收货 7 天内可无理由退货')).toBe(7)
    expect(freeShippingOverIn('Free shipping on orders over $50')).toBe('50.00')
    expect(pageAmounts(fx('product-raw.html'))).toEqual([])
  })
})

describe('WP381 ① 能否进 ChatGPT 购物（只评估）', () => {
  it('必填齐、服务条款缺 → 差一点；缺品牌 → 不行', () => {
    const a = assessChatGptShopping([PRODUCT], STORE)
    expect(a.verdict).toBe('almost')
    expect(a.fields.find((f) => f.field === 'seller_tos')).toMatchObject({ state: 'missing' })
    expect(a.fields.find((f) => f.field === 'gtin')).toMatchObject({ state: 'missing', covered: 0 })
    const ready = assessChatGptShopping([PRODUCT], {
      ...STORE,
      policy_urls: { ...STORE.policy_urls, terms: `${ORIGIN}/policies/terms-of-service` },
    })
    expect(ready.verdict).toBe('ready')
    const bad = assessChatGptShopping([{ ...PRODUCT, vendor: '' }], STORE)
    expect(bad.verdict).toBe('not_ready')
  })

  it('GTIN 校验位', () => {
    expect(validGtin('4006381333931')).toBe(true)
    expect(validGtin('4006381333932')).toBe(false)
    expect(validGtin('12345')).toBe(false)
  })
})
