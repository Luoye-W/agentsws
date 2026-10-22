/**
 * WP381（决策 1066）：网站 / 商品体检与 AI 来源流量的服务端那一半（一个品牌一份）。
 *
 * 判断全在纯函数里（`@agentsws/site-core` 的 `health/*`、`@agentsws/seo-core` 的 `ai-traffic`）；
 * 这一层只把事实读齐、落盘、派单：
 *
 * 1. **只读、只 GET**：抓公开页面走品牌分析那一口（`fetchPage`：不带凭据、UA 认得出、10 秒超时）；
 *    只抓**我们自己的站**，外加用户在设置里填的 feed 与各平台上架页（那几个遵它们的 robots）。
 *    店铺走店铺授权的只读 Admin GraphQL（`site-health-shop.ts` 写死的那几条）。
 * 2. **渲染对比可有可无**：给了渲染口就同一页再渲染一次比；找不到浏览器照实记，原始那份照比。
 * 3. **不一致派给网站运营**：有中 / 高的不一致就给网站运营开一件事（清单写在事项里），由它用运营工具出审批卡改；
 *    同一份清单 7 天内不重派。
 * 4. **读不到就说读不到**：哪块没读到写进 `notes`，那块不出「缺」。
 * 5. **WP448 技术体检**（docs/109 §4.4）：同一轮里再看没收录（Search Console 网址检查）、规范网址、跳转与死链、站点地图、
 *    hreflang（多市场时）、结构化数据（Google 现行要求）、页面速度（真实用户优先，没有退实验室数）；判断在
 *    `@agentsws/site-core` 的 `runTechAudit`（规则表是数据）。中 / 高的按担哪一条**开事项交建站**（整站搭建 / 主题），
 *    同一份清单 7 天内不重派；跳转类带好可直接出「改跳转」卡的清单。
 * 6. **WP448 改版回归**：主题发布、App 装卸之后（另每周兜底一次）抓首页 / 两件商品 / 一个合集 / 一篇文章，和上一次的基线比
 *    （`@agentsws/seo-core` 的 `compareDrift`，比对规则表三级）；严重的交建站开一件事（指到是哪次改版），其余进简报与面板。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchPage, fetchRobots, isDisallowed, type PageFetch } from '@agentsws/brand-intake'
import type {
  AiTrafficSummary,
  Clock,
  DriftPageKind,
  DriftRun,
  DriftSnapshot,
  DriftTrigger,
  RawHtmlFactCheck,
  SeoDriftView,
  SiteHealthRun,
  SiteHealthSettings,
  SitePage,
  TechAuditOwner,
} from '@agentsws/contracts'
import {
  compareDrift,
  driftCounts,
  driftLine,
  effectiveReferrers,
  summarizeAiTraffic,
  type TrafficOrder,
  type TrafficSessions,
} from '@agentsws/seo-core'
import {
  AI_CRAWLER_LIST_VERSION,
  type AuditPageKind,
  assessChatGptShopping,
  availabilityExpectation,
  checkAiCrawlers,
  checkProductFacts,
  compareRawRendered,
  driftSnapshotOf,
  effectiveCrawlers,
  type FactExpectation,
  feedSnapshotFor,
  freeShippingOverIn,
  issueLine,
  jsonLdSnapshot,
  type PageSeoFacts,
  type ProductTruth,
  pageSeoFacts,
  pageSnapshot,
  parseMerchantFeed,
  parseSitemap,
  priceExpectation,
  type RedirectProbe,
  type RedirectTrace,
  returnDaysExpectation,
  returnDaysIn,
  runTechAudit,
  type SitemapRead,
  type SourceSnapshot,
  type SpeedReading,
  type StoreTruth,
  sellingPointExpectation,
  shopifyProductJsSnapshot,
  sitemapsInRobots,
  speedReadingOf,
  techHandoffText,
  traceRedirects,
} from '@agentsws/site-core'
import type { ShopifyAdminReader } from './shop-admin.js'
import {
  AI_TRAFFIC_ORDERS,
  aiTrafficSessionsDoc,
  HEALTH_PRODUCTS,
  HEALTH_PRODUCTS_BY_HANDLE,
  healthProductsOf,
  trafficOrdersOf,
  trafficSessionsOf,
} from './site-health-shop.js'

/** 渲染口：同一批网址开 JS 渲染后的 HTML（读不到的不给）。 */
export interface PageRenderer {
  render(urls: readonly string[], ownHosts: readonly string[]): Promise<Map<string, string>>
}

export type RenderOutcome = 'no_browser' | 'failed'

