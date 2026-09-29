/**
 * 教程文章、更新日志、条款三页共用的**安全** markdown → HTML（构建时跑，出静态字符串）。
 *
 * 移植自本仓 `apps/workstation/src/components/ui/safe-markdown.tsx`（提交 4f269bdb 那一版的
 * `parseMarkdown` / `linkKind` / 行内正则），工作台右栏「教程」与官网 `/docs/<slug>` 读同一份
 * `docs/help/*.md`，所以规则也得是同一套。块的认法一字未改；改的只是出口：React 节点 → 转义过的 HTML 字符串。
 *
 * 四条安全纪律照旧：
 * 1. **不解析 HTML**：每个字符都先转义，`<script>` 就是七个字；
 * 2. **不加载图片**：`![说明](地址)` 只留说明文字；
 * 3. **链接只认三种**：`http(s)://`（新窗口、`noopener noreferrer`）、`help:<slug>`（→ 官网 `/docs/<slug>/`）、
 *    工作台站内路径 `/…`（官网上没有这些页面 → 只留文字，后面补一句「在工作台里」）；其余原样当字；
 * 4. 不引 remark / rehype：手写的这一份天然没有 HTML 这条路。
 */

export type MarkdownBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lang: string; lines: string[] }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const NUMBERED = /^(\d{1,3})[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const TABLE_RULE = /^\|[\s:|-]+\|$/

/** 一行一行认成块（与工作台 `parseMarkdown` 同一套规则）。 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length > 0) out.push({ kind: 'p', lines: para })
    para = []
  }
  const push = (block: MarkdownBlock): void => {
    flush()
    const last = out.at(-1)
    if (block.kind === 'ul' && last?.kind === 'ul') last.items.push(...block.items)
    else if (block.kind === 'ol' && last?.kind === 'ol') last.items.push(...block.items)
    else if (block.kind === 'table' && last?.kind === 'table') last.rows.push(...block.rows)
    else if (block.kind === 'quote' && last?.kind === 'quote') last.lines.push(...block.lines)
    else out.push(block)
  }
  let code: { kind: 'code'; lang: string; lines: string[] } | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (code !== undefined) {
      if (line.startsWith('```')) {
        out.push(code)
        code = undefined
      } else code.lines.push(raw)
      continue
    }
    if (line.startsWith('```')) {
      flush()
      code = { kind: 'code', lang: line.slice(3).trim(), lines: [] }
      continue
    }
    if (line === '') {
      flush()
      out.push({ kind: 'p', lines: [] })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      push({ kind: 'h', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet?.[1] !== undefined) {
      push({ kind: 'ul', items: [bullet[1]] })
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      push({ kind: 'ol', start: Number(numbered[1]), items: [numbered[2]] })
      continue
    }
    if (line.length > 1 && line.startsWith('|') && line.endsWith('|')) {
      if (TABLE_RULE.test(line)) {
        flush()
        continue
      }
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
      push({ kind: 'table', rows: [cells] })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote?.[1] !== undefined) {
      push({ kind: 'quote', lines: [quote[1]] })
      continue
    }
    para.push(line)
  }
  flush()
  if (code !== undefined) out.push(code)
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0)
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** HTML 转义（文本节点与属性值都用它）。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c)
}

export type Lang = 'zh' | 'en'

export interface RenderOptions {
  lang: Lang
  /** 哪些 slug 是真有的教程（`help:<slug>` 只认这些）。 */
  helpSlugs: readonly string[]
  /**
   * 站内路径 `/…` 指哪儿：`app`（默认）= 工作台里的页面（官网上没有，只留文字 +「在工作台里」）；
   * `site` = 官网自己的页面（条款互链），英文页自动加 `/en` 前缀。
   */
  internal?: 'app' | 'site'
}

/** 这个地址能不能做成链接、做成哪种；`undefined` = 原样当字（与工作台 `linkKind` 同一套）。 */
export function linkKind(
  href: string,
  helpSlugs: readonly string[],
): 'external' | 'help' | 'internal' | undefined {
  if (/^https?:\/\/[^\s]+$/i.test(href)) return 'external'
  if (href.startsWith('help:') && helpSlugs.includes(href.slice(5))) return 'help'
  if (href.startsWith('/') && !href.startsWith('//')) return 'internal'
  return undefined
}

/** 官网上一篇教程的地址。 */
export function docHref(slug: string, lang: Lang): string {
  return `${lang === 'en' ? '/en' : ''}/docs/${slug}/`
}

