/**
 * WP393（docs/104 一期 A）：**探平台** + **读竞品独立站的公开商品目录**（读的那一口注入，测试塞录好的样本）。
 *
 * 走哪条路（docs/104 §3.6；WP402 决策 1140 / 1146 改成一条取数链，规矩在 `read-chain.ts`）：
 * 1. **先本机直接请求**（UA 认得出是我们，不带任何凭据）；
 * 2. 被挡（401 / 403 / 430、或回 200 但其实是一张「验证你是不是机器人」的页）→ 改用**工坊内置浏览器**
 *    打开同一个地址读（`browser`，桌面壳那一侧）；这一次读剩下的页都走它；
 * 3. WP402：还被挡 → **工坊云端代读**同一个公开数据地址（`cloud`，按次扣积分）→ 再不行 → 通过插件在**用户自己的浏览器**
 *    里读（`extension`，只读）；429 限速先退避再试同一条，还是 429 才换；
 * 4. 都不行就照实说，下一轮再试；**不伪装、不绕**。
 *
 * 翻页中途断了（某一页被挡 / 打不开 / 这一小时的额度满了）→ 已读到的照样交回、标「没读全」
 * （WP392 的对比引擎据此整次不判下架）。每读一页（含 robots、all.atom）都经 `page` 那一口
 * 算进内置浏览器每小时 ≤60 页的额度（决策 914）。
 *
 * 探平台时先看 robots：店里明说不让程序读的那个地址，一页都不读。
 */
import type { ReadRoute, ReadRouteAttempt, StoreProbeResult } from '@agentsws/contracts'
import {
  failureKindOf,
  isBotChallengePage,
  isDisallowed,
  type PageFetch,
  parseRobotsDisallow,
} from './fetch.js'
import { type ChainRoute, type ChainStep, createReadChain, type ReadChain } from './read-chain.js'
import {
  type CatalogPage,
  type CatalogRowDraft,
  parseShopifyAtom,
  parseShopifyProductsPage,
  parseWooProductsPage,
} from './shop-catalog-parse.js'

/** 直接请求时的 UA（认得出是我们；被站长封是他的权利，但他得先知道要封谁）。 */
export const COMPETITOR_WATCH_USER_AGENT =
  'agentsws-competitor-watch/1.0 (+https://github.com/Luoye-W/agentsws)'

export const SHOPIFY_PAGE_SIZE = 250
export const WOO_PAGE_SIZE = 100
/** 一家最多读几页（Shopify 250 件一页 → 1 万件；再多只读前面这些、标「没读全」）。 */
export const CATALOG_MAX_PAGES = 40
export const CATALOG_TIMEOUT_MS = 20_000

/** 工坊内置浏览器读一个地址的原文（桌面壳那一侧；没有桌面壳 = 不给）。 */
export type BrowserTextRead = (url: string) => Promise<
  | {
      ok: true
      /** 主文档的 HTTP 状态码（拿不到 0）。 */
      status: number
      final_url: string
      text: string
      truncated?: boolean
      /** 页面上有人机验证。 */
      challenge?: boolean
    }
  | { ok: false; message: string }
>

export interface ShopCatalogIo {
  /** 本机直接请求（跟跳转；`url` 回落点）。 */
  fetch: PageFetch
  /** 被挡时改用的内置浏览器（没有 = 这条路跳过）。 */
  browser?: BrowserTextRead
  /**
   * WP402（决策 1140 / 1146）：内置浏览器也被挡时，工坊云端代读同一个公开数据地址（按次扣积分；没关联账号 = 不给）。
   * 读回来的形状和内置浏览器一样。
   */
  cloud?: BrowserTextRead
  /** WP402：再不行，通过插件在用户自己的浏览器里读（只读：打开、读回原文；没装插件 = 不给）。 */
  extension?: BrowserTextRead
  /** 每读一页都经它（每小时额度）；满了回 `undefined`（这一页不读）。不给 = 不限。 */
  page?<T>(task: () => Promise<T>): Promise<T | undefined>
  timeoutMs?: number
  /** 429 退避的等待（测试塞假的）。 */
  sleep?(ms: number): Promise<void>
}

type Via = ReadRoute

