import { createHash } from 'node:crypto'

/** 段正文哈希：用于重解析时按正文对齐段 id（改标题不改 id）。 */
export function bodyHash(body: string): string {
  return createHash('sha256').update(normalizeBody(body), 'utf8').digest('hex')
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').trim()
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/

/** 中英文混排的粗分词：拉丁按词、CJK 按字；标点与空白丢弃。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+|[^\sa-z0-9]/gu)) {
    const t = m[0]
    if (t.length > 1 || /[a-z0-9]/.test(t) || CJK.test(t)) out.push(t)
  }
  return out
}

export function jaccard(a: string, b: string): number {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

function bigrams(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
  return out
}

/** 标题相似度：字符 bigram 的 Dice 系数，0..1。 */
export function headingSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/\s+/g, '')
  const nb = b.toLowerCase().replace(/\s+/g, '')
  if (na === nb) return na.length === 0 ? 0 : 1
  if (na.length < 2 || nb.length < 2) return 0
  const ba = bigrams(na)
  const bb = bigrams(nb)
  const pool = new Map<string, number>()
  for (const g of ba) pool.set(g, (pool.get(g) ?? 0) + 1)
  let inter = 0
  for (const g of bb) {
    const c = pool.get(g) ?? 0
    if (c > 0) {
      inter++
      pool.set(g, c - 1)
    }
  }
  return (2 * inter) / (ba.length + bb.length)
}