const INLINE =
  /!\[([^\]\n]*)\]\(([^)\s]*)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+)`/g

const IN_APP: Record<Lang, string> = { zh: '（在工作台里）', en: ' (in the app)' }

/** 一行里的行内记号 → HTML；认不出、不许做成链接的原样当字（转义过）。 */
export function renderInline(text: string, o: RenderOptions): string {
  let html = ''
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) html += escapeHtml(text.slice(last, at))
    const [whole, imgAlt, , linkText, href, bold1, bold2, code] = m
    if (imgAlt !== undefined) {
      html += escapeHtml(imgAlt)
    } else if (linkText !== undefined && href !== undefined) {
      const kind = linkKind(href, o.helpSlugs)
      const label = renderInline(linkText, o)
      if (kind === 'external')
        html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      else if (kind === 'help') html += `<a href="${docHref(href.slice(5), o.lang)}">${label}</a>`
      else if (kind === 'internal' && o.internal === 'site')
        html += `<a href="${escapeHtml(o.lang === 'en' ? `/en${href}` : href)}">${label}</a>`
      else if (kind === 'internal')
        html += `<span class="in-app">${label}</span>${escapeHtml(IN_APP[o.lang])}`
      else html += escapeHtml(whole)
    } else if (bold1 !== undefined || bold2 !== undefined) {
      html += `<strong>${renderInline(bold1 ?? bold2 ?? '', o)}</strong>`
    } else if (code !== undefined) {
      html += `<code>${escapeHtml(code)}</code>`
    }
    last = at + whole.length
  }
  if (last < text.length) html += escapeHtml(text.slice(last))
  return html
}

/** 标题的锚点 id：去掉记号，留中英文与数字，空白变连字符。 */
export function headingId(text: string): string {
  return text
    .replace(/[*_`[\]()]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

export interface RenderedDoc {
  /** 第一个 `#` 标题（页面标题用）；没有就空串。 */
  title: string
  /** 正文里第一段（description 用），纯文字。 */
  summary: string
  /** 二级标题（目录用）。 */
  toc: { id: string; text: string }[]
  html: string
}

/** 纯文字：去掉行内记号，只留字。 */
export function plainText(text: string): string {
  return text
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
}

/** 一整篇 → HTML（第一个 `#` 标题拿出来当页面标题，不重复画在正文里）。 */
export function renderDoc(text: string, o: RenderOptions): RenderedDoc {
  const blocks = parseMarkdown(text)
  let title = ''
  let summary = ''
  const toc: RenderedDoc['toc'] = []
  const parts: string[] = []
  for (const b of blocks) {
    if (b.kind === 'h') {
      if (b.level === 1 && title === '') {
        title = plainText(b.text)
        continue
      }
      const level = Math.min(Math.max(b.level, 2), 4)
      const id = headingId(plainText(b.text))
      if (level === 2) toc.push({ id, text: plainText(b.text) })
      parts.push(`<h${level} id="${escapeHtml(id)}">${renderInline(b.text, o)}</h${level}>`)
    } else if (b.kind === 'p') {
      if (summary === '') summary = plainText(b.lines.join(' '))
      parts.push(`<p>${b.lines.map((l) => renderInline(l, o)).join(' ')}</p>`)
    } else if (b.kind === 'ul') {
      parts.push(`<ul>${b.items.map((i) => `<li>${renderInline(i, o)}</li>`).join('')}</ul>`)
    } else if (b.kind === 'ol') {
      const start = b.start === 1 ? '' : ` start="${b.start}"`
      parts.push(
        `<ol${start}>${b.items.map((i) => `<li>${renderInline(i, o)}</li>`).join('')}</ol>`,
      )
    } else if (b.kind === 'table') {
      const [head, ...body] = b.rows
      const th = (head ?? []).map((c) => `<th>${renderInline(c, o)}</th>`).join('')
      const tr = body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, o)}</td>`).join('')}</tr>`)
        .join('')
      parts.push(
        `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`,
      )
    } else if (b.kind === 'code') {
      parts.push(`<pre><code>${escapeHtml(b.lines.join('\n'))}</code></pre>`)
    } else {
      parts.push(`<p class="callout">${b.lines.map((l) => renderInline(l, o)).join('<br>')}</p>`)
    }
  }
  return { title, summary, toc, html: parts.join('\n') }
}

/** 源文件开头的 HTML 注释（只给改稿的人看，比如「上线前建议律师审阅」）拿掉，不上页面。 */
export function stripSourceComments(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/u, '')
}

/** 最简的 frontmatter：`---` 包着的 `key: value` 行。 */
export function splitFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/u.exec(text)
  if (m === null) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line.trim())
    if (kv?.[1] !== undefined) data[kv[1]] = (kv[2] ?? '').replace(/^['"]|['"]$/gu, '')
  }
  return { data, body: text.slice(m[0].length) }
}
