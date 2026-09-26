/**
 * WP153（09-26 真账号冒烟 §1）：Agent 回话里的 markdown **安全地**画出来。
 *
 * 冒烟里真模型的回答写着 `**粗体**`，时间线原样显示两对星号。这里只认回话里真会出现、
 * 也值得画的那几样，别的一律当字：
 *
 * - 块：段落、`-` / `*` / `+` 列表、`1.` / `1)` 编号、`#` 标题（画成粗体的一行，不放大字号）；
 * - 行内：`**粗体**` / `__粗体__`、`` `行内代码` ``、链接。
 *
 * 三条安全纪律（回话是模型写的，里面可能有外部内容抄进来的东西）：
 *
 * 1. **不解析 HTML**：一个字符都不变成标签，全部走 React 的文本节点（`<script>` 就是七个字）；
 * 2. **不画图片**：`![说明](地址)` 只留说明文字，外链图片一张都不加载；
 * 3. **链接只认两种**：站内路径（`/` 开头、不是 `//`，同 WP142 的 `LinkedText`，用路由跳）
 *    与 `http(s)://`（新窗口打开，`rel="noopener noreferrer"`）。`javascript:`、`data:`、
 *    `//` 开头的一律当字。
 *
 * 为什么不引 markdown 库：同 `design-md/markdown-preview.tsx` 的理由——为五种节点请进
 * `remark` + `sanitize` 一整套不值当，而且手写的这一份天然没有 HTML 这条路。
 */
import { Link } from 'react-router-dom'

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'h'; text: string }

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/

/** 一行一行认成块。空行断段；列表项之间不许夹空行以外的东西（夹了就另起一段）。 */
export function blocksOf(text: string): Block[] {
  const out: Block[] = []
  const last = (): Block | undefined => out.at(-1)
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      out.push({ kind: 'p', lines: [] })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      out.push({ kind: 'h', text: heading[1] })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet?.[1] !== undefined) {
      const prev = last()
      if (prev?.kind === 'ul') prev.items.push(bullet[1])
      else out.push({ kind: 'ul', items: [bullet[1]] })
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered?.[1] !== undefined && numbered[2] !== undefined) {
      const prev = last()
      if (prev?.kind === 'ol') prev.items.push(numbered[2])
      else out.push({ kind: 'ol', items: [numbered[2]], start: Number(numbered[1]) })
      continue
    }
    const prev = last()
    if (prev?.kind === 'p') prev.lines.push(line)
    else out.push({ kind: 'p', lines: [line] })
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0)
}

/** 行内记号：图片、链接、粗体（两种写法）、行内代码。 */
const INLINE =
  /!\[([^\]\n]*)\]\(([^)\s]*)\)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+)`/g

/** 站内路径：`/` 开头、不是 `//`。 */
const isInternal = (href: string): boolean => href.startsWith('/') && !href.startsWith('//')
/** 站外：只认 http(s)。 */
const isWeb = (href: string): boolean => /^https?:\/\/[^\s]+$/i.test(href)

export function Inline({ text }: { text: string }): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    const key = `${at}-${m[0].length}`
    const [, imgAlt, , linkText, href, bold1, bold2, code] = m
    if (imgAlt !== undefined) {
      // 图片只留说明文字：外链图片一张都不加载
      parts.push(imgAlt)
    } else if (linkText !== undefined && href !== undefined) {
      if (isInternal(href))
        parts.push(
          <Link
            key={key}
            to={href}
            className="text-primary underline-offset-4 hover:underline"
            data-testid="linked-text-link"
          >
            {linkText}
          </Link>,
        )
      else if (isWeb(href))
        parts.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
            data-testid="reply-external-link"
          >
            {linkText}
          </a>,
        )
      else parts.push(m[0])
    } else if (bold1 !== undefined || bold2 !== undefined) {
      parts.push(
        <strong key={key} className="font-semibold">
          <Inline text={bold1 ?? bold2 ?? ''} />
        </strong>,
      )
    } else if (code !== undefined) {
      parts.push(
        <code key={key} className="rounded-sm bg-ws-surface px-1 font-mono text-[12px]">
          {code}
        </code>,
      )
    }
    last = at + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** Agent 的一段回话（时间线用）。 */
export function ReplyMarkdown({ text }: { text: string }): React.ReactElement {
  const blocks = blocksOf(text)
  return (
    <div className="flex flex-col gap-1.5 break-words" data-testid="reply-markdown">
      {blocks.map((b, i) => {
        const key = `${String(i)}-${b.kind}`
        if (b.kind === 'h')
          return (
            <p key={key} className="font-semibold">
              <Inline text={b.text} />
            </p>
          )
        if (b.kind === 'ul')
          return (
            <ul key={key} className="list-disc space-y-0.5 pl-5">
              {b.items.map((item, j) => (
                <li key={`${key}-${String(j)}`}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          )
        if (b.kind === 'ol')
          return (
            <ol key={key} start={b.start} className="list-decimal space-y-0.5 pl-5">
              {b.items.map((item, j) => (
                <li key={`${key}-${String(j)}`}>
                  <Inline text={item} />
                </li>
              ))}
            </ol>
          )
        return (
          <p key={key} className="whitespace-pre-wrap">
            {b.lines.map((line, j) => (
              <span key={`${key}-${String(j)}`}>
                {j > 0 ? '\n' : null}
                <Inline text={line} />
              </span>
            ))}
          </p>
        )
      })}
    </div>
  )
}
