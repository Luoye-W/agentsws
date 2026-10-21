/**
 * WP385（决策 1076）：网站体检的设置在对话里完成 + 岗位 AI 读体检结论。
 *
 * - 配置卡目标 `site.health`：几种人话写法解析得对（feed、上架页、爬虫 / 来源的加减）、写不对说哪里不对、
 *   已经生效的建议值去掉（不出「什么都没变」的卡）、存好就重新体检一次；
 * - `request_setup`：设好了、AI 又带了一模一样的值 → 说「已经是这样了」，不出卡、不记卡住；
 * - `query_site_health`：只给店铺管理 / SEO 与 GEO；没体检过照实说；挑给模型的几格；体检正在跑就等它跑完；
 * - 体检服务：同一时间只跑一次；填了上架页的商品不在最近更新的几件里也补读。
 */
import type { Clock, RunRequest } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { SetupCardError } from '../src/setup-cards.js'
import { createSetupRequestTool } from '../src/setup-request-tool.js'
import { createSiteHealthService, type SiteHealthService } from '../src/site-health.js'
import {
  parseCrawler,
  parseListing,
  parseReferrer,
  siteHealthSetupTarget,
} from '../src/site-health-setup.js'
import { createSiteHealthToolExecutor } from '../src/site-health-tools.js'

const clock: Clock = { now: () => '2026-10-18T09:00:00.000Z' }
const ORIGIN = 'https://nordvolt.example'

function service(
  pages: Record<string, string> = {},
  shop?: Parameters<typeof createSiteHealthService>[0]['shop'],
): SiteHealthService & { fetched: string[] } {
  const fetched: string[] = []
  const svc = createSiteHealthService({
    clock,
    newId: (p) => `${p}_${String(fetched.length)}`,
    origin: async () => ORIGIN,
    fetch: async (url) => {
      fetched.push(String(url))
      const hit = pages[String(url)]
      return {
        ok: hit !== undefined,
        status: hit === undefined ? 404 : 200,
        text: async () => hit ?? '',
      }
    },
    shop: shop ?? (async () => undefined),
  })
  return Object.assign(svc, { fetched })
}

const req = (role_id: string): RunRequest =>
  ({
    id: 'run_1',
    workspace_id: 'ws_1',
    actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id },
    tools: { allow: [] },
  }) as unknown as RunRequest

describe('WP385 体检设置的人话写法', () => {
  it('上架页：平台 | 商品 | 网址；商品可写店里商品网址；缺平台 / 缺商品说哪里不对', () => {
    expect(parseListing('Amazon | power-bank-20000 | https://www.amazon.com/dp/B0TEST01')).toEqual({
      platform: 'Amazon',
      handle: 'power-bank-20000',
      url: 'https://www.amazon.com/dp/B0TEST01',
    })
    expect(
      parseListing(
        'Walmart | https://nordvolt.example/products/Power-Bank-20000 | https://www.walmart.com/ip/1',
      ),
    ).toMatchObject({ platform: 'Walmart', handle: 'power-bank-20000' })
    expect(parseListing('Amazon |  | https://www.amazon.com/dp/B0TEST01')).toContain('哪件商品')
    expect(parseListing('Amazon | power-bank-20000')).toContain('网址')
  })
  it('爬虫：用途写英文或中文、不写按 AI 搜索；来源：域名去掉协议与路径', () => {
    expect(parseCrawler('NewAIBot | 训练')).toEqual({
      token: 'NewAIBot',
      vendor: 'NewAIBot',
      purpose: 'training',
    })
    expect(parseCrawler('NewSearchBot')).toMatchObject({ purpose: 'search' })
    expect(parseCrawler('Bad Bot!! | search')).toContain('UA 名')
    expect(parseCrawler('NewBot | 偷看')).toContain('search、user 或 training')
    expect(parseReferrer('Kimi | https://kimi.com/chat, kimi.moonshot.cn')).toEqual({
      platform: 'Kimi',
      hosts: ['kimi.com', 'kimi.moonshot.cn'],
    })
    expect(parseReferrer('Kimi')).toContain('来源域名')
  })
})

