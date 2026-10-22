/**
 * WP448（docs/109 §4.4）：技术体检——录好的样本（网页、robots、站点地图、JSON-LD、PageSpeed 回包、Search Console 行）
 * 跑出预期的问题清单。不联网：跳转全由替身回答。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SitePage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  driftSnapshotOf,
  isNoindex,
  pageSeoFacts,
  parseSitemap,
  type RedirectProbe,
  runTechAudit,
  type SitemapRead,
  schemaErrors,
  sitemapsInRobots,
  speedReadingOf,
  TECH_AUDIT_RULES,
  type TechAuditInput,
  techHandoffText,
  traceRedirects,
  validHreflang,
} from '../src/index.js'

const FIX = join(import.meta.dirname, 'fixtures/wp448')
const read = (f: string): string => readFileSync(join(FIX, f), 'utf8')
const O = 'https://shop.example'

/** 替身：不跟跳转的那一口（地址 → 状态码 + Location）。 */
const PROBE: Record<string, { status: number; location?: string }> = {
  '/': { status: 200 },
  '/de': { status: 200 },
  '/products/magsafe-10k': { status: 200 },
  '/products/usb-c-charger': { status: 200 },
  '/collections/old-sale': { status: 301, location: '/collections/sale-2024' },
  '/collections/sale-2024': { status: 301, location: `${O}/collections/sale` },
  '/collections/sale': { status: 200 },
  '/pages/warranty-2023': { status: 404 },
  '/products/discontinued-cable': { status: 404 },
  '/blogs/news/pick-a-power-bank': { status: 200 },
  '/pages/a': { status: 302, location: '/pages/b' },
  '/pages/b': { status: 301, location: '/pages/a' },
}
const probe: RedirectProbe = async (url) => {
  const u = new URL(url)
  return PROBE[`${u.pathname}${u.search}`] ?? { status: 404 }
}

async function sample(overrides: Partial<TechAuditInput> = {}): Promise<TechAuditInput> {
  const pages = [
    { kind: 'home' as const, facts: pageSeoFacts({ url: `${O}/`, html: read('home.html') }) },
    { kind: 'page' as const, facts: pageSeoFacts({ url: `${O}/de`, html: read('home-de.html') }) },
    {
      kind: 'product' as const,
      facts: pageSeoFacts({ url: `${O}/products/magsafe-10k`, html: read('product-magsafe.html') }),
    },
    {
      kind: 'product' as const,
      facts: pageSeoFacts({
        url: `${O}/products/usb-c-charger`,
        html: read('product-charger.html'),
      }),
    },
    {
      kind: 'article' as const,
      facts: pageSeoFacts({
        url: `${O}/blogs/news/pick-a-power-bank`,
        html: read('article.html'),
      }),
    },
  ]
  const home = pages[0]?.facts
  const links = home?.links ?? []
  const sm = parseSitemap(read('sitemap.xml'))
  const urls = [
    ...parseSitemap(read('sitemap_products_1.xml')).locs,
    ...parseSitemap(read('sitemap_blogs_1.xml')).locs,
  ]
  const sitemap: SitemapRead = {
    state: sm.kind === 'invalid' ? 'unreadable' : 'found',
    declared_in_robots: sitemapsInRobots(read('robots.txt')).length > 0,
    urls,
    at: `${O}/sitemap.xml`,
  }
  const sitemap_sample = urls.slice(0, 5)
  const traces = new Map()
  const link_from = new Map<string, string>()
  for (const l of links) {
    traces.set(l, await traceRedirects(l, probe, ['shop.example']))
    link_from.set(l, `${O}/`)
  }
  for (const u of sitemap_sample)
    if (!traces.has(u)) traces.set(u, await traceRedirects(u, probe, ['shop.example']))
  const index: SitePage[] = [
    { url: `${O}/products/magsafe-10k`, kind: 'product', index_status: 'indexed' },
    { url: `${O}/collections/sale`, kind: 'collection', index_status: 'not_indexed' },
  ]
  const speed = [
    speedReadingOf(`${O}/`, JSON.parse(read('psi-field.json'))),
    speedReadingOf(`${O}/products/magsafe-10k`, JSON.parse(read('psi-lab.json'))),
  ].filter((x) => x !== undefined)
  return {
    origin: O,
    checked_at: '2026-10-22T09:00:00Z',
    pages,
    index,
    sitemap,
    traces,
    link_from,
    sitemap_sample,
    markets: 2,
    speed,
    speed_enabled: true,
    ...overrides,
  }
}

