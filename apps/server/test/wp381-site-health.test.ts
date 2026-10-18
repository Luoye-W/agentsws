/**
 * WP381：网站 / 商品体检与 AI 来源流量的服务端那一半——全用录好的样本（robots / 原始与渲染后的商品页 /
 * JSON-LD / 店铺公开商品数据 / 商品 feed / 平台上架页 / Shopify 回包），不连真实店、不联网、不调付费接口。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShopifyAdminReader } from '../src/shop-admin.js'
import {
  createSiteHealthService,
  type SiteHealthServiceOptions,
  trafficOrdersFromRows,
} from '../src/site-health.js'

vi.setConfig({ testTimeout: 120_000 })

const FX = join(import.meta.dirname, '../../../packages/site-core/test/fixtures/wp381')
const fx = (name: string): string => readFileSync(join(FX, name), 'utf8')
const ORIGIN = 'https://nordvolt.example'

/** 录好的网页：网址 → 内容；没有的一律 404。 */
const PAGES: Record<string, string> = {
  [`${ORIGIN}/robots.txt`]: fx('robots.txt'),
  [`${ORIGIN}/products/power-bank-20000`]: fx('product-raw.html'),
  [`${ORIGIN}/products/power-bank-20000.js`]: fx('product.js'),
  [`${ORIGIN}/policies/refund-policy`]: fx('refund-policy.html'),
  [`${ORIGIN}/policies/privacy-policy`]: '<html><body>Privacy</body></html>',
  'https://feeds.nordvolt.example/google.xml': fx('merchant-feed.xml'),
  'https://market.example/dp/B0NV20': fx('listing-marketplace.html'),
  'https://blocked.example/robots.txt': 'User-agent: *\nDisallow: /dp/',
}

function fakeFetch(seen: string[]): SiteHealthServiceOptions['fetch'] {
  return async (url) => {
    seen.push(url)
    const body = PAGES[url]
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      url,
      text: async () => body ?? '',
    }
  }
}

const PRODUCTS_DATA = {
  shop: { name: 'NordVolt', currencyCode: 'USD' },
  products: {
    nodes: [
      {
        id: 'gid://shopify/Product/1001',
        title: 'NordVolt Power Bank 20000',
        handle: 'power-bank-20000',
        onlineStoreUrl: `${ORIGIN}/products/power-bank-20000`,
        descriptionHtml:
          '<p>Charge a laptop and two phones at once with 100W USB-C output. Weighs 380 g.</p>',
        vendor: 'NordVolt',
        productType: 'Power banks',
        featuredMedia: { preview: { image: { url: 'https://cdn.example/pb.jpg' } } },
        options: [{ name: 'Color' }],
        variants: {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/2001',
              title: 'Black',
              sku: 'NV-PB20-BK',
              price: '49.99',
              barcode: '4006381333931',
              availableForSale: true,
            },
            {
              id: 'gid://shopify/ProductVariant/2002',
              title: 'White',
              sku: 'NV-PB20-WH',
              price: '49.99',
              barcode: null,
              availableForSale: false,
            },
          ],
        },
      },
    ],
  },
}

const ORDERS_DATA = {
  shop: { currencyCode: 'USD' },
  orders: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        createdAt: '2026-10-15T10:00:00Z',
        currentTotalPriceSet: { shopMoney: { amount: '49.99', currencyCode: 'USD' } },
        customerJourneySummary: {
          firstVisit: {
            referrerUrl: 'https://chatgpt.com/',
            landingPage: '/products/power-bank-20000?utm_source=chatgpt.com',
            source: 'chatgpt.com',
          },
          lastVisit: null,
        },
      },
      {
        createdAt: '2026-10-16T10:00:00Z',
        currentTotalPriceSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } },
        customerJourneySummary: {
          firstVisit: { referrerUrl: 'https://www.google.com/', source: 'Google' },
          lastVisit: null,
        },
      },
    ],
  },
}

