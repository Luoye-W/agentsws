/**
 * WP166：从官网推目标市场。
 *
 * 要钉住的事：每一条信号认得出来、各带一条出处；推不出就空着（不编）；币种最弱、只在别的都没有时用；
 * 「卖全世界」的国家切换不算；否定句（We do not ship to …）里的国家不算。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeBrand,
  analyzeSite,
  countriesIn,
  hreflangCountries,
  inferMarkets,
  localizationCountries,
  shippingCountries,
  tldCountry,
} from '../src/index.js'
import { AMAZON_PAGES, replayFetch, SHOP, SHOP_PAGES } from './fixtures.js'

const HOME = 'https://shop.example/'

describe('WP166 · 从官网推目标市场', () => {
  it('Shopify Markets 的国家切换：表单里的 data-value 与下拉都认', () => {
    const html = `<form method="post" action="/localization" id="localization_form">
      <input type="hidden" name="country_code" value="US">
      <ul><li><a href="#" data-value="US">United States (USD $)</a></li>
      <li><a href="#" data-value="CA">Canada (CAD $)</a></li><li><a data-value="gb">UK</a></li></ul></form>`
    expect(localizationCountries(html)).toEqual(['US', 'CA', 'GB'])
    const select = `<select name="country_code"><option value="DE">Deutschland</option><option value="AT">Österreich</option></select>`
    expect(localizationCountries(select)).toEqual(['DE', 'AT'])
  })

  it('hreflang 只认带地区的；没有 hreflang 时看同站的 /en-gb/ 子目录', () => {
    const html = `<link rel="alternate" hreflang="en-gb" href="https://shop.example/en-gb">
      <link rel="alternate" hreflang="de-DE" href="https://shop.example/de-de">
      <link rel="alternate" hreflang="fr" href="https://shop.example/fr">
      <link rel="alternate" hreflang="x-default" href="https://shop.example/">`
    expect(hreflangCountries(html, HOME).codes).toEqual(['GB', 'DE'])
    const paths = `<a href="/en-au/collections/all">AU</a><a href="https://other.example/en-nz/">x</a>`
    const r = hreflangCountries(paths, HOME)
    expect(r.codes).toEqual(['AU'])
    expect(r.locator).toBe('path:locale')
  })

  it('国家域名认 .co.uk / .de，通用的 .io / .co 与测试域名不认', () => {
    expect(tldCountry('https://shop.co.uk/')).toBe('GB')
    expect(tldCountry('https://www.marke.de/')).toBe('DE')
    expect(tldCountry('https://brand.io/')).toBeUndefined()
    expect(tldCountry('https://brand.co/')).toBeUndefined()
    expect(tldCountry('https://nordvik.example/')).toBeUndefined()
  })

  it('配送政策：只看讲送货的句子，否定句里的国家不算，中英文国名都认', () => {
    const text =
      'Orders ship in 24h. We ship to the United States, the UK and Australia. We do not ship to Russia. 我们也配送到日本。'
    const r = shippingCountries(text)
    expect(r.codes).toEqual(['US', 'GB', 'AU', 'JP'])
    expect(r.quote).toContain('United States')
    // 小写的 us 是代词，不是美国
    expect(countriesIn('contact us for shipping')).toEqual([])
  })

  it('几条信号都给了：被越多条提到的越靠前，每条信号一条出处', () => {
    const home = `<link rel="alternate" hreflang="en-ca" href="https://shop.example/en-ca">
      <form action="/localization"><a data-value="US"></a><a data-value="CA"></a></form>`
    const f = inferMarkets({
      entryUrl: HOME,
      home,
      shipping: { url: `${HOME}policies/shipping-policy`, text: 'We ship to Canada and the US.' },
      currency: { code: 'USD', url: `${HOME}products/a` },
    })
    expect(f?.value).toEqual(['CA', 'US'])
    expect(f?.confidence).toBe('medium')
    expect(f?.evidence.map((e) => e.locator)).toEqual([
      'shopify:localization',
      'hreflang',
      'policy:shipping',
    ])
  })

  it('只有币种：一国一币才认、把握度 low；欧元认不出是哪国，不猜', () => {
    const gbp = inferMarkets({ entryUrl: HOME, home: '', currency: { code: 'GBP', url: HOME } })
    expect(gbp?.value).toEqual(['GB'])
    expect(gbp?.confidence).toBe('low')
    expect(gbp?.evidence[0]?.locator).toBe('currency')
    expect(
      inferMarkets({ entryUrl: HOME, home: '', currency: { code: 'EUR', url: HOME } }),
    ).toBeUndefined()
  })

  it('「卖全世界」的国家切换（几十个国家）不算目标市场；什么都推不出就空着', () => {
    const many = ['US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'CH', 'SE', 'NO']
    const all = [
      ...many,
      'DK',
      'FI',
      'IE',
      'PT',
      'PL',
      'CZ',
      'AU',
      'NZ',
      'JP',
      'KR',
      'SG',
      'HK',
      'MX',
      'BR',
    ]
    const home = `<form action="/localization">${all.map((c) => `<a data-value="${c}"></a>`).join('')}</form>`
    expect(inferMarkets({ entryUrl: HOME, home })).toBeUndefined()
  })

  it('页面上的「Ships to …」', () => {
    const f = inferMarkets({
      entryUrl: HOME,
      home: '<p>Free shipping to Germany, Austria and Switzerland over €50</p>',
    })
    expect(f?.value).toEqual(['DE', 'AT', 'CH'])
    expect(f?.evidence[0]?.locator).toBe('text:ships-to')
  })

  it('整条官网分析：配送政策里写了 US 与 Canada → 档案里有这两个市场，带出处', async () => {
    const { fetch } = replayFetch(SHOP_PAGES)
    const { profile } = await analyzeSite(fetch, `${SHOP}/`)
    expect(profile.markets?.value).toEqual(['US', 'CA'])
    expect(profile.markets?.evidence[0]?.url).toBe(`${SHOP}/policies/shipping-policy`)
    expect(profile.markets?.evidence[0]?.quote).toContain('We ship to the US and Canada')
  })

  it('官网 + Amazon：两边的市场合在一起（去重），出处两边都留', async () => {
    const { fetch } = replayFetch({ ...SHOP_PAGES, ...AMAZON_PAGES })
    const r = await analyzeBrand(fetch, [`${SHOP}/`, 'https://www.amazon.com/dp/B08XYZ1234'], {
      capCredits: 100,
    })
    expect(r.profile.markets?.value).toEqual(['US', 'CA'])
    expect(r.profile.markets?.evidence.map((e) => e.locator)).toEqual([
      'policy:shipping',
      'url:host',
    ])
  })
})
