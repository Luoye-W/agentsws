/**
 * WP448（docs/109 §5.1 #3–4）：**抢词检测**（每周一次，不进每日六个信号）与**掉量分诊**（`decaying` 那一件的提示）。
 *
 * 全从 Search Console「查询 × 页面」行用规则算，数一个不经模型手；同输入同输出。
 *
 * - 抢词：同一个查询我们两页以上都有可观曝光 → 按「哪几页在抢」归成一组；严重的（两页都在前 20、曝光够）
 *   进「今天值得动的 5 件事」，走新车道 `merge`：建议保留点击多的那页，另一页要么合并后跳过去（文章 / 独立页），
 *   要么改写成别的角度并链到保留页（商品 / 合集页不跳）。
 * - 掉量分诊：同一个词我们另一页在涨 → 该合并；这页别的词在涨 → 查询变了；整页几乎没人搜了 → 该下线；其余 → 刷新内容。
 *
 * 思路借 claude-blog（MIT，github.com/AgriciDaniel/claude-blog @ 3544423）`skills/blog-cannibalization`
 * （严重度分级、MERGE / DIFFERENTIATE 两种处理）与 `skills/blog-decay`（refresh / query shift / consolidate / prune
 * 四种分诊、小基数不算）。它们用付费数据或本地文件；我们用 Search Console 查询 × 页面（免费、已经在读）。
 */
import type {
  GscRow,
  SeoCannibalizationGroup,
  SeoDecayTriageResult,
  SeoPick,
} from '@agentsws/contracts'
import { pageKindOf } from './google.js'
import { isBrandQuery, normalizeQuery, pageKey } from './signals.js'

export interface CannibalizationOptions {
  brand_terms: readonly string[]
  /** 一页在这个词上至少这么多曝光才算「可观」（默认 50）。 */
  min_impressions?: number
  /** 一组合计曝光到这个数、且几页都在前 20 → 严重（默认 300）。 */
  critical_impressions?: number
  /** 一组合计曝光到这个数 → 高（默认 150）；不够就是中（只进周报）。 */
  high_impressions?: number
  /** 「前 20」那条线。 */
  max_position?: number
}

export const DEFAULT_CANNIBALIZATION_OPTIONS = {
  min_impressions: 50,
  critical_impressions: 300,
  high_impressions: 150,
  max_position: 20,
} as const

const round1 = (v: number): number => Math.round(v * 10) / 10

/** 能被「合并后跳过去」的页：文章与独立页。商品、合集、首页不跳（那是在卖的页）。 */
const redirectable = (url: string): boolean => {
  const k = pageKindOf(url)
  return k === 'article' || k === 'page'
}