type GetOutcome =
  | { ok: true; text: string; status: number; final_url?: string; via: Via }
  | {
      ok: false
      kind: 'blocked' | 'not_found' | 'unreachable' | 'quota'
      status?: number
      reason: string
    }

interface Fetched {
  text: string
  status: number
  final_url?: string
}

const BLOCKED = new Set([401, 403, 430])

const sayBlocked = (status: number | undefined): string =>
  status === 429
    ? '对方在限流（429）'
    : status === 430
      ? '对方的机器人防护拦了（430）'
      : status === undefined || status === 0 || status === 200
        ? '对方要人点一下验证'
        : `对方拒绝了（${String(status)}）`

/** 这一次读用的取数链（被挡一次就换下一条路，之后这一次都走它）。 */
type ReadState = ReadChain<{ url: string; accept: string }, Fetched>

const run = async <T>(io: ShopCatalogIo, task: () => Promise<T>): Promise<T | undefined> =>
  io.page === undefined ? task() : io.page(task)

const QUOTA_STEP = {
  ok: false,
  kind: 'quota',
  reason: '这一小时读的页数到上限了，下一轮再读',
} as const

async function direct(io: ShopCatalogIo, url: string, accept: string): Promise<ChainStep<Fetched>> {
  const got = await run(io, async (): Promise<ChainStep<Fetched>> => {
    try {
      const res = await io.fetch(url, {
        method: 'GET',
        headers: { 'user-agent': COMPETITOR_WATCH_USER_AGENT, accept },
        signal: AbortSignal.timeout(io.timeoutMs ?? CATALOG_TIMEOUT_MS),
      })
      const final = typeof res.url === 'string' && res.url !== '' ? { final_url: res.url } : {}
      if (res.status === 429) return { ok: false, kind: 'rate_limited', reason: sayBlocked(429) }
      if (BLOCKED.has(res.status))
        return { ok: false, kind: 'blocked', reason: sayBlocked(res.status) }
      if (!res.ok)
        return { ok: false, kind: 'not_found', reason: `没取到（${String(res.status)}）` }
      const text = await res.text()
      if (isBotChallengePage(text))
        return { ok: false, kind: 'blocked', reason: sayBlocked(undefined) }
      return { ok: true, value: { text, status: res.status, ...final } }
    } catch (err) {
      const kind = failureKindOf(err)
      return {
        ok: false,
        kind: 'unreachable',
        reason:
          kind === 'timeout' ? '等太久了' : kind === 'dns' ? '找不到这个域名' : '连不上这个网站',
      }
    }
  })
  return got ?? QUOTA_STEP
}

/** 内置浏览器 / 云端代读 / 用户自己的浏览器：三条路读回来的形状一样，判法也一样。 */
async function viaReader(
  io: ShopCatalogIo,
  read: BrowserTextRead | undefined,
  who: string,
  url: string,
): Promise<ChainStep<Fetched>> {
  if (read === undefined) return { ok: false, kind: 'unavailable', reason: `没有${who}可以换` }
  const got = await run(io, async (): Promise<ChainStep<Fetched>> => {
    const r = await read(url).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }))
    if (!r.ok) return { ok: false, kind: 'failed', reason: `${who}没读到：${r.message}` }
    if (r.status === 429)
      return { ok: false, kind: 'rate_limited', reason: `${who}里对方在限流（429）` }
    if (r.challenge === true || BLOCKED.has(r.status) || isBotChallengePage(r.text))
      return { ok: false, kind: 'blocked', reason: `${who}里也被挡了（${sayBlocked(r.status)}）` }
    if (r.status >= 400)
      return { ok: false, kind: 'not_found', reason: `没取到（${String(r.status)}）` }
    if (r.truncated === true)
      return { ok: false, kind: 'failed', reason: `这一页太大，${who}只读到一部分` }
    return { ok: true, value: { text: r.text, status: r.status, final_url: r.final_url } }
  })
  return got ?? QUOTA_STEP
}