export interface SiteHealthServiceOptions {
  clock: Clock
  newId(prefix: string): string
  /** 落盘文件（品牌数据目录下的 `site-health.json`）；不给 = 只在内存。 */
  file?: string
  /** 这个品牌的网站（`https://example.com`）；不知道回 `undefined`。 */
  origin(): Promise<string | undefined>
  fetch: PageFetch
  /** 渲染口；不给 = 不比渲染后（`render: off`）。抛 `RenderOutcome` 字串 = 那一种没做成。 */
  renderer?(): PageRenderer | undefined
  /** 店铺授权的只读口（没授权回 `undefined`）。 */
  shop(): Promise<ShopifyAdminReader | undefined>
  /** 店铺授权里有哪些权限（有 `read_reports` 才读会话）。 */
  scopes?(): Promise<readonly string[] | undefined>
  /**
   * 没有店铺授权时，AI 来源流量退一步用面板那份订单（连接器拉的，带 `referring_site` / `landing_site`）。
   */
  fallbackOrders?(): TrafficOrder[] | undefined
  /** 把不一致清单交给网站运营（开一件事）；没人担网站运营回 `undefined`。 */
  dispatch?(input: {
    title: string
    text: string
    issues: number
  }): Promise<{ matter_id: string } | undefined>
  event?(type: string, payload: Record<string, unknown>): void
  /**
   * WP448：不自动跟跳转地抓一次（状态码、`Location`、`X-Robots-Tag`）——查跳转链、死链、站点地图里的坏地址。
   * 不给 = 这几项不查（报表页脚说一句）。
   */
  probe?: RedirectProbe
  /** WP448：Search Console 网址检查读到的页（带收录状况）；没连回 `undefined`。 */
  indexStatus?(): Promise<readonly SitePage[] | undefined>
  /** WP448：目标市场几个（≥ 2 才查 hreflang）。 */
  markets?(): number
  /** WP448：一页的 PageSpeed Insights 回包（真实用户数据 + 实验室数）；不给 = 不量速度。 */
  pageSpeed?(url: string): Promise<unknown>
  /**
   * WP448：技术问题 / 严重回归交给建站（按担哪一条：整站搭建 / 主题）开一件事；没人担回 `undefined`。
   */
  handoff?(input: {
    owner: TechAuditOwner
    title: string
    text: string
    issues: number
  }): Promise<{ matter_id: string } | undefined>
}

interface Persisted {
  settings: SiteHealthSettings
  runs: SiteHealthRun[]
  traffic?: AiTrafficSummary
  /** 上次派出去的那份清单（去重用）。 */
  dispatched?: { key: string; at: string; matter_id: string }
  /** WP448：技术体检按担哪一条派出去的那份清单（去重用）。 */
  tech_dispatched?: Partial<Record<TechAuditOwner, { key: string; at: string; matter_id: string }>>
  /** WP448：改版回归抓的那几页（固定下来，前后才比得上）与基线。 */
  drift_pages?: { url: string; kind: DriftPageKind }[]
  drift_baseline?: DriftSnapshot[]
  drift_runs?: DriftRun[]
  /** WP448：严重回归交出去的那份（去重用）。 */
  drift_dispatched?: { key: string; at: string; matter_id: string }
  /** WP448：上一次看到店里装了哪些 App（变了就跑一次改版回归）。 */
  apps_seen?: string[]
}

const KEEP_RUNS = 10
const DISPATCH_QUIET_MS = 7 * 86_400_000
const DEFAULT_SAMPLE = 5
const MAX_SAMPLE = 20
const TRAFFIC_DAYS = 7
const ORDER_PAGE = 100
const ORDER_PAGES = 4
/** WP448：首页上最多查几个站内链接、站点地图里抽查几条、最多读几份子地图、hreflang 另一版最多抓几页。 */
const MAX_LINKS = 40
const SITEMAP_SAMPLE = 10
const MAX_CHILD_SITEMAPS = 6
const MAX_ALTERNATES = 4
const KEEP_DRIFT_RUNS = 10

export interface SiteHealthService {
  latest(): SiteHealthRun | undefined
  runs(): SiteHealthRun[]
  settings(): SiteHealthSettings
  saveSettings(next: SiteHealthSettings): SiteHealthSettings
  /** 跑一次体检（永不抛：读不到的写进 `notes`）。 */
  run(): Promise<SiteHealthRun>
  /**
   * WP385：正在跑的那一次（没在跑回 `undefined`）。同一时间只跑一次：跑着时再要 `run()` 拿到的是同一次。
   */
  running(): Promise<SiteHealthRun> | undefined
  /** 算近 7 天 AI 来源流量（读不到店回 `undefined`）。 */
  aiTraffic(): Promise<AiTrafficSummary | undefined>
  /** 上一次算的 AI 来源流量（面板读它，不现算）。 */
  lastTraffic(): AiTrafficSummary | undefined
  deckData(): { run?: SiteHealthRun; ai_traffic?: AiTrafficSummary; drift?: SeoDriftView }
  /**
   * WP448：改版回归跑一次（主题发布 / App 装卸 / 每周兜底 / 手动）。同一时间只跑一次（跑着时再要拿到的是同一次）。
   * 永不抛：读不到的写进 `notes`。
   */
  drift(trigger: Omit<DriftTrigger, 'at'>): Promise<DriftRun>
  driftView(): SeoDriftView
  /** WP448：店里装的 App 这一刻是哪些（巡检读到的）；和上次不一样就跑一次改版回归。 */
  appsSeen(ids: readonly string[]): Promise<DriftRun | undefined>
}

function load(file: string | undefined): Persisted {
  if (file === undefined || !existsSync(file)) return { settings: {}, runs: [] }
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>
    return {
      settings: p.settings ?? {},
      runs: Array.isArray(p.runs) ? p.runs : [],
      ...(p.traffic === undefined ? {} : { traffic: p.traffic }),
      ...(p.dispatched === undefined ? {} : { dispatched: p.dispatched }),
      ...(p.tech_dispatched === undefined ? {} : { tech_dispatched: p.tech_dispatched }),
      ...(Array.isArray(p.drift_pages) ? { drift_pages: p.drift_pages } : {}),
      ...(Array.isArray(p.drift_baseline) ? { drift_baseline: p.drift_baseline } : {}),
      ...(Array.isArray(p.drift_runs) ? { drift_runs: p.drift_runs } : {}),
      ...(p.drift_dispatched === undefined ? {} : { drift_dispatched: p.drift_dispatched }),
      ...(Array.isArray(p.apps_seen) ? { apps_seen: p.apps_seen } : {}),
    }
  } catch {
    return { settings: {}, runs: [] }
  }
}