describe('WP448 技术体检：页面读法', () => {
  it('读出规范网址、hreflang、robots、H1、JSON-LD（写坏的块单独数）、站内链接', () => {
    const f = pageSeoFacts({ url: `${O}/`, html: read('home.html') })
    expect(f.canonicals).toEqual([`${O}/`])
    expect(f.hreflang.map((h) => h.lang)).toEqual(['en', 'de-DE', 'en-UK'])
    expect(f.h1).toEqual(['Power that keeps up'])
    expect(f.links).toEqual([
      `${O}/products/magsafe-10k`,
      `${O}/products/usb-c-charger`,
      `${O}/collections/old-sale`,
      `${O}/pages/warranty-2023`,
    ])
    const p = pageSeoFacts({ url: `${O}/products/magsafe-10k`, html: read('product-magsafe.html') })
    expect(p.jsonld.blocks).toHaveLength(1)
    expect(p.jsonld.broken).toBe(1)
    const nx = pageSeoFacts({
      url: `${O}/x`,
      html: '<meta name="robots" content="NOINDEX">',
      x_robots: 'nofollow',
    })
    expect(nx.robots).toBe('noindex, nofollow')
    expect(isNoindex(nx.robots)).toBe(true)
    expect(isNoindex('index, follow')).toBe(false)
  })

  it('站点地图：robots 里的声明、索引与网址清单、读不出', () => {
    expect(sitemapsInRobots('User-agent: *\nSitemap: https://a.example/sitemap.xml\n')).toEqual([
      'https://a.example/sitemap.xml',
    ])
    expect(sitemapsInRobots(read('robots.txt'))).toEqual([])
    expect(parseSitemap(read('sitemap.xml')).kind).toBe('index')
    expect(parseSitemap(read('sitemap_products_1.xml')).locs).toHaveLength(2)
    expect(parseSitemap('<html>not a sitemap</html>').kind).toBe('invalid')
  })

  it('跳转跟踪：两跳、绕圈、跳出本站就停', async () => {
    const chain = await traceRedirects(`${O}/collections/old-sale`, probe, ['shop.example'])
    expect(chain.hops.map((h) => h.status)).toEqual([301, 301])
    expect(chain.final).toEqual({ url: `${O}/collections/sale`, status: 200 })
    const loop = await traceRedirects(`${O}/pages/a`, probe, ['shop.example'])
    expect(loop.loop).toBe(true)
    const off = await traceRedirects(
      `${O}/x`,
      async () => ({ status: 301, location: 'https://other.example/' }),
      ['shop.example'],
    )
    expect(off.offsite).toBe(true)
  })

  it('PageSpeed 回包：真实用户优先、没有退整站、再没有用实验室数', () => {
    const field = speedReadingOf(`${O}/`, JSON.parse(read('psi-field.json')))
    expect(field).toMatchObject({
      source: 'field',
      scope: 'page',
      lcp_ms: 4300,
      inp_ms: 180,
      cls: 0.15,
    })
    const lab = speedReadingOf(`${O}/p`, JSON.parse(read('psi-lab.json')))
    expect(lab).toMatchObject({ source: 'lab', lcp_ms: 2900, cls: 0.02, tbt_ms: 351 })
    const origin = speedReadingOf(`${O}/p`, {
      originLoadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000 } } },
    })
    expect(origin).toMatchObject({ source: 'field', scope: 'origin', lcp_ms: 2000 })
    expect(speedReadingOf(`${O}/p`, {})).toBeUndefined()
  })

  it('hreflang 码：ISO 639-1 + 地区；UK / EU 不算国家码；x-default 合规', () => {
    for (const ok of ['en', 'en-GB', 'de-DE', 'zh-Hant', 'zh-Hans-US', 'es-419', 'x-default'])
      expect(validHreflang(ok)).toBe(true)
    // 单写 EU 是巴斯克语（eu），合规；EU 当地区不合规
    for (const bad of ['en-UK', 'eng', 'en-EU', 'english', 'en_US', 'es-LA'])
      expect(validHreflang(bad)).toBe(false)
  })

  it('结构化数据走开源校验库：Product 的报价缺价格算缺 Google 要求的字段', async () => {
    const errs = await schemaErrors([
      {
        '@type': 'Product',
        name: 'X',
        image: 'https://cdn.example/x.jpg',
        offers: { '@type': 'Offer', priceCurrency: 'EUR' },
      },
    ])
    expect(errs).toHaveLength(1)
    expect(errs[0]?.type).toBe('Product')
    expect(errs[0]?.fields).toContain('price')
    const ok = await schemaErrors([
      {
        '@type': 'Product',
        name: 'X',
        image: 'https://cdn.example/x.jpg',
        offers: { '@type': 'Offer', price: '9.90', priceCurrency: 'EUR' },
      },
    ])
    expect(ok).toEqual([])
    // 只看我们在乎的类型：Organization 不校验
    expect(await schemaErrors([{ '@type': 'Organization' }])).toEqual([])
  })
})

