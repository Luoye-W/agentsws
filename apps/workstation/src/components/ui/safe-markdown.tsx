/**
 * WP157：工作台里**唯一的**安全 markdown 渲染——时间线的 Agent 回话（WP153 `ReplyMarkdown`）
 * 与右栏教程文章（WP156 `HelpArticle`）原来各写了一份，这里合成一份，取两者之并：
 *
 * - 块：段落（空行断段）、`-` / `*` / `+` 列表、`1.` / `1)` 编号（从写的那个数接着数）、
 *   `#` 标题、`| a | b |` 表格、`>` 提示框；
 * - 行内：`**粗体**` / `__粗体__`、`` `行内代码` ``、`[文字](地址)`、`![说明](地址)`（只留说明）。
 *
 * 两种排法（`variant`）只差外观：`reply` 时间线里标题画成粗体一行、段内换行照留；
 * `article` 教程里标题分大小、段内软换行拼成一段。
 *
 * ## 四条安全纪律（回话是模型写的，教程也可能被人改）
 *
 * 1. **不解析 HTML**：一个字符都不变成标签，全部走 React 的文本节点（`<script>` 就是七个字）；
 * 2. **不加载图片**：`![说明](地址)` 只留说明文字，外链图片一张都不拉；
 * 3. **链接只认三种**：`http(s)://`（新窗口、`rel="noopener noreferrer"`）、站内 `/…`（不是 `//`，
 *    用路由跳）、`help:<slug>`（教程互链：在右栏换成那一篇）。`javascript:`、`data:`、`//` 开头、
 *    指向不存在的教程——一律原样当字；
 * 4. 为几种节点不引 `remark` + `sanitize`：手写的这一份天然没有 HTML 这条路。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useRailState } from '@/components/rail/rail-state'
import { helpAddress, isHelpSlug } from '@/lib/help'
import { cn } from '@/lib/utils'

export type MarkdownBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'quote'; lines: string[] }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const NUMBERED = /^(\d{1,3})[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const TABLE_RULE = /^\|[\s:|-]+\|$/

/**
 * 一行一行认成块。空行断段（也把列表断开：下一段编号从写的那个数重新起）；
 * 连着的同类块并成一块（列表项、表格行、提示框的几行）。
 */
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
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      flush()
      out.push({ kind: 'p', lines: [] }) // 断开标记，最后滤掉
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
      // `|---|---|` 那一行只是分隔，不出行
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
    // 普通行：接在上一段后面（markdown 的软换行）
    para.push(line)
  }
  flush()
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0)
}

/** 这个地址能不能做成链接、做成哪种；`undefined` = 原样当字。 */
export function linkKind(href: string): 'external' | 'help' | 'internal' | undefined {
  if (/^https?:\/\/[^\s]+$/i.test(href)) return 'external'
  if (href.startsWith('help:') && isHelpSlug(href.slice(5))) return 'help'
  if (href.startsWith('/') && !href.startsWith('//')) return 'internal'
  return undefined
}