const hostOf = (u: string): string | undefined => {
  try {
    return new URL(u).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * WP448：店铺给的商品网址可能是 myshopify 域名或旧域名——技术体检与改版回归一律按我们自己的站去抓
 * （同一页不会因为两个域名被当成两页）。
 */
function onSite(origin: string, u: string): string {
  try {
    const x = new URL(u)
    return `${origin}${x.pathname}`
  } catch {
    return u
  }
}

/** 页面文字里的政策事实（退货天数、包邮门槛）。 */
async function storePolicies(
  get: (url: string) => Promise<string | undefined>,
  origin: string,
): Promise<{ truth: Partial<StoreTruth>; refundHtml?: string; refundUrl: string }> {
  const refundUrl = `${origin}/policies/refund-policy`
  const urls = {
    refund: refundUrl,
    shipping: `${origin}/policies/shipping-policy`,
    privacy: `${origin}/policies/privacy-policy`,
    terms: `${origin}/policies/terms-of-service`,
  }
  const pages = Object.fromEntries(
    await Promise.all(Object.entries(urls).map(async ([k, u]) => [k, await get(u)] as const)),
  ) as Record<keyof typeof urls, string | undefined>
  const policy_urls = Object.fromEntries(
    Object.entries(urls).filter(([k]) => pages[k as keyof typeof urls] !== undefined),
  )
  const strip = (h: string | undefined): string => (h ?? '').replace(/<[^>]+>/g, ' ')
  const days = returnDaysIn(strip(pages.refund))
  const free = freeShippingOverIn(strip(pages.shipping))
  return {
    truth: {
      policy_urls,
      ...(days === undefined ? {} : { return_days: days }),
      ...(free === undefined ? {} : { free_shipping_over: free }),
    },
    ...(pages.refund === undefined ? {} : { refundHtml: pages.refund }),
    refundUrl,
  }
}

export function createSiteHealthService(options: SiteHealthServiceOptions): SiteHealthService {
  let state = load(options.file)
  const save = (): void => {
    if (options.file === undefined) return
    mkdirSync(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, options.file)
  }
  const now = (): string => options.clock.now()

  /** 抓一页：成了回 HTML，没成回 `undefined`（404 记作 `''` 由调用方另判的只有 robots）。 */
  const get = async (url: string): Promise<string | undefined> => {
    const r = await fetchPage(options.fetch, url)
    return r.ok ? r.html : undefined
  }

  /** 外站（feed、平台上架页）：先看它的 robots 再抓。 */
  const getForeign = async (url: string): Promise<string | undefined> => {
    let origin: string
    try {
      const u = new URL(url)
      origin = u.origin
      const disallow = await fetchRobots(options.fetch, origin)
      if (isDisallowed(u.pathname, disallow)) return undefined
    } catch {
      return undefined
    }
    return get(url)
  }

  const robotsOf = async (origin: string): Promise<string | undefined> => {
    const r = await fetchPage(options.fetch, `${origin}/robots.txt`)
    if (r.ok) return r.html
    return r.status === 404 ? '' : undefined
  }

  const renderAll = async (
    urls: string[],
    host: string,
  ): Promise<{ state: SiteHealthRun['render']; pages: Map<string, string> }> => {
    const renderer = options.renderer?.()
    if (renderer === undefined) return { state: 'off', pages: new Map() }
    try {
      return { state: 'done', pages: await renderer.render(urls, [host]) }
    } catch (err) {
      return { state: err === 'no_browser' ? 'no_browser' : 'failed', pages: new Map() }
    }
  }

  /**
   * 读店铺商品（没授权 / 读不到回 `undefined` 与一句人话）。
   * WP385：设置里填了其他平台上架页的商品，不在最近更新的那几件里也补读进来（不然那条上架页永远比不上）。
   */
  const readProducts = async (
    sample: number,
    listed: readonly string[] = [],
  ): Promise<{ shop: { name?: string; currency?: string }; products: ProductTruth[] } | string> => {
    let reader: ShopifyAdminReader | undefined
    try {
      reader = await options.shop()
    } catch {
      reader = undefined
    }
    if (reader === undefined) return '店铺还没授权，商品那块这次没读'
    try {
      const data = await reader.query<unknown>({
        name: 'health_products',
        document: HEALTH_PRODUCTS,
        variables: { first: sample },
      })
      const got = healthProductsOf(data)
      const have = new Set(got.products.map((p) => p.handle))
      const missing = [...new Set(listed)]
        .filter((h) => /^[a-z0-9][a-z0-9-]*$/i.test(h) && !have.has(h))
        .slice(0, MAX_SAMPLE)
      if (missing.length > 0) {
        try {
          const more = healthProductsOf(
            await reader.query<unknown>({
              name: 'health_products_listed',
              document: HEALTH_PRODUCTS_BY_HANDLE,
              variables: {
                first: missing.length,
                query: `status:active AND (${missing.map((h) => `handle:${h}`).join(' OR ')})`,
              },
            }),
          )
          for (const p of more.products)
            if (missing.includes(p.handle) && !have.has(p.handle)) {
              have.add(p.handle)
              got.products.push(p)
            }
        } catch {
          // 补读没成：只比最近更新的那几件
        }
      }
      return got
    } catch {
      return '这次没读到店里的商品'
    }
  }

  const dispatchIfNew = async (run: SiteHealthRun): Promise<void> => {
    const worth = run.products.issues.filter((i) => i.severity !== 'low')
    if (worth.length === 0 || options.dispatch === undefined) return
    const key = worth
      .map(
        (i) =>
          `${i.product_id}|${i.source}|${i.source_label ?? ''}|${i.field}|${i.kind}|${i.found ?? ''}`,
      )
      .sort()
      .join('\n')
    const last = state.dispatched
    if (
      last !== undefined &&
      last.key === key &&
      Date.parse(now()) - Date.parse(last.at) < DISPATCH_QUIET_MS
    ) {
      run.dispatched = { matter_id: last.matter_id, at: last.at, issues: worth.length }
      return
    }
    const lines = worth.slice(0, 30).map((i, n) => `${String(n + 1)}. ${issueLine(i)}`)
    const text = [
      `体检发现 ${String(worth.length)} 处商品信息和店铺后台对不上（后台是准的）。请逐条核对，能在店里改的用运营工具出改动卡；`,
      '结构化数据 / feed 是主题或应用生成的，写清是哪个主题 / 应用要改；其他平台上架页列给我去改。',
      ...lines,
    ].join('\n')
    try {
      const out = await options.dispatch({
        title: '商品信息对不上，核对并改',
        text,
        issues: worth.length,
      })
      if (out === undefined) return
      state.dispatched = { key, at: now(), matter_id: out.matter_id }
      run.dispatched = { matter_id: out.matter_id, at: now(), issues: worth.length }
    } catch {
      run.notes.push('交给网站运营没成，清单在体检报表里')
    }
  }

  /* ── WP448：技术体检 ─────────────────────────────────────────────── */

  /** 抓一页、读出搜索相关的几样（状态码、`X-Robots-Tag` 走不跟跳转那一口，有的话）。 */
  const factsOf = async (url: string): Promise<PageSeoFacts> => {
    const r = await fetchPage(options.fetch, url)
    let x_robots: string | undefined
    if (options.probe !== undefined) {
      try {
        x_robots = (await options.probe(url)).x_robots
      } catch {
        x_robots = undefined
      }
    }
    return pageSeoFacts({
      url,
      html: r.ok ? r.html : undefined,
      status: r.status,
      ...(x_robots === undefined ? {} : { x_robots }),
    })
  }

  /** 读站点地图：robots.txt 里声明的优先，没有就 /sitemap.xml；索引就往下读几份子地图。 */
  const readSitemap = async (origin: string, robots: string | undefined): Promise<SitemapRead> => {
    const declared = sitemapsInRobots(robots)
    const at = declared[0] ?? `${origin}/sitemap.xml`
    const top = await fetchPage(options.fetch, at)
    if (!top.ok)
      return top.status === 404
        ? { state: 'missing', declared_in_robots: declared.length > 0, urls: [], at }
        : { state: 'unknown', declared_in_robots: declared.length > 0, urls: [], at }
    const parsed = parseSitemap(top.html)
    if (parsed.kind === 'invalid')
      return { state: 'unreadable', declared_in_robots: declared.length > 0, urls: [], at }
    if (parsed.kind === 'urlset')
      return { state: 'found', declared_in_robots: declared.length > 0, urls: parsed.locs, at }
    const urls: string[] = []
    for (const child of parsed.locs.slice(0, MAX_CHILD_SITEMAPS)) {
      const r = await fetchPage(options.fetch, child)
      if (r.ok) urls.push(...parseSitemap(r.html).locs)
    }
    return {
      state: 'found',
      declared_in_robots: declared.length > 0,
      urls,
      at,
      ...(parsed.locs.length > MAX_CHILD_SITEMAPS ? { truncated: true } : {}),
    }
  }

  /** 站点地图里第一个合集 / 文章（改版回归与体检都抓它们）。 */
  const firstOf = (urls: readonly string[], re: RegExp): string | undefined =>
    urls.find((u) => {
      try {
        return re.test(new URL(u).pathname)
      } catch {
        return false
      }
    })
  const COLLECTION = /^\/collections\/(?!all\/?$)[^/]+\/?$/
  const ARTICLE = /^\/blogs\/[^/]+\/[^/]+\/?$/
  const PRODUCT = /^\/products\/[^/]+\/?$/

  /** 同一份清单 7 天内不重派（按担哪一条分开）。 */
  const handoffTech = async (
    run: SiteHealthRun,
    tech: NonNullable<SiteHealthRun['tech']>,
  ): Promise<void> => {
    if (options.handoff === undefined) return
    const owners: TechAuditOwner[] = ['site.shopify-build', 'site.shopify-theme']
    for (const owner of owners) {
      const body = techHandoffText(tech.issues, owner)
      if (body === undefined) continue
      const key = tech.issues
        .filter((i) => i.owner === owner && i.severity !== 'low')
        .map((i) => `${i.rule}|${i.url ?? ''}`)
        .sort()
        .join('\n')
      const last = state.tech_dispatched?.[owner]
      const add = (matter_id: string, at: string): void => {
        tech.dispatched = [...(tech.dispatched ?? []), { owner, matter_id, at, issues: body.count }]
      }
      if (
        last !== undefined &&
        last.key === key &&
        Date.parse(now()) - Date.parse(last.at) < DISPATCH_QUIET_MS
      ) {
        add(last.matter_id, last.at)
        continue
      }
      try {
        const out = await options.handoff({
          owner,
          title:
            owner === 'site.shopify-theme'
              ? '网站技术体检：主题里要改的几处'
              : '网站技术体检：跳转、站点地图与死链',
          text: body.text,
          issues: body.count,
        })
        if (out === undefined) continue
        state.tech_dispatched = {
          ...(state.tech_dispatched ?? {}),
          [owner]: { key, at: now(), matter_id: out.matter_id },
        }
        add(out.matter_id, now())
      } catch {
        run.notes.push('技术体检的清单交给建站没成，清单在报表里')
      }
    }
  }

  /** 技术体检（在 WP381 那一轮里跑；读不到的写进 notes，永不抛）。 */
  const techAudit = async (
    run: SiteHealthRun,
    origin: string,
    host: string,
    robots: string | undefined,
    productUrls: readonly string[],
  ): Promise<void> => {
    try {
      const sitemap = await readSitemap(origin, robots)
      const collection = firstOf(sitemap.urls, COLLECTION)
      const article = firstOf(sitemap.urls, ARTICLE)
      const products =
        productUrls.length > 0
          ? productUrls.slice(0, 2)
          : sitemap.urls.filter((u) => PRODUCT.test(new URL(u).pathname)).slice(0, 2)
      const wanted: { kind: AuditPageKind; url: string }[] = [
        { kind: 'home', url: `${origin}/` },
        ...products.map((url) => ({ kind: 'product' as const, url })),
        ...(collection === undefined ? [] : [{ kind: 'collection' as const, url: collection }]),
        ...(article === undefined ? [] : [{ kind: 'article' as const, url: article }]),
      ]
      const pages: { kind: AuditPageKind; facts: PageSeoFacts }[] = []
      for (const w of wanted) pages.push({ kind: w.kind, facts: await factsOf(w.url) })
      const markets = options.markets?.() ?? 1
      // 多市场：首页 hreflang 指到的另几版也抓来（看互指）
      const home = pages[0]?.facts
      if (markets >= 2 && home !== undefined) {
        const alts = home.hreflang
          .filter((h) => h.lang.toLowerCase() !== 'x-default' && hostOf(h.href) === host)
          .map((h) => h.href)
          .filter((u) => u.replace(/\/+$/, '') !== home.url.replace(/\/+$/, ''))
        for (const u of [...new Set(alts)].slice(0, MAX_ALTERNATES))
          pages.push({ kind: 'page', facts: await factsOf(u) })
      }
      // 跳转：首页上的站内链接、站点地图抽查、指向别处的规范网址
      const traces = new Map<string, RedirectTrace>()
      const link_from = new Map<string, string>()
      const sample = sitemap.urls.filter((_, i) =>
        sitemap.urls.length <= SITEMAP_SAMPLE
          ? true
          : i % Math.ceil(sitemap.urls.length / SITEMAP_SAMPLE) === 0,
      )
      if (options.probe !== undefined) {
        const probe = options.probe
        const trace = async (u: string): Promise<void> => {
          if (traces.has(u)) return
          traces.set(u, await traceRedirects(u, probe, [host]))
        }
        for (const l of (home?.links ?? []).slice(0, MAX_LINKS)) {
          link_from.set(l, home?.url ?? origin)
          await trace(l)
        }
        for (const u of sample.slice(0, SITEMAP_SAMPLE)) await trace(u)
        for (const p of pages) {
          const c = p.facts.canonicals[0]
          if (c !== undefined && hostOf(c) === host && c !== p.facts.url) await trace(c)
        }
      }
      // 没给「不跟跳转」那一口（配置如此，不是读失败）：跳转与死链这次不查，不记成「没读到」
      // 速度：首页与第一件商品
      let speed: SpeedReading[] | undefined
      if (options.pageSpeed !== undefined) {
        speed = []
        for (const u of [`${origin}/`, ...products.slice(0, 1)]) {
          try {
            const reading = speedReadingOf(u, await options.pageSpeed(u))
            if (reading !== undefined) speed.push(reading)
          } catch {
            // 这一页没量到：照实留空
          }
        }
        if (speed.length === 0) run.notes.push('这次没量到页面速度')
      }
      let index: readonly SitePage[] | undefined
      try {
        index = await options.indexStatus?.()
      } catch {
        index = []
      }
      run.tech = await runTechAudit({
        origin,
        checked_at: now(),
        pages,
        index,
        sitemap,
        traces,
        link_from,
        sitemap_sample: options.probe === undefined ? [] : sample.slice(0, SITEMAP_SAMPLE),
        markets,
        speed,
        speed_enabled: options.pageSpeed !== undefined,
      })
      if (sitemap.state === 'unknown') run.notes.push('这次没读到站点地图')
      await handoffTech(run, run.tech)
    } catch {
      run.notes.push('这次技术体检没跑完')
    }
  }

  /* ── WP448：改版回归 ─────────────────────────────────────────────── */

  /** 回归要抓的那几页：存过就用存的（前后才比得上），缺哪类就补。 */
  const driftPages = async (origin: string): Promise<{ url: string; kind: DriftPageKind }[]> => {
    const have = state.drift_pages ?? []
    const kinds = new Set(have.map((p) => p.kind))
    if (kinds.has('home') && kinds.has('product') && have.length >= 4) return have
    let robots: string | undefined
    try {
      robots = await robotsOf(origin)
    } catch {
      robots = undefined
    }
    const sitemap = await readSitemap(origin, robots)
    const pick = (re: RegExp, n: number): string[] =>
      sitemap.urls
        .filter((u) => {
          try {
            return re.test(new URL(u).pathname)
          } catch {
            return false
          }
        })
        .slice(0, n)
    // 商品先用店里在卖的（站点地图里可能还挂着下架的），不够再从站点地图补
    const shop = await readProducts(2)
    const live =
      typeof shop === 'string'
        ? []
        : shop.products.map((p) => onSite(origin, p.url ?? `${origin}/products/${p.handle}`))
    const products = [
      ...new Set([...live, ...pick(PRODUCT, 2).map((u) => onSite(origin, u))]),
    ].slice(0, 2)
    const next: { url: string; kind: DriftPageKind }[] = [
      { url: `${origin}/`, kind: 'home' },
      ...products.map((url) => ({ url, kind: 'product' as const })),
      ...pick(COLLECTION, 1).map((url) => ({ url, kind: 'collection' as const })),
      ...pick(ARTICLE, 1).map((url) => ({ url, kind: 'article' as const })),
    ]
    state = { ...state, drift_pages: next }
    return next
  }

  const handoffDrift = async (r: DriftRun): Promise<void> => {
    const severe = r.findings.filter((f) => f.severity === 'critical')
    if (severe.length === 0 || options.handoff === undefined) return
    const key = severe
      .map((f) => `${f.rule}|${f.url}|${f.after ?? ''}`)
      .sort()
      .join('\n')
    const last = state.drift_dispatched
    if (
      last !== undefined &&
      last.key === key &&
      Date.parse(now()) - Date.parse(last.at) < DISPATCH_QUIET_MS
    ) {
      r.dispatched = { matter_id: last.matter_id, at: last.at }
      return
    }
    const which = r.trigger.label ?? DRIFT_TRIGGER_WORDS[r.trigger.kind]
    const text = [
      `${which}之后，改版回归发现 ${String(severe.length)} 处严重问题（搜索引擎会很快反应，越早改回越好）：`,
      ...severe.map((f, n) => `${String(n + 1)}. ${driftLine(f)}`),
      r.trigger.change_id === undefined
        ? ''
        : `是这一次改版带来的：改动卡 ${r.trigger.change_id}。`,
      '确认不是故意的就改回去（或撤回那次发布）；是故意的在这里说一声。',
    ]
      .filter((x) => x !== '')
      .join('\n')
    try {
      const out = await options.handoff({
        owner: 'site.shopify-build',
        title: `改版回归：${which}之后 ${String(severe.length)} 处要马上看`,
        text,
        issues: severe.length,
      })
      if (out === undefined) return
      state.drift_dispatched = { key, at: now(), matter_id: out.matter_id }
      r.dispatched = { matter_id: out.matter_id, at: now() }
    } catch {
      r.notes.push('交给建站没成，清单在面板「改版回归」里')
    }
  }

  const driftOnce = async (trigger: Omit<DriftTrigger, 'at'>): Promise<DriftRun> => {
    const at = now()
    const r: DriftRun = {
      id: options.newId('drift'),
      trigger: { ...trigger, at },
      started_at: at,
      status: 'ok',
      pages: 0,
      findings: [],
      notes: [],
    }
    const origin = (await options.origin().catch(() => undefined))?.replace(/\/+$/, '')
    if (origin === undefined || hostOf(origin) === undefined) {
      r.status = 'failed'
      r.notes.push('还不知道网站地址（公司档案里填网站）')
      r.finished_at = now()
      return keepDrift(r)
    }
    try {
      const list = await driftPages(origin)
      const current: DriftSnapshot[] = []
      for (const p of list) {
        const facts = await factsOf(p.url)
        current.push(driftSnapshotOf(facts, p.kind, now()))
      }
      r.pages = current.filter((c) => c.status !== 0).length
      const missed = current.filter((c) => c.status === 0).length
      if (missed > 0) r.notes.push(`${String(missed)} 页这次没抓到，没比`)
      const baseline = state.drift_baseline ?? []
      if (baseline.length === 0) r.status = 'baseline'
      else r.findings = compareDrift(baseline, current)
      // 新基线：这次抓到的替换掉旧的，没抓到的留旧的
      const got = new Map(current.filter((c) => c.status !== 0).map((c) => [c.url, c]))
      state = {
        ...state,
        drift_baseline: [
          ...baseline.filter((b) => !got.has(b.url) && list.some((p) => p.url === b.url)),
          ...got.values(),
        ],
      }
      if (r.notes.length > 0 && r.status === 'ok') r.status = 'partial'
      await handoffDrift(r)
    } catch {
      r.status = 'failed'
      r.notes.push('这次改版回归没跑完')
    }
    r.finished_at = now()
    const counts = driftCounts(r.findings)
    options.event?.('seo.drift_checked', {
      run_id: r.id,
      trigger: r.trigger.kind,
      ...(r.trigger.change_id === undefined ? {} : { change_id: r.trigger.change_id }),
      status: r.status,
      ...counts,
      ...(r.dispatched === undefined ? {} : { dispatched: r.dispatched.matter_id }),
    })
    return keepDrift(r)
  }

  const keepDrift = (r: DriftRun): DriftRun => {
    state = { ...state, drift_runs: [r, ...(state.drift_runs ?? [])].slice(0, KEEP_DRIFT_RUNS) }
    save()
    return r
  }

  let driftInflight: Promise<DriftRun> | undefined
  const drift = (trigger: Omit<DriftTrigger, 'at'>): Promise<DriftRun> => {
    if (driftInflight !== undefined) return driftInflight
    const p = driftOnce(trigger).finally(() => {
      if (driftInflight === p) driftInflight = undefined
    })
    driftInflight = p
    return p
  }

  const driftView = (): SeoDriftView => {
    const runs = state.drift_runs ?? []
    const last = runs[0]
    const withFindings = runs.find((x) => x.findings.length > 0)
    return {
      ...(last === undefined ? {} : { last }),
      ...(withFindings === undefined ? {} : { last_with_findings: withFindings }),
    }
  }

  const runOnce = async (): Promise<SiteHealthRun> => {
    const settings = state.settings
    const out: SiteHealthRun = {
      id: options.newId('shr'),
      started_at: now(),
      status: 'ok',
      robots: { state: 'unknown', crawler_list_version: AI_CRAWLER_LIST_VERSION },
      crawlers: [],
      render: 'off',
      raw_html: [],
      products: { checked: 0, issues: [], dating: [] },
      notes: [],
    }
    const origin = (await options.origin().catch(() => undefined))?.replace(/\/+$/, '')
    const host = origin === undefined ? undefined : hostOf(origin)
    if (origin === undefined || host === undefined) {
      out.status = 'failed'
      out.notes.push('还不知道网站地址（公司档案里填网站）')
      out.finished_at = now()
      return keep(out)
    }
    out.origin = origin

    // ② AI 爬虫
    const robots = await robotsOf(origin)
    out.robots.state = robots === undefined ? 'unknown' : robots === '' ? 'none' : 'found'
    if (robots === undefined) out.notes.push('这次没读到 robots.txt')

    // ① 商品与政策
    const sample = Math.min(MAX_SAMPLE, Math.max(1, settings.sample_products ?? DEFAULT_SAMPLE))
    const shop = await readProducts(
      sample,
      (settings.listings ?? []).map((l) => l.handle),
    )
    const products = typeof shop === 'string' ? [] : shop.products.filter((p) => p.handle !== '')
    if (typeof shop === 'string') out.notes.push(shop)
    const policies = await storePolicies(get, origin)
    const store: StoreTruth = {
      currency: (typeof shop === 'string' ? undefined : shop.shop.currency) ?? 'USD',
      ...(typeof shop === 'string' || shop.shop.name === undefined ? {} : { name: shop.shop.name }),
      ...policies.truth,
    }
    const urlOf = (p: ProductTruth): string => p.url ?? `${origin}/products/${p.handle}`
    const productPaths = products.slice(0, 2).map((p) => new URL(urlOf(p)).pathname)
    out.crawlers = checkAiCrawlers({
      origin,
      robots,
      crawlers: effectiveCrawlers(settings),
      paths: ['/', ...productPaths, '/collections/', '/policies/refund-policy'],
    })

    // 原始 HTML（每件商品一页 + 退货政策页），渲染对比
    const raws = new Map<string, string | undefined>()
    for (const p of products) raws.set(urlOf(p), await get(urlOf(p)))
    const renderUrls = [
      ...raws.keys(),
      ...(policies.refundHtml === undefined ? [] : [policies.refundUrl]),
    ]
    const rendered = await renderAll(renderUrls, host)
    out.render = rendered.state
    const raw_html: RawHtmlFactCheck[] = []
    for (const p of products) {
      const url = urlOf(p)
      const inStock = p.variants.some((v) => v.available === true)
      const priced = p.variants.find((v) => v.available === true) ?? p.variants[0]
      const sp = sellingPointExpectation(p.description)
      const ex: FactExpectation[] = [
        ...(priced === undefined ? [] : [priceExpectation(priced.price)]),
        ...(p.variants.some((v) => v.available !== undefined)
          ? [availabilityExpectation(inStock)]
          : []),
        ...(sp === undefined ? [] : [sp]),
        ...(store.return_days === undefined ? [] : [returnDaysExpectation(store.return_days)]),
      ]
      const r = rendered.pages.get(url)
      raw_html.push(
        ...compareRawRendered({
          url,
          page: 'product',
          raw: raws.get(url),
          ...(r === undefined ? {} : { rendered: r }),
          expectations: ex,
        }),
      )
    }
    if (policies.refundHtml !== undefined && store.return_days !== undefined) {
      const r = rendered.pages.get(policies.refundUrl)
      raw_html.push(
        ...compareRawRendered({
          url: policies.refundUrl,
          page: 'policy',
          raw: policies.refundHtml,
          ...(r === undefined ? {} : { rendered: r }),
          expectations: [returnDaysExpectation(store.return_days)],
        }),
      )
    }
    out.raw_html = raw_html

    // 几处来源逐件比
    const feedXml =
      settings.feed_url === undefined ? undefined : await getForeign(settings.feed_url)
    if (settings.feed_url !== undefined && feedXml === undefined)
      out.notes.push('这次没读到商品 feed')
    const feed = feedXml === undefined ? undefined : parseMerchantFeed(feedXml)
    const rows: { product: ProductTruth; sources: SourceSnapshot[] }[] = []
    for (const p of products) {
      const url = urlOf(p)
      const raw = raws.get(url)
      const sources: SourceSnapshot[] = [
        pageSnapshot(rendered.pages.get(url) ?? raw),
        raw === undefined ? { source: 'jsonld', read: false, offers: [] } : jsonLdSnapshot(raw),
      ]
      const js = await get(`${origin}/products/${p.handle}.js`)
      if (js !== undefined) sources.push(shopifyProductJsSnapshot(js))
      if (feed !== undefined) sources.push(feedSnapshotFor(feed, p))
      for (const l of (settings.listings ?? []).filter((x) => x.handle === p.handle)) {
        const html = await getForeign(l.url)
        if (html === undefined) out.notes.push(`这次没读到 ${l.platform} 上架页`)
        else sources.push(jsonLdSnapshot(html, 'platform', l.platform))
      }
      rows.push({ product: p, sources })
    }
    const facts = checkProductFacts(rows, store, now().slice(0, 10))
    out.products = { checked: products.length, issues: facts.issues, dating: facts.dating }
    if (products.length > 0) out.chatgpt_shopping = assessChatGptShopping(products, store)

    // WP448：技术体检（同一轮）
    await techAudit(
      out,
      origin,
      host,
      robots,
      products.map((p) => onSite(origin, urlOf(p))),
    )

    if (out.notes.length > 0) out.status = 'partial'
    await dispatchIfNew(out)
    out.finished_at = now()
    options.event?.('site_health.checked', {
      run_id: out.id,
      status: out.status,
      crawlers_blocked: out.crawlers.filter((c) => c.state === 'blocked' || c.state === 'partial')
        .length,
      js_only: out.raw_html.filter((r) => r.verdict === 'js_only').length,
      product_issues: out.products.issues.length,
      render: out.render,
      ...(out.dispatched === undefined ? {} : { dispatched: out.dispatched.matter_id }),
      ...(out.tech === undefined
        ? {}
        : {
            tech_issues: out.tech.issues.length,
            tech_dispatched: (out.tech.dispatched ?? []).map((d) => d.matter_id),
          }),
    })
    return keep(out)
  }

  /** WP385：同一时间只跑一次（报表上点、改完设置、周一那一轮可能前后脚到）。 */
  let inflight: Promise<SiteHealthRun> | undefined
  const run = (): Promise<SiteHealthRun> => {
    if (inflight !== undefined) return inflight
    const p = runOnce().finally(() => {
      if (inflight === p) inflight = undefined
    })
    inflight = p
    return p
  }

  const keep = (r: SiteHealthRun): SiteHealthRun => {
    state = { ...state, runs: [r, ...state.runs].slice(0, KEEP_RUNS) }
    save()
    return r
  }

  const aiTraffic = async (): Promise<AiTrafficSummary | undefined> => {
    const until = now()
    const since = new Date(Date.parse(until) - TRAFFIC_DAYS * 86_400_000).toISOString()
    // 多读前一段同样长的窗口（算周变化）
    const from = new Date(Date.parse(until) - 2 * TRAFFIC_DAYS * 86_400_000).toISOString()
    const list = effectiveReferrers(state.settings)
    let reader: ShopifyAdminReader | undefined
    try {
      reader = await options.shop()
    } catch {
      reader = undefined
    }
    let orders: TrafficOrder[] | undefined
    let currency: string | undefined
    if (reader !== undefined) {
      try {
        const got: TrafficOrder[] = []
        let after: string | undefined
        for (let page = 0; page < ORDER_PAGES; page += 1) {
          const data = await reader.query<unknown>({
            name: 'ai_traffic_orders',
            document: AI_TRAFFIC_ORDERS,
            variables: {
              first: ORDER_PAGE,
              query: `created_at:>='${from}'`,
              ...(after === undefined ? {} : { after }),
            },
          })
          const one = trafficOrdersOf(data)
          currency ??= one.currency
          got.push(...one.orders)
          after = one.next
          if (after === undefined) break
        }
        orders = got
      } catch {
        orders = undefined
      }
    }
    orders ??= options.fallbackOrders?.()
    if (orders === undefined) return undefined
    // 会话：授权里有「店铺报表」才问
    let sessions: TrafficSessions[] | undefined
    let visits: AiTrafficSummary['visits'] = 'no_scope'
    const scopes = await options.scopes?.().catch(() => undefined)
    if (reader !== undefined && scopes?.includes('read_reports') === true) {
      try {
        sessions = trafficSessionsOf(
          await reader.query<unknown>({
            name: 'ai_traffic_sessions',
            document: aiTrafficSessionsDoc(TRAFFIC_DAYS),
          }),
        )
        visits = sessions === undefined ? 'unavailable' : 'ok'
      } catch {
        visits = 'unavailable'
      }
    }
    const summary = summarizeAiTraffic({
      orders,
      ...(sessions === undefined ? {} : { sessions }),
      visits_state: visits,
      since,
      until,
      currency: currency ?? orders[0]?.currency ?? 'USD',
      now: until,
      list,
      previous: { since: from, until: since },
    })
    state = { ...state, traffic: summary }
    save()
    options.event?.('site_health.ai_traffic', {
      orders: summary.total_orders,
      ai_orders: summary.ai_orders,
      visits: summary.visits,
    })
    return summary
  }

  return {
    latest: () => state.runs[0],
    runs: () => [...state.runs],
    settings: () => state.settings,
    saveSettings: (next) => {
      state = { ...state, settings: next }
      save()
      return next
    },
    run,
    running: () => inflight,
    aiTraffic,
    lastTraffic: () => state.traffic,
    deckData: () => {
      const d = driftView()
      return {
        ...(state.runs[0] === undefined ? {} : { run: state.runs[0] }),
        ...(state.traffic === undefined ? {} : { ai_traffic: state.traffic }),
        ...(d.last === undefined ? {} : { drift: d }),
      }
    },
    drift,
    driftView,
    async appsSeen(ids) {
      const next = [...new Set(ids)].sort()
      const before = state.apps_seen
      state = { ...state, apps_seen: next }
      save()
      if (before === undefined) return undefined
      const added = next.filter((x) => !before.includes(x))
      const removed = before.filter((x) => !next.includes(x))
      if (added.length === 0 && removed.length === 0) return undefined
      const label = [
        added.length === 0 ? '' : `装了 ${added.join('、')}`,
        removed.length === 0 ? '' : `卸了 ${removed.join('、')}`,
      ]
        .filter((x) => x !== '')
        .join('，')
      return drift({ kind: 'app_change', label })
    },
  }
}

/** 改版回归是谁引起的（没写人话时用这几句）。 */
const DRIFT_TRIGGER_WORDS: Record<DriftTrigger['kind'], string> = {
  theme_publish: '主题发布',
  app_change: 'App 装卸',
  weekly: '例行检查',
  manual: '手动',
}

/** 面板那份订单（连接器拉的）→ 来源流量要的样子（只有金额、时间、来源网址、落地页）。 */
export function trafficOrdersFromRows(
  rows: readonly {
    total_price: number
    full_total_price?: number
    currency: string
    created_at: string
    referring_site?: string
    landing_site?: string
  }[],
): TrafficOrder[] {
  return rows.map((o) => {
    const visit = {
      ...(o.referring_site === undefined ? {} : { referrer_url: o.referring_site }),
      ...(o.landing_site === undefined ? {} : { landing_page: o.landing_site }),
    }
    return {
      total: o.full_total_price ?? o.total_price,
      currency: o.currency,
      created_at: o.created_at,
      ...(Object.keys(visit).length === 0 ? {} : { first: visit }),
    }
  })
}
