/**
 * 外链样式表那几次请求（71 §5.1）。
 *
 * 这是整条链路上**唯一**额外的网络请求：页面本身由 WP121 那一轮
 * （`analyzeSite`）抓好，原样传进来，我们一个页面都不重抓。样式表拿不到，
 * 因为它不在 HTML 里。
 *
 * 四条纪律与 WP121 一字不差（`@agentsws/brand-intake` 的 `fetch.ts`）：
 * 不带凭据、UA 认得出是我们、抓不到就说抓不到、遵 robots。这里只多两条：
 *
 * - **只抓同源与常见 CDN**。站上的样式表常挂在 `cdn.shopify.com` 这类域上，
 *   那是它自己的资源；但一条指向第三方分析脚本样式的 link 不值得我们跑一趟。
 * - **有上限**（{@link DESIGN_MAX_STYLESHEETS}）。一个现代站能挂十几份样式表，
 *   抓完它们对抽出来的令牌没有实质帮助，只是把用户的时间花在等。
 */
import { fetchPage, fetchRobots, isDisallowed, type PageFetch } from '@agentsws/brand-intake'
import { type StyleSheet, stylesheetHrefs } from './css.js'
import { DESIGN_MAX_STYLESHEETS, type DesignPageInput } from './site-design.js'

/** 认得出是"站自己的"资源域。 */
const FRIENDLY_CDN =
  /(^|\.)(shopify|shopifycdn|myshopify|squarespace|wixstatic|bigcommerce|cloudfront|jsdelivr|unpkg)\.(com|net)$/i

/** 这份样式表值得抓吗。 */
export function worthFetching(sheetUrl: string, pageUrl: string): boolean {
  try {
    const u = new URL(sheetUrl)
    const p = new URL(pageUrl)
    if (u.origin === p.origin) return true
    return FRIENDLY_CDN.test(u.hostname)
  } catch {
    return false
  }
}

export interface SheetFetchResult {
  sheets: StyleSheet[]
  /** 没抓着的那几份，各带一句人话。界面上「有 2 份样式表没读到」就是这个。 */
  missed: { url: string; reason: string }[]
}

/**
 * 把这些页面上外链的样式表抓回来（按页分好）。
 *
 * 同一份样式表被好几页引用是常态（主题的 `theme.css`），所以**按地址去重**——
 * 抓一次，分给引用它的每一页。省下来的不只是请求数，还有它在主次判定里被
 * 重复计一遍的偏差。
 */
export async function fetchStylesheets(
  doFetch: PageFetch,
  pages: readonly DesignPageInput[],
  options: { maxSheets?: number } = {},
): Promise<Map<string, StyleSheet[]>> {
  const max = options.maxSheets ?? DESIGN_MAX_STYLESHEETS
  const byPage = new Map<string, StyleSheet[]>()
  const cache = new Map<string, StyleSheet | undefined>()
  const robotsByOrigin = new Map<string, string[]>()
  let fetched = 0

  for (const page of pages) {
    const mine: StyleSheet[] = []
    for (const href of stylesheetHrefs(page.html, page.url)) {
      if (!worthFetching(href, page.url)) continue
      if (cache.has(href)) {
        const hit = cache.get(href)
        if (hit !== undefined) mine.push(hit)
        continue
      }
      if (fetched >= max) break

      const origin = new URL(href).origin
      let disallow = robotsByOrigin.get(origin)
      if (disallow === undefined) {
        disallow = await fetchRobots(doFetch, origin)
        robotsByOrigin.set(origin, disallow)
      }
      if (isDisallowed(new URL(href).pathname, disallow)) {
        cache.set(href, undefined)
        continue
      }

      fetched++
      const res = await fetchPage(doFetch, href)
      if (!res.ok || res.html.trim() === '') {
        cache.set(href, undefined)
        continue
      }
      const sheet: StyleSheet = { url: href, css: res.html }
      cache.set(href, sheet)
      mine.push(sheet)
    }
    byPage.set(page.url, mine)
  }
  return byPage
}
