/**
 * 三把钥匙（40 §2.2 第 2 条）：**同语义 / 同触发器 / 同目标对象**，外加"是不是同一类东西"。
 *
 * 语义那把直接复用 WP29 学习回路的词袋（`@agentsws/learning` 的 `keySimilarity` /
 * `keyTokens`）——同一件事换个说法要认得出来，而且必须在没有网络、没有 key 的机器上
 * 算得出同一个值（不叫模型）。
 *
 * 打分刻意简单，因为它要能**说给人听**：
 * - **同 kind 是道门**：一条规矩和一条定时任务话说得一模一样也不算重复，它们本来
 *   就不是一种东西，"复用它"根本无从谈起。
 * - 语义重合度是底分（0..1）；**触发时机相同 +0.3、目标对象相同 +0.3**，封顶 1。
 *   两把都中（同一个 cron、同一个店铺）就已经过门槛——那正是 40 §2.2 说的"三把钥匙"。
 *
 * 于是："每天早上汇总退款单" vs "早上把退款单汇总一下" 光靠语义就过门槛；
 * 话说得不像但同一个 cron、同一个店铺的两条，靠另外两把钥匙也拦得住。
 */
import { keySimilarity, keyTokens } from '@agentsws/learning'
import type { CatalogEntry, SimilarHit, SimilarKey, SimilarQuery } from './types.js'

/** 另外两把钥匙各加多少分。语义本身就是 0..1 的底分，不再乘权重。 */
export const BONUS = { trigger: 0.3, target: 0.3 } as const

/** 低于这个分不打扰人（40 §2.2：查出来才出选择题卡，查不出来就直接建）。 */
export const SIMILAR_THRESHOLD = 0.55

/** 周复盘"疑似重复"用更高的门槛：那是主动报给人的，不是人正在建东西时的挡板。 */
export const DUPLICATE_THRESHOLD = 0.7

export const DEFAULT_LIMIT = 5

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** 条目参与语义匹配的那段文字。 */
export const textOf = (e: { title: string; summary?: string }): string =>
  `${e.title} ${e.summary ?? ''}`.trim()

const pct = (n: number): string => `${Math.round(n * 100)}%`

/** 触发器写法不统一（`cron:0 9 * * *` 与 `CRON: 0 9 * * *`），比之前先规整一下。 */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/gu, '')

export interface Scored {
  similarity: number
  keys: SimilarKey[]
  reasons: string[]
}

/**
 * 一对条目的相似度与理由。对称：`score(a,b) === score(b,a)`。
 *
 * 不同 kind 直接 0 分（那道门），`keys` 里也不会有 `kind`。
 */
export function score(
  a: { kind: string; title: string; summary?: string; trigger?: string; target?: string },
  b: { kind: string; title: string; summary?: string; trigger?: string; target?: string },
): Scored {
  if (a.kind !== b.kind) return { similarity: 0, keys: [], reasons: [] }

  const keys: SimilarKey[] = ['kind']
  const reasons: string[] = []

  // 标题与"标题 + 一句话摘要"各算一遍取高的：摘要能帮上忙时算上它，
  // 摘要把词袋冲淡时（词袋有 12 个词的上限）不至于反而认不出来。
  const semantic = Math.max(keySimilarity(a.title, b.title), keySimilarity(textOf(a), textOf(b)))
  let total = semantic
  if (semantic > 0) {
    keys.push('semantic')
    const other = new Set(keyTokens(textOf(b)))
    const shared = keyTokens(textOf(a)).filter((t) => other.has(t))
    reasons.push(
      shared.length === 0
        ? `说的像是同一件事（词重合 ${pct(semantic)}）`
        : `说的像是同一件事（${shared.slice(0, 4).join('')}，词重合 ${pct(semantic)}）`,
    )
  }

  if (a.trigger !== undefined && b.trigger !== undefined && norm(a.trigger) === norm(b.trigger)) {
    total += BONUS.trigger
    keys.push('trigger')
    reasons.push(`触发时机相同（${a.trigger}）`)
  }
  if (a.target !== undefined && b.target !== undefined && norm(a.target) === norm(b.target)) {
    total += BONUS.target
    keys.push('target')
    reasons.push(`针对同一个对象（${a.target}）`)
  }

  return { similarity: round4(Math.min(1, total)), keys, reasons }
}