/** 抢词：同一组查询两页以上都有可观曝光。严重的排前面；同级按曝光。 */
export function detectCannibalization(
  rows: readonly GscRow[],
  opts: CannibalizationOptions,
): SeoCannibalizationGroup[] {
  const o = { ...DEFAULT_CANNIBALIZATION_OPTIONS, ...opts }
  // 查询 → 页 → 这一对的行（同一页不同写法的地址并成一页）
  const byQuery = new Map<string, { query: string; pages: Map<string, GscRow> }>()
  for (const r of rows) {
    if (isBrandQuery(r.query, o.brand_terms)) continue
    const q = normalizeQuery(r.query)
    const entry = byQuery.get(q) ?? { query: r.query, pages: new Map<string, GscRow>() }
    const pk = pageKey(r.page)
    const prev = entry.pages.get(pk)
    entry.pages.set(
      pk,
      prev === undefined
        ? r
        : {
            ...prev,
            clicks: prev.clicks + r.clicks,
            impressions: prev.impressions + r.impressions,
            position:
              (prev.position * prev.impressions + r.position * r.impressions) /
              Math.max(1, prev.impressions + r.impressions),
          },
    )
    byQuery.set(q, entry)
  }
  // 按「哪几页在抢」归组
  const groups = new Map<string, { queries: string[]; rows: GscRow[] }>()
  for (const { query, pages } of byQuery.values()) {
    const contenders = [...pages.values()].filter((r) => r.impressions >= o.min_impressions)
    if (contenders.length < 2) continue
    const set = contenders.map((r) => pageKey(r.page)).sort()
    const k = set.join('|')
    const g = groups.get(k) ?? { queries: [], rows: [] }
    g.queries.push(query)
    g.rows.push(...contenders)
    groups.set(k, g)
  }
  const out: SeoCannibalizationGroup[] = []
  for (const g of groups.values()) {
    const per = new Map<string, { url: string; clicks: number; impressions: number; pos: number }>()
    for (const r of g.rows) {
      const k = pageKey(r.page)
      const p = per.get(k) ?? { url: r.page, clicks: 0, impressions: 0, pos: 0 }
      p.clicks += r.clicks
      p.impressions += r.impressions
      p.pos += r.position * r.impressions
      per.set(k, p)
    }
    const pages = [...per.values()]
      .map((p) => ({
        url: p.url,
        clicks: p.clicks,
        impressions: p.impressions,
        position: round1(p.pos / Math.max(1, p.impressions)),
      }))
      .sort(
        (a, b) =>
          b.clicks - a.clicks ||
          a.position - b.position ||
          a.url.length - b.url.length ||
          a.url.localeCompare(b.url),
      )
    const keep = pages[0]
    const other = pages[1]
    if (keep === undefined || other === undefined) continue
    const total = pages.reduce((n, p) => n + p.impressions, 0)
    const allTop = pages.every((p) => p.position <= o.max_position)
    const severity: SeoCannibalizationGroup['severity'] =
      allTop && total >= o.critical_impressions
        ? 'critical'
        : total >= o.high_impressions
          ? 'high'
          : 'medium'
    const losers = pages.slice(1)
    // 都是文章 / 独立页才合并后跳；有商品、合集、首页在里面就是两种意图（买 vs 了解），改写角度
    const action: SeoCannibalizationGroup['action'] = pages.every((p) => redirectable(p.url))
      ? 'redirect'
      : 'differentiate'
    const queries = [...new Set(g.queries)].sort()
    const q = queries[0] ?? ''
    const path = (u: string): string => {
      try {
        return new URL(u).pathname
      } catch {
        return u
      }
    }
    const lose = losers.map((p) => path(p.url)).join('、')
    const suggestion =
      action === 'redirect'
        ? `「${q}」${queries.length > 1 ? `等 ${String(queries.length)} 个词` : ''}我们 ${String(pages.length)} 页在抢：保留 ${path(keep.url)}（点击 ${String(keep.clicks)}），把 ${lose} 有用的内容并过去，再跳转过去。`
        : `「${q}」${queries.length > 1 ? `等 ${String(queries.length)} 个词` : ''}我们 ${String(pages.length)} 页在抢：保留 ${path(keep.url)}（点击 ${String(keep.clicks)}），${lose} 改写成别的角度，并链到保留的那页。`
    out.push({
      key: queries.map(normalizeQuery).join('|'),
      severity,
      queries,
      pages,
      keep: keep.url,
      action,
      suggestion,
    })
  }
  const order = { critical: 0, high: 1, medium: 2 } as const
  return out.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      b.pages.reduce((n, p) => n + p.impressions, 0) -
        a.pages.reduce((n, p) => n + p.impressions, 0) ||
      a.key.localeCompare(b.key),
  )
}

/** 抢词那一组 → 卡上的一件（`merge` 车道）。证据是要处理的那一页在这组词上的数。 */
export function mergePick(g: SeoCannibalizationGroup, rank: number): SeoPick {
  const other = g.pages[1] ?? g.pages[0]
  const clicks = other?.clicks ?? 0
  const impressions = other?.impressions ?? 0
  return {
    rank,
    signal: 'cannibalization',
    query: g.queries[0] ?? '',
    ...(other === undefined ? {} : { page: other.url }),
    evidence: {
      clicks,
      impressions,
      ctr: impressions === 0 ? 0 : Math.round((clicks / impressions) * 10000) / 10000,
      position: other?.position ?? 0,
      words: (g.queries[0] ?? '').trim().split(/\s+/).filter(Boolean).length,
    },
    lane: 'merge',
    suggestion: g.suggestion,
    merge: g,
  }
}

/* ── 掉量分诊 ─────────────────────────────────────────────────────────── */