/** 这一次读的取数链：直接请求 → 内置浏览器 → 工坊云端 → 你自己的浏览器（没有的那条路跳过）。 */
function chainOf(io: ShopCatalogIo): ReadState {
  type In = { url: string; accept: string }
  const routes: ChainRoute<In, Fetched>[] = [
    { route: 'direct', read: (i) => direct(io, i.url, i.accept) },
  ]
  if (io.browser !== undefined)
    routes.push({
      route: 'browser',
      read: (i) => viaReader(io, io.browser, '工坊内置浏览器', i.url),
    })
  if (io.cloud !== undefined)
    routes.push({ route: 'cloud', read: (i) => viaReader(io, io.cloud, '工坊云端', i.url) })
  if (io.extension !== undefined)
    routes.push({
      route: 'extension',
      read: (i) => viaReader(io, io.extension, '你自己的浏览器', i.url),
    })
  return createReadChain(routes, io.sleep === undefined ? {} : { sleep: io.sleep })
}

/** 读一个地址：先直接请求，被挡就换下一条路（这一次之后都走它）；都不行照实说。 */
async function get(
  _io: ShopCatalogIo,
  state: ReadState,
  url: string,
  accept: string,
): Promise<GetOutcome> {
  const r = await state.read({ url, accept })
  if (r.ok) return { ok: true, ...r.value, via: r.via }
  const kind =
    r.kind === 'not_found' || r.kind === 'unreachable' || r.kind === 'quota' ? r.kind : 'blocked'
  return { ok: false, kind, reason: r.reason }
}

/** 这一次走的是哪条路（读成过就是那条；一页都没读成 = 最后粘住的那条）。 */
const viaOf = (state: ReadState): Via => state.via() ?? state.route() ?? 'direct'

/** 这一次换过路的那一句（给连接卡 / 简报）。 */
const ROUTE_NOTE: Partial<Record<Via, string>> = {
  browser: '对方挡了直接读，改用工坊内置浏览器读的',
  cloud: '直接读和内置浏览器都被挡了，改由工坊云端读的（按次扣积分）',
  extension: '前几条路都没读到，通过插件在你自己的浏览器里读的',
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i

/** 用户 / AI 给的官网 → 店铺首页（只留 `https://host`）；不像个公开网址回 `undefined`。 */
export function normalizeStoreUrl(raw: string): string | undefined {
  const t = raw.trim()
  if (t === '') return undefined
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  if (u.username !== '' || u.password !== '') return undefined
  if (!u.hostname.includes('.') || PRIVATE_HOST.test(u.hostname)) return undefined
  return `${u.protocol}//${u.host}`.toLowerCase()
}

const originOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return undefined
  }
}

const JSON_ACCEPT = 'application/json'
const shopifyProbe = (o: string) => `${o}/products.json?limit=1`
const wooProbe = (o: string) => `${o}/wp-json/wc/store/v1/products?per_page=1`

/** robots 里不让读的路径（读不到 = 没有规则）。 */
async function robotsOf(io: ShopCatalogIo, origin: string): Promise<string[]> {
  const r = await direct(io, `${origin}/robots.txt`, 'text/plain')
  return r.ok ? parseRobotsDisallow(r.value.text) : []
}

type Attempt =
  | { found: true; origin: string; via: Via }
  | { found: false; kind?: 'blocked' | 'unreachable' | 'quota'; reason?: string; moved?: string }

async function attempt(
  io: ShopCatalogIo,
  state: ReadState,
  url: string,
  origin: string,
  parse: (text: string, origin: string) => CatalogPage | undefined,
): Promise<Attempt> {
  const r = await get(io, state, url, JSON_ACCEPT)
  if (!r.ok)
    return r.kind === 'blocked' || r.kind === 'unreachable' || r.kind === 'quota'
      ? { found: false, kind: r.kind, reason: r.reason }
      : { found: false }
  const landed = originOf(r.final_url) ?? origin
  if (parse(r.text, landed) !== undefined) return { found: true, origin: landed, via: r.via }
  // 跳到了另一个域名、还丢了路径（`engwe-bikes.com` → `us.engwe.com/`）：交回新域名再试一次
  return landed !== origin ? { found: false, moved: landed } : { found: false }
}

/**
 * 探平台：读一下 `/products.json?limit=1`（Shopify）和 `/wp-json/wc/store/v1/products?per_page=1`（WooCommerce），
 * 能读就定下来；都不是 = `other`（照实说「这家网站暂时读不了商品数据」）。地址按跳转后的存。
 */
