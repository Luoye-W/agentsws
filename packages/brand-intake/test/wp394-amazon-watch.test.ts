/**
 * WP394（docs/104 一期 B，docs/106 §13 A9）：读 Amazon 前台的积木——全用录好的样本，不联网。
 *
 * 商品页那几格（美元正常页 / 配送到加拿大 / 验证页 / 缺货 / 划线价 + 优惠券）、BSR 两级、搜索卡片（联想词是 WP398 的）；
 * 读一轮：被拦就停不重试、剩下的转云端（积分照扣、划线价 / 优惠券照实空着）、币种不符作废、额度满了照实说；
 * 挑对标款（规则脑）、什么算重要。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompetitorWatchSource } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AmazonPageOutcome,
  amazonBsr,
  amazonHostOfMarket,
  amazonMoney,
  amazonProductUrlOf,
  amazonSearchCards,
  isAmazonChallenge,
  isAmazonHost,
  isImportantAmazonChange,
  parseAmazonProduct,
  readAmazonAsins,
  suggestAmazonBenchmarks,
  suggestAmazonRules,
} from '../src/index.js'

const dir = join(import.meta.dirname, 'fixtures', 'amazon-watch')
const page = (name: string): string => readFileSync(join(dir, name), 'utf8')
const NOW = '2026-10-19T01:00:00.000Z'

describe('WP394 · 站点与地址', () => {
  it('各站前台、联想词、图片资源域都认作 Amazon；别的站不算', () => {
    for (const h of [
      'www.amazon.com',
      'amazon.co.uk',
      'www.amazon.com.be',
      'completion.amazon.com',
      'm.media-amazon.com',
      'images-na.ssl-images-amazon.com',
    ])
      expect(isAmazonHost(h)).toBe(true)
    for (const h of ['amazonaws.com', 'notamazon.com', 'example.com', 'amazon.com.evil.test'])
      expect(isAmazonHost(h)).toBe(false)
  })

  it('站点 → 前台域名、商品页地址', () => {
    expect(amazonHostOfMarket('US')).toBe('www.amazon.com')
    expect(amazonHostOfMarket('uk')).toBe('www.amazon.co.uk')
    expect(amazonHostOfMarket('ZZ')).toBeUndefined()
    expect(amazonProductUrlOf('US', 'b0testrg01')).toBe('https://www.amazon.com/dp/B0TESTRG01')
  })

  it('价格文字 → 数与币种（千分位、欧式小数点、加元）', () => {
    expect(amazonMoney('$1,299.00')).toEqual({ value: 1299, currency: 'USD' })
    expect(amazonMoney('CDN$ 1,779.42')).toEqual({ value: 1779.42, currency: 'CAD' })
    expect(amazonMoney('1.599,99 €')).toEqual({ value: 1599.99, currency: 'EUR' })
    expect(amazonMoney('￥12,800')).toEqual({ value: 12800, currency: 'JPY' })
    expect(amazonMoney('—')).toBeUndefined()
  })
})

describe('WP394 · 商品页那几格', () => {
  it('美元正常页：现价、划线价、评分、评论数、BSR 大类 + 小类、有货、图、五点', () => {
    const f = parseAmazonProduct(page('us-normal.html'), { asin: 'B0TESTRG01' })
    expect(f).toMatchObject({
      asin: 'B0TESTRG01',
      title: 'Rival Gear Trail 500 Electric Bike, 750W Commuter Ebike with Removable Battery',
      brand: 'Rival Gear',
      price: 1299,
      currency: 'USD',
      list_price: 1499,
      rating: 4.4,
      reviews: 2318,
      available: true,
      deliver_to: 'New York 10001',
      undeliverable: false,
      image: 'https://m.media-amazon.com/images/I/71trail500._AC_SL1500_.jpg',
    })
    expect(f?.bsr).toEqual([
      { rank: 1234, category: 'Sports & Outdoors' },
      { rank: 5, category: 'Electric Bicycles' },
    ])
    expect(f?.bullets).toHaveLength(3)
    expect(f?.coupon).toBeUndefined()
  })

  it('BSR 在参数表里也读得到（大类 + 两个小类）；缺货页 = 没货、没有现价', () => {
    const html = page('out-of-stock.html')
    expect(amazonBsr(html)).toEqual([
      { rank: 8901, category: 'Sports & Outdoors' },
      { rank: 41, category: 'Electric Bicycles' },
      { rank: 3, category: 'Folding Bikes' },
    ])
    const f = parseAmazonProduct(html, { asin: 'B0TESTRG02' })
    expect(f?.available).toBe(false)
    expect(f?.price).toBeUndefined()
    expect(f?.brand).toBe('Rival Gear')
  })

  it('有划线价（Was）和优惠券的页', () => {
    const f = parseAmazonProduct(page('deal-coupon.html'), { asin: 'B0TESTRG03' })
    expect(f).toMatchObject({
      price: 1599.99,
      list_price: 1899.99,
      coupon: 'Apply $100 coupon',
      reviews: 987,
      available: true,
    })
  })

  it('配送到加拿大的页：币种是加元、写着不能配送（由读的那一轮作废）', () => {
    const f = parseAmazonProduct(page('ca-undeliverable.html'), { asin: 'B0TESTRG01' })
    expect(f?.currency).toBe('CAD')
    expect(f?.undeliverable).toBe(true)
    expect(f?.deliver_to).toBe('Canada')
  })

  it('验证页：认得出，不交回任何一格', () => {
    expect(isAmazonChallenge(page('captcha.html'))).toBe(true)
    expect(isAmazonChallenge(page('us-normal.html'))).toBe(false)
    expect(parseAmazonProduct(page('captcha.html'), { asin: 'B0TESTRG01' })).toBeUndefined()
  })
})

describe('WP394 · 搜索卡片', () => {
  it('搜索结果页：每张卡的 ASIN、标题、价、评分、评论数、广告位', () => {
    const cards = amazonSearchCards(page('search.html'))
    expect(cards.map((c) => c.asin)).toEqual([
      'B0TESTAD01',
      'B0TESTRG01',
      'B0TESTOTH1',
      'B0TESTRG02',
      'B0TESTRG03',
      'B0TESTRG04',
    ])
    expect(cards[0]?.sponsored).toBe(true)
    expect(cards[1]).toMatchObject({ price: 1299, reviews: 2318, rating: 4.4, sponsored: false })
  })
})

const SRC = {
  id: 'cw_amz_c_rival_US',
  competitor_id: 'c_rival',
  label: 'Rival Gear',
  marketplace: 'US',
  asins: ['B0TESTRG01', 'B0TESTRG02', 'B0TESTRG03'],
} satisfies Pick<CompetitorWatchSource, 'id' | 'competitor_id' | 'label' | 'marketplace' | 'asins'>

const PAGES: Record<string, string> = {
  B0TESTRG01: 'us-normal.html',
  B0TESTRG02: 'out-of-stock.html',
  B0TESTRG03: 'deal-coupon.html',
}

/** 读页替身：照样本解析；`script` 按 ASIN 改结局。记下每次开了哪一页。 */
function browserStub(script: Record<string, AmazonPageOutcome['status']> = {}) {
  const opened: string[] = []
  const browser = async (input: { marketplace: string; asin: string }) => {
    opened.push(input.asin)
    const s = script[input.asin]
    if (s === 'blocked') return { status: 'blocked' as const }
    if (s === 'quota') return { status: 'quota' as const }
    const name = s === 'wrong_region' ? 'ca-undeliverable.html' : (PAGES[input.asin] as string)
    const facts = parseAmazonProduct(page(name), { asin: input.asin })
    return facts === undefined ? { status: 'blocked' as const } : { status: 'ok' as const, facts }
  }
  return { opened, browser }
}

