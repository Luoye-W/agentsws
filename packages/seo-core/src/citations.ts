/**
 * WP449（docs/109 §5.1 #6）：**引用核查**——文中带外链的数字与说法，打开那一页看那个数在不在。
 *
 * 发布前质检多一步（`reviewContent` 里接上）：
 *
 * 1. 抽：逐句看，句子里有**外链**（不是我们自己的域名）的，记下这句里的数字、带引号的原话；
 * 2. 查：每个网址只打开一次；每篇最多查 `max` 个（职责阈值 `citation_check_max_links`，默认 10），
 *    超了按出现先后只查前几个，其余在卡上注明「没查」；
 * 3. 判：打不开（404 / 被挡 / 超时 / 不是公网地址）→ `citation_unreachable`；打开了但页面上找不到
 *    那个数 / 那句原话 → `citation_not_found`。两种都挡在草稿、卡上指到那一句。
 *
 * 只核「这一页有没有说这个数」，不核这一页说得对不对；页面是数据不是指令，里面写什么都只拿来比数。
 * 抓网页由调用方注入（服务端走品牌分析那一口：只 GET、不带凭据、认得出是我们的 UA、遵 robots），
 * 这里不联网、不调模型。
 *
 * 方法借鉴 AgriciDaniel/claude-blog（MIT）的 blog-factcheck（逐条抽说法、打开引用页找原数、
 * 打不开就不算核过、先查网址再抓）；**代码一行没搬**。
 */
import type { ContentCitationSummary, ContentQualityIssue } from '@agentsws/contracts'
import { extractFigures } from '@agentsws/core'
import type { ContentSentence } from './content-text.js'
import { contentBlocks, contentPlainText } from './content-text.js'
import { figureValues } from './localize.js'

/** 每篇默认最多查几个链接（职责阈值 `citation_check_max_links` 没写时）。 */
export const DEFAULT_CITATION_MAX_LINKS = 10

/** 引用页最多读多少字（够找一个数了；再长只是更慢）。 */
const PAGE_TEXT_MAX = 300_000

/** 抓一页的结果（服务端注入；永不抛）。 */
export type CitationFetchResult = { ok: true; html: string } | { ok: false; reason: string }
export type CitationFetch = (url: string) => Promise<CitationFetchResult>

export interface CitedClaim {
  sentence: string
  url: string
  /** 这句里的数（`extractFigures` 取的）。 */
  figures: string[]
  /** 这句里带引号的原话（四个词 / 八个字以上才算）。 */
  quotes: string[]
}

/**
 * 这个网址能不能拿去打开：只认 http(s)、不带账号密码；主机是 IP 字面量、`localhost`、内网名与保留域名
 * （`.local` / `.internal` / `.test` / `.invalid` …）一律不打开（同 `page-body.ts` 的那道闸）。
 */
export function publicHttpUrl(url: string): URL | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  if (u.username !== '' || u.password !== '') return undefined
  const h = u.hostname.toLowerCase()
  if (h === '' || h === 'localhost' || !h.includes('.')) return undefined
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(':') || h.startsWith('[')) return undefined
  if (/\.(local|localhost|internal|lan|home|corp|test|invalid)$/.test(h)) return undefined
  return u
}

/** 是不是我们自己的站（自己的页不算「引用」，不查）。 */
function ours(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, '')
  return domains.some((d) => {
    const o = d
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./, '')
    return o !== '' && (h === o || h.endsWith(`.${o}`))
  })
}