const SESSIONS_DATA = {
  shopifyqlQuery: {
    parseErrors: [],
    tableData: {
      columns: [{ name: 'referrer_domain' }, { name: 'sessions' }],
      rows: [
        { referrer_domain: 'chatgpt.com', sessions: 42 },
        { referrer_domain: 'google.com', sessions: 900 },
      ],
    },
  },
}

function reader(asked: string[]): ShopifyAdminReader {
  return {
    via: 'stand_in',
    store: 'nordvolt.myshopify.com',
    async query<T>(op: { name: string }): Promise<T> {
      asked.push(op.name)
      if (op.name === 'health_products') return PRODUCTS_DATA as T
      if (op.name === 'ai_traffic_orders') return ORDERS_DATA as T
      if (op.name === 'ai_traffic_sessions') return SESSIONS_DATA as T
      throw new Error(`没录：${op.name}`)
    },
  }
}

let n = 0
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(over: Partial<SiteHealthServiceOptions> = {}) {
  const fetched: string[] = []
  const asked: string[] = []
  const dispatched: { title: string; text: string; issues: number }[] = []
  const events: string[] = []
  const options: SiteHealthServiceOptions = {
    clock: { now: () => '2026-10-17T08:00:00.000Z' },
    newId: (p) => `${p}_${++n}`,
    origin: async () => ORIGIN,
    fetch: fakeFetch(fetched),
    renderer: () => ({
      render: async (urls) =>
        new Map(
          urls
            .filter((u) => u.endsWith('/power-bank-20000'))
            .map((u) => [u, fx('product-rendered.html')]),
        ),
    }),
    shop: async () => reader(asked),
    scopes: async () => ['read_orders', 'read_products'],
    dispatch: async (input) => {
      dispatched.push(input)
      return { matter_id: `mat_${dispatched.length}` }
    },
    event: (type) => events.push(type),
    ...over,
  }
  return { svc: createSiteHealthService(options), fetched, asked, dispatched, events }
}