export interface DecayTriageOptions {
  /** 「这页别的词在涨」的增量占丢掉的点击多少以上算「查询变了」（默认 0.5）。 */
  shift_ratio?: number
  /** 同一个词另一页涨的点击占这页丢的多少以上算「该合并」（默认 0.5）。 */
  merge_ratio?: number
  /** 整页本周点击不超过它、且曝光低于下面那个数 → 该下线。 */
  retire_max_clicks?: number
  retire_max_impressions?: number
}

export const DEFAULT_DECAY_TRIAGE = {
  shift_ratio: 0.5,
  merge_ratio: 0.5,
  retire_max_clicks: 2,
  retire_max_impressions: 100,
} as const

/**
 * `decaying` 那一行 → 分诊（规则判、附证据数字）。先后：该合并 > 查询变了 > 该下线 > 刷新内容。
 *
 * 上周点击没拉到的行（`clicks_prev_week` 不写）不算涨也不算跌——不把「没拉到」当成 0。
 */
export function triageDecay(
  row: GscRow,
  rows: readonly GscRow[],
  opts: DecayTriageOptions = {},
): SeoDecayTriageResult {
  const o = { ...DEFAULT_DECAY_TRIAGE, ...opts }
  const page = pageKey(row.page)
  const q = normalizeQuery(row.query)
  const mine = rows.filter((r) => pageKey(r.page) === page)
  const page_clicks = mine.reduce((n, r) => n + r.clicks, 0)
  const page_impressions = mine.reduce((n, r) => n + r.impressions, 0)
  const withPrev = mine.filter((r) => r.clicks_prev_week !== undefined)
  const page_clicks_prev =
    withPrev.length === 0 ? undefined : withPrev.reduce((n, r) => n + (r.clicks_prev_week ?? 0), 0)
  const lost = Math.max(0, (row.clicks_prev_week ?? 0) - row.clicks)
  const evidenceBase = {
    page_clicks,
    ...(page_clicks_prev === undefined ? {} : { page_clicks_prev }),
    page_impressions,
  }
  // ① 同一个词我们另一页在涨 → 两页在抢
  const rival = rows
    .filter((r) => normalizeQuery(r.query) === q && pageKey(r.page) !== page)
    .filter((r) => r.clicks_prev_week !== undefined && r.clicks > (r.clicks_prev_week ?? 0))
    .sort(
      (a, b) => b.clicks - (b.clicks_prev_week ?? 0) - (a.clicks - (a.clicks_prev_week ?? 0)),
    )[0]
  if (rival !== undefined && rival.clicks - (rival.clicks_prev_week ?? 0) >= lost * o.merge_ratio)
    return {
      verdict: 'merge',
      reason: `同一个词我们另一页 ${rival.page} 在涨（点击 ${String(rival.clicks_prev_week ?? 0)} → ${String(rival.clicks)}）——两页在抢，该合并。`,
      evidence: { ...evidenceBase, other_page: rival.page, other_page_clicks: rival.clicks },
    }
  // ② 这页别的词在涨 → 查询变了
  const gaining_clicks = mine
    .filter((r) => normalizeQuery(r.query) !== q && r.clicks_prev_week !== undefined)
    .reduce((n, r) => n + Math.max(0, r.clicks - (r.clicks_prev_week ?? 0)), 0)
  if (lost > 0 && gaining_clicks >= lost * o.shift_ratio)
    return {
      verdict: 'query_shift',
      reason: `「${row.query}」少了 ${String(lost)} 次点击，但这页别的词多了 ${String(gaining_clicks)} 次——查询变了，按涨起来的词改标题与开头。`,
      evidence: { ...evidenceBase, gaining_clicks },
    }
  // ③ 整页几乎没人搜了 → 该下线
  if (page_clicks <= o.retire_max_clicks && page_impressions < o.retire_max_impressions)
    return {
      verdict: 'retire',
      reason: `这页整周只有 ${String(page_clicks)} 次点击、${String(page_impressions)} 次曝光——值不得再改，下线并跳到最相关的页。`,
      evidence: evidenceBase,
    }
  // ④ 还有需求 → 刷新内容
  return {
    verdict: 'refresh',
    reason: `这页还有 ${String(page_impressions)} 次曝光，是内容旧了——刷新内容（加小节、更新日期），再请 Google 重新收录。`,
    evidence: evidenceBase,
  }
}