export async function probeStore(
  io: ShopCatalogIo,
  rawUrl: string,
  now: string,
): Promise<StoreProbeResult> {
  const start = normalizeStoreUrl(rawUrl)
  if (start === undefined)
    return {
      url: rawUrl.trim(),
      platform: 'unknown',
      route: 'unreachable',
      reason: '这不像一个网站地址',
      checked_at: now,
    }
  const state = chainOf(io)
  let origin = start
  let blocked: string | undefined
  let unreachable: string | undefined
  let robotsSaidNo = false
  for (let hop = 0; hop < 2; hop += 1) {
    const disallow = await robotsOf(io, origin)
    let moved: string | undefined
    for (const [path, url, parse, platform] of [
      ['/products.json', shopifyProbe(origin), parseShopifyProductsPage, 'shopify'],
      ['/wp-json/wc/store/v1/products', wooProbe(origin), parseWooProductsPage, 'woocommerce'],
    ] as const) {
      if (isDisallowed(path, disallow)) {
        robotsSaidNo = true
        continue
      }
      const a = await attempt(io, state, url, origin, parse)
      if (a.found)
        return {
          url: a.origin,
          platform,
          route: a.via,
          via: a.via,
          checked_at: now,
        }
      if (a.kind === 'blocked' || a.kind === 'quota') blocked ??= a.reason
      if (a.kind === 'unreachable') unreachable ??= a.reason
      if (a.moved !== undefined) moved ??= a.moved
      // 打不开这个网站：WooCommerce 那个地址也不用试了
      if (a.kind === 'unreachable') break
    }
    if (moved === undefined || moved === origin) break
    origin = moved
  }
  if (blocked !== undefined)
    return {
      url: origin,
      platform: 'unknown',
      route: 'blocked',
      ...(state.route() === undefined || state.route() === 'direct'
        ? {}
        : { via: state.route() as Via }),
      reason: blocked,
      checked_at: now,
    }
  if (unreachable !== undefined)
    return {
      url: origin,
      platform: 'unknown',
      route: 'unreachable',
      reason: unreachable,
      checked_at: now,
    }
  return {
    url: origin,
    platform: 'other',
    route: 'unsupported',
    reason: robotsSaidNo
      ? '这家网站的 robots 规则不让程序读商品数据'
      : '这家网站暂时读不了商品数据',
    checked_at: now,
  }
}

/** 读一次的结果（来源 id / 竞品 id / 读到的时间由 WP392 那条管道的进料口补上）。 */
export interface ShopCatalogRead {
  rows: CatalogRowDraft[]
  /** 读全了没有（翻页断了 = `false`：那一次不判下架）。 */
  complete: boolean
  via: Via
  /** 一行都没读到的那一句人话（有它 = 这次没读成）。 */
  error?: string
  /** 给连接卡 / 简报的几句（`第 2 页没读到`、`改用工坊内置浏览器读的`）。 */
  notes: string[]
  /** 这一次读了几页（含 all.atom）。 */
  pages: number
  /** WP402：取数链上试过的路（连接卡 / 报告用）。 */
  attempts?: ReadRouteAttempt[]
}

/** 按页把一家店读全（Shopify / WooCommerce 同一个循环）。 */
async function readPaged(
  io: ShopCatalogIo,
  state: ReadState,
  pageUrl: (n: number) => string,
  parse: (text: string) => CatalogPage | undefined,
  pageSize: number,
  maxPages: number,
): Promise<{
  rows: CatalogRowDraft[]
  complete: boolean
  error?: string
  notes: string[]
  pages: number
  currency?: string
}> {
  const rows: CatalogRowDraft[] = []
  const notes: string[] = []
  let currency: string | undefined
  for (let n = 1; n <= maxPages; n += 1) {
    const r = await get(io, state, pageUrl(n), JSON_ACCEPT)
    const page = r.ok ? parse(r.text) : undefined
    if (page === undefined) {
      const why = r.ok ? '读回来的不是商品数据' : r.reason
      if (n === 1) return { rows, complete: false, error: why, notes, pages: n }
      notes.push(`第 ${n} 页没读到（${why}），这次不判下架`)
      return {
        rows,
        complete: false,
        notes,
        pages: n,
        ...(currency === undefined ? {} : { currency }),
      }
    }
    rows.push(...page.rows)
    currency ??= page.currency
    if (page.products < pageSize)
      return {
        rows,
        complete: true,
        notes,
        pages: n,
        ...(currency === undefined ? {} : { currency }),
      }
  }
  notes.push(`商品太多，只读了前 ${maxPages} 页`)
  return {
    rows,
    complete: false,
    notes,
    pages: maxPages,
    ...(currency === undefined ? {} : { currency }),
  }
}

