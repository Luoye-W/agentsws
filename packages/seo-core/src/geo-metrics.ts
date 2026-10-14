/**
 * WP321（docs/99 §5.3 / §5.5，借 open-seo）：GEO / SEO 指标——**规则算，数不经模型手**。
 *
 * 输入是历史表里的原文判定（`geo_answers` + `geo_mentions` + `geo_citations`、`seo_rank_snapshots`、
 * `seo_brand_gsc_weekly`），输出是看板要的数。几条硬规矩：
 *
 * - 提及率 / 引用率的**分母只算拿到回答的**（失败 / 空回答不算「没提到」）；
 * - 同一周同一格（Prompt × AI × 市场）有好几条（手动又跑了一轮）时取最新那条；
 * - 周对比**只比两期都拿到回答的格**；任一期覆盖 < 90% 不出变化；另给近 4 周滚动的提及率；
 * - 声量份额只在已知品牌（我们 + 竞品）里算；情感是 AI 判断（附原话），只数不改。
 */
import type {
  AiPlatform,
  GeoAnswerRecord,
  GeoBrandShare,
  GeoCellChange,
  GeoCitationRecord,
  GeoCitedSource,
  GeoMentionRecord,
  GeoTrendLine,
  GeoWeekPoint,
  RankKeywordRow,
  RankMetricsView,
  SeoBrandGscWeek,
  SeoRankSnapshot,
} from '@agentsws/contracts'
import { GEO_TREND_MIN_COVERAGE, GEO_TREND_WEEKS } from '@agentsws/contracts'

const DAY_MS = 86_400_000

/** 一个时刻所在那一周的周一（UTC，`YYYY-MM-DD`）。 */
export function mondayOf(iso: string): string {
  const t = Date.parse(iso)
  const d = new Date(Number.isNaN(t) ? 0 : t)
  const back = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
    .toISOString()
    .slice(0, 10)
}

/** 周一日期加减几天（还是 `YYYY-MM-DD`）。 */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 指标要的一条回答：原文记录 + 那一轮的周 + 判定 + 引用（+ Prompt 带不带品牌名）。 */
export interface MetricAnswer {
  answer: GeoAnswerRecord
  week: string
  mentions: readonly GeoMentionRecord[]
  citations: readonly GeoCitationRecord[]
  branded?: boolean | undefined
}

const cellKey = (a: GeoAnswerRecord): string => `${a.prompt_id}|${a.platform}|${a.market}`
const ours = (m: MetricAnswer): GeoMentionRecord | undefined =>
  m.mentions.find((x) => x.entity === 'ours')
const round = (v: number, digits = 3): number => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/** 同一周同一格只留最新那条（`fetched_at` 晚的）。 */
export function latestPerCell(rows: readonly MetricAnswer[]): MetricAnswer[] {
  const by = new Map<string, MetricAnswer>()
  for (const r of rows) {
    const k = `${r.week}|${cellKey(r.answer)}`
    const cur = by.get(k)
    if (cur === undefined || r.answer.fetched_at >= cur.answer.fetched_at) by.set(k, r)
  }
  return [...by.values()]
}

/** 一组格（同一周）的几个数。 */
function pointOf(week: string, rows: readonly MetricAnswer[]): GeoWeekPoint {
  const ok = rows.filter((r) => r.answer.status === 'ok')
  const mentioned = ok.filter((r) => ours(r)?.mentioned === true)
  const cited = ok.filter((r) => ours(r)?.cited === true)
  const ranks = mentioned.map((r) => ours(r)?.rank).filter((x): x is number => x !== undefined)
  let all = 0
  for (const r of ok) all += r.mentions.filter((m) => m.mentioned).length
  return {
    week,
    planned: rows.length,
    ok: ok.length,
    mentioned: mentioned.length,
    cited: cited.length,
    ...(ok.length === 0
      ? {}
      : {
          mention_rate: round(mentioned.length / ok.length),
          citation_rate: round(cited.length / ok.length),
        }),
    ...(ranks.length === 0
      ? {}
      : { avg_rank: round(ranks.reduce((a, b) => a + b, 0) / ranks.length, 2) }),
    ...(all === 0 ? {} : { sov: round(mentioned.length / all) }),
    ...(rows.length === 0 ? {} : { coverage: round(ok.length / rows.length) }),
  }
}

