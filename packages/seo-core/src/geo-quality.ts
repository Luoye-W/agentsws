/**
 * WP380：看板与周报的第二层——**说得对不对、比得过谁**（逐项准确度、说错的那几句、和各竞品比）、
 * **报告里每个数标来路**（实测 / 推算 / 估算 + 样本量 + 日期）、**站外来源地图**、**缺位的主要原因
 * 与先后**（严重度 × 重要度 ÷ 工作量，带负责岗位与复查日期）。
 *
 * 思路参考 Aleyda Solis《AI Search Optimization Checklist》（2026-09-26 版），口径是我们自己的。
 * 纯函数：判断那一步（比较、说法）已由模型附原话做完；这里只数、只排。
 */
import type {
  CitedSiteKind,
  GeoFactKey,
  GeoFixOwner,
  GeoGap,
  GeoGapCause,
  GeoOfficialFact,
  GeoPromptTopic,
  GeoQualityView,
  GeoReportFigure,
  GeoRunEstimate,
  GeoSourceMapRow,
  GeoWeekPoint,
  RankMetricsView,
} from '@agentsws/contracts'
import { GEO_FACT_KEYS } from '@agentsws/contracts'
import { latestPerCell, type MetricAnswer, shiftDay } from './geo-metrics.js'

const pctOf = (v: number): string => `${Math.round(v * 100)}%`

/** 看板「说得对不对、比得过谁」：近 4 周逐项、最新一周说错的几句、近 4 周和每个竞品比。 */
export function geoQualityOf(
  rows: readonly MetricAnswer[],
  week: string | undefined,
  facts: readonly GeoOfficialFact[],
): Omit<GeoQualityView, 'facts' | 'consistency' | 'rechecks'> {
  const empty = { fields: [], bad_claims: [], rivals: [], by: 'ai' as const }
  if (week === undefined) return empty
  const from = shiftDay(week, -21)
  const ok = latestPerCell(rows).filter(
    (r) => r.answer.status === 'ok' && r.week >= from && r.week <= week,
  )
  const fields = GEO_FACT_KEYS.map((field) => {
    const cs = ok.flatMap((r) => (r.insight?.claims ?? []).filter((c) => c.field === field))
    const n = (v: string) => cs.filter((c) => c.verdict === v).length
    return { field, correct: n('correct'), wrong: n('wrong'), outdated: n('outdated') }
  }).filter((f) => f.correct + f.wrong + f.outdated > 0)
  const official = new Map(facts.map((f) => [f.key, f.value]))
  const bad_claims = ok
    .filter((r) => r.week === week)
    .flatMap((r) =>
      (r.insight?.claims ?? [])
        .filter((c) => c.verdict !== 'correct')
        .map((c) => ({
          answer_id: r.answer.id,
          week: r.week,
          platform: r.answer.platform,
          market: r.answer.market,
          prompt_text: r.answer.prompt_text,
          field: c.field,
          verdict: c.verdict as 'wrong' | 'outdated',
          said: c.said,
          quote: c.quote,
          ...(official.has(c.field) ? { official: official.get(c.field) as string } : {}),
        })),
    )
    .slice(0, 10)
  const by = new Map<string, { name: string; wins: number; losses: number; ties: number }>()
  for (const r of ok) {
    const c = r.insight?.compare
    if (c === undefined) continue
    const name = c.rival ?? '—'
    const cur = by.get(name.toLowerCase()) ?? { name, wins: 0, losses: 0, ties: 0 }
    if (c.verdict === 'ours') cur.wins += 1
    else if (c.verdict === 'competitor') cur.losses += 1
    else cur.ties += 1
    by.set(name.toLowerCase(), cur)
  }
  const rivals = [...by.values()].sort(
    (a, b) => b.wins + b.losses + b.ties - (a.wins + a.losses + a.ties),
  )
  return { week, fields, bad_claims, rivals, by: 'ai' }
}

/**
 * 报告里的几个数，每个都标来路：规则从回答原文数的 = 实测；要模型判断的（胜率、准确度）= 推算；
 * 积分预估 = 估算。没样本的数不出。
 */
