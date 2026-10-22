/**
 * WP448（docs/109 §4.4）：技术体检与改版回归的服务端那一半——录好的样本（网页、robots、站点地图、JSON-LD、
 * PageSpeed 回包、Search Console 网址检查），不联网、不连真实店、不调付费接口。
 *
 * - 技术体检跟着 WP381 那一轮跑，按担哪一条交建站，同一份清单 7 天内不重派，跳转类带改跳转清单；
 * - 改版回归：第一次存基线；主题发布后比出三级，严重的交建站并指到那张发布卡；首页告警区一张卡；
 * - App 变了跑一次回归；落盘重开读得回。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonId, SitePage, WorkspaceId } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { renderSiteHealthAnswer } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { alertNotificationOf } from '../src/alert-notifications.js'
import { driftAlertCards } from '../src/seo-drift-alerts.js'
import { createSiteHealthService, type SiteHealthServiceOptions } from '../src/site-health.js'
import { siteHealthQueryData } from '../src/site-health-tools.js'

vi.setConfig({ testTimeout: 120_000 })

const FX = join(import.meta.dirname, '../../../packages/site-core/test/fixtures/wp448')
const fx = (name: string): string => readFileSync(join(FX, name), 'utf8')
const O = 'https://shop.example'

/** 录好的网页（改版前）。 */
const BEFORE: Record<string, string> = {
  [`${O}/robots.txt`]: fx('robots.txt'),
  [`${O}/sitemap.xml`]: fx('sitemap.xml'),
  [`${O}/sitemap_products_1.xml`]: fx('sitemap_products_1.xml'),
  [`${O}/sitemap_blogs_1.xml`]: fx('sitemap_blogs_1.xml'),
  [`${O}/`]: fx('home.html'),
  [`${O}/de`]: fx('home-de.html'),
  [`${O}/products/magsafe-10k`]: fx('product-magsafe.html'),
  [`${O}/products/usb-c-charger`]: fx('product-charger.html'),
  [`${O}/blogs/news/pick-a-power-bank`]: fx('article.html'),
}