/** 两周都拿到回答的格上，这周比上周提及率变了几个百分点（覆盖不足不出）。 */
function changePp(cur: readonly MetricAnswer[], prev: readonly MetricAnswer[]): number | undefined {
  const pc = pointOf('', cur).coverage ?? 0
  const pp = pointOf('', prev).coverage ?? 0
  if (pc < GEO_TREND_MIN_COVERAGE || pp < GEO_TREND_MIN_COVERAGE) return undefined
  const before = new Map(
    prev.filter((r) => r.answer.status === 'ok').map((r) => [cellKey(r.answer), r]),
  )
  const pairs = cur
    .filter((r) => r.answer.status === 'ok' && before.has(cellKey(r.answer)))
    .map((r) => [before.get(cellKey(r.answer)) as MetricAnswer, r] as const)
  if (pairs.length === 0) return undefined
  const rate = (xs: readonly MetricAnswer[]) =>
    xs.filter((r) => ours(r)?.mentioned === true).length / xs.length
  return round((rate(pairs.map((p) => p[1])) - rate(pairs.map((p) => p[0]))) * 100, 1)
}

/** 按周排好的点（带近 4 周滚动提及率与周对比）。 */
export function weekPoints(rows: readonly MetricAnswer[]): GeoWeekPoint[] {
  const latest = latestPerCell(rows)
  const weeks = [...new Set(latest.map((r) => r.week))].sort()
  const byWeek = new Map(weeks.map((w) => [w, latest.filter((r) => r.week === w)]))
  return weeks.map((w) => {
    const cur = byWeek.get(w) ?? []
    const point = pointOf(w, cur)
    const from = shiftDay(w, -7 * (GEO_TREND_WEEKS - 1))
    const window = latest.filter((r) => r.week >= from && r.week <= w)
    const ok = window.filter((r) => r.answer.status === 'ok')
    const prev = byWeek.get(shiftDay(w, -7))
    const change = prev === undefined ? undefined : changePp(cur, prev)
    return {
      ...point,
      ...(ok.length === 0
        ? {}
        : {
            mention_rate_4w: round(
              ok.filter((r) => ours(r)?.mentioned === true).length / ok.length,
            ),
          }),
      ...(change === undefined ? {} : { change_pp: change }),
    }
  })
}

/** 趋势线：全部、每个 AI、每个市场、带 / 不带品牌名。 */
export function geoTrends(rows: readonly MetricAnswer[]): GeoTrendLine[] {
  const out: GeoTrendLine[] = [{ kind: 'all', key: 'all', points: weekPoints(rows) }]
  const platforms = [...new Set(rows.map((r) => r.answer.platform))]
  for (const p of platforms)
    out.push({
      kind: 'platform',
      key: p,
      points: weekPoints(rows.filter((r) => r.answer.platform === p)),
    })
  const markets = [...new Set(rows.map((r) => r.answer.market))].sort()
  if (markets.length > 1)
    for (const m of markets)
      out.push({
        kind: 'market',
        key: m,
        points: weekPoints(rows.filter((r) => r.answer.market === m)),
      })
  for (const [key, want] of [
    ['branded', true],
    ['unbranded', false],
  ] as const) {
    const part = rows.filter((r) => r.branded !== undefined && r.branded === want)
    if (part.length > 0) out.push({ kind: 'branded', key, points: weekPoints(part) })
  }
  return out
}

