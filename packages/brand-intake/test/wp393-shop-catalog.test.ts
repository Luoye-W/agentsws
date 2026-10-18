/**
 * WP393（docs/104 一期 A）：探平台 + 读竞品独立站公开商品目录。全用录好的样本（`fixtures/shop-catalog/`），不联网：
 * 夹具表里没有的地址一律回 503，哪天谁加了真实请求会当场红。
 */
import { describe, expect, it } from 'vitest'
import {
  type BrowserTextRead,
  COMPETITOR_WATCH_USER_AGENT,
  normalizeStoreUrl,
  type PageFetch,
  parseShopifyAtom,
  parseShopifyProductsPage,
  parseWooProductsPage,
  probeStore,
  readShopCatalog,
  wooPrice,
} from '../src/index.js'
import { fixture } from './fixtures.js'

const NOW = '2026-10-18T09:00:00.000Z'
const f = (name: string) => fixture(`shop-catalog/${name}`)

interface Route {
  status?: number
  body?: string
  /** 跟完跳转落在哪。 */
  url?: string
}
type Calls = { url: string; headers: Record<string, string> }[]

/** 只认识路由表的 fetch（没登记的地址回 503）。 */
function fakeFetch(routes: Record<string, Route | (() => Route)>, calls: Calls = []): PageFetch {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r0 = routes[url]
    const r = typeof r0 === 'function' ? r0() : r0
    if (r === undefined) return { ok: false, status: 503, text: async () => '' }
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      ...(r.url === undefined ? {} : { url: r.url }),
      text: async () => r.body ?? '',
    }
  }
}

const SHOP = 'https://rival-bikes.example'
const p = (n: number, size = 2) => `${SHOP}/products.json?limit=${size}&page=${n}`

describe('WP393 · 解析（录好的样本）', () => {
  it('Shopify products.json：一个款式一行；划线价高于现价才算在打折；Default Title 不写款式名；不读 updated_at', () => {
    const page = parseShopifyProductsPage(f('shopify-products-p1.json'), SHOP)
    expect(page?.products).toBe(2)
    expect(page?.rows).toHaveLength(3)
    const [a, b, c] = page?.rows ?? []
    expect(a).toMatchObject({
      product_key: '7001',
      variant_key: '42001',
      title: 'Level 3 Commuter',
      variant_title: 'Small / Black',
      url: `${SHOP}/products/level-3-commuter`,
      image: 'https://cdn.example/rival/level-3.jpg',
      price: 1599,
      compare_at_price: 1799,
      available: true,
      product_created_at: '2025-03-01T17:00:00.000Z',
    })
    expect(b).toMatchObject({ variant_key: '42002', available: false })
    expect(b?.compare_at_price).toBeUndefined()
    // 划线价 = 现价：没在打折
    expect(c?.compare_at_price).toBeUndefined()
    expect(c?.variant_title).toBeUndefined()
    expect(JSON.stringify(page)).not.toContain('updated_at')
  })

  it('不是 Shopify 的 JSON / HTML：认不出（undefined），不当成「没商品」', () => {
    expect(parseShopifyProductsPage(f('plain-site.html'), SHOP)).toBeUndefined()
    expect(parseShopifyProductsPage('[]', SHOP)).toBeUndefined()
    expect(parseShopifyProductsPage(f('shopify-products-empty.json'), SHOP)?.products).toBe(0)
  })

  it('WooCommerce：价按 minor unit 换算；原价高于现价才记划线价；有没有货；标题实体解开', () => {
    const page = parseWooProductsPage(f('woo-products-p1.json'))
    expect(page?.currency).toBe('USD')
    expect(page?.rows[0]).toMatchObject({
      product_key: '101',
      title: 'Cruiser 700',
      price: 1299,
      compare_at_price: 1499,
      currency: 'USD',
      available: true,
      url: 'https://ride.example/product/cruiser-700/',
    })
    expect(page?.rows[1]).toMatchObject({ title: 'Roadster & Rack', price: 995, available: false })
    expect(page?.rows[1]?.compare_at_price).toBeUndefined()
    expect(wooPrice('129900', 2)).toBe(1299)
    expect(wooPrice('15800', 0)).toBe(15800)
    expect(wooPrice('12345', 3)).toBe(12.35)
    expect(wooPrice('abc', 2)).toBeUndefined()
    expect(parseWooProductsPage('{"code":"rest_no_route"}')).toBeUndefined()
  })

  it('all.atom：商品 id 从 <id> 末尾来，价与币种从第一个款式来', () => {
    const items = parseShopifyAtom(f('shopify-all.atom'))
    expect(items?.[0]).toMatchObject({
      product_key: '7009',
      handle: 'trail-x',
      title: 'Trail X',
      url: `${SHOP}/products/trail-x`,
      price: 2199,
      currency: 'USD',
      published: '2026-10-17T08:00:00.000Z',
    })
    expect(parseShopifyAtom('not a feed')).toBeUndefined()
  })

  it('官网地址规整：只留首页；本机 / 内网地址不读', () => {
    expect(normalizeStoreUrl('Aventon.com/collections/ebikes')).toBe('https://aventon.com')
    expect(normalizeStoreUrl('http://shop.example:8080/x')).toBe('http://shop.example:8080')
    expect(normalizeStoreUrl('localhost:4317')).toBeUndefined()
    expect(normalizeStoreUrl('http://192.168.1.2')).toBeUndefined()
    expect(normalizeStoreUrl('ftp://shop.example')).toBeUndefined()
    expect(normalizeStoreUrl('https://user:pw@shop.example')).toBeUndefined()
  })
})

