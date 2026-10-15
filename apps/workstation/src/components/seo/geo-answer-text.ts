/**
 * WP335「一条回答」的纯函数：把回答原文收成可读的纯文字、按品牌名切段（高亮用）、和上一期逐词比。
 * 没有 React、没有请求——单测直接测。
 */

/** markdown 收成纯文字：链接留字、去粗斜体 / 行内代码记号、去标题井号；引用编号 `[1]` 留着（对得上下面的编号）。 */
export function plainOf(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface Segment {
  text: string
  /** 命中的是谁（`ours` / 竞品 id）；不是品牌名不写。 */
  entity?: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 按品牌名 / 别名 / 域名切段（不分大小写；英文按词边界，免得 `Ank` 命中 `Anker`）。
 * 长的名字先认（「NordVolt Air」先于「NordVolt」）。
 */
export function highlight(
  text: string,
  names: readonly { entity: string; terms: readonly string[] }[],
): Segment[] {
  const terms = names
    .flatMap((n) => n.terms.map((term) => ({ entity: n.entity, term: term.trim() })))
    .filter((x) => x.term.length >= 2)
    .sort((a, b) => b.term.length - a.term.length)
  if (terms.length === 0 || text === '') return [{ text }]
  const owner = new Map<string, string>()
  for (const x of terms)
    if (!owner.has(x.term.toLowerCase())) owner.set(x.term.toLowerCase(), x.entity)
  const re = new RegExp(
    `(?<![A-Za-z0-9])(${terms.map((x) => escapeRe(x.term)).join('|')})(?![A-Za-z0-9])`,
    'gi',
  )
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    const hit = m[0]
    const entity = owner.get(hit.toLowerCase())
    out.push(entity === undefined ? { text: hit } : { text: hit, entity })
    last = at + hit.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

export interface DiffPart {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** 逐词太长时退到逐行（免得一篇长回答把浏览器算卡）。 */
const WORD_LIMIT = 1500

function lcsDiff(a: readonly string[], b: readonly string[]): DiffPart[] {
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as Uint16Array
      row[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as Uint16Array)[j + 1] ?? 0) + 1
          : Math.max((dp[i + 1] as Uint16Array)[j] ?? 0, row[j + 1] ?? 0)
    }
  const out: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string): void => {
    const prev = out.at(-1)
    if (prev !== undefined && prev.kind === kind) prev.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i] as string)
      i++
      j++
    } else if (((dp[i + 1] as Uint16Array)[j] ?? 0) >= ((dp[i] as Uint16Array)[j + 1] ?? 0)) {
      push('del', a[i] as string)
      i++
    } else {
      push('add', b[j] as string)
      j++
    }
  }
  while (i < n) push('del', a[i++] as string)
  while (j < m) push('add', b[j++] as string)
  return out
}

/** 上一期 → 这一期：逐词（连空白一起，原样拼得回去）；太长退到逐行。 */
export function diffText(before: string, after: string): DiffPart[] {
  const words = (s: string): string[] => s.split(/(\s+)/).filter((x) => x !== '')
  const a = words(before)
  const b = words(after)
  if (a.length <= WORD_LIMIT && b.length <= WORD_LIMIT) return lcsDiff(a, b)
  const lines = (s: string): string[] => s.split(/(\n)/).filter((x) => x !== '')
  return lcsDiff(lines(before), lines(after))
}