/** 某一周：我们与各竞品被提到几次、声量份额（`names`：实体 → 现在的名字）。 */
export function brandShares(
  rows: readonly MetricAnswer[],
  week: string,
  names: ReadonlyMap<string, string>,
): GeoBrandShare[] {
  const ok = latestPerCell(rows).filter((r) => r.week === week && r.answer.status === 'ok')
  const count = new Map<string, number>()
  for (const e of names.keys()) count.set(e, 0)
  for (const r of ok)
    for (const m of r.mentions) if (m.mentioned) count.set(m.entity, (count.get(m.entity) ?? 0) + 1)
  const total = [...count.values()].reduce((a, b) => a + b, 0)
  return [...count.entries()]
    .map(([entity, mentioned]) => ({
      entity,
      name: names.get(entity) ?? entity,
      mentioned,
      ...(total === 0 ? {} : { sov: round(mentioned / total) }),
    }))
    .sort((a, b) =>
      a.entity === 'ours' ? -1 : b.entity === 'ours' ? 1 : b.mentioned - a.mentioned,
    )
}

/** 某一周提到我们的回答的情感（AI 判断；没判的不数）。 */
export function sentimentCounts(
  rows: readonly MetricAnswer[],
  week: string,
): { positive: number; neutral: number; negative: number; by: 'ai' } {
  const out = { positive: 0, neutral: 0, negative: 0, by: 'ai' as const }
  for (const r of latestPerCell(rows)) {
    if (r.week !== week || r.answer.status !== 'ok') continue
    const s = ours(r)?.sentiment
    if (s !== undefined) out[s] += 1
  }
  return out
}

const groupOf = (kind: GeoCitationRecord['site_kind']): GeoCitedSource['group'] =>
  kind === 'ours' ? 'ours' : kind === 'competitor' ? 'competitor' : 'offsite'

/**
 * 被引用最多的站 / 页（`by`）：`[from, to]` 这几周里被引用（正文里引用的 + 列在来源里的；只在搜索结果里
 * 的不算）几次、几条 Prompt、哪几个 AI；与之前同样长的一段比（之前没有 = 新冒出来的）。
 */
export function citedSources(
  rows: readonly MetricAnswer[],
  range: { from: string; to: string },
  by: 'domain' | 'page',
): GeoCitedSource[] {
  const span = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 7
  const prevFrom = shiftDay(range.from, -span)
  const latest = latestPerCell(rows).filter((r) => r.answer.status === 'ok')
  const keyOf = (c: GeoCitationRecord) => (by === 'domain' ? c.domain : c.url_norm)
  const agg = new Map<
    string,
    { c: GeoCitationRecord; n: number; prompts: Set<string>; platforms: Set<AiPlatform> }
  >()
  const prev = new Map<string, number>()
  for (const r of latest) {
    const inNow = r.week >= range.from && r.week <= range.to
    const inPrev = r.week >= prevFrom && r.week < range.from
    if (!inNow && !inPrev) continue
    // 一条回答里同一站 / 页只数一次
    const seen = new Set<string>()
    for (const c of r.citations) {
      if (c.where === 'searched') continue
      const k = keyOf(c)
      if (seen.has(k)) continue
      seen.add(k)
      if (inPrev) {
        prev.set(k, (prev.get(k) ?? 0) + 1)
        continue
      }
      const cur = agg.get(k) ?? { c, n: 0, prompts: new Set(), platforms: new Set() }
      cur.n += 1
      cur.prompts.add(r.answer.prompt_id)
      cur.platforms.add(r.answer.platform)
      agg.set(k, cur)
    }
  }
  return [...agg.entries()]
    .map(([k, v]) => {
      const previous = prev.get(k) ?? 0
      return {
        domain: v.c.domain,
        ...(by === 'page' ? { url_norm: v.c.url_norm, url: v.c.url } : {}),
        ...(by === 'page' && v.c.title !== undefined ? { title: v.c.title } : {}),
        site_kind: v.c.site_kind,
        group: groupOf(v.c.site_kind),
        citations: v.n,
        prompts: v.prompts.size,
        platforms: [...v.platforms],
        previous,
        new: previous === 0,
      }
    })
    .sort(
      (a, b) =>
        b.citations - a.citations || (a.url_norm ?? a.domain).localeCompare(b.url_norm ?? b.domain),
    )
}

