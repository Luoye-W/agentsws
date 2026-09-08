/**
 * 邮件正文与线程头的纯函数（无 IO、无时间、无随机）。
 * 入站文本的两条规矩：① HTML 只取可读文本 ② 引用尾巴（上一封的原文）不进 `parts.text`——
 * 它已经在 raw 区，重复喂给模型只会放大注入面并烧 token。
 */

const HTML_DROP_BLOCKS =
  /<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<!doctype[^>]*>/gi
/** 引用块：blockquote 与 Gmail / Outlook 的引用容器 */
const HTML_QUOTE_BLOCKS =
  /<blockquote\b[\s\S]*?<\/blockquote\s*>|<div\b[^>]*(?:class|id)\s*=\s*["']?[^"'>]*(?:gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|OLK_SRC_BODY_SECTION|divRplyFwdMsg)[^"'>]*["']?[^>]*>[\s\S]*$/gi
const HTML_BREAKS = /<(?:br|hr)\s*\/?>/gi
const HTML_BLOCK_END =
  /<\/(?:p|div|tr|li|ul|ol|table|h1|h2|h3|h4|h5|h6|blockquote|section|article|pre)\s*>/gi
const HTML_TAG = /<[^>]*>/g

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    const known = ENTITIES[key]
    if (known !== undefined) return known
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return whole
  })
}

/** HTML → 纯文本：先扔掉脚本/样式与**引用块**，再把块级标签折成换行。 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(HTML_DROP_BLOCKS, ' ')
    .replace(HTML_QUOTE_BLOCKS, '\n')
    .replace(HTML_BREAKS, '\n')
    .replace(HTML_BLOCK_END, '\n')
    .replace(HTML_TAG, '')
  return normalizeText(decodeEntities(stripped))
}

/** 统一换行、去行尾空白、压掉三行以上空行。 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .trim()
}

const QUOTE_MARKERS: readonly RegExp[] = [
  /^\s*-{2,}\s*(?:original message|forwarded message|原始邮件|以下为引用内容)\s*-{2,}/i,
  /^\s*_{10,}\s*$/,
  /^\s*On\b.{0,400}\bwrote:\s*$/i,
  /^\s*(?:在)?.{0,200}(?:写道|於.{0,60}寫道)[:：]\s*$/,
  /^\s*From:\s*\S+/i,
  /^\s*发件人[:：]\s*\S+/,
  /^\s*>/,
  /^\s*Sent from Mail for\b/i,
]

/**
 * 去掉引用尾巴：命中第一个引用标记即截断。
 * 多行的 `On <date>,\n<name> wrote:` 也算——把相邻两行拼起来再判一次。
 */
export function stripQuotedTail(text: string): string {
  const lines = normalizeText(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (QUOTE_MARKERS.some((re) => re.test(line)))
      return normalizeText(lines.slice(0, i).join('\n'))
    if (/^\s*On\b/i.test(line)) {
      const joined = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ')
      if (/\bwrote:\s*$/i.test(joined.trimEnd())) return normalizeText(lines.slice(0, i).join('\n'))
    }
  }
  return normalizeText(lines.join('\n'))
}

/** `Message-ID` 规整成 `<id>` 形态；空串返回 undefined。 */
export function normalizeMessageId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  const trimmed = id.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed
  return `<${trimmed.replace(/^<|>$/g, '')}>`
}

/** `References` / `In-Reply-To` 头拆成 message-id 列表（保序去重）。 */
export function parseReferences(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  const text = Array.isArray(value) ? value.join(' ') : String(value)
  const out: string[] = []
  for (const m of text.matchAll(/<[^<>\s]+>/g)) {
    const id = m[0]
    if (!out.includes(id)) out.push(id)
  }
  return out
}

export interface ThreadHeaders {
  message_id?: string
  in_reply_to?: string
  references?: string[]
}

/**
 * 线程 id：`In-Reply-To` / `References` 的**首个**（= 线程根），否则用本封 `Message-ID`。
 * 18 §2.1 的 `thread.external_id`。
 */
export function threadExternalId(h: ThreadHeaders): string | undefined {
  const refs = h.references ?? []
  const root = refs[0] ?? normalizeMessageId(h.in_reply_to)
  return root ?? normalizeMessageId(h.message_id)
}

/** 回复主题：已经是 `Re:` 就不再叠加。 */
export function replySubject(subject: string | undefined): string {
  const base = (subject ?? '').trim()
  if (base.length === 0) return 'Re:'
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`
}

export interface ReplyHeaders {
  subject: string
  in_reply_to?: string
  references?: string
}

/** 回复头：`In-Reply-To` = 被回的那封，`References` = 原链 + 被回的那封。 */
export function buildReplyHeaders(input: {
  subject?: string
  reply_to_message_id?: string
  references?: readonly string[]
}): ReplyHeaders {
  const target = normalizeMessageId(input.reply_to_message_id)
  const chain = [...(input.references ?? [])]
  if (target !== undefined && !chain.includes(target)) chain.push(target)
  return {
    subject: replySubject(input.subject),
    ...(target === undefined ? {} : { in_reply_to: target }),
    ...(chain.length === 0 ? {} : { references: chain.join(' ') }),
  }
}

/** `Name <a@b.c>` → `a@b.c`（小写）；解析不出就返回去空白后的原串。 */
export function normalizeAddress(address: string): string {
  const m = address.match(/<([^<>]+)>/)
  return (m?.[1] ?? address).trim().toLowerCase()
}
