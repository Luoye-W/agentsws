/**
 * WP488（决策 1681）：从官网 / 售后（帮助中心）网站学一遍——**编排**。
 *
 * 这个包的老纪律照旧：只放判定与编排，不认识模型、不认识浏览器、不认识 HTTP。
 * 读页（工坊自己的读页那一条路）与问模型都由调用方注入；挑页、拼题、认回话、成候选的纯函数在
 * `@agentsws/support-core` 的 `site-learning.ts`。产出是一串**候选**（每条记来源页），由宿主写成待确认的卡。
 */
import type { Iso8601 } from '@agentsws/contracts'
import {
  type KnowledgeCandidate,
  MIN_PAGE_TEXT,
  normalizeSiteUrl,
  parseSiteItems,
  planSitePages,
  sameSiteLinks,
  siteCandidate,
  sitemapLocs,
  sitePagePrompt,
} from '@agentsws/support-core'

/** 读一页：HTML（找链接用）与正文（问模型用）。读不到回 `undefined`。 */
export interface SitePage {
  url: string
  html?: string
  text: string
}

export interface SiteReader {
  page(url: string): Promise<SitePage | undefined>
  /** sitemap.xml 原文（没有 / 读不到回 `undefined`）。 */
  sitemap?(url: string): Promise<string | undefined>
}

export interface LearnFromSiteInput {
  /** 入口（官网首页、售后站首页、FAQ 页都行）。 */
  urls: readonly string[]
  read: SiteReader
  /** 问模型：给一段提示词，回一段字。回 `undefined` = 这一页跳过。 */
  extract(prompt: string, url: string): Promise<string | undefined>
  at: Iso8601
  /** 所有入口加起来最多读几页。 */
  maxPages: number
  onProgress?: (done: number, total: number) => void
  shouldContinue?: () => boolean | Promise<boolean>
}

export interface LearnedPage {
  url: string
  /** 这一页的正文（宿主算内容 hash、登记复查用）。 */
  text: string
  candidates: KnowledgeCandidate[]
}

export interface LearnFromSiteResult {
  pages: LearnedPage[]
  /** 计划读的页（入口 + 挑出来的子页）。 */
  planned: string[]
  /** 读不到 / 太短 / 没问出东西的页。 */
  skipped: { url: string; reason: 'unreadable' | 'thin' | 'no_items' | 'stopped' }[]
}

/** 挑页：入口页里的链接 + sitemap，政策 / FAQ 先读；多个入口平分页数。 */
export async function planSite(
  urls: readonly string[],
  read: SiteReader,
  maxPages: number,
): Promise<{ planned: string[]; entries: Map<string, SitePage> }> {
  const roots = [...new Set(urls.map((u) => normalizeSiteUrl(u)).filter((u) => u !== undefined))]
  const entries = new Map<string, SitePage>()
  const planned: string[] = []
  const per = Math.max(1, Math.floor(maxPages / Math.max(1, roots.length)))
  for (const root of roots) {
    const entry = await read.page(root).catch(() => undefined)
    if (entry === undefined) continue
    entries.set(root, entry)
    const found = entry.html === undefined ? [] : sameSiteLinks(entry.html, root)
    if (read.sitemap !== undefined) {
      const origin = new URL(root).origin
      const xml = await read.sitemap(`${origin}/sitemap.xml`).catch(() => undefined)
      if (xml !== undefined) {
        const locs = sitemapLocs(xml, root)
        found.push(...locs.pages)
        // 索引只跟一层、最多三份（Shopify 的 sitemap 是索引）
        for (const sub of locs.sitemaps.slice(0, 3)) {
          const inner = await read.sitemap(sub).catch(() => undefined)
          if (inner !== undefined) found.push(...sitemapLocs(inner, root).pages)
        }
      }
    }
    for (const u of planSitePages(root, found, per)) if (!planned.includes(u)) planned.push(u)
  }
  return { planned: planned.slice(0, maxPages), entries }
}

export async function learnFromSite(input: LearnFromSiteInput): Promise<LearnFromSiteResult> {
  const { planned, entries } = await planSite(input.urls, input.read, input.maxPages)
  const pages: LearnedPage[] = []
  const skipped: LearnFromSiteResult['skipped'] = []
  const seen = new Set<string>()
  for (const [i, url] of planned.entries()) {
    if (input.shouldContinue !== undefined && !(await input.shouldContinue())) {
      for (const rest of planned.slice(i)) skipped.push({ url: rest, reason: 'stopped' })
      break
    }
    input.onProgress?.(i, planned.length)
    const page = entries.get(url) ?? (await input.read.page(url).catch(() => undefined))
    if (page === undefined) {
      skipped.push({ url, reason: 'unreadable' })
      continue
    }
    if (page.text.trim().length < MIN_PAGE_TEXT) {
      skipped.push({ url, reason: 'thin' })
      continue
    }
    const reply = await input.extract(sitePagePrompt({ url, text: page.text }), url)
    const candidates: KnowledgeCandidate[] = []
    for (const item of reply === undefined ? [] : parseSiteItems(reply)) {
      const c = siteCandidate(item, url, input.at)
      // 同一句问法在几页上都有（页头页脚的「联系我们」）只留第一页的
      if (c === undefined || seen.has(c.key)) continue
      seen.add(c.key)
      candidates.push(c)
    }
    if (candidates.length === 0) skipped.push({ url, reason: 'no_items' })
    pages.push({ url, text: page.text, candidates })
  }
  input.onProgress?.(planned.length, planned.length)
  return { pages, planned, skipped }
}
