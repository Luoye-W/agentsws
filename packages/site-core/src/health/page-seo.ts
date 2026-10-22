/**
 * WP448（docs/109 §4.4）：一页里搜索引擎看重的那几样——标题、描述、规范网址、robots、H1、hreflang、结构化数据、站内链接。
 *
 * 技术体检（`tech-audit.ts`）与改版回归（`@agentsws/seo-core` 的 `drift.ts` 比的快照）都从这里读。
 * 纯函数、锚定的正则（同 `@agentsws/brand-intake` 的 `html.ts`：不装 DOM 解析器）；读不出就是读不出，不编。
 *
 * 检查项思路借 claude-seo（MIT）`skills/seo-technical`、`skills/seo-drift` @ 4b99de2，用我们自己的话与代码写。
 */
import { absolute, decodeEntities, metaContent, squash, titleOf } from '@agentsws/brand-intake'
import type { DriftPageKind, DriftSnapshot } from '@agentsws/contracts'

export interface PageSeoFacts {
  url: string
  /** 状态码（抓不到 = 0）。 */
  status: number
  title?: string
  description?: string
  /** 页面里所有 `rel=canonical`（补成绝对地址；写了两个本身就是问题）。 */
  canonicals: string[]
  /** robots meta（含 `googlebot`）与 `X-Robots-Tag` 合在一起，小写。 */
  robots?: string
  h1: string[]
  hreflang: { lang: string; href: string }[]
  /** 解析成功的 JSON-LD 顶层块（`@graph` 不摊平，交给校验库自己走）与写坏的块数。 */
  jsonld: { blocks: unknown[]; broken: number }
  /** 站内 `<a href>`（同主机、去掉 #、去重），抓死链用。 */
  links: string[]
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  const v = m?.[1] ?? m?.[2] ?? m?.[3]
  return v === undefined ? undefined : decodeEntities(v.trim())
}

/** 只看 `<head>`（没有 head 就看整页）：规范网址、hreflang 写在 body 里搜索引擎不认。 */
const headOf = (html: string): string => /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, ' ')

/** 一页 HTML → 搜索相关的几样。 */
export function pageSeoFacts(input: {
  url: string
  html: string | undefined
  status?: number
  /** 响应头 `X-Robots-Tag`（有的话）。 */
  x_robots?: string
}): PageSeoFacts {
  const html = input.html ?? ''
  const head = headOf(html)
  const canonicals: string[] = []
  const hreflang: { lang: string; href: string }[] = []
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = attr(tag, 'href')
    if (href === undefined || href === '') continue
    const abs = absolute(href, input.url)
    if (abs === undefined) continue
    if (rel.includes('canonical')) canonicals.push(abs)
    const lang = attr(tag, 'hreflang')
    if (rel.includes('alternate') && lang !== undefined && lang !== '')
      hreflang.push({ lang, href: abs })
  }
  const robotsParts: string[] = []
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') ?? '').toLowerCase()
    if (name === 'robots' || name === 'googlebot') {
      const c = attr(m[0], 'content')
      if (c !== undefined && c !== '') robotsParts.push(c.toLowerCase())
    }
  }
  if (input.x_robots !== undefined && input.x_robots.trim() !== '')
    robotsParts.push(input.x_robots.trim().toLowerCase())
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => squash(decodeEntities(stripTags(m[1] ?? ''))))
    .filter((t) => t !== '')
  const blocks: unknown[] = []
  let broken = 0
  for (const m of html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      blocks.push(JSON.parse(m[1] ?? '') as unknown)
    } catch {
      broken += 1
    }
  }
  let host: string | undefined
  try {
    host = new URL(input.url).host.toLowerCase()
  } catch {
    host = undefined
  }
  const links = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href')
    if (href === undefined || href === '' || href.startsWith('#')) continue
    if (/^(mailto|tel|javascript):/i.test(href)) continue
    const abs = absolute(href, input.url)
    if (abs === undefined) continue
    try {
      if (new URL(abs).host.toLowerCase() === host) links.add(abs)
    } catch {
      // 补不成绝对地址的不算
    }
  }
  const title = titleOf(html)
  const description = metaContent(html, 'description')
  return {
    url: input.url,
    status: input.status ?? (input.html === undefined ? 0 : 200),
    ...(title === undefined || title === '' ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    canonicals: [...new Set(canonicals)],
    ...(robotsParts.length === 0 ? {} : { robots: robotsParts.join(', ') }),
    h1,
    hreflang,
    jsonld: { blocks, broken },
    links: [...links],
  }
}

