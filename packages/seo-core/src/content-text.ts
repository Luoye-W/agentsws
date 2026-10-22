/**
 * WP449：把一篇稿子（Shopify 的 `body_html`、Markdown，或纯文字）拆成**块**与**句子**，链接留着位置。
 *
 * 发布前质检的几样新检查都要它：引用核查要知道「哪一句带着哪个外链」，「好不好被 AI 引用」要知道
 * 小标题、段落、列表、表格各有几块，市场版本检查要逐句看。以前质检直接拿原文切句，HTML 标签和
 * 链接里的网址（`/statistics/12345`）会被当成正文里的数——这里先把它们剥掉。
 *
 * 纯函数、同输入同输出；认不出的标签一律当行内文字处理，不抛。
 */

export interface ContentLink {
  href: string
  /** 链接上的字（Markdown 的 `[字](网址)`；裸网址就是网址本身）。 */
  text: string
  /** 在这一块纯文字里的起止位置。 */
  start: number
  end: number
}

export interface ContentBlock {
  kind: 'heading' | 'paragraph' | 'list_item' | 'table_row'
  /** 小标题的级别（1–6）。 */
  level?: number
  /** 列表项：有序（1. 2. 3.）还是无序。 */
  ordered?: boolean
  /** 去过标签、解过实体、压过空白的纯文字。 */
  text: string
  links: ContentLink[]
}

export interface ContentSentence {
  text: string
  /** 这一句里的链接（网址原样）。 */
  links: string[]
  /** 属于第几块（`contentBlocks` 的下标）。 */
  block: number
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  pound: '£',
  deg: '°',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
}

/** 解常见实体（数字实体都认）。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#' && (e[1] === 'x' || e[1] === 'X'))
      return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e[0] === '#') return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** 看起来是不是 HTML（有块级标签）。 */
export function looksLikeHtml(body: string): boolean {
  return /<(p|h[1-6]|li|ul|ol|table|tr|div|br|section|article|blockquote)\b/i.test(body)
}

/** 一块在拼的时候：文字 + 链接（位置相对这一块）。 */
class Builder {
  text = ''
  links: ContentLink[] = []
  push(s: string): void {
    this.text += s
  }
  link(href: string, text: string): void {
    const start = this.text.length
    this.text += text
    this.links.push({ href, text, start, end: this.text.length })
  }
}

/** 压空白并把链接位置跟着挪（只压连续空白，位置照样对得上）。 */
function finish(
  b: Builder,
  kind: ContentBlock['kind'],
  extra: Partial<ContentBlock>,
): ContentBlock | undefined {
  let out = ''
  // pos[i]：原文第 i 个字符在压过空白的文字里落在哪（多一格给末尾）
  const pos: number[] = []
  let space = false
  for (let i = 0; i < b.text.length; i++) {
    const ch = b.text[i] ?? ''
    pos.push(out.length)
    if (/\s/.test(ch)) {
      if (!space && out !== '') out += ' '
      space = true
      continue
    }
    space = false
    out += ch
  }
  pos.push(out.length)
  const trimmed = out.trimEnd()
  if (trimmed === '') return undefined
  const links = b.links.map((l) => ({
    ...l,
    text: l.text.replace(/\s+/g, ' ').trim(),
    start: Math.min(pos[l.start] ?? trimmed.length, trimmed.length),
    end: Math.min(pos[l.end] ?? trimmed.length, trimmed.length),
  }))
  return { kind, text: trimmed, links, ...extra }
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'header',
  'footer',
  'figure',
  'figcaption',
])

function htmlBlocks(html: string): ContentBlock[] {
  const src = html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const blocks: ContentBlock[] = []
  const lists: ('ol' | 'ul')[] = []
  let cur = new Builder()
  let kind: ContentBlock['kind'] = 'paragraph'
  let extra: Partial<ContentBlock> = {}
  let href: string | undefined
  let anchor = ''
  const flush = (): void => {
    if (href !== undefined) {
      cur.link(href, decodeEntities(anchor))
      href = undefined
      anchor = ''
    }
    const b = finish(cur, kind, extra)
    if (b !== undefined) blocks.push(b)
    cur = new Builder()
    kind = 'paragraph'
    extra = {}
  }
  const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi
  let last = 0
  for (const m of src.matchAll(re)) {
    const textBefore = decodeEntities(src.slice(last, m.index))
    if (href !== undefined) anchor += textBefore
    else cur.push(textBefore)
    last = (m.index ?? 0) + m[0].length
    const closing = m[1] === '/'
    const tag = (m[2] ?? '').toLowerCase()
    if (tag === 'a') {
      if (!closing) {
        const h = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3] ?? '')
        const value = h?.[2] ?? h?.[3] ?? h?.[4]
        if (value !== undefined && value.trim() !== '') {
          href = decodeEntities(value.trim())
          anchor = ''
        }
      } else if (href !== undefined) {
        cur.link(href, decodeEntities(anchor))
        href = undefined
        anchor = ''
      }
      continue
    }
    if (tag === 'br') {
      cur.push(' ')
      continue
    }
    if (tag === 'td' || tag === 'th') {
      if (!closing && cur.text.trim() !== '') cur.push(' | ')
      continue
    }
    if (!BLOCK_TAGS.has(tag)) continue
    if ((tag === 'ul' || tag === 'ol') && !closing) {
      flush()
      lists.push(tag)
      continue
    }
    if ((tag === 'ul' || tag === 'ol') && closing) {
      flush()
      lists.pop()
      continue
    }
    flush()
    if (closing) continue
    if (/^h[1-6]$/.test(tag)) {
      kind = 'heading'
      extra = { level: Number(tag.slice(1)) }
    } else if (tag === 'li') {
      kind = 'list_item'
      extra = { ordered: lists[lists.length - 1] === 'ol' }
    } else if (tag === 'tr') kind = 'table_row'
  }
  const tail = decodeEntities(src.slice(last))
  if (href !== undefined) anchor += tail
  else cur.push(tail)
  flush()
  return blocks
}

