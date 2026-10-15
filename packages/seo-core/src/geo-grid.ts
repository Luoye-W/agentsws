/**
 * WP335（docs/99 §5.4 / §5.6，O3）：看板上的 **Prompt × AI 方格**、「一条回答」那一格的时间线、
 * 简报那一行——**规则算，数不经模型手**。
 *
 * 几条与 `geo-metrics` 同口径：
 *
 * - 同一周同一格（Prompt × AI × 市场）好几条取最新那条；
 * - 失败 / 空回答是「没查成」，不算「没提到」；
 * - 和上一期比**只比两期都拿到回答的格**（任一期没拿到就不出箭头）。
 */
import type {
  AiPlatform,
  GeoCellState,
  GeoGridCell,
  GeoGridRow,
  GeoGridView,
  GeoWeekPoint,
  RankMetricsView,
} from '@agentsws/contracts'
import { AI_PLATFORMS } from '@agentsws/contracts'
import { latestPerCell, type MetricAnswer } from './geo-metrics.js'

const cellKey = (m: MetricAnswer): string =>
  `${m.answer.prompt_id}|${m.answer.platform}|${m.answer.market}`

/** 一条回答在方格里是什么状态（失败 / 空 = 没查成）。 */
export function cellStateOf(m: MetricAnswer): GeoCellState {
  if (m.answer.status !== 'ok') return 'failed'
  return m.mentions.find((x) => x.entity === 'ours')?.mentioned === true ? 'mentioned' : 'absent'
}

const rankOf = (m: MetricAnswer): number | undefined =>
  m.mentions.find((x) => x.entity === 'ours' && x.mentioned)?.rank

/** 同一格两期比：没提到 → 提到 / 名次往前 = `up`；反过来 = `down`；没变或有一期没拿到回答 = 不写。 */
export function cellChangeOf(
  before: MetricAnswer | undefined,
  after: MetricAnswer,
): 'up' | 'down' | undefined {
  if (before === undefined) return undefined
  const b = cellStateOf(before)
  const a = cellStateOf(after)
  if (b === 'failed' || a === 'failed') return undefined
  if (b !== a) return a === 'mentioned' ? 'up' : 'down'
  if (a !== 'mentioned') return undefined
  const rb = rankOf(before)
  const ra = rankOf(after)
  if (rb === undefined || ra === undefined || rb === ra) return undefined
  return ra < rb ? 'up' : 'down'
}

/**
 * 最新一周（或指定那一周）的 Prompt × AI 方格。上一期 = 比它早、有数的最近一周。
 * 行按「不带品牌名的在前」再按原句排；列按 `AI_PLATFORMS` 的顺序。没有这一周的数回 `undefined`。
 */