describe('WP448 技术体检：样本跑出预期问题清单', () => {
  it('七块各命中预期的规则，严重度与归属来自规则表', async () => {
    const r = await runTechAudit(await sample())
    const got = r.issues.map(
      (i) => `${i.rule}|${i.url === undefined ? '' : new URL(i.url).pathname}`,
    )
    expect(got.sort()).toEqual(
      [
        'indexing.not_indexed|/collections/sale',
        'canonical.multiple|/products/usb-c-charger',
        'redirect.chain|/collections/old-sale',
        'link.dead_internal|/pages/warranty-2023',
        'sitemap.not_in_robots|',
        'sitemap.bad_url|/products/discontinued-cable',
        'sitemap.missing_page|/products/usb-c-charger',
        'hreflang.invalid_code|/',
        'hreflang.no_return|/de',
        'hreflang.no_x_default|',
        'schema.broken_json|/products/magsafe-10k',
        'schema.invalid|/products/magsafe-10k',
        'schema.product_missing|/products/usb-c-charger',
        'schema.article_recommended|/blogs/news/pick-a-power-bank',
        'speed.lcp|/',
        'speed.cls|/',
        'speed.lcp|/products/magsafe-10k',
        'speed.tbt|/products/magsafe-10k',
      ].sort(),
    )
    expect(r).toMatchObject({
      indexing: 'checked',
      sitemap: 'found',
      hreflang: 'checked',
      speed: 'mixed',
      pages: 5,
    })
    // 跳转链带好可以直接出「改跳转」卡的那一行
    const chain = r.issues.find((i) => i.rule === 'redirect.chain')
    expect(chain?.redirect).toEqual({ path: '/collections/old-sale', target: '/collections/sale' })
    expect(chain?.owner).toBe('site.shopify-build')
    // 严重度：真实用户 LCP 4.3 秒（过了「差」线）= 高；实验室数降一级并标「实验室」
    const lcpHome = r.issues.find((i) => i.rule === 'speed.lcp' && i.url === `${O}/`)
    expect(lcpHome).toMatchObject({ severity: 'high', measured: 'field' })
    expect(lcpHome?.detail).toContain('LCP 4.3 秒（真实用户）')
    const lcpLab = r.issues.find((i) => i.rule === 'speed.lcp' && i.url?.endsWith('magsafe-10k'))
    expect(lcpLab).toMatchObject({ severity: 'low', measured: 'lab' })
    expect(lcpLab?.detail).toContain('（实验室）')
    // 归属与严重度来自规则表
    for (const i of r.issues) {
      const rule = TECH_AUDIT_RULES[i.rule as keyof typeof TECH_AUDIT_RULES]
      expect(i.owner).toBe(rule.owner)
      expect(i.area).toBe(rule.area)
    }
    // 只列有问题的：高的排前面
    expect(r.issues[0]?.severity).toBe('high')
    expect(r.issues.at(-1)?.severity).toBe('low')
  })

  it('没连 Search Console 明说；一个市场不查 hreflang；速度没开', async () => {
    const r = await runTechAudit(
      await sample({ index: undefined, markets: 1, speed: undefined, speed_enabled: false }),
    )
    expect(r.indexing).toBe('not_connected')
    expect(r.hreflang).toBe('single_market')
    expect(r.speed).toBe('off')
    expect(
      r.issues.some((i) => i.area === 'indexing' || i.area === 'hreflang' || i.area === 'speed'),
    ).toBe(false)
  })

  it('站点地图找不到 / 读不出；多市场却一条 hreflang 都没有', async () => {
    const plain = pageSeoFacts({
      url: `${O}/`,
      html: '<head><link rel="canonical" href="https://shop.example/"></head><h1>x</h1>',
    })
    const base = {
      pages: [{ kind: 'home' as const, facts: plain }],
      traces: new Map(),
      link_from: new Map(),
      sitemap_sample: [],
      speed: undefined,
      index: undefined,
    }
    const missing = await runTechAudit(
      await sample({ ...base, sitemap: { state: 'missing', declared_in_robots: false, urls: [] } }),
    )
    expect(missing.issues.map((i) => i.rule)).toEqual(['sitemap.missing', 'hreflang.missing'])
    const bad = await runTechAudit(
      await sample({
        ...base,
        markets: 1,
        sitemap: {
          state: 'unreadable',
          declared_in_robots: true,
          urls: [],
          at: `${O}/sitemap.xml`,
        },
      }),
    )
    expect(bad.issues.map((i) => i.rule)).toEqual(['sitemap.unreadable'])
  })

  it('规范网址：缺、指走、指到会跳的地址、noindex 冲突；合集里的商品地址指 /products/ 不算', async () => {
    const pages = [
      {
        kind: 'page' as const,
        facts: pageSeoFacts({ url: `${O}/pages/a1`, html: '<head></head>' }),
      },
      {
        kind: 'page' as const,
        facts: pageSeoFacts({
          url: `${O}/pages/a2`,
          html: '<head><meta name="robots" content="noindex"><link rel="canonical" href="/collections/old-sale"></head>',
        }),
      },
      {
        kind: 'product' as const,
        facts: pageSeoFacts({
          url: `${O}/collections/sale/products/magsafe-10k`,
          html: '<head><link rel="canonical" href="/products/magsafe-10k"><script type="application/ld+json">{"@type":"Product","name":"M","image":"i","offers":{"@type":"Offer","price":1}}</script></head>',
        }),
      },
    ]
    const traces = new Map([
      [
        `${O}/collections/old-sale`,
        await traceRedirects(`${O}/collections/old-sale`, probe, ['shop.example']),
      ],
    ])
    const r = await runTechAudit(
      await sample({
        pages,
        traces,
        link_from: new Map(),
        sitemap_sample: [],
        index: undefined,
        markets: 1,
        speed: undefined,
        sitemap: { state: 'unknown', declared_in_robots: false, urls: [] },
      }),
    )
    expect(r.issues.map((i) => `${i.rule}|${new URL(i.url ?? O).pathname}`).sort()).toEqual(
      [
        'canonical.missing|/pages/a1',
        'canonical.points_elsewhere|/pages/a2',
        'canonical.noindex_conflict|/pages/a2',
        'canonical.target_broken|/pages/a2',
        // old-sale 本身是两跳的跳转链
        'redirect.chain|/collections/old-sale',
      ].sort(),
    )
  })

  it('交建站的正文：按担哪一条分开，只交中 / 高，跳转单独一段清单', async () => {
    const r = await runTechAudit(await sample())
    const build = techHandoffText(r.issues, 'site.shopify-build')
    expect(build?.text).toContain('可以直接出「改跳转」卡的清单（旧路径 → 新路径）：')
    expect(build?.text).toContain('/collections/old-sale → /collections/sale')
    expect(build?.text).not.toContain('robots.txt 里没有 Sitemap')
    const theme = techHandoffText(r.issues, 'site.shopify-theme')
    expect(theme?.text).toContain('写了不止一个规范网址')
    expect(theme?.text).not.toContain('改跳转')
    expect(techHandoffText([], 'site.shopify-build')).toBeUndefined()
  })

  it('改版回归的快照：标题、描述、规范网址、robots、H1、结构化数据摘要（键顺序不影响摘要）', () => {
    const a = driftSnapshotOf(
      pageSeoFacts({ url: `${O}/products/magsafe-10k`, html: read('product-magsafe.html') }),
      'product',
      '2026-10-22T09:00:00Z',
    )
    expect(a).toMatchObject({
      status: 200,
      title: 'MagSafe 10K Power Bank – NordVolt',
      canonical: `${O}/products/magsafe-10k`,
      h1: ['MagSafe 10K'],
      schema: { types: ['Product'], product_currency: 'EUR' },
    })
    const x = (json: string) =>
      driftSnapshotOf(
        pageSeoFacts({ url: `${O}/`, html: `<script type="application/ld+json">${json}</script>` }),
        'home',
        't',
      ).schema.hash
    expect(x('{"a":1,"b":2}')).toBe(x('{"b":2,"a":1}'))
    expect(x('{"a":1}')).not.toBe(x('{"a":2}'))
  })
})
