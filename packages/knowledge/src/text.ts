/**
 * 分词与写过滤。
 *
 * FTS5 的 `unicode61` 把一整段中文当成**一个** token（它只在非字母数字处切分），
 * 所以「德国站退货」永远不会被「退货」命中。本包不引入 `simple` 扩展（需要编译 .so，
 * 与"本地免费档零外部进程"的目标冲突），改用**字符 2-gram 预处理列**：
 * 入库时把 CJK 连续段展开成 `德国 国站 站退 退货` 存进 `ngram` 列，查询时把 CJK 词
 * 同样展开成 bigram **短语**去匹配。这是 13 §2 定案（sqlite-vec + FTS5 + simple）的过渡实现。
 */

/** CJK 连续段优先，其次是拉丁字母 / 数字串。\p{L} 也含汉字，故 CJK 分支必须在前。 */
const TERM_SCAN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{Letter}\p{Number}]+/gu
const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u

export interface QueryTerm {
  /** 人看得懂的原词（用于 matched / missing 报告） */
  term: string
  /** 该词在 FTS5 里的短语表达（bigram 序列或单词本身） */
  phrase: string
}

/** 一个 CJK 段的字符 2-gram；单字段退化为该字本身。 */
export function bigrams(run: string): string[] {
  const chars = [...run]
  if (chars.length <= 1) return chars.length === 1 ? [run] : []
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`)
  return out
}

/** 入库用：把文本展开成「拉丁词 + CJK bigram」的空格串，写进 FTS5 的 ngram 列。 */
export function ngramText(text: string): string {
  const out: string[] = []
  for (const m of text.matchAll(TERM_SCAN)) {
    const token = m[0]
    if (CJK_ONLY.test(token)) out.push(...bigrams(token))
    else out.push(token.toLowerCase())
  }
  return out.join(' ')
}

const escapeFts = (s: string) => s.replace(/"/g, '""')

/** 查询用：拆成人可读词 + 各自的 FTS5 短语。 */
export function queryTerms(text: string): QueryTerm[] {
  const out: QueryTerm[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(TERM_SCAN)) {
    const token = m[0]
    const term = CJK_ONLY.test(token) ? token : token.toLowerCase()
    if (seen.has(term)) continue
    seen.add(term)
    const parts = CJK_ONLY.test(token) ? bigrams(token) : [term]
    if (parts.length === 0) continue
    out.push({ term, phrase: `"${escapeFts(parts.join(' '))}"` })
  }
  return out
}

/** 把若干词 OR 起来成一条 FTS5 MATCH 表达式；无词返回 undefined。 */
export function matchExpression(terms: readonly QueryTerm[]): string | undefined {
  if (terms.length === 0) return undefined
  return terms.map((t) => `(${t.phrase})`).join(' OR ')
}

/** Jaccard 相似度（词集合，中文按 bigram）。 */
export function jaccard(a: string, b: string): number {
  const sa = new Set(ngramText(a).split(' ').filter(Boolean))
  const sb = new Set(ngramText(b).split(' ').filter(Boolean))
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/** 19 §1.2 写过滤：邮箱 / IBAN / 卡号形态 / ≥9 位连续数字。顺序即报告原因的优先级。 */
const SECRET_PATTERNS: readonly { reason: string; re: RegExp }[] = [
  {
    reason: 'email_like',
    re: /[\p{Letter}\p{Number}._%+-]+@[\p{Letter}\p{Number}.-]+\.\p{Letter}{2,}/gu,
  },
  { reason: 'iban_like', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { reason: 'card_number_like', re: /\b(?:\d[ -]?){13,19}\b/g },
  { reason: 'long_digit_run', re: /\d{9,}/g },
]

/** 命中返回原因（如 `email_like`），否则 undefined。 */
export function detectSecret(text: string): string | undefined {
  for (const { reason, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    if (re.test(text)) return reason
  }
  return undefined
}

/** 出库脱敏：把秘密形态的片段换成 `[redacted]`。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { re } of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}