export function geoGrid(rows: readonly MetricAnswer[], week?: string): GeoGridView | undefined {
  const latest = latestPerCell(rows)
  const weeks = [...new Set(latest.map((r) => r.week))].sort()
  const target = week ?? weeks.at(-1)
  if (target === undefined) return undefined
  const now = latest.filter((r) => r.week === target)
  if (now.length === 0) return undefined
  const prevWeek = weeks.filter((w) => w < target).at(-1)
  const before = new Map(
    prevWeek === undefined
      ? []
      : latest.filter((r) => r.week === prevWeek).map((r) => [cellKey(r), r] as const),
  )
  const asked = new Set(now.map((r) => r.answer.platform))
  const platforms = AI_PLATFORMS.filter((p) => asked.has(p))
  // 认不出的平台名（以后加的）排在最后，不丢
  for (const p of asked) if (!platforms.includes(p)) platforms.push(p)
  const markets = [...new Set(now.map((r) => r.answer.market))].sort()
  const byPrompt = new Map<string, MetricAnswer[]>()
  for (const r of now) {
    const list = byPrompt.get(r.answer.prompt_id) ?? []
    list.push(r)
    byPrompt.set(r.answer.prompt_id, list)
  }
  const order = (p: AiPlatform): number => platforms.indexOf(p)
  const out: GeoGridRow[] = [...byPrompt.values()].map((list) => {
    const first = list[0] as MetricAnswer
    const cells: GeoGridCell[] = [...list]
      .sort(
        (a, b) =>
          order(a.answer.platform) - order(b.answer.platform) ||
          a.answer.market.localeCompare(b.answer.market),
      )
      .map((r) => {
        const rank = rankOf(r)
        const change = cellChangeOf(before.get(cellKey(r)), r)
        return {
          platform: r.answer.platform,
          market: r.answer.market,
          state: cellStateOf(r),
          ...(rank === undefined ? {} : { rank }),
          cited: r.mentions.find((x) => x.entity === 'ours')?.cited === true,
          answer_id: r.answer.id,
          ...(change === undefined ? {} : { change }),
        }
      })
    // 行尾箭头：两期都拿到回答的格里，提到我们的格数多了 / 少了
    let was = 0
    let is = 0
    for (const r of list) {
      const b = before.get(cellKey(r))
      if (b === undefined || cellStateOf(b) === 'failed' || cellStateOf(r) === 'failed') continue
      if (cellStateOf(b) === 'mentioned') was += 1
      if (cellStateOf(r) === 'mentioned') is += 1
    }
    const branded = first.branded
    return {
      prompt_id: first.answer.prompt_id,
      prompt_text: first.answer.prompt_text,
      ...(branded === undefined ? {} : { branded }),
      cells,
      ...(is === was ? {} : { change: is > was ? ('up' as const) : ('down' as const) }),
    }
  })
  out.sort(
    (a, b) =>
      Number(a.branded === true) - Number(b.branded === true) ||
      a.prompt_text.localeCompare(b.prompt_text),
  )
  return { week: target, platforms, markets, rows: out }
}

/** 一格（Prompt × AI × 市场）近几周的时间线：每周一个点（同一周取最新），旧的在前。 */
export function cellHistory(
  rows: readonly MetricAnswer[],
  cell: { prompt_id: string; platform: AiPlatform; market: string },
  weeks = 12,
): { week: string; state: GeoCellState; rank?: number; answer_id: string }[] {
  const key = `${cell.prompt_id}|${cell.platform}|${cell.market}`
  return latestPerCell(rows.filter((r) => cellKey(r) === key))
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-weeks)
    .map((r) => {
      const rank = rankOf(r)
      return {
        week: r.week,
        state: cellStateOf(r),
        ...(rank === undefined ? {} : { rank }),
        answer_id: r.answer.id,
      }
    })
}

const MINUS = '−'
const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : '0')

/**
 * 简报那一行（docs/99 §5.4）：「AI 里提到我们 38%（+5）· 关注词平均第 12（−1）」。
 *
 * - 这一周没拿到回答（没开 / 没跑成）→ 不出（`undefined`）；
 * - 提及率的变化用 `change_pp`（覆盖不足 / 没上一期时不写，于是不带括号）；
 * - 关注词平均排名只平均进了前 20 的词；上一期的平均按同样口径（上周进了前 20 的词）。
 */
export function geoBriefLine(
  point: GeoWeekPoint | undefined,
  rank?: RankMetricsView,
): string | undefined {
  if (point === undefined || point.ok === 0 || point.mention_rate === undefined) return undefined
  const pct = Math.round(point.mention_rate * 100)
  const pp = point.change_pp === undefined ? undefined : Math.round(point.change_pp)
  const parts = [`AI 里提到我们 ${pct}%${pp === undefined ? '' : `（${signed(pp)}）`}`]
  if (rank?.avg_rank !== undefined) {
    const now = Math.round(rank.avg_rank)
    const prev = rank.rows
      .map((r) => r.previous)
      .filter((v): v is number => v !== undefined && v <= 20)
    const was =
      prev.length === 0 ? undefined : Math.round(prev.reduce((a, b) => a + b, 0) / prev.length)
    parts.push(`关注词平均第 ${now}${was === undefined ? '' : `（${signed(now - was)}）`}`)
  }
  // 全角括号后面不再空一格（与 docs/99 §5.4 的样子一致）
  return parts.join(' · ').replace('） · ', '）· ')
}
