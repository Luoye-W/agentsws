/**
 * WP156：教程文章的渲染（右栏「教程」面板里用）。
 *
 * ## 为什么自带一个最小实现
 *
 * 工作台里唯一的 markdown 渲染是 `design-md/markdown-preview.tsx`（只认标题 / 列表 / 段落，
 * 没有链接）。教程要的多三样：**编号步骤**、**链接**（外链与「另一篇教程」）、**行内代码与粗体**。
 * 为这几样引 `remark` + `sanitize` 不划算，所以这里手写，而且只认这些：
 *
 * - `#` / `##` / `###` 标题；`1.` 编号列表；`-` 列表；`>` 提示框；`| a | b |` 简单表格；空行断段；
 * - 行内：`**粗体**`、`` `代码` ``、`[文字](地址)`。
 *
 * ## 安全
 *
 * 一个字符都不解析成 HTML，全部走 React 文本节点。链接只认三种地址：
 * `https://` / `http://`（新窗口、`noopener`）、`help:<slug>`（在右栏换成那一篇）、
 * 站内 `/…`（照常跳转）。别的（`javascript:`、`data:`…）当普通文字排出来。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useRailState } from '@/components/rail/rail-state'
import { helpAddress, isHelpSlug } from '@/lib/help'

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'p'; text: string }

/** 一行一行认；连续的普通行拼成一段（markdown 的软换行）。 */
export function parseHelpBlocks(markdown: string): Block[] {
  const out: Block[] = []
  const push = (block: Block): void => {
    const last = out[out.length - 1]
    if (block.kind === 'ol' && last?.kind === 'ol') last.items.push(...block.items)
    else if (block.kind === 'ul' && last?.kind === 'ul') last.items.push(...block.items)
    else if (block.kind === 'quote' && last?.kind === 'quote') last.text += ` ${block.text}`
    else if (block.kind === 'table' && last?.kind === 'table') last.rows.push(...block.rows)
    else out.push(block)
  }
  let para: string[] = []
  const flush = (): void => {
    if (para.length > 0) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      flush()
      // 空行把列表断开：下一条编号列表从 1 重新数
      out.push({ kind: 'p', text: '' })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h?.[1] !== undefined && h[2] !== undefined) {
      flush()
      push({ kind: 'h', level: h[1].length, text: h[2] })
      continue
    }
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(line)
    if (ol?.[1] !== undefined && ol[2] !== undefined) {
      flush()
      push({ kind: 'ol', start: Number(ol[1]), items: [ol[2]] })
      continue
    }
    const ul = /^[-*]\s+(.*)$/.exec(line)
    if (ul?.[1] !== undefined) {
      flush()
      push({ kind: 'ul', items: [ul[1]] })
      continue
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      flush()
      // `|---|---|` 那一行只是分隔，不出行
      if (!/^\|[\s:|-]+\|$/.test(line))
        push({
          kind: 'table',
          rows: [
            line
              .slice(1, -1)
              .split('|')
              .map((c) => c.trim()),
          ],
        })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote?.[1] !== undefined) {
      flush()
      push({ kind: 'quote', text: quote[1] })
      continue
    }
    para.push(line)
  }
  flush()
  return out.filter((b) => !(b.kind === 'p' && b.text === ''))
}

type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

/** 行内三样：`**粗体**`、`` `代码` ``、`[文字](地址)`；认不出的原样当文字。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    const index = m.index ?? 0
    if (index > at) out.push({ kind: 'text', text: text.slice(at, index) })
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] })
    else if (m[3] !== undefined && m[4] !== undefined)
      out.push({ kind: 'link', text: m[3], href: m[4] })
    at = index + m[0].length
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

/** 这个地址能不能做成链接、做成哪种。 */
export function linkKind(href: string): 'external' | 'help' | 'internal' | undefined {
  if (/^https?:\/\//.test(href)) return 'external'
  if (href.startsWith('help:') && isHelpSlug(href.slice(5))) return 'help'
  if (href.startsWith('/') && !href.startsWith('//')) return 'internal'
  return undefined
}

function InlineText({ text }: { text: string }): ReactNode {
  const rail = useRailState()
  return parseInline(text).map((part, i) => {
    const key = `${String(i)}-${part.text.slice(0, 12)}`
    if (part.kind === 'bold')
      return (
        <strong key={key} className="font-medium text-foreground">
          {part.text}
        </strong>
      )
    if (part.kind === 'code')
      return (
        <code key={key} className="rounded bg-muted px-1 font-mono text-[11px]">
          {part.text}
        </code>
      )
    if (part.kind === 'link') {
      const kind = linkKind(part.href)
      const cls = 'text-primary underline-offset-4 hover:underline'
      if (kind === 'external')
        return (
          <a key={key} href={part.href} target="_blank" rel="noreferrer noopener" className={cls}>
            {part.text}
          </a>
        )
      if (kind === 'help')
        return (
          <button
            key={key}
            type="button"
            className={cls}
            onClick={() => {
              const slug = part.href.slice(5)
              if (isHelpSlug(slug)) rail.openAddress(helpAddress(slug))
            }}
          >
            {part.text}
          </button>
        )
      if (kind === 'internal')
        return (
          <Link key={key} to={part.href} className={cls}>
            {part.text}
          </Link>
        )
      return <span key={key}>{part.text}</span>
    }
    return <span key={key}>{part.text}</span>
  })
}

const HEADING: Record<number, string> = {
  1: 'text-base font-semibold text-foreground',
  2: 'mt-2 text-sm font-semibold text-foreground',
  3: 'mt-1 text-sm font-medium text-foreground',
}

export function HelpArticle({ markdown }: { markdown: string }): ReactNode {
  const blocks = parseHelpBlocks(markdown)
  return (
    <article
      className="flex flex-col gap-2 text-[13px] leading-6 text-ws-body"
      data-testid="help-article"
    >
      {blocks.map((b, i) => {
        const key = `${String(i)}-${b.kind}`
        if (b.kind === 'h') {
          const cls = HEADING[b.level] ?? HEADING[3]
          if (b.level === 1)
            return (
              <h3 key={key} className={cls}>
                <InlineText text={b.text} />
              </h3>
            )
          return (
            <h4 key={key} className={cls}>
              <InlineText text={b.text} />
            </h4>
          )
        }
        if (b.kind === 'ol')
          return (
            <ol key={key} start={b.start} className="list-decimal space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={`${String(j)}-${item.slice(0, 12)}`}>
                  <InlineText text={item} />
                </li>
              ))}
            </ol>
          )
        if (b.kind === 'ul')
          return (
            <ul key={key} className="list-disc space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={`${String(j)}-${item.slice(0, 12)}`}>
                  <InlineText text={item} />
                </li>
              ))}
            </ul>
          )
        if (b.kind === 'table') {
          const [head, ...body] = b.rows
          return (
            <div key={key} className="overflow-x-auto">
              <table className="w-full text-xs">
                {head === undefined ? null : (
                  <thead className="text-ws-muted-fg">
                    <tr className="border-b">
                      {head.map((cell, j) => (
                        <th
                          key={`${String(j)}-${cell}`}
                          className="py-1 pr-2 text-left font-normal"
                        >
                          <InlineText text={cell} />
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
                          <InlineText text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (b.kind === 'quote')
          return (
            <p
              key={key}
              className="rounded-md border-l-2 border-amber-500/60 bg-amber-500/5 px-2 py-1 text-xs"
            >
              <InlineText text={b.text} />
            </p>
          )
        return (
          <p key={key}>
            <InlineText text={b.text} />
          </p>
        )
      })}
    </article>
  )
}
