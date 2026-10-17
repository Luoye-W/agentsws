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
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchPage, fetchRobots, isDisallowed, type PageFetch } from '@agentsws/brand-intake'
import type {
  AiTrafficSummary,
  Clock,
  RawHtmlFactCheck,
  SiteHealthRun,
  SiteHealthSettings,
} from '@agentsws/contracts'
import {
  effectiveReferrers,
  summarizeAiTraffic,
  type TrafficOrder,
  type TrafficSessions,
} from '@agentsws/seo-core'
import {
  AI_CRAWLER_LIST_VERSION,
  assessChatGptShopping,
  availabilityExpectation,
  checkAiCrawlers,
  checkProductFacts,
  compareRawRendered,
  effectiveCrawlers,
  type FactExpectation,
  feedSnapshotFor,
  freeShippingOverIn,
  issueLine,
  jsonLdSnapshot,
  type ProductTruth,
  pageSnapshot,
  parseMerchantFeed,
  priceExpectation,
  returnDaysExpectation,
  returnDaysIn,
  type SourceSnapshot,
  type StoreTruth,
  sellingPointExpectation,
  shopifyProductJsSnapshot,
} from '@agentsws/site-core'
import type { ShopifyAdminReader } from './shop-admin.js'
import {
  AI_TRAFFIC_ORDERS,
  aiTrafficSessionsDoc,
  HEALTH_PRODUCTS,
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
}

interface Persisted {
  settings: SiteHealthSettings
  runs: SiteHealthRun[]
  traffic?: AiTrafficSummary
  /** 上次派出去的那份清单（去重用）。 */
  dispatched?: { key: string; at: string; matter_id: string }
}

const KEEP_RUNS = 10
const DISPATCH_QUIET_MS = 7 * 86_400_000
const DEFAULT_SAMPLE = 5
const MAX_SAMPLE = 20
const TRAFFIC_DAYS = 7
const ORDER_PAGE = 100
const ORDER_PAGES = 4

export interface SiteHealthService {
  latest(): SiteHealthRun | undefined
  runs(): SiteHealthRun[]
  settings(): SiteHealthSettings
  saveSettings(next: SiteHealthSettings): SiteHealthSettings
  /** 跑一次体检（永不抛：读不到的写进 `notes`）。 */
  run(): Promise<SiteHealthRun>
  /** 算近 7 天 AI 来源流量（读不到店回 `undefined`）。 */
  aiTraffic(): Promise<AiTrafficSummary | undefined>
  /** 上一次算的 AI 来源流量（面板读它，不现算）。 */
  lastTraffic(): AiTrafficSummary | undefined
  deckData(): { run?: SiteHealthRun; ai_traffic?: AiTrafficSummary }
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

  /** 读店铺商品（没授权 / 读不到回 `undefined` 与一句人话）。 */
  const readProducts = async (
    sample: number,
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
      return healthProductsOf(data)
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

  const run = async (): Promise<SiteHealthRun> => {
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
    const shop = await readProducts(sample)
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
    })
    return keep(out)
  }

  const keep = (r: SiteHealthRun): SiteHealthRun => {
    state = { ...state, runs: [r, ...state.runs].slice(0, KEEP_RUNS) }
    save()
    return r
  }

  const aiTraffic = async (): Promise<AiTrafficSummary | undefined> => {
    const until = now()
    const since = new Date(Date.parse(until) - TRAFFIC_DAYS * 86_400_000).toISOString()
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
              query: `created_at:>='${since}'`,
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
    aiTraffic,
    lastTraffic: () => state.traffic,
    deckData: () => ({
      ...(state.runs[0] === undefined ? {} : { run: state.runs[0] }),
      ...(state.traffic === undefined ? {} : { ai_traffic: state.traffic }),
    }),
  }
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