/**
 * 读一家竞品独立站的公开商品目录。`platform` 是 `unknown` 就先探一次；`other` 照实说读不了（不发请求）。
 */
export async function readShopCatalog(
  io: ShopCatalogIo,
  input: {
    url: string
    platform: 'shopify' | 'woocommerce' | 'other' | 'unknown'
    now: string
    pageSize?: number
    maxPages?: number
  },
): Promise<ShopCatalogRead> {
  const origin = normalizeStoreUrl(input.url)
  if (origin === undefined)
    return { rows: [], complete: false, via: 'direct', error: '店铺地址不对', notes: [], pages: 0 }
  let platform = input.platform
  let base = origin
  if (platform === 'other')
    return {
      rows: [],
      complete: false,
      via: 'direct',
      error: '这家网站暂时读不了商品数据',
      notes: [],
      pages: 0,
    }
  if (platform === 'unknown') {
    const p = await probeStore(io, origin, input.now)
    if (p.platform !== 'shopify' && p.platform !== 'woocommerce')
      return {
        rows: [],
        complete: false,
        via: p.via ?? 'direct',
        error: p.reason ?? '这家网站暂时读不了商品数据',
        notes: [],
        pages: 0,
      }
    platform = p.platform
    base = p.url
  }
  const state = chainOf(io)
  const maxPages = input.maxPages ?? CATALOG_MAX_PAGES
  if (platform === 'woocommerce') {
    const size = input.pageSize ?? WOO_PAGE_SIZE
    const r = await readPaged(
      io,
      state,
      (n) => `${base}/wp-json/wc/store/v1/products?per_page=${size}&page=${n}`,
      parseWooProductsPage,
      size,
      maxPages,
    )
    const note = ROUTE_NOTE[viaOf(state)]
    if (note !== undefined) r.notes.unshift(note)
    return { ...r, via: viaOf(state), attempts: state.attempts() }
  }
  const size = input.pageSize ?? SHOPIFY_PAGE_SIZE
  const r = await readPaged(
    io,
    state,
    (n) => `${base}/products.json?limit=${size}&page=${n}`,
    (t) => parseShopifyProductsPage(t, base),
    size,
    maxPages,
  )
  let pages = r.pages
  let currency = r.currency
  // all.atom：最新上架的 25 件——补上 products.json 里没有的那几件（翻页断了时尤其要它）
  if (r.error === undefined) {
    const atom = await get(io, state, `${base}/collections/all.atom`, 'application/atom+xml')
    pages += 1
    const entries = atom.ok ? parseShopifyAtom(atom.text) : undefined
    if (entries === undefined) r.notes.push('最新上架那份没读到，上新只看商品列表')
    else {
      const have = new Set(r.rows.map((x) => x.product_key))
      const handles = new Set(
        r.rows.map((x) =>
          x.url === undefined ? '' : (/\/products\/([^/?#]+)/.exec(x.url)?.[1] ?? ''),
        ),
      )
      currency ??= entries.find((e) => e.currency !== undefined)?.currency
      for (const e of entries) {
        if (have.has(e.product_key) || (e.handle !== undefined && handles.has(e.handle))) continue
        r.rows.push({
          product_key: e.product_key,
          title: e.title,
          ...(e.url === undefined ? {} : { url: e.url }),
          ...(e.price === undefined ? {} : { price: e.price }),
          ...(e.currency === undefined ? {} : { currency: e.currency }),
          ...(e.published === undefined ? {} : { product_created_at: e.published }),
        })
        have.add(e.product_key)
      }
    }
  }
  const rows =
    currency === undefined
      ? r.rows
      : r.rows.map((x) => (x.currency === undefined ? { ...x, currency } : x))
  const note = ROUTE_NOTE[viaOf(state)]
  if (note !== undefined) r.notes.unshift(note)
  return {
    rows,
    complete: r.complete,
    via: viaOf(state),
    attempts: state.attempts(),
    ...(r.error === undefined ? {} : { error: r.error }),
    notes: r.notes,
    pages,
  }
}