export function reportFigures(input: {
  point?: GeoWeekPoint | undefined
  rank?: RankMetricsView | undefined
  estimate?: GeoRunEstimate | undefined
  as_of: string
}): GeoReportFigure[] {
  const out: GeoReportFigure[] = []
  const p = input.point
  const at = input.as_of
  if (p?.mention_rate !== undefined)
    out.push({
      key: 'mention_rate',
      label: '提到我们',
      value: pctOf(p.mention_rate),
      basis: 'measured',
      n: p.ok,
      as_of: at,
    })
  if (p?.citation_rate !== undefined)
    out.push({
      key: 'citation_rate',
      label: '引用我们的页',
      value: pctOf(p.citation_rate),
      basis: 'measured',
      n: p.ok,
      as_of: at,
    })
  if (p?.sov !== undefined)
    out.push({ key: 'sov', label: '声量份额', value: pctOf(p.sov), basis: 'measured', as_of: at })
  if (p?.win_rate !== undefined)
    out.push({
      key: 'win_rate',
      label: '比较胜率',
      value: pctOf(p.win_rate),
      basis: 'derived',
      ...(p.compared === undefined ? {} : { n: p.compared }),
      as_of: at,
    })
  if (p?.accuracy !== undefined)
    out.push({
      key: 'accuracy',
      label: '描述准确度',
      value: pctOf(p.accuracy),
      basis: 'derived',
      ...(p.claims === undefined ? {} : { n: p.claims }),
      as_of: at,
    })
  const r = input.rank
  if (r?.avg_rank !== undefined)
    out.push({
      key: 'avg_rank',
      label: '关注词平均名次',
      value: `第 ${Math.round(r.avg_rank * 10) / 10}`,
      basis: 'measured',
      n: r.in_top20,
      as_of: r.week ?? at,
    })
  const e = input.estimate
  if (e?.credits !== undefined && e.route === 'official')
    out.push({
      key: 'credits',
      label: '这一轮积分',
      value: `约 ${e.credits}`,
      basis: 'estimated',
      as_of: at,
    })
  return out
}

/** 来路的中文（报告摘要里那一个字）。 */
export const FIGURE_BASIS_ZH: Readonly<Record<GeoReportFigure['basis'], string>> = {
  measured: '实测',
  derived: '推算',
  estimated: '估算',
}

/** 「提到我们 38%（实测，n=20，10-12）」。 */
export function figureLine(f: GeoReportFigure): string {
  const n = f.n === undefined ? '' : `，n=${f.n}`
  return `${f.label} ${f.value}（${FIGURE_BASIS_ZH[f.basis]}${n}，${f.as_of.slice(5)}）`
}

const MAP_GROUP: Readonly<Record<CitedSiteKind, GeoSourceMapRow['group']>> = {
  ours: 'owned',
  competitor: 'other',
  marketplace: 'marketplace',
  media: 'media',
  forum: 'community',
  video: 'video',
  other: 'other',
}
const MAP_OWNER: Readonly<Record<GeoSourceMapRow['group'], GeoSourceMapRow['owner']>> = {
  owned: 'content',
  media: 'pr',
  community: 'community',
  marketplace: 'reviews',
  video: 'kol',
  other: 'pr',
}

/**
 * 站外来源地图：`[from, to]` 这几周里被引用的外部来源，按市场 × 站的类型分（自有 / 媒体 / 社区 /
 * 电商平台 / 视频），每组带交给谁；竞品自己的站不进地图。同一条回答里同一个站只数一次。
 */
export function sourceMap(
  rows: readonly MetricAnswer[],
  range: { from: string; to: string },
): GeoSourceMapRow[] {
  const groups = new Map<
    string,
    {
      market: string
      kind: CitedSiteKind
      domains: Map<string, { citations: number; mentions_us: boolean }>
    }
  >()
  for (const r of latestPerCell(rows)) {
    if (r.answer.status !== 'ok' || r.week < range.from || r.week > range.to) continue
    const us = r.mentions.some((m) => m.entity === 'ours' && m.mentioned)
    const seen = new Set<string>()
    for (const c of r.citations) {
      if (c.where === 'searched' || c.site_kind === 'competitor' || seen.has(c.domain)) continue
      seen.add(c.domain)
      const key = `${r.answer.market}|${c.site_kind}`
      const g = groups.get(key) ?? {
        market: r.answer.market,
        kind: c.site_kind,
        domains: new Map(),
      }
      const d = g.domains.get(c.domain) ?? { citations: 0, mentions_us: false }
      d.citations += 1
      d.mentions_us = d.mentions_us || us
      g.domains.set(c.domain, d)
      groups.set(key, g)
    }
  }
  return [...groups.values()]
    .map((g) => {
      const domains = [...g.domains.entries()]
        .map(([domain, d]) => ({ domain, ...d }))
        .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain))
      const group = MAP_GROUP[g.kind]
      return {
        market: g.market,
        group,
        site_kind: g.kind,
        domains: domains.slice(0, 5),
        citations: domains.reduce((a, d) => a + d.citations, 0),
        owner: MAP_OWNER[group],
      }
    })
    .sort((a, b) => a.market.localeCompare(b.market) || b.citations - a.citations)
}

/* ── 缺位的主要原因与先后 ──────────────────────────────────────────── */

/** 每种原因归谁、要多少力气（1 小 – 3 大）、复查等几天。 */
export const GAP_CAUSES: Readonly<
  Record<GeoGapCause, { owner: GeoFixOwner | 'content'; effort: number; recheck_days: number }>