/** 网址比较用的键：去掉 #、查询串里的跟踪参数、结尾斜杠；主机小写、去 `www.`。 */
export function urlKey(u: string): string {
  try {
    const x = new URL(u)
    const path = x.pathname.replace(/\/+$/, '') || '/'
    return `${x.protocol}//${x.host.toLowerCase().replace(/^www\./, '')}${path}`
  } catch {
    return u.trim().replace(/\/+$/, '').toLowerCase()
  }
}

/** robots 里有没有 noindex（`none` 等于 noindex + nofollow）。 */
export function isNoindex(robots: string | undefined): boolean {
  return robots !== undefined && /\b(noindex|none)\b/.test(robots)
}

/** 结构化数据里出现过的类型（`@graph` 与数组摊平；去重、排序）。 */
export function schemaTypes(blocks: readonly unknown[]): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const t = o['@type']
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string') out.add(x)
    if (o['@graph'] !== undefined) walk(o['@graph'], depth + 1)
  }
  walk(blocks, 0)
  return [...out].sort()
}

/** 简单稳定的字串摘要（FNV-1a，32 位，十六进制）——基线里只存摘要，不存全文。 */
export function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 稳定序列化（键排序），摘要前用：同一份结构化数据换个键顺序不算「被改了」。 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** Product 节点的第一条报价（价格、币种）——改版回归只看「价格还在不在、变没变」。 */
function productOffer(blocks: readonly unknown[]): { price?: string; currency?: string } {
  const nodes: Record<string, unknown>[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    nodes.push(o)
    if (o['@graph'] !== undefined) walk(o['@graph'], depth + 1)
  }
  walk(blocks, 0)
  const isProduct = (o: Record<string, unknown>): boolean =>
    (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).some(
      (t) => typeof t === 'string' && /^(Product|ProductGroup)$/.test(t),
    )
  const p = nodes.find(isProduct)
  if (p === undefined) return {}
  const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers
  if (offers === null || typeof offers !== 'object') return {}
  const o = offers as Record<string, unknown>
  const price = o.price ?? o.lowPrice
  const currency = o.priceCurrency
  return {
    ...(price === undefined || price === null ? {} : { price: String(price) }),
    ...(typeof currency === 'string' ? { currency } : {}),
  }
}

/** 一页 → 改版回归的基线快照。 */
export function driftSnapshotOf(
  facts: PageSeoFacts,
  kind: DriftPageKind,
  captured_at: string,
): DriftSnapshot {
  const offer = productOffer(facts.jsonld.blocks)
  return {
    url: facts.url,
    kind,
    status: facts.status,
    ...(facts.title === undefined ? {} : { title: facts.title }),
    ...(facts.description === undefined ? {} : { description: facts.description }),
    ...(facts.canonicals[0] === undefined ? {} : { canonical: facts.canonicals[0] }),
    ...(facts.robots === undefined ? {} : { robots: facts.robots }),
    h1: facts.h1.slice(0, 5),
    schema: {
      types: schemaTypes(facts.jsonld.blocks),
      ...(offer.price === undefined ? {} : { product_price: offer.price }),
      ...(offer.currency === undefined ? {} : { product_currency: offer.currency }),
      hash: facts.jsonld.blocks.length === 0 ? '' : hash32(stable(facts.jsonld.blocks)),
    },
    captured_at,
  }
}