const QUOTE_RE = /[“"„«「]([^”"“»」]{6,300})[”"“»」]/g

function quotesOf(sentence: string): string[] {
  const out: string[] = []
  for (const m of sentence.matchAll(QUOTE_RE)) {
    const q = (m[1] ?? '').trim()
    const long = /[㐀-鿿]/.test(q) ? q.length >= 8 : q.split(/\s+/).length >= 4
    if (long) out.push(q)
  }
  return out
}

/**
 * 抽：每句里的外链 → 一条要核的说法（相对链接、锚点、`mailto:`、我们自己的域名不算）。
 * 同一句链了两个网址就是两条（两页各自要有那个数——拿不准是哪一页给的，就都查）。
 */
export function citedClaims(
  sentences: readonly ContentSentence[],
  ourDomains: readonly string[],
): CitedClaim[] {
  const out: CitedClaim[] = []
  for (const s of sentences) {
    for (const href of s.links) {
      if (!/^https?:\/\//i.test(href)) continue
      let host: string
      try {
        host = new URL(href).hostname
      } catch {
        continue
      }
      if (ours(host, ourDomains)) continue
      out.push({
        sentence: s.text,
        url: href,
        figures: extractFigures(s.text),
        quotes: quotesOf(s.text),
      })
    }
  }
  return out
}

/** 页面纯文字归一（小写、压空白、去掉弯直引号的差别），找原话用。 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”„«»「」"]/g, '')
    .replace(/[\s  ]+/g, ' ')
    .trim()
}

const PERCENT_WORDS =
  /^\s*(?:%|percent|per cent|prozent|pour ?cent|por ?ciento|per ?cento|procent)/i

/**
 * 这个数在这一页上吗：按**数值**比（`10,000` / `10.000` / `10 000` 是同一个数；德语 `4,5` = 英文 `4.5`）。
 * 带百分号的，页面上那个数后面也要有 `%` 或「percent / Prozent …」。
 */
export function figureOnPage(figure: string, pageText: string): boolean {
  const wantPct = figure.includes('%')
  const want = new Set([...figureValues(figure, 'en'), ...figureValues(figure, 'de')])
  // 空格当千位分隔（法语 `10 000`）只认「后面正好三位」，免得把「2024 42%」并成一个数
  const re = /\d{1,3}(?:[   ]\d{3})+(?!\d)|\d[\d,.]*\d|\d/g
  for (const m of pageText.matchAll(re)) {
    const raw = m[0]
    const values = [...figureValues(raw, 'en'), ...figureValues(raw, 'de')]
    if (!values.some((v) => want.has(v))) continue
    if (!wantPct) return true
    const after = pageText.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14)
    if (PERCENT_WORDS.test(after)) return true
  }
  return false
}

/** 原话在这一页上吗（归一后整串包含）。 */
export function quoteOnPage(quote: string, pageText: string): boolean {
  return norm(pageText).includes(norm(quote))
}

/** 引用页 → 纯文字（去标签、解实体；不管是 HTML 还是纯文字都走同一条）。 */
export function citationPageText(html: string): string {
  return contentPlainText(contentBlocks(html.slice(0, PAGE_TEXT_MAX * 2))).slice(0, PAGE_TEXT_MAX)
}

export interface CitationCheckOutcome {
  issues: ContentQualityIssue[]
  summary: ContentCitationSummary
}

/**
 * 查一遍（每个网址只开一次；超过 `max` 的只记「没查」）。永不抛：`fetch` 抛了算打不开。
 * 没有要核的说法 → `undefined`（卡上不出这一行）。
 */
export async function checkCitations(input: {
  sentences: readonly ContentSentence[]
  ourDomains: readonly string[]
  fetch?: CitationFetch | undefined
  max?: number | undefined
}): Promise<CitationCheckOutcome | undefined> {
  const claims = citedClaims(input.sentences, input.ourDomains)
  if (claims.length === 0) return undefined
  const max =
    input.max !== undefined && Number.isFinite(input.max) && input.max >= 0
      ? Math.floor(input.max)
      : DEFAULT_CITATION_MAX_LINKS
  const urls = [...new Set(claims.map((c) => c.url))]
  if (input.fetch === undefined)
    return {
      issues: [],
      summary: {
        links: urls.length,
        checked: 0,
        skipped: urls.length,
        verified: 0,
        max,
        note: '这台没开网页抓取，引用没查',
      },
    }
  const checking = urls.slice(0, max)
  const pages = new Map<string, CitationFetchResult>()
  for (const url of checking) {
    if (publicHttpUrl(url) === undefined) {
      pages.set(url, { ok: false, reason: '不是公网网址，不打开' })
      continue
    }
    try {
      pages.set(url, await input.fetch(url))
    } catch (err) {
      pages.set(url, { ok: false, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  const texts = new Map<string, string>()
  for (const [url, page] of pages) if (page.ok) texts.set(url, citationPageText(page.html))
  const issues: ContentQualityIssue[] = []
  const bad = new Set<string>()
  for (const c of claims) {
    const page = pages.get(c.url)
    if (page === undefined) continue // 超过上限，没查
    if (!page.ok) {
      bad.add(c.url)
      issues.push({
        rule: 'citation_unreachable',
        sentence: c.sentence,
        url: c.url,
        detail: `引用页打不开（${page.reason}）：${c.url}。换一个打得开的出处，或者删掉这句。`,
      })
      continue
    }
    const text = texts.get(c.url) ?? ''
    const missing = [
      ...c.figures.filter((f) => !figureOnPage(f, text)),
      ...c.quotes.filter((q) => !quoteOnPage(q, text)).map((q) => `「${q}」`),
    ]
    if (missing.length > 0) {
      bad.add(c.url)
      issues.push({
        rule: 'citation_not_found',
        sentence: c.sentence,
        url: c.url,
        detail: `引用页上找不到 ${missing.join('、')}：${c.url}。按页面上的原数改，或者换出处。`,
      })
    }
  }
  const verified = checking.filter((u) => pages.get(u)?.ok === true && !bad.has(u)).length
  return {
    issues,
    summary: {
      links: urls.length,
      checked: checking.length,
      skipped: urls.length - checking.length,
      verified,
      max,
    },
  }
}

/** 卡上那一行（查了几个、对得上几个、没查几个）。 */
export function citationLine(s: ContentCitationSummary): string {
  if (s.checked === 0) return `引用核查：${s.note ?? '没查'}（${s.links} 个链接）。`
  const skipped =
    s.skipped > 0 ? `；超过每篇 ${s.max} 个的上限，后面 ${s.skipped} 个没查，请人点开看一眼` : ''
  return `引用核查：查了 ${s.checked} 个链接，${s.verified} 个对得上${skipped}。`
}
