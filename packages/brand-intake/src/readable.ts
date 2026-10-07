/**
 * WP246：**网页转文字**（本机那一级）——任意网页 → 干净正文 markdown。
 *
 * 思路是 readability 那一路（找正文块、去导航页眉页脚侧栏、看链接密度），代码是自己写的、
 * 不引任何解析库：一个宽容的小建树器（标签不配对也不崩）+ 打分 + 转 markdown。
 * 与 `html.ts` 同一个态度：取不准就照实少给，不编。
 *
 * 只认结构，不跑页面脚本——靠脚本现画的页面（单页应用）抽不出正文，调用方照实说「本机抽不出」，
 * 要不要转给第三方（默认关）由设置决定。
 */
import { decodeEntities } from './html.js'

interface El {
  tag: string
  attrs: Record<string, string>
  children: Node[]
  parent?: El
}
type Node = El | string

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
/** 整块扔掉（连里面的字）。 */
const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'button',
  'select',
  'textarea',
  'nav',
  'header',
  'footer',
  'aside',
  'canvas',
  'object',
  'dialog',
  'menu',
])
/** class / id 里带这些词的块当页面零件（导航、分享、cookie 条……）。 */
const BOILERPLATE =
  /(^|[\s_-])(nav|navbar|menu|header|footer|sidebar|breadcrumbs?|cookie|consent|banner|share|social|related|newsletter|subscribe|popup|modal|advert|ads?|promo|skip|toolbar|comments?)($|[\s_-])/iu
const BLOCKS = new Set(['article', 'main', 'section', 'div', 'td'])

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(/([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu)) {
    const k = m[1]?.toLowerCase()
    if (k !== undefined) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** 宽容的建树：认不出的闭合标签忽略；没闭合的到父级闭合时一起收。 */
export function parseHtmlTree(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] }
  let cur = root
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</gu
  const lower = html.toLowerCase()
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const tok = m[0]
    const name = m[1]?.toLowerCase()
    if (name === undefined) {
      if (tok.startsWith('<!') || tok.startsWith('<!--')) continue
      cur.children.push(tok)
      continue
    }
    if (tok.startsWith('</')) {
      let p: El | undefined = cur
      while (p !== undefined && p.tag !== name) p = p.parent
      if (p?.parent !== undefined) cur = p.parent
      continue
    }
    const el: El = { tag: name, attrs: parseAttrs(m[2] ?? ''), children: [], parent: cur }
    // `<p>` 碰到下一个 `<p>` / 块，`<li>` 碰到下一个 `<li>`：先收上一个（HTML 的隐式闭合，够用即可）
    if ((name === 'p' || name === 'li') && cur.tag === name && cur.parent !== undefined)
      cur = cur.parent
    cur.children.push(el)
    if (VOID.has(name) || tok.endsWith('/>')) continue
    if (name === 'script' || name === 'style') {
      // 原文里的 `<` 别当标签：直接跳到对应的闭合标签
      const close = lower.indexOf(`</${name}`, m.index + tok.length)
      re.lastIndex = close < 0 ? html.length : close
      continue
    }
    cur = el
  }
  return root
}

const isEl = (n: Node): n is El => typeof n !== 'string'

function textOf(n: Node): string {
  if (!isEl(n)) return n
  if (DROP.has(n.tag)) return ''
  return n.children.map(textOf).join(' ')
}
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim()

function linkTextLen(el: El): number {
  let n = 0
  for (const c of el.children)
    if (isEl(c)) n += c.tag === 'a' ? squash(decodeEntities(textOf(c))).length : linkTextLen(c)
  return n
}

function isBoilerplate(el: El): boolean {
  if (DROP.has(el.tag)) return true
  const role = el.attrs.role ?? ''
  if (/^(navigation|banner|contentinfo|complementary|search|dialog)$/iu.test(role)) return true
  if (el.attrs.hidden !== undefined || el.attrs['aria-hidden'] === 'true') return true
  return BOILERPLATE.test(`${el.attrs.class ?? ''} ${el.attrs.id ?? ''}`)
}

function walk(el: El, visit: (e: El) => void): void {
  visit(el)
  for (const c of el.children) if (isEl(c)) walk(c, visit)
}

/** 正文块：先 `<article>`（字最多的那个）→ `<main>` / `role=main` → 段落分最高的块。 */
function pickRoot(body: El): El {
  const all: El[] = []
  walk(body, (e) => all.push(e))
  const len = (e: El): number => squash(decodeEntities(textOf(e))).length
  const articles = all.filter((e) => e.tag === 'article').sort((a, b) => len(b) - len(a))
  if (articles[0] !== undefined && len(articles[0]) > 200) return articles[0]
  const main = all.find((e) => e.tag === 'main' || e.attrs.role === 'main')
  if (main !== undefined && len(main) > 200) return main
  // 每个 <p> 给它的父块加分（字越多分越高），父的父加一半；链接多的块打折
  const score = new Map<El, number>()
  for (const p of all.filter((e) => e.tag === 'p' || e.tag === 'pre' || e.tag === 'blockquote')) {
    const t = squash(decodeEntities(textOf(p)))
    if (t.length < 25) continue
    const s =
      1 + Math.min(3, Math.floor(t.length / 100)) + (t.match(/[,，。.]/gu)?.length ?? 0) * 0.2
    let up = p.parent
    for (let depth = 0; up !== undefined && depth < 3; depth += 1, up = up.parent) {
      if (!BLOCKS.has(up.tag) && up.tag !== 'body') continue
      score.set(up, (score.get(up) ?? 0) + s / (depth + 1))
    }
  }
  let best: El | undefined
  let bestScore = 0
  for (const [el, s] of score) {
    const total = len(el)
    const density = total === 0 ? 1 : linkTextLen(el) / total
    const adjusted = s * (1 - density)
    if (adjusted > bestScore) {
      best = el
      bestScore = adjusted
    }
  }
  return best ?? body
}