/** 一句话：为什么这条被认为像。 */
export function explain(hit: Scored): string {
  return hit.reasons.length === 0 ? '同一类东西' : hit.reasons.join('；')
}

/** 在给定条目里找像的那些，按分从高到低。 */
export function findSimilar(query: SimilarQuery, entries: readonly CatalogEntry[]): SimilarHit[] {
  const threshold = query.threshold ?? SIMILAR_THRESHOLD
  const limit = query.limit ?? DEFAULT_LIMIT
  const hits: SimilarHit[] = []
  for (const entry of entries) {
    if (entry.workspace_id !== query.workspace_id) continue
    if (entry.id === query.exclude_id) continue
    // 已经被公司版取代的个人副本不再挡人（它自己都指向别处了）
    if (entry.superseded_by !== undefined) continue
    const s = score(
      {
        kind: query.kind,
        title: query.title,
        ...(query.summary === undefined ? {} : { summary: query.summary }),
        ...(query.trigger === undefined ? {} : { trigger: query.trigger }),
        ...(query.target === undefined ? {} : { target: query.target }),
      },
      entry,
    )
    if (s.similarity < threshold) continue
    hits.push({ entry, similarity: s.similarity, keys: s.keys, reasons: s.reasons })
  }
  hits.sort((x, y) => y.similarity - x.similarity || x.entry.id.localeCompare(y.entry.id))
  return hits.slice(0, limit)
}

/** 这条东西"还在用"吗：有岗位在用，或最近 30 天跑过。 */
export const inUse = (e: CatalogEntry): boolean => e.used_by_positions.length > 0 || e.runs_30d > 0

/**
 * 疑似重复的成对（40 §2.2 第 4 条）。
 *
 * 只报**两条都还在用**的：一条已经没人用的旧东西不值得占复盘的篇幅。
 */
export function findDuplicates(
  entries: readonly CatalogEntry[],
  options: { threshold?: number; limit?: number } = {},
): {
  a: CatalogEntry
  b: CatalogEntry
  similarity: number
  both_in_use: boolean
  reasons: string[]
}[] {
  const threshold = options.threshold ?? DUPLICATE_THRESHOLD
  const live = entries.filter((e) => e.superseded_by === undefined)
  const pairs: {
    a: CatalogEntry
    b: CatalogEntry
    similarity: number
    both_in_use: boolean
    reasons: string[]
  }[] = []
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]
      const b = live[j]
      if (a === undefined || b === undefined) continue
      if (a.workspace_id !== b.workspace_id) continue
      const s = score(a, b)
      if (s.similarity < threshold) continue
      const both_in_use = inUse(a) && inUse(b)
      if (!both_in_use) continue
      pairs.push({ a, b, similarity: s.similarity, both_in_use, reasons: s.reasons })
    }
  }
  pairs.sort(
    (x, y) =>
      y.similarity - x.similarity || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id),
  )
  return options.limit === undefined ? pairs : pairs.slice(0, options.limit)
}

/** 目录搜索（工具箱搜索框与 ⌘K 同源）：词袋重合 + 子串，两者取其一。 */
export function matchesText(entry: CatalogEntry, text: string): boolean {
  const needle = text.trim()
  if (needle === '') return true
  const haystack = `${entry.title} ${entry.summary} ${entry.id}`.toLowerCase()
  if (haystack.includes(needle.toLowerCase())) return true
  const wanted = keyTokens(needle)
  if (wanted.length === 0) return false
  const have = new Set(keyTokens(textOf(entry)))
  return wanted.every((t) => have.has(t))
}
