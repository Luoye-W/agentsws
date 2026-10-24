/**
 * WP450（docs/109 §5.2 #17）：**llms.txt**——按店铺结构与政策页生成内容（交建站放上去），以及体检里那一项「有没有、内容过不过时」。
 *
 * 格式照社区规范 llmstxt.org：一个 H1（店名，唯一必须的）、一句 `>` 摘要、几个 H2 小节，每节一串 `- [名字](网址): 说明`；
 * `## Optional` 放 AI 可以跳过的。合不合格按 Lighthouse 的 `llms-txt` 那几条：4xx 算没有；5xx / 抓不到算不知道；
 * 有 H1、至少一个 Markdown 链接、50 个字以上（返回的是 HTML 页 = 软 404，不合格）。
 *
 * Shopify（2026-05 起，shopify.dev「llms.txt.liquid」「agents.md.liquid」两页，10-25 读）：店铺默认就有 `/llms.txt`，内容照抄
 * Shopify 生成的 `/agents.md`；想换成自己的，在主题里加 `templates/llms.txt.liquid`（不要 App）。这个模板里只能用
 * `request` 与 `agents` 两个对象（拿不到合集、文章），所以我们给的是**写死的文字**，店里结构变了要重新生成——体检里「过时」就是为这个。
 *
 * 方法借 claude-seo（MIT，github.com/AgriciDaniel/claude-seo @ 4b99de2）`skills/seo-agentic`（结构、Lighthouse 三条、
 * 「不承诺 AI 一定读、Google 搜索不看它」）。只借方法，代码自己写。
 */
import type { LlmsTxtCheck, LlmsTxtDraft } from '@agentsws/contracts'

export interface LlmsLink {
  title: string
  url: string
  note?: string
}

export interface LlmsStructure {
  name: string
  /** 一句话介绍（品牌档案的 one-liner；没有就不写摘要）。 */
  summary?: string
  origin: string
  collections: LlmsLink[]
  products: LlmsLink[]
  /** 政策页（退换、配送、隐私、条款、联系）。 */
  policies: LlmsLink[]
  /** 独立页（关于我们、FAQ、尺码表……）。 */
  pages: LlmsLink[]
  articles: LlmsLink[]
  source: LlmsTxtDraft['source']
}

/** 每节最多列几条（文件短才有人读）。 */
export const LLMS_SECTION_MAX = { collections: 20, products: 15, pages: 10, articles: 10 } as const

/** Shopify 每家店都有的四个政策页（店铺后台读不到时按这几个地址兜底）。 */
export const SHOPIFY_POLICY_PATHS: readonly { path: string; zh: string; en: string }[] = [
  { path: '/policies/refund-policy', zh: '退换政策', en: 'Refund policy' },
  { path: '/policies/shipping-policy', zh: '配送政策', en: 'Shipping policy' },
  { path: '/policies/privacy-policy', zh: '隐私政策', en: 'Privacy policy' },
  { path: '/policies/terms-of-service', zh: '服务条款', en: 'Terms of service' },
]

/** 在 Shopify 上怎么放（几步人话，交建站的事项与面板都用这一份）。 */
export const LLMS_PLACEMENT_ZH: readonly string[] = [
  'Shopify 从 2026 年 5 月起每家店默认就有 /llms.txt（内容照抄 Shopify 自动生成的 /agents.md），不用装 App。',
  '要换成这一份：后台「在线商店 → 主题 → 编辑代码」，在 templates 里新建 llms.txt.liquid，把内容整段粘进去、保存。只换 /llms.txt，/agents.md 不受影响。',
  '这个模板里拿不到合集和文章，所以内容是写死的：店里加了合集、改了政策，体检会提示「过时」，再生成一份换上。',
  '换主题会丢这个文件：换完主题记得重新放。',
  '不保证 AI 一定会读它，Google 搜索也不看它；它只是让读它的 AI 更快认清我们卖什么、政策在哪。',
]

export const LLMS_PLACEMENT_EN: readonly string[] = [
  'Since May 2026 every Shopify store serves /llms.txt by default (a copy of the Shopify-generated /agents.md) — no app needed.',
  'To replace it: Online Store → Themes → Edit code, add templates/llms.txt.liquid, paste the content and save. Only /llms.txt changes; /agents.md stays.',
  "That template can't read collections or articles, so the content is static: when collections or policies change, the health check flags it as outdated — generate a new one.",
  'Switching themes drops the file: put it back after a theme change.',
  'No AI is guaranteed to read it and Google Search ignores it; it only helps the AIs that do read it see what we sell and where our policies are.',
]