describe('WP385 配置卡目标 site.health', () => {
  it('存：feed、加 / 去上架页、加减爬虫与来源（默认清单里的只记减、加回来就是不减）；存好重新体检一次', async () => {
    const svc = service()
    const rerun = vi.fn()
    const target = siteHealthSetupTarget({ service: () => svc, rerun })
    expect(await target.satisfied()).toBe(true)
    await target.apply({
      feed_url: 'https://feeds.nordvolt.example/google.xml',
      listings_add:
        'Amazon | power-bank-20000 | https://www.amazon.com/dp/B0TEST01; eBay | cable-c | https://www.ebay.com/itm/9',
      crawlers_add: 'NewAIBot | training',
      crawlers_remove: 'GPTBot',
      referrers_add: 'Poe | poe.com',
      referrers_remove: '豆包',
    })
    expect(rerun).toHaveBeenCalledTimes(1)
    expect(svc.settings()).toEqual({
      feed_url: 'https://feeds.nordvolt.example/google.xml',
      listings: [
        {
          platform: 'Amazon',
          handle: 'power-bank-20000',
          url: 'https://www.amazon.com/dp/B0TEST01',
        },
        { platform: 'eBay', handle: 'cable-c', url: 'https://www.ebay.com/itm/9' },
      ],
      crawlers_add: [{ token: 'NewAIBot', vendor: 'NewAIBot', purpose: 'training' }],
      crawlers_remove: ['GPTBot'],
      referrers_add: [{ platform: 'Poe', hosts: ['poe.com'] }],
      referrers_remove: ['豆包'],
    })
    // 再改：去掉一条上架页、GPTBot 加回来（= 不再减）、清掉 feed
    await target.apply({
      feed_url: '无',
      listings_remove: 'https://www.ebay.com/itm/9',
      crawlers_add: 'GPTBot | training',
    })
    const s = svc.settings()
    expect(s.feed_url).toBeUndefined()
    expect(s.listings?.map((l) => l.platform)).toEqual(['Amazon'])
    expect(s.crawlers_remove).toBeUndefined()
    expect(s.crawlers_add?.map((c) => c.token)).toEqual(['NewAIBot'])
  })
  it('写不对：抛人话、一格都不存、不体检', async () => {
    const svc = service()
    const rerun = vi.fn()
    const target = siteHealthSetupTarget({ service: () => svc, rerun })
    await expect(target.apply({ feed_url: 'ftp://x' })).rejects.toThrow(SetupCardError)
    await expect(
      target.apply({
        feed_url: 'https://ok.example/f.xml',
        listings_add: 'Amazon | https://a.co/1',
      }),
    ).rejects.toThrow('哪件商品')
    expect(svc.settings()).toEqual({})
    expect(rerun).not.toHaveBeenCalled()
  })
  it('格子：feed 带现值；其余是「加 / 去」那几格（现值空）；没有像秘密的格子', async () => {
    const svc = service()
    svc.saveSettings({ feed_url: 'https://feeds.nordvolt.example/google.xml' })
    const fields = await siteHealthSetupTarget({ service: () => svc }).fields()
    expect(fields.map((f) => f.key)).toEqual([
      'feed_url',
      'listings_add',
      'listings_remove',
      'crawlers_add',
      'crawlers_remove',
      'referrers_add',
      'referrers_remove',
    ])
    expect(fields[0]).toMatchObject({ suggested: 'https://feeds.nordvolt.example/google.xml' })
    expect(fields.every((f) => f.required === false)).toBe(true)
  })
  it('还没生效的：已经是这样的建议值去掉；写不对的留着（存时说哪里不对）', async () => {
    const svc = service()
    svc.saveSettings({
      feed_url: 'https://feeds.nordvolt.example/google.xml',
      listings: [
        {
          platform: 'Amazon',
          handle: 'power-bank-20000',
          url: 'https://www.amazon.com/dp/B0TEST01',
        },
      ],
    })
    const target = siteHealthSetupTarget({ service: () => svc })
    const pending = target.pending
    if (pending === undefined) throw new Error('要有 pending')
    expect(
      await pending({
        feed_url: 'https://feeds.nordvolt.example/google.xml/',
        listings_add: 'Amazon | power-bank-20000 | https://www.amazon.com/dp/B0TEST01',
        crawlers_add: 'GPTBot | training',
        crawlers_remove: 'NoSuchBot',
        referrers_remove: 'ChatGPT',
      }),
    ).toEqual({ referrers_remove: 'ChatGPT' })
    expect(await pending({ listings_add: 'Amazon | | https://a.co/2' })).toEqual({
      listings_add: 'Amazon | | https://a.co/2',
    })
  })
})

describe('WP385 request_setup 撞上「已经是这样了」', () => {
  const toolFor = (svc: SiteHealthService) => {
    const target = siteHealthSetupTarget({ service: () => svc })
    return createSetupRequestTool({
      directory: async () => [],
      isConnected: async () => undefined,
      target: async (id) => (id === target.id ? target : undefined),
      targetIds: async () => [target.id],
    })
  }
  const ask = (suggestions: { key: string; value: string }[]) => ({
    name: 'request_setup',
    input: { setting: 'site.health', why: '按你说的记进体检设置。', suggestions },
    request: req('dtc.store'),
  })
  it('新的值 → 「我打算改成这样」（只带还没生效的格子）；一模一样的 → 已经是这样了、不出卡', async () => {
    const svc = service()
    const tool = toolFor(svc)
    const first = await tool(
      ask([{ key: 'feed_url', value: 'https://feeds.nordvolt.example/g.xml' }]),
    )
    expect(first.data).toMatchObject({
      ok: false,
      needs_setup: 'site.health',
      change: true,
      suggestions: { feed_url: 'https://feeds.nordvolt.example/g.xml' },
    })
    svc.saveSettings({ feed_url: 'https://feeds.nordvolt.example/g.xml' })
    const again = await tool(
      ask([{ key: 'feed_url', value: 'https://feeds.nordvolt.example/g.xml' }]),
    )
    expect(again.data).toMatchObject({ ok: true, already: true })
    expect((again.data as { message: string }).message).toContain('已经是这样了')
    const mixed = await tool(
      ask([
        { key: 'feed_url', value: 'https://feeds.nordvolt.example/g.xml' },
        { key: 'crawlers_remove', value: 'Bytespider' },
      ]),
    )
    expect(mixed.data).toMatchObject({
      change: true,
      suggestions: { crawlers_remove: 'Bytespider' },
    })
  })
})

