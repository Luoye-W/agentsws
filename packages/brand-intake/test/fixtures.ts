/**
 * 夹具与一个**只认识夹具的 fetch**。
 *
 * 这一份的意义不在方便，在**一个字节都不出这台机器**：夹具表里没有的网址
 * 一律回 503，所以哪天谁不小心加了一个真实请求，测试会当场红，而不是
 * 静悄悄地去敲了一次别人的服务器。
 *
 * `calls` 留着是为了断言另外两件事：请求带的 UA 认得出是我们，以及
 * **一个凭据字段都没有**。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '../src/index.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

export const SHOP = 'https://nordvik.example'

/** 一家 Shopify 店的全套页面。 */
export const SHOP_PAGES: Record<string, string> = {
  [`${SHOP}/robots.txt`]: 'robots.txt',
  [`${SHOP}/`]: 'shop-home.html',
  [`${SHOP}/pages/about`]: 'shop-about.html',
  [`${SHOP}/pages/contact`]: 'shop-contact.html',
  [`${SHOP}/policies/refund-policy`]: 'shop-refund.html',
  [`${SHOP}/policies/shipping-policy`]: 'shop-shipping.html',
  [`${SHOP}/products/granite-wallet`]: 'product-wallet.html',
  [`${SHOP}/products/fjord-tote`]: 'product-tote.html',
}

export const AMAZON_PAGES: Record<string, string> = {
  'https://www.amazon.com/dp/B08XYZ1234': 'amazon-listing.html',
  'https://www.amazon.com/stores/nordvik': 'amazon-storefront.html',
}

export interface Replay {
  fetch: PageFetch
  calls: { url: string; headers: Record<string, string> }[]
}

/**
 * 造一个只回夹具的 fetch。
 *
 * `overrides` 用来演"这一页挂了"：把某个网址映射成一个状态码，或者映射成
 * 另一份夹具（政策页 302 回首页那一条就是这么演的）。
 */
export function replayFetch(
  pages: Record<string, string> = SHOP_PAGES,
  overrides: Record<string, number | string> = {},
): Replay {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch: PageFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const override = overrides[url]
    if (typeof override === 'number') return { ok: false, status: override, text: async () => '' }
    const name = typeof override === 'string' ? override : pages[url]
    if (name === undefined) return { ok: false, status: 503, text: async () => '' }
    return { ok: true, status: 200, text: async () => fixture(name) }
  }
  return { fetch, calls }
}