/** 一行 Markdown 里的链接（`[字](网址)`、`<网址>`、裸网址）→ 纯文字 + 链接位置。 */
function inlineMarkdown(line: string, b: Builder): void {
  const re =
    /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s)<>\]]+)/g
  let last = 0
  for (const m of line.matchAll(re)) {
    b.push(stripMarks(line.slice(last, m.index)))
    last = (m.index ?? 0) + m[0].length
    if (m[0].startsWith('!')) continue // 图片：替代文字不算正文
    if (m[2] !== undefined) b.link(m[2], stripMarks(m[1] ?? ''))
    else {
      const url = (m[3] ?? m[4] ?? '').replace(/[.,;:!?]+$/, '')
      b.link(url, url)
      const rest = (m[3] ?? m[4] ?? '').slice(url.length)
      if (rest !== '') b.push(rest)
    }
  }
  b.push(stripMarks(line.slice(last)))
}

/** 去掉行内强调记号（`**粗**`、`_斜_`、`` `码` ``）。 */
function stripMarks(s: string): string {
  return s.replace(/(\*\*|__|\*|`)/g, '')
}

function markdownBlocks(md: string): ContentBlock[] {
  const blocks: ContentBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length === 0) return
    const b = new Builder()
    inlineMarkdown(para.join(' '), b)
    const out = finish(b, 'paragraph', {})
    if (out !== undefined) blocks.push(out)
    para = []
  }
  const one = (line: string, kind: ContentBlock['kind'], extra: Partial<ContentBlock>): void => {
    const b = new Builder()
    inlineMarkdown(line, b)
    const out = finish(b, kind, extra)
    if (out !== undefined) blocks.push(out)
  }
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') {
      flushPara()
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
    if (h !== null) {
      flushPara()
      one(h[2] ?? '', 'heading', { level: (h[1] ?? '#').length })
      continue
    }
    const ul = /^[-*+•]\s+(.*)$/.exec(line)
    if (ul !== null) {
      flushPara()
      one(ul[1] ?? '', 'list_item', { ordered: false })
      continue
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ol !== null) {
      flushPara()
      one(ol[1] ?? '', 'list_item', { ordered: true })
      continue
    }
    if (/^\|.*\|$/.test(line)) {
      flushPara()
      if (/^\|[\s:|-]+\|$/.test(line)) continue // 表头下面那条分隔线
      one(
        line
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim())
          .join(' | '),
        'table_row',
        {},
      )
      continue
    }
    para.push(line)
  }
  flushPara()
  return blocks
}

/**
 * 一篇稿子 → 块。`title` 给了就当第一块（一级小标题）。HTML 按标签认；否则按 Markdown 认
 * （纯文字也走这一条：一行一段落）。
 */
export function contentBlocks(body: string, title?: string): ContentBlock[] {
  const head: ContentBlock[] =
    title !== undefined && title.trim() !== ''
      ? [{ kind: 'heading', level: 1, text: title.replace(/\s+/g, ' ').trim(), links: [] }]
      : []
  const blocks = looksLikeHtml(body) ? htmlBlocks(body) : markdownBlocks(body)
  return [...head, ...blocks]
}

/** 一块纯文字按句切成区间（中英文句末标点；`.` 后面要跟空白才算句末，免得切开 `4.5`）。 */
function sentenceRanges(text: string): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    const end =
      ch === '。' ||
      ch === '！' ||
      ch === '？' ||
      ((ch === '!' || ch === '?') && (next === undefined || /\s/.test(next))) ||
      (ch === '.' && (next === undefined || /\s/.test(next)))
    if (!end) continue
    out.push([start, i + 1])
    start = i + 1
  }
  if (start < text.length) out.push([start, text.length])
  return out
    .map(([a, b]): [number, number] => {
      let s = a
      let e = b
      while (s < e && /\s/.test(text[s] ?? '')) s++
      while (e > s && /\s/.test(text[e - 1] ?? '')) e--
      return [s, e]
    })
    .filter(([a, b]) => b > a)
}

/** 块 → 句（每句带着落在它里面的链接）。 */
export function contentSentences(blocks: readonly ContentBlock[]): ContentSentence[] {
  const out: ContentSentence[] = []
  blocks.forEach((b, block) => {
    for (const [s, e] of sentenceRanges(b.text))
      out.push({
        text: b.text.slice(s, e),
        links: b.links.filter((l) => l.start < e && l.end > s).map((l) => l.href),
        block,
      })
  })
  return out
}

/** 整篇的纯文字（块之间空一行）。 */
export function contentPlainText(blocks: readonly ContentBlock[]): string {
  return blocks.map((b) => b.text).join('\n\n')
}