const line = (l: LlmsLink): string =>
  `- [${l.title.replace(/[[\]]/g, '')}](${l.url})${l.note === undefined || l.note.trim() === '' ? '' : `: ${l.note.trim().replace(/\s+/g, ' ').slice(0, 160)}`}`

const isCjk = (s: string): boolean => /[぀-ヿ一-鿿]/.test(s)

/** 生成一份 llms.txt（见文件头）。 */
export function buildLlmsTxt(s: LlmsStructure, at: string): LlmsTxtDraft {
  const zh = isCjk(`${s.name}${s.summary ?? ''}`)
  const h = zh
    ? { c: '商品分类', p: '主推商品', pol: '政策与帮助', g: '指南与文章', o: 'Optional' }
    : { c: 'Collections', p: 'Products', pol: 'Policies & help', g: 'Guides', o: 'Optional' }
  const sections: { title: string; links: LlmsLink[] }[] = [
    { title: h.c, links: s.collections.slice(0, LLMS_SECTION_MAX.collections) },
    { title: h.p, links: s.products.slice(0, LLMS_SECTION_MAX.products) },
    { title: h.pol, links: s.policies },
    { title: h.g, links: s.articles.slice(0, LLMS_SECTION_MAX.articles) },
    { title: h.o, links: s.pages.slice(0, LLMS_SECTION_MAX.pages) },
  ].filter((x) => x.links.length > 0)
  const out = [`# ${s.name.trim() || s.origin}`, '']
  if (s.summary !== undefined && s.summary.trim() !== '') out.push(`> ${s.summary.trim()}`, '')
  out.push(
    zh
      ? `官网：${s.origin}。价格、库存以商品页为准；下面是店里的主要页面。`
      : `Official store: ${s.origin}. Prices and stock are as shown on each product page; below are the main pages.`,
    '',
  )
  for (const sec of sections) out.push(`## ${sec.title}`, '', ...sec.links.map(line), '')
  return {
    content: `${out.join('\n').trimEnd()}\n`,
    generated_at: at,
    sections: sections.map((x) => ({ title: x.title, links: x.links.length })),
    source: s.source,
  }
}

/** 文件里的 Markdown 链接（网址）。 */
export function llmsLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] as string)
}

const pathOf = (url: string, origin: string): string | undefined => {
  try {
    const u = new URL(url, origin)
    const o = new URL(origin)
    if (u.hostname.replace(/^www\./, '') !== o.hostname.replace(/^www\./, '')) return undefined
    return (u.pathname.replace(/\/+$/, '') || '/').toLowerCase()
  } catch {
    return undefined
  }
}

/** 店里的结构页（合集、商品、独立页、文章、政策）——「写着已经没有的页」只认这几类。 */
const STRUCTURE_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(collections|products|pages|blogs|policies)\//

/**
 * 体检那一项：有没有、合不合格、过不过时。
 *
 * - `expected`：按店铺现在的结构该有的链接（合集与政策页——最该被 AI 看到的那几样）；
 * - `known`：店里现在全部认得的地址（站点地图 + 政策页）；文件里写的结构页不在里面 = 「已经没有的页」。不给就不判这一条。
 */
