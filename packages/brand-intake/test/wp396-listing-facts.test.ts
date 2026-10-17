/**
 * WP396（docs/106 §13）：自家 Listing 体检要的那几格从商品页读对。
 *
 * 样本是照 Amazon 商品页结构手写的（`fixtures/listing/`，美国站 / 英国站），不联网。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currencyOfPrice, readAmazonListingFacts } from '../src/index.js'

const DIR = join(import.meta.dirname, 'fixtures', 'listing')
const html = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const read = (name: string, marketplace = 'US') =>
  readAmazonListingFacts(html(name), {
    asin: 'B0NORDV001',
    marketplace,
    url: `https://www.amazon.com/dp/B0NORDV001`,
    read_at: '2026-10-18T01:00:00.000Z',
  })

describe('WP396 · 商品页 → 体检那几格', () => {
  it('正常的美国站页：标题、五点、图、视频、A+、变体、价、划线价、券、货、购物车', () => {
    const f = read('us-normal.html')
    expect(f).toBeDefined()
    expect(f?.title).toBe(
      'Nordvik Granite Wallet for Men, RFID Blocking Slim Bifold Leather Wallet, Black',
    )
    expect(f?.brand).toBe('Nordvik')
    expect(f?.bullets).toHaveLength(5)
    expect(f?.image_count).toBe(7)
    expect(f?.has_main_image).toBe(true)
    expect(f?.has_video).toBe(true)
    expect(f?.has_aplus).toBe(true)
    expect(f?.has_description).toBe(true)
    expect(f?.variants).toEqual({
      present: true,
      child_asins: ['B0NORDV001', 'B0NORDV002', 'B0NORDV003'],
      unavailable_count: 1,
    })
    expect(f?.rating).toBe(4.6)
    expect(f?.reviews_count).toBe(2481)
    expect(f?.price).toBe('$54.99')
    expect(f?.currency).toBe('USD')
    expect(f?.list_price).toBe('$69.99')
    expect(f?.coupon).toBe('Apply $5 coupon')
    expect(f?.availability).toBe('in_stock')
    expect(f?.buybox).toEqual({ present: true, seller: 'Nordvik Official', ships_from: 'Amazon' })
    expect(f?.undeliverable).toBe(false)
  })

  it('五点缺：空的那条也留着（体检要数空了几条）', () => {
    expect(read('us-no-bullets.html')?.bullets).toEqual(['', 'Holds 8 cards'])
  })

  it('没 A+、没描述、图少、没视频', () => {
    const f = read('us-no-aplus.html')
    expect(f?.has_aplus).toBe(false)
    expect(f?.has_description).toBe(false)
    expect(f?.image_count).toBe(2)
    expect(f?.has_video).toBe(false)
  })

  it('没变体那一块：present 是 false', () => {
    expect(read('us-broken-variant-a.html')?.variants.present).toBe(false)
  })

  it('没货：买框没了、写着 Currently unavailable', () => {
    const f = read('us-out-of-stock.html')
    expect(f?.availability).toBe('out_of_stock')
    expect(f?.buybox.present).toBe(false)
    expect(f?.buybox.seller).toBeUndefined()
  })

  it('购物车在别人手里：读出卖家名', () => {
    expect(read('us-buybox-other.html')?.buybox.seller).toBe('QuickDeals Store')
  })

  it('配送地址不对：标出来（这次读数作废由调用方判）', () => {
    expect(read('us-undeliverable.html')?.undeliverable).toBe(true)
  })

  it('英国站：英镑、global ratings', () => {
    const f = read('uk-normal.html', 'GB')
    expect(f?.price).toBe('£49.99')
    expect(f?.currency).toBe('GBP')
    expect(f?.reviews_count).toBe(1032)
  })

  it('验证页：回 undefined（不编数据）', () => {
    expect(read('captcha.html')).toBeUndefined()
  })

  it('币种按符号认', () => {
    expect(currencyOfPrice('$12.00')).toBe('USD')
    expect(currencyOfPrice('CDN$ 12.00')).toBe('CAD')
    expect(currencyOfPrice('£9')).toBe('GBP')
    expect(currencyOfPrice('12,00 €')).toBe('EUR')
    expect(currencyOfPrice('12')).toBeUndefined()
  })
})
