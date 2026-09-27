/**
 * WP166：模型写改动卡初稿前，读这一页的正文（Luoye 09-27：初稿要读页面正文）。
 *
 * 两条路，按顺序：
 *
 * 1. **店铺连接的只读口**（Shopify）：按网址认出是哪一类页面（`/pages/<handle>` 独立页、
 *    `/products/<handle>` 商品、`/blogs/<blog>/<handle>` 文章、`/collections/<handle>` 集合），
 *    用对应的 `list_*` 只读 Action 按 handle 查、取正文（`body` / `body_html` / `descriptionHtml`…）。
 *    这几个 Action 在 `packages/connect-adapter/action-side-effects.yml` 里都标着 `read`。
 * 2. **公开网址**：店里读不到（没连店 / 首页这类没有 handle 的页 / 上游没回正文）才抓。
 *    **不新开出网路径**：走品牌分析那一口抓取（`@agentsws/brand-intake` 的 `fetchPage`：只 GET、
 *    不带凭据、UA 认得出是我们、10 秒超时、遵 robots），另加两道闸——只抓**我们自己的域名**
 *    （品牌档案 / Search Console 里认出来的那几个），主机是 IP 字面量、`localhost`、内网名与保留域名（`.test` / `.example` / `.invalid`）的一律不抓。
 *
 * 读回来的可以是 HTML：去标签、截长度在 `@agentsws/seo-core` 的 `pageBodyText`（提示词那一侧）。
 * 这里永不抛；读不到回 `undefined`。
 */
import { fetchPage, fetchRobots, isDisallowed, type PageFetch } from '@agentsws/brand-intake'
import { type StoreConnectLike, storeReader } from './markets.js'

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v
  const r = rec(v)
  if (Array.isArray(r.nodes)) return r.nodes
  if (Array.isArray(r.edges)) return r.edges.map((e) => rec(e).node)
  return []
}

/** 网址 → 店里哪一类、handle 是什么（认不出回 `undefined`）。 */
export function storePageOf(
  url: string,
): { kind: 'page' | 'product' | 'article' | 'collection'; handle: string } | undefined {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return undefined
  }
  // 多语言子目录（/en-gb/products/x）先去掉
  const p = path.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, '')
  const m =
    /^\/pages\/([^/?#]+)/.exec(p) ??
    /^\/products\/([^/?#]+)/.exec(p) ??
    /^\/blogs\/[^/]+\/([^/?#]+)/.exec(p) ??
    /^\/collections\/([^/?#]+)\/?$/.exec(p)
  if (m === null) return undefined
  const handle = decodeURIComponent(m[1] ?? '')
  if (handle === '') return undefined
  const kind = p.startsWith('/pages/')
    ? 'page'
    : p.startsWith('/products/')
      ? 'product'
      : p.startsWith('/blogs/')
        ? 'article'
        : 'collection'
  return { kind, handle }
}

const LIST_ACTION = {
  page: { action: 'list_pages', key: 'pages' },
  product: { action: 'list_products', key: 'products' },
  article: { action: 'list_articles', key: 'articles' },
  collection: { action: 'list_collections', key: 'collections' },
} as const

/** 一行里的正文（各种回包形状都认）。 */
function bodyOf(row: unknown): string | undefined {
  const r = rec(row)
  for (const k of ['body_html', 'bodyHtml', 'body', 'descriptionHtml', 'description', 'content']) {
    const v = r[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

/** 这个主机能不能抓：只抓我们自己的域名；IP 字面量、localhost、内网名一律不抓。 */
export function allowedHost(host: string, ours: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (h === '' || h === 'localhost' || !h.includes('.')) return false
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(':') || h.startsWith('[')) return false
  if (/\.(local|localhost|internal|lan|home|corp|test|example|invalid)$/.test(h)) return false
  return ours.some((d) => {
    const o = d.toLowerCase().replace(/^www\./, '')
    return o !== '' && (h === o || h.endsWith(`.${o}`))
  })
}

/** 一页 HTML 里的主体（有 `<main>` / `<article>` 就只要它，免得导航与页脚占满长度）。 */
export function mainHtml(html: string): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]
  if (main !== undefined && main.trim() !== '') return main
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
  if (article !== undefined && article.trim() !== '') return article
  return /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
}

export function createPageBodyReader(options: {
  connect?: StoreConnectLike | undefined
  /** 现在这家店的那条连接（没有 = 只走公开网址）。 */
  connection(): { id: string; service: string } | undefined
  /** 品牌分析那一口抓取（只 GET、不带凭据）。不给 = 不走公开网址。 */
  fetch?: PageFetch | undefined
}): (input: {
  url: string
  /** 我们自己的域名（只抓这些；品牌档案里的 + Search Console 里认出来的）。 */
  domains: readonly string[]
}) => Promise<{ text: string; from: 'store' | 'web' } | undefined> {
  const fromStore = async (url: string): Promise<string | undefined> => {
    const which = storePageOf(url)
    const connection = options.connection()
    if (which === undefined || connection === undefined || options.connect === undefined)
      return undefined
    const spec = LIST_ACTION[which.kind]
    const run = await storeReader(options.connect, connection, [spec.action])
    if (run === undefined) return undefined
    const out = await run(spec.action, { query: `handle:${which.handle}` })
    const rows = arr(rec(out)[spec.key] ?? out)
    const hit =
      rows.find((r) => rec(r).handle === which.handle) ?? (rows.length === 1 ? rows[0] : undefined)
    return hit === undefined ? undefined : bodyOf(hit)
  }

  const fromWeb = async (url: string, domains: readonly string[]): Promise<string | undefined> => {
    if (options.fetch === undefined) return undefined
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return undefined
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    if (u.username !== '' || u.password !== '') return undefined
    if (!allowedHost(u.hostname, domains)) return undefined
    const disallow = await fetchRobots(options.fetch, u.origin)
    if (isDisallowed(u.pathname, disallow)) return undefined
    const res = await fetchPage(options.fetch, u.toString())
    return res.ok ? mainHtml(res.html) : undefined
  }

  return async ({ url, domains }) => {
    try {
      const store = await fromStore(url)
      if (store !== undefined) return { text: store, from: 'store' }
    } catch {
      // 店里读不到就去看公开网址
    }
    try {
      const web = await fromWeb(url, domains)
      if (web !== undefined) return { text: web, from: 'web' }
    } catch {
      // 都读不到：照原来的写法，卡上注明
    }
    return undefined
  }
}
