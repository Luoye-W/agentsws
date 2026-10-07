/**
 * 从 HTML 里把结构化的那部分读出来（70 §4）。
 *
 * **全是正则，没有 DOM。** 理由不是图快：装一个 HTML 解析器意味着把别人页面上
 * 的任意标记喂给一个有状态的解析状态机，而我们要的只有三样东西——JSON-LD 那几个
 * `<script>`、`<meta property="og:…">`、几个 `<link rel>`。这三样都能用锚定的正则
 * 取干净，取不到就是取不到。
 *
 * **三层，先到先得，一层模型都不用**（这一段是 KefuAgent 那边验过的顺序）：
 *
 * 1. `jsonld` —— 站方自己声明的结构化数据。机器写给机器的，把握度 `high`。
 * 2. `og` —— 分享卡片用的那几个 meta。也是声明的，但常年不更新，`high`。
 * 3. `microdata` —— `itemprop`。`medium`。
 *
 * 三层都空才轮到模型，那一步的把握度一律 `low`。
 */

/** `<script type="application/ld+json">` 里那些对象（解析不了的整块跳过）。 */
export function jsonLdNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    const raw = m[1]
    if (raw === undefined) continue
    try {
      push(JSON.parse(raw) as unknown, out)
    } catch {
      // 站上的 JSON-LD 写坏了是常事。坏的那一块跳过，别的照读。
    }
  }
  return out
}

/** 摊平 `@graph` 与数组。 */
function push(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) push(n, out)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const obj = node as Record<string, unknown>
  out.push(obj)
  const graph = obj['@graph']
  if (graph !== undefined) push(graph, out)
}

/** `@type` 对得上吗（`@type` 可能是数组）。 */
export function isType(node: Record<string, unknown>, pattern: RegExp): boolean {
  const t = node['@type']
  if (typeof t === 'string') return pattern.test(t)
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && pattern.test(x))
  return false
}

/** 取一个 `og:` / `twitter:` meta。 */
export function metaContent(html: string, property: string): string | undefined {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const byProperty = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${esc}["'][^>]*>`, 'i')
  const tag = byProperty.exec(html)?.[0]
  if (tag === undefined) return undefined
  const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
  return content === undefined || content.trim() === '' ? undefined : decodeEntities(content.trim())
}

/** `<link rel="…">` 的 href。 */
export function linkHref(html: string, rel: RegExp): string | undefined {
  for (const m of html.matchAll(/<link[^>]*>/gi)) {
    const tag = m[0]
    const relValue = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (relValue === undefined || !rel.test(relValue)) continue
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (href !== undefined && href.trim() !== '') return href.trim()
  }
  return undefined
}

/** `<title>`。 */
export function titleOf(html: string): string | undefined {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  return t === undefined ? undefined : squash(decodeEntities(stripTags(t)))
}

/** 页面里所有 `href`（原样，没解析成绝对地址）。 */
export function hrefs(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const h = m[1]
    if (h !== undefined) out.push(h)
  }
  return out
}

/** 去标签、解实体、压空白——给模型那一步与"口吻样例"用的正文。 */
export function visibleText(html: string, maxChars = 8000): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  return squash(decodeEntities(stripTags(body))).slice(0, maxChars)
}

/**
 * WP244：**正文**——政策摘要、口吻样例用它，不用整页文字。
 *
 * 整页文字开头总是页头那一串：「Skip to content」、导航（Home Catalog Contact）、购物车（Cart 0）。
 * 拿它当政策摘要，摘要的前一半就是导航（Fable 10-07 真机）。所以：有 `<main>` 只取 `<main>`；
 * 再把页头 / 导航 / 页脚 / 侧栏整块去掉，最后把「跳到正文」那一句去掉。
 */
export function mainText(html: string, maxChars = 8000): string {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]
  const body = (main ?? html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
  const text = squash(decodeEntities(stripTags(body)))
    .replace(/^(skip to (main )?content|跳到正文|跳至内容)\s*/i, '')
    .trim()
  return text.slice(0, maxChars)
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ')
}

export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 常见的命名实体。WP244：Shopify 的政策页满是 `&ndash;` / `&rsquo;` / `&hellip;`，
 * 以前只认五个，摘要里就留着一串 `&ndash;`（Fable 10-07 真机）。
 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  shy: '',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwj: '',
  zwnj: '',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (whole, name: string) => {
    const known = ENTITIES[name] ?? ENTITIES[name.toLowerCase()]
    if (known !== undefined) return known
    if (name.startsWith('#')) {
      // `&#8211;` 与 `&#x2013;` 两种写法都有
      const raw = name.slice(1)
      const code = /^x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw.slice(1), 16) : Number(raw)
      if (Number.isFinite(code) && code > 0 && code < 0x10ffff) return String.fromCodePoint(code)
    }
    return whole
  })
}

/** 相对地址补成绝对（补不成就丢掉——一个补错的地址比没有更糟）。 */
export function absolute(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    u.hash = ''
    return u.toString()
  } catch {
    return undefined
  }
}

/** 页面上第一个 `#rrggbb` 主题色（`<meta name="theme-color">` 优先）。 */
export function themeColor(html: string): string | undefined {
  const meta = metaContent(html, 'theme-color')
  const pick = meta ?? /--(?:brand|primary)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(html)?.[1]
  if (pick === undefined) return undefined
  const hex = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.exec(pick.trim())?.[0]
  return hex === undefined ? undefined : hex.toLowerCase()
}
