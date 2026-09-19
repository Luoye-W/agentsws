/**
 * Amazon 那条路（70 §4.2）。
 *
 * 三件：listing 页该抽的都抽到了；店铺页只枚举卡片不逐个进；**被验证码挡住
 * 的时候如实说挡住了**，不编一份数据出来。
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeAmazonListing,
  analyzeAmazonStorefront,
  classifyAmazonUrl,
  countryOfHost,
  featureBullets,
  isBlocked,
  storefrontCards,
} from '../src/index.js'
import { AMAZON_PAGES, fixture, replayFetch } from './fixtures.js'

const LISTING = 'https://www.amazon.com/dp/B08XYZ1234'
const STORE = 'https://www.amazon.com/stores/nordvik'

describe('WP121 · Amazon 分流', () => {
  it('认得出 listing 与店铺，认不出的交回给官网那条路', () => {
    expect(classifyAmazonUrl(LISTING)).toEqual({
      kind: 'amazon_listing',
      asin: 'B08XYZ1234',
      country: 'US',
    })
    expect(classifyAmazonUrl(STORE)?.kind).toBe('amazon_storefront')
    expect(classifyAmazonUrl('https://nordvik.example/')).toBeUndefined()
    expect(classifyAmazonUrl('不是个网址')).toBeUndefined()
  })

  it('国家码按域名后缀取，长后缀先命中', () => {
    // .com 在表的最后一行，不然 .com.au 会先被它吃掉
    expect(countryOfHost('www.amazon.com.au')).toBe('AU')
    expect(countryOfHost('www.amazon.co.uk')).toBe('GB')
    expect(countryOfHost('www.amazon.com')).toBe('US')
    expect(countryOfHost('www.amazon.de')).toBe('DE')
    expect(countryOfHost('shop.example.com')).toBeUndefined()
  })
})

describe('WP121 · Amazon listing', () => {
  it('标题、品牌、五点、价、评分、类目、变体都抽到了', async () => {
    const { fetch } = replayFetch(AMAZON_PAGES)
    const entry = classifyAmazonUrl(LISTING)
    if (entry?.kind !== 'amazon_listing') throw new Error('分流错了')
    const { profile, pages } = await analyzeAmazonListing(fetch, LISTING, entry)

    expect(pages[0]?.ok).toBe(true)
    expect(profile.brand_name?.value).toBe('Nordvik')
    const product = profile.products?.value[0]
    expect(product?.title).toContain('Granite Wallet')
    expect(product?.asin).toBe('B08XYZ1234')
    expect(product?.price_snapshot).toBe('$54')
    expect(product?.selling_points).toHaveLength(3)
    expect(product?.selling_points?.[1]).toContain('RFID')
    expect(product?.has_variants).toBe(true)
    expect(profile.rating?.value).toBe(4.6)
    expect(profile.reviews_count?.value).toBe(2481)
    expect(profile.markets?.value).toEqual(['US'])
    expect(profile.category?.value).toBe('Clothing › Accessories › Wallets')
  })

  it('五点最多留五条', () => {
    const many = `<div id="feature-bullets"><ul>${'<li><span>一条卖点写得够长</span></li>'.repeat(9)}</ul></div>`
    expect(featureBullets(many)).toHaveLength(5)
  })

  it('被验证码挡住：如实说挡住了，一格都不编', async () => {
    const { fetch } = replayFetch({ [LISTING]: 'amazon-blocked.html' })
    const entry = classifyAmazonUrl(LISTING)
    if (entry?.kind !== 'amazon_listing') throw new Error('分流错了')
    const { profile, pages } = await analyzeAmazonListing(fetch, LISTING, entry)
    expect(pages[0]?.ok).toBe(false)
    expect(pages[0]?.reason).toContain('验证码')
    expect(Object.keys(profile)).toHaveLength(0)
  })

  it('isBlocked 认得出几种挡法', () => {
    expect(isBlocked(fixture('amazon-blocked.html'))).toBe(true)
    expect(isBlocked(fixture('amazon-listing.html'))).toBe(false)
  })

  it('页面取不到：回一句人话，不抛', async () => {
    const { fetch } = replayFetch({}, { [LISTING]: 503 })
    const entry = classifyAmazonUrl(LISTING)
    if (entry?.kind !== 'amazon_listing') throw new Error('分流错了')
    const { pages } = await analyzeAmazonListing(fetch, LISTING, entry)
    expect(pages[0]?.ok).toBe(false)
    expect(pages[0]?.reason).toBe('对方服务器出错（503）')
  })
})

describe('WP121 · Amazon 店铺', () => {
  it('只枚举卡片，一次请求就够——不逐个进 listing 页', async () => {
    const { fetch, calls } = replayFetch(AMAZON_PAGES)
    const entry = classifyAmazonUrl(STORE)
    if (entry?.kind !== 'amazon_storefront') throw new Error('分流错了')
    const { profile } = await analyzeAmazonStorefront(fetch, STORE, entry)

    // 一个店铺 20 个商品就是 20 次请求；第一版档案用不上那么细
    expect(calls).toHaveLength(1)
    expect(profile.products?.value).toHaveLength(2)
    expect(profile.products?.value[0]?.asin).toBe('B08XYZ1234')
    expect(profile.products?.value[0]?.price_snapshot).toBe('$54')
    // 相对地址补成了绝对
    expect(profile.products?.value[0]?.image_url).toBe('https://www.amazon.com/images/wallet.jpg')
    expect(profile.markets?.value).toEqual(['US'])
  })

  it('同一个 ASIN 出现两次只收一张卡', () => {
    const html = fixture('amazon-storefront.html')
    const doubled = html + html
    expect(storefrontCards(doubled, STORE)).toHaveLength(2)
  })
})