export function checkLlmsTxt(input: {
  url: string
  origin: string
  fetched:
    | { status: number; body?: string; content_type?: string; final_url?: string }
    | undefined
  expected: readonly string[]
  known?: ReadonlySet<string>
  at: string
}): LlmsTxtCheck {
  const base = { url: input.url, checked_at: input.at }
  const f = input.fetched
  if (f === undefined || f.status === 0 || f.status >= 500)
    return { ...base, state: 'unknown', reasons: ['这次没抓到 llms.txt，下次体检再看'] }
  if (f.status === 404 || f.status === 410 || (f.status >= 400 && f.status < 500))
    return { ...base, state: 'missing', reasons: ['网站上没有 llms.txt'] }
  const body = f.body ?? ''
  const html = /text\/html/i.test(f.content_type ?? '') || /^\s*(<!doctype html|<html)/i.test(body)
  const reasons: string[] = []
  if (html) reasons.push('打开 /llms.txt 回的是网页（像是找不到页面），不是文字文件')
  else {
    if (!/^\s*﻿?# \S/m.test(body)) reasons.push('没有以「# 店名」开头的标题')
    if (llmsLinks(body).length === 0) reasons.push('一个链接都没有')
    if (body.trim().length < 50) reasons.push('内容太短（不到 50 个字）')
  }
  if (reasons.length > 0) return { ...base, state: 'invalid', reasons }
  const generated_by: 'shopify' | 'custom' =
    /\/agents\.md$/i.test(f.final_url ?? '') ||
    /\/agents\.md\b/i.test(body) ||
    /\b(ucp|mcp)\b/i.test(body)
      ? 'shopify'
      : 'custom'
  const have = new Set(
    llmsLinks(body)
      .map((u) => pathOf(u, input.origin))
      .filter((p): p is string => p !== undefined),
  )
  const missing = input.expected.filter((u) => {
    const p = pathOf(u, input.origin)
    return p !== undefined && !have.has(p)
  })
  const dead =
    input.known === undefined
      ? []
      : llmsLinks(body).filter((u) => {
          const p = pathOf(u, input.origin)
          return (
            p !== undefined &&
            STRUCTURE_PATH.test(`${p}/`) &&
            !(input.known as ReadonlySet<string>).has(p)
          )
        })
  // Shopify 自己生成的那份会跟着店铺变，只是不列合集与政策；不算过时，只提一句可以换成我们这份
  if (generated_by === 'shopify')
    return {
      ...base,
      state: 'current',
      generated_by,
      reasons:
        missing.length === 0
          ? []
          : [
              `是 Shopify 自动生成的那份，没列合集与政策页（${String(missing.length)} 个）；想写清楚可以换成生成的这份`,
            ],
      ...(missing.length === 0 ? {} : { missing_links: missing }),
    }
  if (missing.length > 0)
    reasons.push(`店里现在有、文件里没写的 ${String(missing.length)} 个（合集 / 政策页）`)
  if (dead.length > 0) reasons.push(`文件里写着、店里已经没有的 ${String(dead.length)} 个`)
  return {
    ...base,
    state: reasons.length === 0 ? 'current' : 'stale',
    generated_by,
    reasons,
    ...(missing.length === 0 ? {} : { missing_links: missing }),
    ...(dead.length === 0 ? {} : { dead_links: dead }),
  }
}

/** 按地址认路径（体检把站点地图里的地址变成 `known` 用）。 */
export function llmsKnownPaths(urls: readonly string[], origin: string): Set<string> {
  const out = new Set<string>()
  for (const u of urls) {
    const p = pathOf(u, origin)
    if (p !== undefined) out.add(p)
  }
  for (const p of SHOPIFY_POLICY_PATHS) out.add(p.path)
  return out
}

/** 站点地图地址 → 结构（店铺后台读不到时兜底：标题按地址里的那一段拼）。 */
export function llmsStructureFromUrls(input: {
  name: string
  summary?: string
  origin: string
  urls: readonly string[]
}): LlmsStructure {
  const human = (seg: string): string =>
    decodeURIComponent(seg)
      .replace(/[-_]+/g, ' ')
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
  const pick = (kind: string): LlmsLink[] => {
    const seen = new Set<string>()
    const out: LlmsLink[] = []
    for (const u of input.urls) {
      const p = pathOf(u, input.origin)
      if (p === undefined) continue
      const m = new RegExp(`^/(?:[a-z]{2}(?:-[a-z]{2})?/)?${kind}/([^/]+)(?:/([^/]+))?$`).exec(p)
      if (m === null) continue
      const seg = (kind === 'blogs' ? m[2] : m[1]) ?? ''
      if (seg === '' || seg === 'all' || seen.has(p)) continue
      seen.add(p)
      out.push({ title: human(seg), url: `${input.origin.replace(/\/+$/, '')}${p}` })
    }
    return out
  }
  const origin = input.origin.replace(/\/+$/, '')
  const zh = isCjk(`${input.name}${input.summary ?? ''}`)
  return {
    name: input.name,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    origin,
    collections: pick('collections'),
    products: pick('products'),
    pages: pick('pages'),
    articles: pick('blogs'),
    policies: SHOPIFY_POLICY_PATHS.map((p) => ({
      title: zh ? p.zh : p.en,
      url: `${origin}${p.path}`,
    })),
    source: 'sitemap',
  }
}