/** 同一格这周与上周比：提及、名次、情感、引用来源的增减（只列有变化的；丢了提及的排前面）。 */
export function cellChanges(rows: readonly MetricAnswer[], week: string): GeoCellChange[] {
  const latest = latestPerCell(rows).filter((r) => r.answer.status === 'ok')
  const before = new Map(
    latest.filter((r) => r.week === shiftDay(week, -7)).map((r) => [cellKey(r.answer), r]),
  )
  const sources = (r: MetricAnswer) =>
    new Set(r.citations.filter((c) => c.where !== 'searched').map((c) => c.domain))
  const out: GeoCellChange[] = []
  for (const r of latest) {
    if (r.week !== week) continue
    const p = before.get(cellKey(r.answer))
    if (p === undefined) continue
    const a = ours(r)
    const b = ours(p)
    const now = sources(r)
    const was = sources(p)
    const added = [...now].filter((d) => !was.has(d)).sort()
    const removed = [...was].filter((d) => !now.has(d)).sort()
    const mentionFlip = (a?.mentioned === true) !== (b?.mentioned === true)
    const rankMoved = a?.rank !== b?.rank
    const moodMoved = a?.sentiment !== b?.sentiment
    if (!mentionFlip && !rankMoved && !moodMoved && added.length === 0 && removed.length === 0)
      continue
    out.push({
      prompt_id: r.answer.prompt_id,
      prompt_text: r.answer.prompt_text,
      platform: r.answer.platform,
      market: r.answer.market,
      mentioned: { before: b?.mentioned === true, after: a?.mentioned === true },
      ...(rankMoved
        ? {
            rank: {
              ...(b?.rank === undefined ? {} : { before: b.rank }),
              ...(a?.rank === undefined ? {} : { after: a.rank }),
            },
          }
        : {}),
      ...(moodMoved
        ? {
            sentiment: {
              ...(b?.sentiment === undefined ? {} : { before: b.sentiment }),
              ...(a?.sentiment === undefined ? {} : { after: a.sentiment }),
            },
          }
        : {}),
      sources_added: added,
      sources_removed: removed,
      same_text: r.answer.answer_hash === p.answer.answer_hash,
    })
  }
  const lost = (c: GeoCellChange) => (c.mentioned.before && !c.mentioned.after ? 0 : 1)
  return out.sort(
    (x, y) =>
      lost(x) - lost(y) ||
      x.prompt_text.localeCompare(y.prompt_text) ||
      x.platform.localeCompare(y.platform),
  )
}

/** 排名快照 + 那一轮的周。 */
export type RankPoint = SeoRankSnapshot & { week: string }

/**
 * 关注词排名：最新一周每个词 × 市场 × 设备一行，带上周、4 周前、周变化；只平均进了前 20 的词，
 * 另数 20 名外几个、进前 10 / 掉出前 10 几个（上一期没数的词不算变化）。
 */
export function rankMetrics(
  points: readonly RankPoint[],
  gscPosition?: (keyword: string) => number | undefined,
): RankMetricsView {
  const weeks = [...new Set(points.map((p) => p.week))].sort()
  const week = weeks.at(-1)
  const empty = { rows: [], in_top20: 0, out_of_20: 0, entered_top10: 0, left_top10: 0 }
  if (week === undefined) return empty
  const key = (p: SeoRankSnapshot) => `${p.keyword}|${p.market}|${p.device}`
  const at = (w: string) => {
    const m = new Map<string, RankPoint>()
    for (const p of points)
      if (p.week === w) {
        const cur = m.get(key(p))
        if (cur === undefined || p.fetched_at >= cur.fetched_at) m.set(key(p), p)
      }
    return m
  }
  const now = at(week)
  const prev = at(shiftDay(week, -7))
  const old = at(shiftDay(week, -28))
  let entered = 0
  let left = 0
  const rows: RankKeywordRow[] = [...now.values()].map((p) => {
    const b = prev.get(key(p))
    const o = old.get(key(p))
    const top10 = (r: number | undefined) => r !== undefined && r <= 10
    if (b !== undefined && top10(p.rank) && !top10(b.rank)) entered += 1
    if (b !== undefined && top10(b.rank) && !top10(p.rank)) left += 1
    const gsc = gscPosition?.(p.keyword)
    return {
      keyword: p.keyword,
      market: p.market,
      device: p.device,
      ...(p.rank === undefined ? {} : { rank: p.rank }),
      ...(b?.rank === undefined ? {} : { previous: b.rank }),
      ...(o?.rank === undefined ? {} : { four_weeks_ago: o.rank }),
      ...(p.rank !== undefined && b?.rank !== undefined ? { change: b.rank - p.rank } : {}),
      ...(p.url === undefined ? {} : { url: p.url }),
      features: p.serp_features,
      aio_mentions_us: p.aio_mentions_us,
      aio_cites_us: p.aio_cites_us,
      ...(gsc === undefined ? {} : { gsc_position: gsc }),
    }
  })
  rows.sort(
    (a, b) =>
      (a.rank ?? 99) - (b.rank ?? 99) ||
      a.keyword.localeCompare(b.keyword) ||
      a.market.localeCompare(b.market),
  )
  const ranked = rows.map((r) => r.rank).filter((r): r is number => r !== undefined)
  return {
    week,
    rows,
    ...(ranked.length === 0
      ? {}
      : { avg_rank: round(ranked.reduce((a, b) => a + b, 0) / ranked.length, 1) }),
    in_top20: ranked.length,
    out_of_20: rows.length - ranked.length,
    entered_top10: entered,
    left_top10: left,
  }
}