function cloudStub() {
  const calls: string[][] = []
  const cloud = async (input: { marketplace: string; asins: string[] }) => {
    calls.push(input.asins)
    return {
      credits: 0.18 * input.asins.length,
      items: input.asins.map((asin) => ({
        asin,
        title: `cloud ${asin}`,
        price: 1199,
        currency: 'USD',
        rating: 4.3,
        reviews_count: 100,
        bsr: 2000,
        category: 'Sports & Outdoors › Cycling',
        in_stock: true,
      })),
    }
  }
  return { calls, cloud }
}

describe('WP394 · 读对标款那一轮', () => {
  it('内置浏览器都读到：三行、美元、BSR 有数、不走云端', async () => {
    const b = browserStub()
    const c = cloudStub()
    const got = await readAmazonAsins(SRC, { browser: b.browser, cloud: c.cloud, now: NOW })
    expect(got.rows).toHaveLength(3)
    expect(got.complete).toBe(true)
    expect(got.via).toBe('browser')
    expect(got.credits).toBeUndefined()
    expect(c.calls).toEqual([])
    expect(got.rows[0]).toMatchObject({ product_key: 'B0TESTRG01', currency: 'USD', price: 1299 })
    expect(got.rows[0]?.bsr?.[0]).toEqual({ rank: 1234, category: 'Sports & Outdoors' })
    expect(got.rows[2]).toMatchObject({ compare_at_price: 1899.99, coupon: 'Apply $100 coupon' })
  })

  it('被拦：那一页之后不再碰 Amazon（不重试），剩下的转云端、积分照扣、划线价 / 优惠券照实空着', async () => {
    const b = browserStub({ B0TESTRG02: 'blocked' })
    const c = cloudStub()
    const got = await readAmazonAsins(SRC, { browser: b.browser, cloud: c.cloud, now: NOW })
    expect(b.opened).toEqual(['B0TESTRG01', 'B0TESTRG02'])
    expect(c.calls).toEqual([['B0TESTRG02', 'B0TESTRG03']])
    expect(got.blocked).toBe(true)
    expect(got.via).toBe('cloud')
    expect(got.credits).toBeCloseTo(0.36)
    expect(got.complete).toBe(true)
    const cloudRow = got.rows.find((r) => r.product_key === 'B0TESTRG03')
    expect(cloudRow?.compare_at_price).toBeUndefined()
    expect(cloudRow?.coupon).toBeUndefined()
    expect(cloudRow?.fields_unread).toEqual(['compare_at_price', 'coupon'])
    expect(cloudRow?.bsr).toEqual([{ rank: 2000, category: 'Sports & Outdoors' }])
    expect(got.notes?.join('；')).toMatch(/人机验证.*不绕/)
    expect(got.notes?.join('；')).toContain('扣了 0.36 积分')
    expect(got.notes?.join('；')).not.toMatch(/apify|keepa|junglee/i)
  })

  it('没有内置浏览器（没有桌面壳）：全走云端；云端也没接上就照实说没读', async () => {
    const c = cloudStub()
    const got = await readAmazonAsins(SRC, { cloud: c.cloud, now: NOW })
    expect(c.calls).toEqual([SRC.asins])
    expect(got.rows).toHaveLength(3)
    const none = await readAmazonAsins(SRC, { now: NOW })
    expect(none.rows).toEqual([])
    expect(none.complete).toBe(false)
    expect(none.error).toMatch(/没有工坊内置浏览器.*云端数据也还没接上/)
  })

  it('币种不符 / 不能配送：这一个作废、照实说，不拿来比', async () => {
    const b = browserStub({ B0TESTRG01: 'wrong_region' })
    const got = await readAmazonAsins(SRC, { browser: b.browser, now: NOW })
    expect(got.rows.map((r) => r.product_key)).toEqual(['B0TESTRG02', 'B0TESTRG03'])
    expect(got.complete).toBe(false)
    expect(got.unread).toEqual(['B0TESTRG01'])
    expect(got.notes?.[0]).toMatch(/币种.*作废/)
  })

  it('这一小时额度满了：剩下的不读、不转云端（不花钱），先读上次最早的', async () => {
    const b = browserStub({ B0TESTRG02: 'quota' })
    const c = cloudStub()
    const got = await readAmazonAsins(SRC, {
      browser: b.browser,
      cloud: c.cloud,
      now: NOW,
      order: ['B0TESTRG03', 'B0TESTRG02', 'B0TESTRG01'],
    })
    expect(b.opened).toEqual(['B0TESTRG03', 'B0TESTRG02'])
    expect(c.calls).toEqual([])
    expect(got.complete).toBe(false)
    expect(got.unread).toEqual(['B0TESTRG02', 'B0TESTRG01'])
    expect(got.notes?.join('')).toMatch(/额度满了：读了 1 个，还有 2 个/)
  })
})