function abs(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/** 一个块转 markdown（行内与块级混排，最后再压空行）。 */
function toMarkdown(el: El, base: string, listDepth = 0): string {
  const inner = (e: El): string =>
    e.children
      .map((c) =>
        isEl(c) ? toMarkdown(c, base, listDepth) : decodeEntities(c).replace(/\s+/gu, ' '),
      )
      .join('')
  if (isBoilerplate(el)) {
    // 带 boilerplate 字样、但正文大半在它里面（有的站把正文包在 class="content-header-wrapper" 里）：照留
    return linkTextLen(el) * 2 < squash(textOf(el)).length &&
      squash(textOf(el)).length > 600 &&
      !DROP.has(el.tag)
      ? inner(el)
      : ''
  }
  const t = el.tag
  if (/^h[1-6]$/u.test(t)) {
    const text = squash(inner(el))
    return text === '' ? '' : `\n\n${'#'.repeat(Number(t[1]))} ${text}\n\n`
  }
  if (
    t === 'p' ||
    t === 'div' ||
    t === 'section' ||
    t === 'article' ||
    t === 'main' ||
    t === 'figure'
  )
    return `\n\n${inner(el)}\n\n`
  if (t === 'br') return '  \n'
  if (t === 'hr') return '\n\n---\n\n'
  if (t === 'strong' || t === 'b') {
    const s = squash(inner(el))
    return s === '' ? '' : ` **${s}** `
  }
  if (t === 'em' || t === 'i') {
    const s = squash(inner(el))
    return s === '' ? '' : ` _${s}_ `
  }
  if (t === 'a') {
    const s = squash(inner(el))
    const href = el.attrs.href === undefined ? undefined : abs(el.attrs.href, base)
    if (s === '') return ''
    return href === undefined ? s : ` [${s}](${href}) `
  }
  if (t === 'code') return `\`${squash(inner(el))}\``
  if (t === 'pre') return `\n\n\`\`\`\n${decodeEntities(textOf(el)).trim()}\n\`\`\`\n\n`
  if (t === 'blockquote')
    return `\n\n${squash(inner(el))
      .split(/\n+/u)
      .map((l) => `> ${l}`)
      .join('\n')}\n\n`
  if (t === 'ul' || t === 'ol') {
    let i = 0
    const items = el.children.filter(isEl).filter((c) => c.tag === 'li')
    const lines = items.map((li) => {
      i += 1
      const body = squash(toMarkdown({ ...li, tag: 'span' }, base, listDepth + 1))
      return `${'  '.repeat(listDepth)}${t === 'ol' ? `${i}.` : '-'} ${body}`
    })
    return `\n\n${lines.filter((l) => !/^\s*(-|\d+\.)\s*$/u.test(l)).join('\n')}\n\n`
  }
  if (t === 'tr') {
    const cells = el.children.filter(isEl).filter((c) => c.tag === 'td' || c.tag === 'th')
    return `\n| ${cells.map((c) => squash(inner(c)).replace(/\|/gu, '/')).join(' | ')} |`
  }
  if (t === 'table') return `\n\n${inner(el).trim()}\n\n`
  if (t === 'img') return ''
  return inner(el)
}

export interface ReadableResult {
  title?: string
  /** 干净正文（markdown）。 */
  markdown: string
  /** 正文字数（判断「抽没抽出来」）。 */
  chars: number
  truncated: boolean
  /** 页面声明的语言（`<html lang>`）。 */
  lang?: string
}

/** 最多留多少字（再多模型那一步只是更贵）。 */
export const READABLE_MAX_CHARS = 40_000

/** 网页 → 干净正文。`url` 用来把相对链接补成绝对的。 */
export function htmlToReadable(
  html: string,
  url: string,
  maxChars = READABLE_MAX_CHARS,
): ReadableResult {
  const tree = parseHtmlTree(html)
  let body: El = tree
  let lang: string | undefined
  let title: string | undefined
  walk(tree, (e) => {
    if (e.tag === 'html' && lang === undefined && e.attrs.lang !== undefined) lang = e.attrs.lang
    if (e.tag === 'body' && body === tree) body = e
    if (
      e.tag === 'meta' &&
      title === undefined &&
      /^(og:title|twitter:title)$/iu.test(e.attrs.property ?? e.attrs.name ?? '')
    )
      title = squash(e.attrs.content ?? '') || undefined
  })
  if (title === undefined) {
    let t: string | undefined
    walk(tree, (e) => {
      if (e.tag === 'title' && t === undefined) t = squash(decodeEntities(textOf(e)))
    })
    title = t === '' ? undefined : t
  }
  const root = pickRoot(body)
  let md = toMarkdown(root, url)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/ +([,.;:!?，。；：！？)])/gu, '$1')
    .trim()
  md = md.replace(/^(skip to (main )?content|跳到正文|跳至内容)\s*/iu, '')
  const truncated = md.length > maxChars
  if (truncated) md = `${md.slice(0, maxChars)}\n\n…（后面还有，截断了）`
  const chars = md.replace(/\]\([^)]*\)/gu, ']').replace(/[#*_`>[\]|\-\s]/gu, '').length
  return {
    ...(title === undefined ? {} : { title }),
    markdown: md,
    chars,
    truncated,
    ...(lang === undefined ? {} : { lang }),
  }
}