/** 品牌词 Search Console 周数据 → 每周一行（曝光 / 点击合计、平均排名按曝光加权）。 */
export function brandGscWeeks(
  rows: readonly SeoBrandGscWeek[],
): { week: string; impressions: number; clicks: number; position?: number }[] {
  const by = new Map<string, SeoBrandGscWeek[]>()
  for (const r of rows) by.set(r.week, [...(by.get(r.week) ?? []), r])
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, rs]) => {
      const impressions = rs.reduce((a, r) => a + r.impressions, 0)
      const clicks = rs.reduce((a, r) => a + r.clicks, 0)
      const weighted = rs.reduce((a, r) => a + r.position * r.impressions, 0)
      return {
        week,
        impressions,
        clicks,
        ...(impressions === 0 ? {} : { position: round(weighted / impressions, 1) }),
      }
    })
}

/* ── 变化大才出卡（docs/99 §5.4） ─────────────────────────────────────── */

/** 「变化大」的几道线（只加不改口径；改了写进报告）。 */
export const GEO_ALERT_RULES = {
  /** 某个 AI 上提及率周跌这么多个百分点。 */
  platform_drop_pp: 15,
  /** 同一 Prompt 连续这么多周、在这么多个 AI 上缺位。 */
  missing_weeks: 2,
  missing_platforms: 2,
  /** 关注词上周在前几、这周掉出前 10。 */
  rank_was_top: 5,
  rank_fell_below: 10,
  /** 新竞品在这么多条回答里出现。 */
  new_competitor_answers: 3,
} as const

export type GeoAlert =
  | {
      kind: 'platform_drop'
      platform: AiPlatform
      change_pp: number
      /** 从「提到」变成「没提到」的那几格。 */
      lost: { prompt_id: string; prompt_text: string; market: string }[]
    }
  | {
      kind: 'prompt_missing'
      prompt_id: string
      prompt_text: string
      market: string
      platforms: AiPlatform[]
      /** 这周缺位的回答里被引用的站外 / 竞品站（交公关的线索）。 */
      cited_domains: string[]
      competitors: string[]
    }
  | {
      kind: 'rank_drop'
      keyword: string
      market: string
      device: string
      was: number
      now?: number
      url?: string
    }
  | { kind: 'new_competitor'; name: string; answers: number }

/**
 * 这周哪些变化大到要人定（其余只是数字波动，不出卡）：某 AI 提及率周跌 ≥ 15 个百分点；同一 Prompt
 * 连续 2 周在 ≥ 2 个 AI 上缺位；关注词掉出前 10 且上周在前 5；新竞品在 ≥ 3 条回答里出现。
 */