describe('WP394 · 挑对标款（规则脑）与什么算重要', () => {
  const cards = amazonSearchCards(page('search.html'))
  const own = [
    { asin: 'B0OWNMINE1', title: 'Nordvik Ranger Electric Bike 750W Commuter', price: 1399 },
    { asin: 'B0OWNMINE2', title: 'Nordvik Fold Folding Electric Bike', price: 1099 },
  ]

  it('品牌对得上、和自家同类、评论多的在前；别家的、配件、广告位（够数时）不要；各配一款自家的', () => {
    const picks = suggestAmazonBenchmarks({
      competitor: { name: 'Rival Gear' },
      cards,
      own,
      own_brand: 'Nordvik',
    })
    expect(picks.map((p) => p.asin)).toEqual(['B0TESTRG01', 'B0TESTRG03', 'B0TESTRG02'])
    expect(picks.find((p) => p.asin === 'B0TESTRG02')?.vs_own).toBe('B0OWNMINE2')
    expect(picks.find((p) => p.asin === 'B0TESTRG01')?.vs_own).toBe('B0OWNMINE1')
    expect(picks[0]?.why).toContain('2,318 条评论')
  })

  it('个数不写死：max 给几个就最多几个', () => {
    const picks = suggestAmazonBenchmarks({
      competitor: { name: 'Rival Gear' },
      cards,
      own,
      max: 1,
    })
    expect(picks).toHaveLength(1)
  })

  it('没确认过方案 = 一条都不算重要；确认过就按那几条判', () => {
    const drop = { kind: 'price' as const, pct: -12, before: 1499, after: 1319 }
    expect(isImportantAmazonChange(drop, undefined)).toBe(false)
    const { rules } = suggestAmazonRules('Electric Bicycles')
    expect(rules.price_drop_pct).toBe(8)
    expect(isImportantAmazonChange(drop, rules)).toBe(true)
    expect(isImportantAmazonChange({ ...drop, pct: -3 }, rules)).toBe(false)
    expect(
      isImportantAmazonChange(
        {
          ...drop,
          pct: -3,
          vs_own: { own_key: 'B0OWNMINE1', own_price: 1399, diff: -80 },
        },
        rules,
      ),
    ).toBe(true)
    expect(isImportantAmazonChange({ kind: 'rating', before: 4.1, after: 3.9 }, rules)).toBe(true)
    expect(isImportantAmazonChange({ kind: 'out_of_stock' }, rules)).toBe(false)
  })
})