/** 新主题发布之后：首页被设成 noindex、商品页的 Product 结构化数据没了。 */
const AFTER: Record<string, string> = {
  ...BEFORE,
  [`${O}/`]: fx('home.html').replace(
    '<head>',
    '<head>\n<meta name="robots" content="noindex, nofollow">',
  ),
  [`${O}/products/magsafe-10k`]: fx('product-magsafe.html').replace(
    /<script type="application\/ld\+json">\s*\{"@context":"https:\/\/schema.org","@type":"Product"[\s\S]*?<\/script>/,
    '',
  ),
}

/** 不跟跳转那一口的替身（跳转链与死链）。 */
const REDIRECTS: Record<string, { status: number; location?: string }> = {
  '/collections/old-sale': { status: 301, location: '/collections/sale-2024' },
  '/collections/sale-2024': { status: 301, location: '/collections/sale' },
  '/collections/sale': { status: 200 },
  '/pages/warranty-2023': { status: 404 },
  '/products/discontinued-cable': { status: 404 },
}

function world() {
  let pages = BEFORE
  let now = '2026-10-22T08:00:00.000Z'
  const fetched: string[] = []
  const handoffs: { owner: string; title: string; text: string }[] = []
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const options = (dir?: string): SiteHealthServiceOptions => ({
    clock: { now: () => now },
    newId: (p) => `${p}_${String(Math.random()).slice(2, 8)}`,
    ...(dir === undefined ? {} : { file: join(dir, 'site-health.json') }),
    origin: async () => O,
    fetch: async (url) => {
      fetched.push(url)
      const body = pages[url]
      return {
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        url,
        text: async () => body ?? '',
      }
    },
    probe: async (url) => {
      const u = new URL(url)
      const hit = REDIRECTS[u.pathname]
      if (hit !== undefined) return hit
      return { status: pages[url] === undefined ? 404 : 200 }
    },
    shop: async () => ({
      via: 'stand_in' as const,
      store: 'shop-example.myshopify.com',
      async query<T>(op: { name: string }): Promise<T> {
        if (op.name !== 'health_products') throw new Error(`没录：${op.name}`)
        const product = (handle: string, title: string) => ({
          id: `gid://shopify/Product/${handle}`,
          title,
          handle,
          onlineStoreUrl: `${O}/products/${handle}`,
          descriptionHtml: `<p>${title}.</p>`,
          vendor: 'NordVolt',
          productType: 'Chargers',
          featuredMedia: null,
          options: [],
          variants: {
            nodes: [
              {
                id: `gid://shopify/ProductVariant/${handle}`,
                title: 'Default',
                sku: handle,
                price: '39.90',
                barcode: null,
                availableForSale: true,
              },
            ],
          },
        })
        return {
          shop: { name: 'NordVolt', currencyCode: 'EUR' },
          products: {
            nodes: [
              product('magsafe-10k', 'MagSafe 10K'),
              product('usb-c-charger', 'USB-C Charger'),
            ],
          },
        } as T
      },
    }),
    indexStatus: async (): Promise<SitePage[]> => [
      { url: `${O}/products/magsafe-10k`, kind: 'product', index_status: 'indexed' },
      { url: `${O}/collections/sale`, kind: 'collection', index_status: 'not_indexed' },
    ],
    markets: () => 2,
    pageSpeed: async (url) =>
      JSON.parse(url === `${O}/` ? fx('psi-field.json') : fx('psi-lab.json')) as unknown,
    handoff: async (input) => {
      handoffs.push(input)
      return { matter_id: `mat_${String(handoffs.length)}` }
    },
    event: (type, payload) => events.push({ type, payload }),
  })
  return {
    options,
    fetched,
    handoffs,
    events,
    setPages: (p: Record<string, string>) => {
      pages = p
    },
    setNow: (t: string) => {
      now = t
    },
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('WP448 技术体检（服务端，跟着 WP381 那一轮）', () => {
  it('七块读齐、只列有问题的；按担哪一条交建站，跳转类带改跳转清单；7 天内不重派，过了再派', async () => {
    const w = world()
    const svc = createSiteHealthService(w.options())
    const run = await svc.run()
    const tech = run.tech
    expect(tech).toMatchObject({
      indexing: 'checked',
      sitemap: 'found',
      hreflang: 'checked',
      speed: 'mixed',
    })
    const rules = new Set(tech?.issues.map((i) => i.rule))
    for (const r of [
      'indexing.not_indexed',
      'canonical.multiple',
      'redirect.chain',
      'link.dead_internal',
      'sitemap.not_in_robots',
      'sitemap.bad_url',
      'hreflang.invalid_code',
      'hreflang.no_return',
      'schema.broken_json',
      'schema.invalid',
      'schema.product_missing',
      'speed.lcp',
    ])
      expect(rules.has(r), r).toBe(true)
    // 交建站：整站搭建一件（跳转、死链、站点地图、收录）、主题一件（规范网址、hreflang、结构化数据、速度）
    expect(w.handoffs.map((h) => h.owner).sort()).toEqual([
      'site.shopify-build',
      'site.shopify-theme',
    ])
    const build = w.handoffs.find((h) => h.owner === 'site.shopify-build')
    expect(build?.text).toContain('可以直接出「改跳转」卡的清单（旧路径 → 新路径）：')
    expect(build?.text).toContain('/collections/old-sale → /collections/sale')
    expect(tech?.dispatched?.map((d) => d.matter_id).sort()).toEqual(['mat_1', 'mat_2'])
    // 只抓了自己的站与 Google 的测速（测速走注入的那一口，这里没有外站请求）
    expect(w.fetched.every((u) => u.startsWith(O))).toBe(true)
    expect(w.events.find((e) => e.type === 'site_health.checked')?.payload).toMatchObject({
      tech_issues: tech?.issues.length,
    })
    // 同一份清单 7 天内不重派：再跑一次，事项照旧指着上一件
    w.setNow('2026-10-25T08:00:00.000Z')
    const again = await svc.run()
    expect(w.handoffs).toHaveLength(2)
    expect(again.tech?.dispatched?.map((d) => d.matter_id).sort()).toEqual(['mat_1', 'mat_2'])
    // 过了 7 天再派
    w.setNow('2026-10-30T08:00:00.000Z')
    await svc.run()
    expect(w.handoffs).toHaveLength(4)
  })

  it('没连 Search Console、一个市场、没量速度：这几块照实说，不出「缺」', async () => {
    const w = world()
    const svc = createSiteHealthService({
      ...w.options(),
      indexStatus: async () => undefined,
      markets: () => 1,
      pageSpeed: undefined as never,
    })
    const run = await svc.run()
    expect(run.tech).toMatchObject({ indexing: 'not_connected', hreflang: 'single_market' })
    expect(run.tech?.issues.some((i) => i.area === 'indexing' || i.area === 'hreflang')).toBe(false)
  })
})

describe('WP448 改版回归（服务端）', () => {
  it('第一次存基线；主题发布后比出三级，严重的交建站并指到那张发布卡；告警卡「去处理」到那件事', async () => {
    const w = world()
    const dir = mkdtempSync(join(tmpdir(), 'wp448-drift-'))
    dirs.push(dir)
    const svc = createSiteHealthService(w.options(dir))
    const first = await svc.drift({ kind: 'weekly' })
    expect(first.status).toBe('baseline')
    expect(first.pages).toBe(4)
    expect(first.findings).toEqual([])
    // 新主题发布
    w.setPages(AFTER)
    w.setNow('2026-10-23T10:00:00.000Z')
    const r = await svc.drift({ kind: 'theme_publish', change_id: 'chg_77', label: '主题发布' })
    expect(r.status).toBe('ok')
    const crit = r.findings.filter((f) => f.severity === 'critical').map((f) => f.rule)
    // 商品页剩下的那块面包屑本来就写坏了（读不出），所以是「结构化数据整个没了」
    expect(crit.sort()).toEqual(['noindex_added', 'schema_removed'])
    expect(w.handoffs).toHaveLength(1)
    expect(w.handoffs[0]).toMatchObject({ owner: 'site.shopify-build' })
    expect(w.handoffs[0]?.title).toBe('改版回归：主题发布之后 2 处要马上看')
    expect(w.handoffs[0]?.text).toContain('是这一次改版带来的：改动卡 chg_77。')
    expect(r.dispatched?.matter_id).toBe('mat_1')
    expect(
      w.events.find((e) => e.type === 'seo.drift_checked' && e.payload.critical === 2),
    ).toBeDefined()
    // 面板数据与告警卡
    const view = svc.driftView()
    expect(view.last?.id).toBe(r.id)
    expect(svc.deckData().drift?.last_with_findings?.id).toBe(r.id)
    const cards = driftAlertCards({
      view,
      now: '2026-10-23T11:00:00.000Z',
      position: {
        position_id: 'asg_seo',
        role_id: 'dtc.seo',
        href: '/positions/asg_seo/duties/dtc.seo',
      },
    })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('改版回归：主题发布之后 2 处严重问题')
    expect((cards[0]?.detail.payload as Record<string, unknown> | undefined)?.open_path).toBe(
      '/matters/mat_1',
    )
    // int/1026（WP466）：这张真出的卡进铃铛就是一条「告警」·紧急，点了去交给建站的那件事
    expect(
      alertNotificationOf(cards[0] as DeckCard, {
        workspace_id: 'ws_1' as WorkspaceId,
        person_id: 'p_seo' as PersonId,
      }),
    ).toMatchObject({ category: 'alert', urgent: true, href: '/matters/mat_1' })
    // 没担这两条的人看不到；7 天后自己消失
    expect(driftAlertCards({ view, now: '2026-10-23T11:00:00.000Z' })).toEqual([])
    expect(
      driftAlertCards({
        view,
        now: '2026-11-01T11:00:00.000Z',
        position: { position_id: 'a', role_id: 'dtc.seo', href: '/x' },
      }),
    ).toEqual([])
    // 改回去之后再比：严重的没了，告警也收了
    w.setPages(BEFORE)
    w.setNow('2026-10-24T10:00:00.000Z')
    const fixed = await svc.drift({ kind: 'manual' })
    expect(fixed.findings.some((f) => f.severity === 'critical')).toBe(false)
    expect(
      driftAlertCards({
        view: svc.driftView(),
        now: '2026-10-24T11:00:00.000Z',
        position: { position_id: 'a', role_id: 'dtc.seo', href: '/x' },
      }),
    ).toEqual([])
    // 岗位 AI 读体检结论的工具：技术体检与改版回归两块也读得到（数照抄）
    await svc.run()
    const data = siteHealthQueryData(svc, 'all', false)
    expect(data.tech?.issues.length).toBeGreaterThan(0)
    expect(data.drift).toMatchObject({ trigger: 'manual', status: 'ok' })
    const onlyDrift = siteHealthQueryData(svc, 'drift', false)
    expect(onlyDrift.tech).toBeUndefined()
    const answer = renderSiteHealthAnswer(siteHealthQueryData(svc, 'tech', false))
    expect(answer).toContain('技术体检要改')
    // 落盘重开：基线与那几页读得回
    const reopened = createSiteHealthService(w.options(dir))
    expect(reopened.driftView().last?.id).toBe(fixed.id)
    w.setNow('2026-10-25T10:00:00.000Z')
    expect((await reopened.drift({ kind: 'weekly' })).status).toBe('ok')
  })

  it('App 变了才跑：第一次只记下；装了新的就跑一次，写明装了哪个', async () => {
    const w = world()
    const svc = createSiteHealthService(w.options())
    expect(await svc.appsSeen(['klaviyo'])).toBeUndefined()
    expect(await svc.appsSeen(['klaviyo'])).toBeUndefined()
    const r = await svc.appsSeen(['klaviyo', 'judge-me'])
    expect(r?.trigger).toMatchObject({ kind: 'app_change', label: '装了 judge-me' })
  })

  it('不知道网站地址：照实说，不抛', async () => {
    const w = world()
    const svc = createSiteHealthService({ ...w.options(), origin: async () => undefined })
    const r = await svc.drift({ kind: 'weekly' })
    expect(r.status).toBe('failed')
    expect(r.notes[0]).toContain('网站地址')
  })
})
