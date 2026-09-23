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
import {
  absolute,
  BRAND_INTAKE_USER_AGENT,
  fetchPage,
  fetchRobots,
  isDisallowed,
  type PageFetch,
  parseRobotsDisallow,
} from '@agentsws/brand-intake'
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
      const fetchedPage = await fetchPage(doFetch, href)
      if (!fetchedPage.ok || fetchedPage.html.trim() === '') {
        cache.set(href, undefined)
        continue
      }
      const sheet: StyleSheet = { url: href, css: fetchedPage.html }
      cache.set(href, sheet)
      mine.push(sheet)
    }
    byPage.set(page.url, mine)
  }
  return byPage
}

/* ── 站上的图 → 视觉档（WP122b 交付 ⑤）──────────────────────────── */

export interface PageImage {
  url: string
  mime: 'image/jpeg' | 'image/png' | 'image/webp'
  bytes: Uint8Array
}

export interface PageImageOptions {
  /** 最多取几张（视觉调用按张计积分，见契约 `CREDITS_PER_VISION_CALL`）。 */
  maxImages?: number
  /** 单张上限（默认 2 MB）：要的是照片与插画，不是一整张海报原图。 */
  maxBytes?: number
}

const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|#|$)/i
const MIME_OF: Record<string, PageImage['mime']> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function mimeOf(url: string, contentType: string | undefined): PageImage['mime'] | undefined {
  const ct = contentType?.split(';')[0]?.trim().toLowerCase()
  if (ct === 'image/jpeg' || ct === 'image/png' || ct === 'image/webp') return ct
  const ext = IMAGE_EXT.exec(url)?.[1]?.toLowerCase()
  return ext === undefined ? undefined : MIME_OF[ext]
}

/**
 * 从页面上挑几张**内容图**抓回来给视觉模型看（WP122b 交付 ⑤）。
 *
 * 我们没有无头浏览器（71 §3），拍不了屏幕截图；但"图片风格"那一节要看的
 * 恰恰是站上的摄影与插画——`<img>` 与 `og:image` 就是它们本尊。挑法与纪律
 * 都照样式表那一条来：**同源与站自己的 CDN**、遵 robots、封顶张数、
 * 抓不到就说抓不到（单张失败只跳过，不报错）。data: URI、SVG、图标尺寸
 * 的小图一律不碰。
 */
/**
 * 抓图那一口的形状。与 `PageFetch`（样式表）分开：图要的是**字节**与
 * content-type，不是文本。生产传 `globalThis.fetch`（天然兼容），
 * 测试传夹具。
 */
export type ImageFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

export async function fetchPageImages(
  doFetch: ImageFetch,
  pages: readonly DesignPageInput[],
  options: PageImageOptions = {},
): Promise<PageImage[]> {
  const max = options.maxImages ?? 4
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024

  /** 候选地址：按页去重，logo 之外的 img 优先（logo 另有专口，不在这一步看）。 */
  const urls: string[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    const candidates: string[] = []
    for (const m of page.html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*>/gi)) {
      const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]
      if (content !== undefined) candidates.push(absolute(content, page.url) ?? content)
    }
    for (const m of page.html.matchAll(/<img[^>]*>/gi)) {
      if (/logo/i.test(m[0])) continue
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]
      if (src !== undefined) candidates.push(absolute(src, page.url) ?? src)
    }
    for (const url of candidates) {
      if (seen.has(url)) continue
      seen.add(url)
      urls.push(url)
    }
  }

  const robotsByOrigin = new Map<string, string[]>()
  const out: PageImage[] = []
  for (const url of urls) {
    if (out.length >= max) break
    if (url.startsWith('data:')) continue
    if (!IMAGE_EXT.test(url)) continue
    if (!worthFetching(url, pages[0]?.url ?? url)) continue
    try {
      const origin = new URL(url).origin
      let disallow = robotsByOrigin.get(origin)
      if (disallow === undefined) {
        // robots 那一份自己取：ImageFetch 回字节不回文本，不走 fetchPage
        const robots = await doFetch(`${origin}/robots.txt`, {
          method: 'GET',
          headers: { 'user-agent': BRAND_INTAKE_USER_AGENT },
        })
        disallow = robots.ok
          ? parseRobotsDisallow(Buffer.from(await robots.arrayBuffer()).toString('utf8'))
          : []
        robotsByOrigin.set(origin, disallow)
      }
      if (isDisallowed(new URL(url).pathname, disallow)) continue
      const res = await doFetch(url, {
        method: 'GET',
        headers: { 'user-agent': BRAND_INTAKE_USER_AGENT, accept: 'image/*' },
      })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > maxBytes) continue
      const mime = mimeOf(url, res.headers?.get?.('content-type') ?? undefined)
      if (mime === undefined) continue
      out.push({ url, mime, bytes: new Uint8Array(buf) })
    } catch {}
  }
  return out
}
