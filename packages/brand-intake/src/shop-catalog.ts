/**
 * WP393（docs/104 一期 A）：**探平台** + **读竞品独立站的公开商品目录**（读的那一口注入，测试塞录好的样本）。
 *
 * 走哪条路（docs/104 §3.6）：
 * 1. **先本机直接请求**（UA 认得出是我们，不带任何凭据）；
 * 2. 被挡（401 / 403 / 429 / 430、或回 200 但其实是一张「验证你是不是机器人」的页）→ 改用**工坊内置浏览器**
 *    打开同一个地址读（`browser`，桌面壳那一侧）；这一次读剩下的页都走它；
 * 3. 还读不到就照实说，**不重试、不绕**。
 *
 * 翻页中途断了（某一页被挡 / 打不开 / 这一小时的额度满了）→ 已读到的照样交回、标「没读全」
 * （WP392 的对比引擎据此整次不判下架）。每读一页（含 robots、all.atom）都经 `page` 那一口
 * 算进内置浏览器每小时 ≤60 页的额度（决策 914）。
 *
 * 探平台时先看 robots：店里明说不让程序读的那个地址，一页都不读。
 */
import type { StoreProbeResult } from '@agentsws/contracts'
import {
  failureKindOf,
  isBotChallengePage,
  isDisallowed,
  type PageFetch,
  parseRobotsDisallow,
} from './fetch.js'
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
  /** 被挡时改用的内置浏览器（没有 = 被挡就照实说）。 */
  browser?: BrowserTextRead
  /** 每读一页都经它（每小时额度）；满了回 `undefined`（这一页不读）。不给 = 不限。 */
  page?<T>(task: () => Promise<T>): Promise<T | undefined>
  timeoutMs?: number
}

type Via = 'direct' | 'browser'

type GetOutcome =
  | { ok: true; text: string; status: number; final_url?: string; via: Via }
  | {
      ok: false
      kind: 'blocked' | 'not_found' | 'unreachable' | 'quota' | 'truncated'
      status?: number
      reason: string
    }

const BLOCKED = new Set([401, 403, 429, 430])

const sayBlocked = (status: number | undefined): string =>
  status === 429
    ? '对方在限流（429）'
    : status === 430
      ? '对方的机器人防护拦了（430）'
      : status === undefined || status === 0 || status === 200
        ? '对方要人点一下验证'
        : `对方拒绝了（${String(status)}）`

/** 这一次读用的路（被挡一次就换浏览器，之后这一次都走它）。 */
interface ReadState {
  via: Via
}

const run = async <T>(io: ShopCatalogIo, task: () => Promise<T>): Promise<T | undefined> =>
  io.page === undefined ? task() : io.page(task)

async function direct(io: ShopCatalogIo, url: string, accept: string): Promise<GetOutcome> {
  const got = await run(io, async (): Promise<GetOutcome> => {
    try {
      const res = await io.fetch(url, {
        method: 'GET',
        headers: { 'user-agent': COMPETITOR_WATCH_USER_AGENT, accept },
        signal: AbortSignal.timeout(io.timeoutMs ?? CATALOG_TIMEOUT_MS),
      })
      const final = typeof res.url === 'string' && res.url !== '' ? { final_url: res.url } : {}
      if (BLOCKED.has(res.status))
        return { ok: false, kind: 'blocked', status: res.status, reason: sayBlocked(res.status) }
      if (!res.ok)
        return {
          ok: false,
          kind: 'not_found',
          status: res.status,
          reason: `没取到（${String(res.status)}）`,
        }
      const text = await res.text()
      if (isBotChallengePage(text))
        return { ok: false, kind: 'blocked', status: res.status, reason: sayBlocked(undefined) }
      return { ok: true, text, status: res.status, via: 'direct', ...final }
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
  return got ?? { ok: false, kind: 'quota', reason: '这一小时读的页数到上限了，下一轮再读' }
}

async function viaBrowser(io: ShopCatalogIo, url: string): Promise<GetOutcome> {
  const browser = io.browser
  if (browser === undefined)
    return { ok: false, kind: 'blocked', reason: '没有工坊内置浏览器可以换' }
  const got = await run(io, async (): Promise<GetOutcome> => {
    const r = await browser(url).catch((e: unknown) => ({
      ok: false as const,
      message: e instanceof Error ? e.message : String(e),
    }))
    if (!r.ok) return { ok: false, kind: 'blocked', reason: `内置浏览器也没读到：${r.message}` }
    if (r.challenge === true || BLOCKED.has(r.status) || isBotChallengePage(r.text))
      return {
        ok: false,
        kind: 'blocked',
        status: r.status,
        reason: `内置浏览器里也被挡了（${sayBlocked(r.status)}）`,
      }
    if (r.status >= 400)
      return { ok: false, kind: 'not_found', status: r.status, reason: `没取到（${r.status}）` }
    if (r.truncated === true)
      return { ok: false, kind: 'truncated', reason: '这一页太大，内置浏览器只读到一部分' }
    return { ok: true, text: r.text, status: r.status, final_url: r.final_url, via: 'browser' }
  })
  return got ?? { ok: false, kind: 'quota', reason: '这一小时读的页数到上限了，下一轮再读' }
}

/** 读一个地址：先直接请求，被挡就换内置浏览器（这一次之后都走它）；还不行照实说。 */
async function get(
  io: ShopCatalogIo,
  state: ReadState,
  url: string,
  accept: string,
): Promise<GetOutcome> {
  if (state.via === 'browser') return viaBrowser(io, url)
  const d = await direct(io, url, accept)
  if (d.ok || d.kind !== 'blocked' || io.browser === undefined) return d
  state.via = 'browser'
  const b = await viaBrowser(io, url)
  return b.ok ? b : { ...b, reason: `${d.reason}；${b.reason}` }
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
  return r.ok ? parseRobotsDisallow(r.text) : []
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
  const state: ReadState = { via: 'direct' }
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
          route: a.via === 'browser' ? 'browser' : 'direct',
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
      ...(state.via === 'browser' ? { via: 'browser' as const } : {}),
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
  const state: ReadState = { via: 'direct' }
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
    if (state.via === 'browser') r.notes.unshift('对方挡了直接读，改用工坊内置浏览器读的')
    return { ...r, via: state.via }
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
  if (state.via === 'browser') r.notes.unshift('对方挡了直接读，改用工坊内置浏览器读的')
  return {
    rows,
    complete: r.complete,
    via: state.via,
    ...(r.error === undefined ? {} : { error: r.error }),
    notes: r.notes,
    pages,
  }
}