describe('WP393 · 探平台', () => {
  it('Shopify + 跳 www：按跳转后的地址存；先看 robots；UA 认得出是我们、不带凭据', async () => {
    const calls: Calls = []
    const fetch = fakeFetch(
      {
        'https://rival.example/robots.txt': { body: 'User-agent: *\nDisallow: /cart\n' },
        'https://rival.example/products.json?limit=1': {
          body: f('shopify-products-p1.json'),
          url: 'https://www.rival.example/products.json?limit=1',
        },
      },
      calls,
    )
    const out = await probeStore({ fetch }, 'rival.example', NOW)
    expect(out).toMatchObject({
      url: 'https://www.rival.example',
      platform: 'shopify',
      route: 'direct',
      via: 'direct',
      checked_at: NOW,
    })
    expect(calls.map((c) => c.url)).toEqual([
      'https://rival.example/robots.txt',
      'https://rival.example/products.json?limit=1',
    ])
    for (const c of calls) {
      expect(c.headers['user-agent']).toBe(COMPETITOR_WATCH_USER_AGENT)
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('cookie')
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain('authorization')
    }
  })

  it('跳到另一个域名、还丢了路径（engwe-bikes → us.engwe）：换新域名再探一次', async () => {
    const fetch = fakeFetch({
      'https://engwe.example/products.json?limit=1': {
        body: f('plain-site.html'),
        url: 'https://us.engwe.example/',
      },
      'https://us.engwe.example/products.json?limit=1': { body: f('shopify-products-p2.json') },
    })
    const out = await probeStore({ fetch }, 'https://engwe.example', NOW)
    expect(out).toMatchObject({ url: 'https://us.engwe.example', platform: 'shopify' })
  })

  it('WooCommerce：Shopify 那个地址 404，Store API 能读', async () => {
    const fetch = fakeFetch({
      'https://ride.example/products.json?limit=1': { status: 404, body: f('plain-site.html') },
      'https://ride.example/wp-json/wc/store/v1/products?per_page=1': {
        body: f('woo-products-p1.json'),
      },
    })
    const out = await probeStore({ fetch }, 'ride.example', NOW)
    expect(out).toMatchObject({
      platform: 'woocommerce',
      route: 'direct',
      url: 'https://ride.example',
    })
  })

  it('不是店铺的普通网站：other，照实说读不了', async () => {
    const fetch = fakeFetch({
      'https://northwind.example/products.json?limit=1': {
        status: 404,
        body: f('plain-site.html'),
      },
      'https://northwind.example/wp-json/wc/store/v1/products?per_page=1': {
        body: f('plain-site.html'),
      },
    })
    const out = await probeStore({ fetch }, 'northwind.example', NOW)
    expect(out).toMatchObject({
      platform: 'other',
      route: 'unsupported',
      reason: '这家网站暂时读不了商品数据',
    })
  })

  it('被挡（429）又没有内置浏览器：unknown + 照实说被挡；有内置浏览器就在它里面读同一个地址', async () => {
    const fetch = fakeFetch({
      'https://rival.example/products.json?limit=1': { status: 429 },
      'https://rival.example/wp-json/wc/store/v1/products?per_page=1': { status: 429 },
    })
    const blocked = await probeStore({ fetch }, 'rival.example', NOW)
    expect(blocked).toMatchObject({ platform: 'unknown', route: 'blocked' })
    expect(blocked.reason).toContain('429')

    const opened: string[] = []
    const browser: BrowserTextRead = async (url) => {
      opened.push(url)
      return { ok: true, status: 200, final_url: url, text: f('shopify-products-p1.json') }
    }
    const out = await probeStore({ fetch, browser }, 'rival.example', NOW)
    expect(out).toMatchObject({ platform: 'shopify', route: 'browser', via: 'browser' })
    expect(opened).toEqual(['https://rival.example/products.json?limit=1'])
  })

  it('robots 不让读 products.json：那个地址一页都不读', async () => {
    const calls: Calls = []
    const fetch = fakeFetch(
      {
        'https://strict.example/robots.txt': {
          body: 'User-agent: *\nDisallow: /products.json\nDisallow: /wp-json/\n',
        },
      },
      calls,
    )
    const out = await probeStore({ fetch }, 'strict.example', NOW)
    expect(calls.map((c) => c.url)).toEqual(['https://strict.example/robots.txt'])
    expect(out.platform).toBe('other')
    expect(out.reason).toContain('robots')
  })

  it('域名不对：unreachable', async () => {
    const fetch: PageFetch = async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: { code: 'ENOTFOUND' },
      })
    }
    const out = await probeStore({ fetch }, 'no-such-shop.example', NOW)
    expect(out).toMatchObject({ platform: 'unknown', route: 'unreachable' })
  })
})