describe('WP381 体检（服务端）', () => {
  it('一次体检：爬虫、原始 vs 渲染、商品几处对照、ChatGPT 购物评估，不一致交给网站运营一次', async () => {
    const { svc, dispatched, events, fetched } = setup()
    svc.saveSettings({
      feed_url: 'https://feeds.nordvolt.example/google.xml',
      listings: [
        { handle: 'power-bank-20000', platform: 'Amazon', url: 'https://market.example/dp/B0NV20' },
      ],
    })
    const run = await svc.run()
    expect(run.status).toBe('ok')
    expect(run.robots.state).toBe('found')
    expect(run.crawlers.find((c) => c.token === 'GPTBot')?.state).toBe('blocked')
    expect(run.crawlers.find((c) => c.token === 'PerplexityBot')?.state).toBe('partial')
    expect(run.render).toBe('done')
    expect(run.raw_html.find((r) => r.fact === 'price')).toMatchObject({
      verdict: 'js_only',
      expected: '49.99',
    })
    expect(run.raw_html.find((r) => r.page === 'policy')).toMatchObject({
      fact: 'return_policy',
      verdict: 'ok',
    })
    const found = run.products.issues.map(
      (i) => `${i.source}:${i.source_label ?? ''}:${i.field}:${i.kind}:${i.found ?? ''}`,
    )
    expect(found).toEqual(
      expect.arrayContaining([
        'jsonld::price:mismatch:44.99',
        'feed:merchant_feed:price:mismatch:39.99',
        'platform:Amazon:price:mismatch:54.99',
        'platform:Amazon:date:expired:2026-09-30',
      ]),
    )
    expect(run.chatgpt_shopping?.verdict).toBe('almost')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.text).toContain(
      '「NordVolt Power Bank 20000」结构化数据的价格写的是 44.99，后台是 49.99',
    )
    expect(run.dispatched).toMatchObject({ matter_id: 'mat_1' })
    expect(events).toContain('site_health.checked')
    // 只抓了自己站与用户填的那两个地址（外站先看它的 robots）
    for (const u of fetched)
      expect(
        u.startsWith(ORIGIN) ||
          u.startsWith('https://feeds.nordvolt.example/') ||
          u.startsWith('https://market.example/'),
      ).toBe(true)
    expect(fetched).toContain('https://market.example/robots.txt')

    // 同一份清单 7 天内不重派
    const again = await svc.run()
    expect(dispatched).toHaveLength(1)
    expect(again.dispatched?.matter_id).toBe('mat_1')
  })

  it('没网址 = 体检不了；没店铺授权 = 商品那块不读、爬虫照查；找不到浏览器照实记', async () => {
    const none = await setup({ origin: async () => undefined }).svc.run()
    expect(none).toMatchObject({ status: 'failed' })
    expect(none.notes[0]).toContain('网站地址')
    const { svc, dispatched } = setup({
      shop: async () => undefined,
      renderer: () => ({
        render: async () => {
          throw 'no_browser'
        },
      }),
    })
    const r = await svc.run()
    expect(r.status).toBe('partial')
    expect(r.notes).toContain('店铺还没授权，商品那块这次没读')
    expect(r.crawlers.length).toBeGreaterThan(10)
    expect(r.products.checked).toBe(0)
    expect(r.chatgpt_shopping).toBeUndefined()
    expect(r.render).toBe('no_browser')
    expect(dispatched).toHaveLength(0)
  })

  it('外站 robots 不让抓就不抓（记一句）；结论落盘、重开读得回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp381-'))
    dirs.push(dir)
    const file = join(dir, 'site-health.json')
    const { svc } = setup({ file, renderer: () => undefined })
    svc.saveSettings({
      listings: [
        { handle: 'power-bank-20000', platform: 'Other', url: 'https://blocked.example/dp/1' },
      ],
    })
    const r = await svc.run()
    expect(r.notes).toContain('这次没读到 Other 上架页')
    expect(r.render).toBe('off')
    const reopened = createSiteHealthService({
      file,
      clock: { now: () => '2026-10-17T09:00:00.000Z' },
      newId: () => 'x',
      origin: async () => ORIGIN,
      fetch: fakeFetch([]),
      shop: async () => undefined,
    })
    expect(reopened.latest()?.id).toBe(r.id)
    expect(reopened.settings().listings?.[0]?.platform).toBe('Other')
  })
})

describe('WP381 AI 来源流量（服务端）', () => {
  it('订单首次 / 最后一次进店来源 + 授权里有「店铺报表」时的会话；面板读上一次的', async () => {
    const { svc, asked } = setup({ scopes: async () => ['read_orders', 'read_reports'] })
    const s = await svc.aiTraffic()
    expect(asked).toEqual(['ai_traffic_orders', 'ai_traffic_sessions'])
    expect(s).toMatchObject({
      measured: true,
      total_orders: 2,
      ai_orders: 1,
      ai_revenue: 49.99,
      visits: 'ok',
    })
    expect(s?.rows).toEqual([{ platform: 'ChatGPT', orders: 1, revenue: 49.99, visits: 42 }])
    expect(svc.deckData().ai_traffic).toEqual(s)
  })

  it('没有「店铺报表」不问会话；没店铺授权退一步用面板那份订单；都没有就不出', async () => {
    const a = setup()
    expect((await a.svc.aiTraffic())?.visits).toBe('no_scope')
    expect(a.asked).toEqual(['ai_traffic_orders'])
    const b = setup({
      shop: async () => undefined,
      fallbackOrders: () =>
        trafficOrdersFromRows([
          {
            total_price: 30,
            currency: 'USD',
            created_at: '2026-10-16T00:00:00.000Z',
            referring_site: 'https://www.perplexity.ai/search',
          },
        ]),
    })
    expect((await b.svc.aiTraffic())?.rows).toEqual([
      { platform: 'Perplexity', orders: 1, revenue: 30 },
    ])
    const c = setup({ shop: async () => undefined })
    expect(await c.svc.aiTraffic()).toBeUndefined()
  })
})