/** 行内记号：图片、链接、粗体（两种写法）、行内代码。 */
const INLINE =
  /!\[([^\]\n]*)\]\(([^)\s]*)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+)`/g

const LINK_CLS = 'text-primary underline-offset-4 hover:underline'

/** 一行里的行内记号画出来；认不出、不许做成链接的原样当字。 */
export function MarkdownInline({ text }: { text: string }): ReactNode {
  const rail = useRailState()
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const key = `${String(at)}-${String(m[0].length)}`
    const [, imgAlt, , linkText, href, bold1, bold2, code] = m
    if (imgAlt !== undefined) {
      // 图片只留说明文字：外链图片一张都不加载
      parts.push(imgAlt)
    } else if (linkText !== undefined && href !== undefined) {
      const kind = linkKind(href)
      if (kind === 'external')
        parts.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={LINK_CLS}
            data-testid="reply-external-link"
          >
            {linkText}
          </a>,
        )
      else if (kind === 'internal')
        parts.push(
          <Link key={key} to={href} className={LINK_CLS} data-testid="linked-text-link">
            {linkText}
          </Link>,
        )
      else if (kind === 'help')
        parts.push(
          <button
            key={key}
            type="button"
            className={LINK_CLS}
            data-testid="help-cross-link"
            data-slug={href.slice(5)}
            onClick={() => {
              const slug = href.slice(5)
              if (isHelpSlug(slug)) rail.openAddress(helpAddress(slug))
            }}
          >
            {linkText}
          </button>,
        )
      else parts.push(m[0])
    } else if (bold1 !== undefined || bold2 !== undefined) {
      parts.push(
        <strong key={key} className="font-semibold text-foreground">
          <MarkdownInline text={bold1 ?? bold2 ?? ''} />
        </strong>,
      )
    } else if (code !== undefined) {
      parts.push(
        <code key={key} className="rounded-sm bg-ws-surface px-1 font-mono text-[0.92em]">
          {code}
        </code>,
      )
    }
    last = at + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

const ARTICLE_HEADING: Record<number, string> = {
  1: 'text-base font-semibold text-foreground',
  2: 'mt-2 text-sm font-semibold text-foreground',
  3: 'mt-1 text-sm font-medium text-foreground',
}

function Heading({
  block,
  variant,
}: {
  block: { level: number; text: string }
  variant: Variant
}): ReactNode {
  const body = <MarkdownInline text={block.text} />
  // 时间线里标题只画成粗体的一行，不放大字号
  if (variant === 'reply') return <p className="font-semibold">{body}</p>
  const cls = ARTICLE_HEADING[block.level] ?? ARTICLE_HEADING[3]
  return block.level === 1 ? <h3 className={cls}>{body}</h3> : <h4 className={cls}>{body}</h4>
}

function Table({ rows }: { rows: string[][] }): ReactNode {
  const [head, ...body] = rows
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        {head === undefined ? null : (
          <thead className="text-ws-muted-fg">
            <tr className="border-b">
              {head.map((cell, j) => (
                <th key={`${String(j)}-${cell}`} className="py-1 pr-2 text-left font-normal">
                  <MarkdownInline text={cell} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, r) => (
            <tr key={`${String(r)}-${row[0] ?? ''}`} className="border-b last:border-0">
              {row.map((cell, j) => (
                <td key={`${String(j)}-${cell}`} className="py-1 pr-2 align-top">
                  <MarkdownInline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Variant = 'reply' | 'article'

/**
 * 一段 markdown 安全地画出来。`reply`：时间线里 Agent 的回话；`article`：右栏教程文章。
 */
export function SafeMarkdown({
  text,
  variant = 'reply',
  className,
  testId,
}: {
  text: string
  variant?: Variant
  className?: string
  testId?: string
}): ReactNode {
  const article = variant === 'article'
  const Root = article ? 'article' : 'div'
  return (
    <Root
      className={cn(
        'flex flex-col break-words',
        article ? 'gap-2 text-[13px] leading-6 text-ws-body' : 'gap-1.5',
        className,
      )}
      data-testid={testId ?? (article ? 'help-article' : 'reply-markdown')}
      data-variant={variant}
    >
      {parseMarkdown(text).map((b, i) => {
        const key = `${String(i)}-${b.kind}`
        const gap = article ? 'space-y-1' : 'space-y-0.5'
        if (b.kind === 'h') return <Heading key={key} block={b} variant={variant} />
        if (b.kind === 'ul')
          return (
            <ul key={key} className={cn('list-disc pl-5', gap)}>
              {b.items.map((item, j) => (
                <li key={`${key}-${String(j)}`}>
                  <MarkdownInline text={item} />
                </li>
              ))}
            </ul>
          )
        if (b.kind === 'ol')
          return (
            <ol key={key} start={b.start} className={cn('list-decimal pl-5', gap)}>
              {b.items.map((item, j) => (
                <li key={`${key}-${String(j)}`}>
                  <MarkdownInline text={item} />
                </li>
              ))}
            </ol>
          )
        if (b.kind === 'table') return <Table key={key} rows={b.rows} />
        if (b.kind === 'quote')
          return (
            <p
              key={key}
              data-slot="callout"
              className="rounded-md border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1 text-xs"
            >
              <MarkdownInline text={b.lines.join(' ')} />
            </p>
          )
        // 段落：时间线里段内换行照留（模型常一行一句）；教程里软换行拼成一段
        if (article)
          return (
            <p key={key}>
              <MarkdownInline text={b.lines.join(' ')} />
            </p>
          )
        return (
          <p key={key} className="whitespace-pre-wrap">
            {b.lines.map((line, j) => (
              <span key={`${key}-${String(j)}`}>
                {j > 0 ? '\n' : null}
                <MarkdownInline text={line} />
              </span>
            ))}
          </p>
        )
      })}
    </Root>
  )
}