describe('WP393 · 读商品目录', () => {
  it('Shopify 翻页读全 + all.atom 补上 products.json 里没有的新品；币种从 atom 来', async () => {
    const calls: Calls = []
    const fetch = fakeFetch(
      {
        [p(1)]: { body: f('shopify-products-p1.json') },
        [p(2)]: { body: f('shopify-products-p2.json') },
        [`${SHOP}/collections/all.atom`]: { body: f('shopify-all.atom') },
      },
      calls,
    )
    const out = await readShopCatalog(
      { fetch },
      { url: SHOP, platform: 'shopify', now: NOW, pageSize: 2 },
    )
    expect(out.complete).toBe(true)
    expect(out.via).toBe('direct')
    expect(out.pages).toBe(3)
    expect(out.rows.map((r) => `${r.product_key}/${r.variant_key ?? ''}`)).toEqual([
      '7001/42001',
      '7001/42002',
      '7002/43001',
      '7003/44001',
      '7009/',
    ])
    expect(out.rows.every((r) => r.currency === 'USD')).toBe(true)
    expect(out.rows[4]).toMatchObject({
      title: 'Trail X',
      price: 2199,
      product_created_at: '2026-10-17T08:00:00.000Z',
    })
    expect(calls.map((c) => c.url)).toEqual([p(1), p(2), `${SHOP}/collections/all.atom`])
  })

  it('翻到第 2 页被挡（没有内置浏览器）：第 1 页照样交回、标「没读全」', async () => {
    const fetch = fakeFetch({
      [p(1)]: { body: f('shopify-products-p1.json') },
      [p(2)]: { status: 429 },
      [`${SHOP}/collections/all.atom`]: { body: f('shopify-all.atom') },
    })
    const out = await readShopCatalog(
      { fetch },
      { url: SHOP, platform: 'shopify', now: NOW, pageSize: 2 },
    )
    expect(out.complete).toBe(false)
    expect(out.error).toBeUndefined()
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.notes.join('；')).toContain('第 2 页没读到')
  })

  it('回 200 但是 Cloudflare 验证页：改用内置浏览器读同一个地址，之后的页都走它', async () => {
    const calls: Calls = []
    const fetch = fakeFetch({ [p(1)]: { body: f('cloudflare-challenge.html') } }, calls)
    const opened: string[] = []
    const pages: Record<string, string> = {
      [p(1)]: f('shopify-products-p1.json'),
      [p(2)]: f('shopify-products-p2.json'),
      [`${SHOP}/collections/all.atom`]: f('shopify-all.atom'),
    }
    const browser: BrowserTextRead = async (url) => {
      opened.push(url)
      const text = pages[url]
      return text === undefined
        ? { ok: false, message: '打不开' }
        : { ok: true, status: 200, final_url: url, text }
    }
    const out = await readShopCatalog(
      { fetch, browser },
      { url: SHOP, platform: 'shopify', now: NOW, pageSize: 2 },
    )
    expect(calls.map((c) => c.url)).toEqual([p(1)])
    expect(opened).toEqual([p(1), p(2), `${SHOP}/collections/all.atom`])
    expect(out).toMatchObject({ via: 'browser', complete: true })
    expect(out.notes[0]).toContain('内置浏览器')
  })

  it('内置浏览器里也被挡：照实说，不重试不绕', async () => {
    const fetch = fakeFetch({ [p(1)]: { status: 403 } })
    let opened = 0
    const browser: BrowserTextRead = async (url) => {
      opened += 1
      return { ok: true, status: 200, final_url: url, text: f('cloudflare-challenge.html') }
    }
    const out = await readShopCatalog(
      { fetch, browser },
      { url: SHOP, platform: 'shopify', now: NOW, pageSize: 2 },
    )
    expect(opened).toBe(1)
    expect(out.rows).toHaveLength(0)
    expect(out.error).toContain('内置浏览器里也被挡了')
  })

  it('每一页都算进额度：满了就停，已读到的标「没读全」', async () => {
    let left = 1
    const io = {
      fetch: fakeFetch({
        [p(1)]: { body: f('shopify-products-p1.json') },
        [p(2)]: { body: f('shopify-products-p2.json') },
      }),
      page: async <T>(task: () => Promise<T>): Promise<T | undefined> => {
        if (left <= 0) return undefined
        left -= 1
        return task()
      },
    }
    const out = await readShopCatalog(io, { url: SHOP, platform: 'shopify', now: NOW, pageSize: 2 })
    expect(out.complete).toBe(false)
    expect(out.notes.join('；')).toContain('上限')
  })

  it('WooCommerce Store API：一页不满就是读全了；价按 minor unit 换算', async () => {
    const fetch = fakeFetch({
      'https://ride.example/wp-json/wc/store/v1/products?per_page=100&page=1': {
        body: f('woo-products-p1.json'),
      },
    })
    const out = await readShopCatalog(
      { fetch },
      { url: 'https://ride.example', platform: 'woocommerce', now: NOW },
    )
    expect(out.complete).toBe(true)
    expect(out.rows.map((r) => r.price)).toEqual([1299, 995])
  })

  it('平台是 other：不发请求，照实说读不了；unknown 先探再读', async () => {
    const calls: Calls = []
    const none = await readShopCatalog(
      { fetch: fakeFetch({}, calls) },
      { url: SHOP, platform: 'other', now: NOW },
    )
    expect(none.error).toBe('这家网站暂时读不了商品数据')
    expect(calls).toHaveLength(0)

    const fetch = fakeFetch({
      'https://ride.example/products.json?limit=1': { status: 404 },
      'https://ride.example/wp-json/wc/store/v1/products?per_page=1': {
        body: f('woo-products-p1.json'),
      },
      'https://ride.example/wp-json/wc/store/v1/products?per_page=100&page=1': {
        body: f('woo-products-p1.json'),
      },
    })
    const out = await readShopCatalog(
      { fetch },
      { url: 'ride.example', platform: 'unknown', now: NOW },
    )
    expect(out.rows).toHaveLength(2)
  })
})