describe('WP385 query_site_health', () => {
  const run = (svc: SiteHealthService, role = 'dtc.seo', input: Record<string, unknown> = {}) =>
    createSiteHealthToolExecutor({ service: () => svc, waitMs: 2_000 })({
      name: 'query_site_health',
      input,
      request: req(role),
    })

  it('只给店铺管理 / SEO 与 GEO；没体检过照实说；设置原样给', async () => {
    const svc = service()
    svc.saveSettings({
      feed_url: 'https://feeds.nordvolt.example/g.xml',
      crawlers_remove: ['GPTBot'],
    })
    expect((await run(svc, 'support.inbox')).status).toBe('blocked')
    const res = await run(svc, 'dtc.seo')
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({
      ok: true,
      message: expect.stringContaining('还没体检过'),
      settings: {
        feed_url: 'https://feeds.nordvolt.example/g.xml',
        listings: [],
        crawlers_removed: ['GPTBot'],
      },
    })
  })
  it('体检过：被挡的 AI 搜索爬虫与第几行、训练类单列；只看一块就只给那一块', async () => {
    const svc = service({
      [`${ORIGIN}/robots.txt`]:
        'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n',
    })
    await svc.run()
    const all = (await run(svc, 'dtc.store')).data as Record<string, unknown>
    expect(all.message).toMatch(/2026-10-18 体检：1 个 AI 爬虫被挡/)
    expect(all.crawlers).toMatchObject({
      blocked: [{ token: 'PerplexityBot', purpose: 'search', state: 'blocked' }],
      training_blocked: ['GPTBot'],
    })
    const only = (await run(svc, 'dtc.store', { part: 'crawlers' })).data as Record<string, unknown>
    expect(only.crawlers).toBeDefined()
    expect(only.settings).toBeUndefined()
    expect(only.products).toBeUndefined()
  })
  it('体检正在跑：等它跑完再回（拿到的是新的）；等不到就标 running、给上一次的', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const svc = createSiteHealthService({
      clock,
      newId: (p) => `${p}_x`,
      origin: async () => {
        await gate
        return ORIGIN
      },
      fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
      shop: async () => undefined,
    })
    const a = svc.run()
    expect(svc.run()).toBe(a)
    expect(svc.running()).toBe(a)
    const slow = createSiteHealthToolExecutor({ service: () => svc, waitMs: 20 })
    const early = await slow({ name: 'query_site_health', input: {}, request: req('dtc.store') })
    expect(early.data).toMatchObject({ running: true, message: expect.stringContaining('正在跑') })
    const waiting = createSiteHealthToolExecutor({ service: () => svc, waitMs: 5_000 })({
      name: 'query_site_health',
      input: {},
      request: req('dtc.store'),
    })
    release()
    const got = (await waiting).data as Record<string, unknown>
    expect(got.running).toBeUndefined()
    expect(got.checked_at).toBe('2026-10-18T09:00:00.000Z')
    expect(svc.running()).toBeUndefined()
  })
})

describe('WP385 体检服务：填了上架页的商品补读', () => {
  it('不在最近更新的几件里：按 handle 再读一次，那条上架页照样比', async () => {
    const queries: { name: string; variables?: Record<string, unknown> }[] = []
    const product = (handle: string, price: string) => ({
      id: `gid://shopify/Product/${handle}`,
      title: handle,
      handle,
      variants: { nodes: [{ id: `v_${handle}`, price, availableForSale: true }] },
    })
    const listing = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Old cable',
      offers: { '@type': 'Offer', price: '9.99', priceCurrency: 'USD' },
    })}</script>`
    const svc = service({ 'https://www.ebay.com/itm/9': listing }, async () => ({
      via: 'stand_in',
      store: 'nordvolt.myshopify.com',
      query: async <T>(q: { name: string; variables?: Record<string, unknown> }) => {
        queries.push(q)
        return {
          shop: { name: 'NordVolt', currencyCode: 'USD' },
          products: {
            nodes:
              q.name === 'health_products_listed'
                ? [product('old-cable', '12.99')]
                : [product('power-bank-20000', '49.99')],
          },
        } as T
      },
    }))
    svc.saveSettings({
      listings: [{ platform: 'eBay', handle: 'old-cable', url: 'https://www.ebay.com/itm/9' }],
    })
    const r = await svc.run()
    expect(queries.map((q) => q.name)).toEqual(['health_products', 'health_products_listed'])
    expect(queries[1]?.variables?.query).toBe('status:active AND (handle:old-cable)')
    expect(r.products.checked).toBe(2)
    expect(svc.fetched).toContain('https://www.ebay.com/itm/9')
    expect(
      r.products.issues.some(
        (i) => i.source === 'platform' && i.field === 'price' && i.found === '9.99',
      ),
    ).toBe(true)
  })
})
