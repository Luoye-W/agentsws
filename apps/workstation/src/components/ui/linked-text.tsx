/**
 * WP142（docs/78 §1 #5）：一段纯文字里的**站内链接**画成可点的链接。
 *
 * Agent 的回话（事项时间线）以前只能是纯文字，于是「找到 2 个」之后没法给一个
 * 「去候选池看全部」。现在回话里写 `[字](/站内路径)`，这里把它画成 `<Link>`。
 *
 * 只认 `/` 开头的站内路径（不认 `//`、不认 `http(s)://`）：回话是模型写的，
 * 不该让它在工作台里放一个跳到站外的链接。别的方括号原样显示。
 */
import { Link } from 'react-router-dom'

const LINK = /\[([^\]\n]+)\]\((\/(?!\/)[^)\s]*)\)/g

export function LinkedText({ text }: { text: string }): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    parts.push(
      <Link
        key={`${at}-${m[2]}`}
        to={m[2] as string}
        className="text-primary underline-offset-4 hover:underline"
        data-testid="linked-text-link"
      >
        {m[1]}
      </Link>,
    )
    last = at + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}
