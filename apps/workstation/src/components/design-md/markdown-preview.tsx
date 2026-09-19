/**
 * `DESIGN.md` 原文那一半的**右预览**（71 §4，WP122）。
 *
 * ## 为什么不引一个 markdown 库
 *
 * 工作台现在一个 markdown 渲染器都没有（`blocks` 里那个 `markdown` 只是注册表上
 * 的一个名字）。为"编辑一份我们自己格式的文件"引一个通用渲染器，等于把
 * `remark` + `sanitize` + 一套样式请进来，只为渲染四种节点。所以这里手写，
 * 而且**只认这一种文件真会用到的那几种**：YAML front matter、`#` 标题、
 * `-` 列表、段落。认不出来的行原样当段落排——它不会吞字，最多是不好看。
 *
 * ## 为什么不直接用 `dangerouslySetInnerHTML`
 *
 * 这份文件的内容有三个来路，其中两个不是我们写的：用户粘进来的整份替换、
 * 模型写成的正文。把它当 HTML 插进 DOM 就是给了它一条打界面的路。
 * 这里一个字符都不解析成标签，全部走 React 的文本节点。
 */

/** front matter 与正文的分界（`---` 那一行，只认文件开头那一对）。 */
function splitFrontMatter(markdown: string): { front: string; body: string } {
  if (!markdown.startsWith('---')) return { front: '', body: markdown }
  const end = markdown.indexOf('\n---', 3)
  if (end < 0) return { front: '', body: markdown }
  const close = markdown.indexOf('\n', end + 1)
  return {
    front: markdown.slice(3, end).trim(),
    body: close < 0 ? '' : markdown.slice(close + 1),
  }
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'li'; text: string }
  | { kind: 'p'; text: string }

/** 一行一行认。空的行只用来断段，不产出块。 */
function blocksOf(body: string): Block[] {
  const out: Block[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const hashes = heading?.[1]
    if (hashes !== undefined && heading?.[2] !== undefined) {
      out.push({ kind: 'h', level: hashes.length, text: heading[2] })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet?.[1] !== undefined) {
      out.push({ kind: 'li', text: bullet[1] })
      continue
    }
    out.push({ kind: 'p', text: line })
  }
  return out
}

const HEADING_CLASS: Record<number, string> = {
  1: 'font-semibold text-base',
  2: 'font-semibold text-sm',
  3: 'font-medium text-sm',
}

export function MarkdownPreview({ markdown }: { markdown: string }): React.ReactElement {
  const { front, body } = splitFrontMatter(markdown)
  const blocks = blocksOf(body)
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="design-md-preview">
      {front === '' ? null : (
        // 机器可读的那一段：给人看一眼"文件头有东西"，不逐格排版——
        // 逐格排出来的那张表就是左边那个「可视化」页，两处画两遍必然对不上
        <pre
          className="overflow-auto rounded-sm bg-ws-surface p-2 font-mono text-[11px] text-ws-muted-fg"
          data-testid="design-md-preview-front"
        >
          {front}
        </pre>
      )}
      {blocks.map((b, i) => {
        const key = `${String(i)}-${b.text.slice(0, 24)}`
        if (b.kind === 'h')
          return (
            <p key={key} className={HEADING_CLASS[b.level] ?? 'font-medium text-sm'}>
              {b.text}
            </p>
          )
        if (b.kind === 'li')
          return (
            <p key={key} className="pl-3 text-ws-body">
              · {b.text}
            </p>
          )
        return (
          <p key={key} className="leading-6 whitespace-pre-wrap text-ws-body">
            {b.text}
          </p>
        )
      })}
    </div>
  )
}