export function geoAlerts(input: {
  rows: readonly MetricAnswer[]
  week: string
  ranks?: RankMetricsView | undefined
  /** 模型从这周回答里认出的、不在名单里的品牌 → 出现在几条回答里。 */
  others?: ReadonlyMap<string, number> | undefined
  /** 竞品 id → 名字（缺位时列出这条回答里出现了哪些竞品）。 */
  names?: ReadonlyMap<string, string> | undefined
}): GeoAlert[] {
  const out: GeoAlert[] = []
  const latest = latestPerCell(input.rows).filter((r) => r.answer.status === 'ok')
  const prevWeek = shiftDay(input.week, -7)
  // ① 某个 AI 的提及率周跌
  for (const line of geoTrends(input.rows).filter((l) => l.kind === 'platform')) {
    const p = line.points.find((x) => x.week === input.week)
    if (p?.change_pp === undefined || p.change_pp > -GEO_ALERT_RULES.platform_drop_pp) continue
    const before = new Map(
      latest
        .filter((r) => r.week === prevWeek && r.answer.platform === line.key)
        .map((r) => [cellKey(r.answer), r]),
    )
    const lost = latest
      .filter((r) => r.week === input.week && r.answer.platform === line.key)
      .filter(
        (r) =>
          ours(r)?.mentioned !== true &&
          ours(before.get(cellKey(r.answer)) ?? r)?.mentioned === true,
      )
      .map((r) => ({
        prompt_id: r.answer.prompt_id,
        prompt_text: r.answer.prompt_text,
        market: r.answer.market,
      }))
    out.push({
      kind: 'platform_drop',
      platform: line.key as AiPlatform,
      change_pp: p.change_pp,
      lost,
    })
  }
  // ② 同一 Prompt 连续 2 周在 ≥ 2 个 AI 上缺位（同一个市场）
  const missingIn = (week: string) => {
    const m = new Map<string, MetricAnswer[]>()
    for (const r of latest) {
      if (r.week !== week) continue
      const o = ours(r)
      if (o?.mentioned === true || o?.cited === true) continue
      const k = `${r.answer.prompt_id}|${r.answer.market}`
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return m
  }
  const nowMissing = missingIn(input.week)
  const weeksBack = Array.from({ length: GEO_ALERT_RULES.missing_weeks - 1 }, (_, i) =>
    missingIn(shiftDay(input.week, -7 * (i + 1))),
  )
  for (const [k, rs] of nowMissing) {
    if (rs.length < GEO_ALERT_RULES.missing_platforms) continue
    if (weeksBack.some((m) => (m.get(k)?.length ?? 0) < GEO_ALERT_RULES.missing_platforms)) continue
    const first = rs[0] as MetricAnswer
    const cited = new Set<string>()
    const rivals = new Set<string>()
    for (const r of rs) {
      for (const c of r.citations)
        if (c.where !== 'searched' && c.site_kind !== 'ours') cited.add(c.domain)
      for (const m of r.mentions)
        if (m.entity !== 'ours' && m.mentioned)
          rivals.add(input.names?.get(m.entity) ?? m.name_snapshot)
    }
    out.push({
      kind: 'prompt_missing',
      prompt_id: first.answer.prompt_id,
      prompt_text: first.answer.prompt_text,
      market: first.answer.market,
      platforms: rs.map((r) => r.answer.platform),
      cited_domains: [...cited].sort(),
      competitors: [...rivals].sort(),
    })
  }
  // ③ 关注词掉出前 10、上周在前 5
  for (const r of input.ranks?.rows ?? []) {
    if (r.previous === undefined || r.previous > GEO_ALERT_RULES.rank_was_top) continue
    if (r.rank !== undefined && r.rank <= GEO_ALERT_RULES.rank_fell_below) continue
    out.push({
      kind: 'rank_drop',
      keyword: r.keyword,
      market: r.market,
      device: r.device,
      was: r.previous,
      ...(r.rank === undefined ? {} : { now: r.rank }),
      ...(r.url === undefined ? {} : { url: r.url }),
    })
  }
  // ④ 新竞品
  for (const [name, answers] of input.others ?? new Map<string, number>())
    if (answers >= GEO_ALERT_RULES.new_competitor_answers)
      out.push({ kind: 'new_competitor', name, answers })
  return out
}