> = {
  not_crawlable: { owner: 'site', effort: 2, recheck_days: 14 },
  not_readable: { owner: 'site', effort: 2, recheck_days: 14 },
  not_useful: { owner: 'content', effort: 1, recheck_days: 14 },
  outdated: { owner: 'web-ops', effort: 1, recheck_days: 14 },
  no_difference: { owner: 'content', effort: 2, recheck_days: 14 },
  not_recognized: { owner: 'site', effort: 2, recheck_days: 28 },
  inconsistent: { owner: 'web-ops', effort: 2, recheck_days: 28 },
  no_corroboration: { owner: 'pr', effort: 3, recheck_days: 28 },
  not_trusted: { owner: 'pr', effort: 3, recheck_days: 28 },
  not_buyable: { owner: 'web-ops', effort: 2, recheck_days: 14 },
}

/** 原因的中文名（卡与报告上用）。 */
export const GAP_CAUSE_ZH: Readonly<Record<GeoGapCause, string>> = {
  not_crawlable: '抓不到',
  not_readable: '读不出',
  not_useful: '没用',
  outdated: '过时',
  no_difference: '没差异',
  not_recognized: '认不出',
  inconsistent: '说法不一致',
  no_corroboration: '没人佐证',
  not_trusted: '不可信',
  not_buyable: '买不了',
}

/** 一个问题上手头有的信号（都可选；WP381 的体检结果有就传）。 */
export interface GapSignals {
  topic?: GeoPromptTopic | undefined
  /** 这个问题的回答里说错 / 说旧的几项（描述准确度）。 */
  wrong_fields?: readonly GeoFactKey[] | undefined
  outdated_fields?: readonly GeoFactKey[] | undefined
  /** 和竞品比输了几次、赢了几次。 */
  losses?: number | undefined
  wins?: number | undefined
  negative?: boolean | undefined
  /** 对外说法一致性检查里有没查出的几处。 */
  inconsistent?: boolean | undefined
  /** WP381：AI 爬虫被挡 / 原始网页里没正文。 */
  blocked?: boolean | undefined
  js_only?: boolean | undefined
}

/** 主要原因：先看最硬的信号（抓不到、读不出），再看说法，最后按车道兜底。 */
export function gapCause(gap: Pick<GeoGap, 'lane' | 'page'>, s: GapSignals = {}): GeoGapCause {
  if (s.blocked === true) return 'not_crawlable'
  if (s.js_only === true) return 'not_readable'
  const wrong = s.wrong_fields ?? []
  if (wrong.includes('markets')) return 'not_buyable'
  if (wrong.includes('name') || wrong.includes('category')) return 'not_recognized'
  if ((s.outdated_fields ?? []).length > 0) return 'outdated'
  if (s.inconsistent === true && wrong.length > 0) return 'inconsistent'
  if (s.negative === true) return 'not_trusted'
  if ((s.losses ?? 0) > (s.wins ?? 0)) return 'no_difference'
  return gap.lane === 'pr_handoff' ? 'no_corroboration' : 'not_useful'
}

/** 这一问离下单多近（1–3）：比较 / 价格 / 口碑 / 带品牌名 = 3，品类 / 选购 = 2，其余 1。 */
const importanceOf = (topic: GeoPromptTopic | undefined): number =>
  topic === undefined
    ? 2
    : ['comparison', 'price_value', 'reviews', 'branded'].includes(topic)
      ? 3
      : ['category', 'buying_guide'].includes(topic)
        ? 2
        : 1

/**
 * 给缺位补上主要原因、先后（严重度 × 重要度 ÷ 工作量，一位小数）、负责岗位、复查日期，按先后排好。
 * 严重度：缺位的 AI ≥ 3 个 = 3、2 个 = 2、1 个 = 1；说错了名字 / 品类 / 市场 = 3。
 */
export function rankGaps(
  gaps: readonly GeoGap[],
  signalsOf: (gap: GeoGap) => GapSignals,
  week: string,
): GeoGap[] {
  return gaps
    .map((g) => {
      const s = signalsOf(g)
      const cause = gapCause(g, s)
      const meta = GAP_CAUSES[cause]
      const severity = Math.max(
        Math.min(3, Math.max(1, g.platforms.length)),
        cause === 'not_recognized' || cause === 'not_buyable' ? 3 : 1,
      )
      const effort = cause === 'not_useful' && g.page === undefined ? 2 : meta.effort
      const priority = Math.round(((severity * importanceOf(s.topic)) / effort) * 10) / 10
      return {
        ...g,
        cause,
        priority,
        owner: meta.owner,
        recheck_on: shiftDay(week, meta.recheck_days),
      }
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}
