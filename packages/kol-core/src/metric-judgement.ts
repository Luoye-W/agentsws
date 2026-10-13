/*
 * 移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/influencer/metric-judgement.ts` @ 88d74b2c。
 * WP302（决策 406 第一期）整块搬进来，只加了这段头注释；红人卡片网格上「互动率」那一格的判断色块用它。
 * 工坊的红人账号还没有均播（avg views），`judgeReach` 先留着不接，等有均播那一天直接用。
 */
/**
 * Card-level metric judgement (W-UI1 §3).
 *
 * The pool card used to print three bare numbers — 粉丝 / 均播 / 互动率 — and
 * leave the reading to the customer. Every promise the marketing site makes is
 * "we are not a black box, every step comes with a reason", and three bare
 * numbers are precisely a black box: 0.2% means nothing without the median it
 * is 0.2% OF.
 *
 * This module is the whole of that judgement, and it is deliberately a TABLE
 * rather than a set of conditions scattered through JSX: the thresholds are
 * arguable, so they have to be somewhere one person can argue with them.
 *
 * PURE. It returns machine keys plus the numbers a sentence needs; every word
 * the customer reads lives in `messages/*.json`, the same split
 * `services/quality-metrics.ts` uses for the drawer's quality panel.
 *
 * ── PROVENANCE (resolved at merge, 2026-08-11) ─────────────────────────────
 *
 * The engagement median mirrors `INDUSTRY_ENGAGEMENT_BASELINE` from
 * `services/quality-metrics.ts` — the SAME table the drawer's quality score
 * reads, picked for the creator's own follower bucket. The values are COPIED
 * rather than imported: that module reaches the database through its peer-
 * baseline query, and importing it from a `'use client'` card dragged
 * `postgres` into the browser bundle (the build says so out loud). A test
 * asserts the two tables agree, so the copy cannot drift silently. Those constants are
 * self-described as "deliberately rough public rules-of-thumb … a floor for
 * 'we have no data', not a measured benchmark", which is why the copy says
 * 「同量级中位数约 X%」 rather than claiming a measurement.
 *
 * The handoff spec's flat 1.8% was the mid (100k–1M) bucket applied to every
 * creator; it shipped as a per-bucket lookup instead, because a card and a
 * drawer that disagree about the same creator is worse than either number.
 *
 * `REACH_NORMAL_BAND` is 0.1–1.0, matching `scoreViewsFollowerRatio`, whose
 * comment names 0.1–1.0 as the healthy band. The spec's 10–30% had no source
 * in this repo and would have called a perfectly normal 0.5 ratio abnormal.
 *
 * STILL OPEN (owner): `loadPeerBaseline()` computes a REAL same-bucket median
 * from the library whenever ≥5 peers exist. The card cannot call it — it is a
 * DB query and the pool list does not carry the result. Threading it through
 * the list payload would replace a rule of thumb with our own data.
 */

/** Three verdicts, one per colour. Amber stays rare — see §1.2. */
export type JudgementLevel = 'good' | 'warn' | 'bad'

/** Engagement-rate verdicts. */
export type EngagementVerdictKey = 'low' | 'average' | 'healthy'

/** Views-per-follower verdicts. */
export type ReachVerdictKey = 'pushDriven' | 'declining' | 'normal'

/**
 * Engagement-rate cut points, as FRACTIONS (0.007 = 0.7%).
 *
 * Fractions rather than percents because `engagementRateOf()` and
 * `normalizeEngagementRate()` both speak fractions; converting at the boundary
 * once is cheaper than remembering which side of the API is which.
 */
export const ENGAGEMENT_THRESHOLDS = {
  /** Below this: bottom of the distribution, worth saying out loud. */
  low: 0.007,
  /** Below this (and at or above `low`): under the median but unremarkable. */
  average: 0.015,
} as const

/**
 * The median an engagement sentence is measured against, for THIS creator's
 * size bucket (nano 5% → mega 0.8%, from `INDUSTRY_ENGAGEMENT_BASELINE`).
 *
 * Was a flat 1.8% — the mid (100k–1M) bucket applied to everybody. That is the
 * number the drawer would disagree with: a 4k-follower creator at 2.5% read
 * 「healthy」 on the card while the drawer's quality score, which picks the
 * constant for the creator's own bucket, called the same rate below baseline.
 * One creator cannot be told two things by two panels of the same product.
 *
 * Falls back to the mid bucket when follower count is unknown, because an
 * unknown-size creator still has to be told something.
 */
export function engagementMedianFor(followers: number | null | undefined): number {
  const value = finite(followers)
  if (value === null || value <= 0) return 0.018
  if (value < 10_000) return 0.05 // nano
  if (value < 100_000) return 0.03 // micro
  if (value < 1_000_000) return 0.018 // mid
  if (value < 10_000_000) return 0.01 // macro
  return 0.008 // mega
}

/** Views-per-follower cut points, as a ratio (1.2 = views are 1.2× followers). */
export const REACH_THRESHOLDS = {
  /** Above this, reach is coming from the feed rather than the subscriber base. */
  pushDriven: 1.2,
  /** Below this, the followers are not watching. */
  declining: 0.05,
} as const

/** The band the copy calls "normal at this size", as fractions. See PROVENANCE. */
export const REACH_NORMAL_BAND = { min: 0.1, max: 1.0 } as const

export interface EngagementVerdict {
  key: EngagementVerdictKey
  level: JudgementLevel
  /** The creator's rate as a percentage string, e.g. `0.2`. */
  value: string
  /** The bucket median this verdict was judged against, as a percentage
   * string (e.g. `5.0` for a nano creator, `1.8` for a mid one). */
  median: string
}

export interface ReachVerdict {
  key: ReachVerdictKey
  level: JudgementLevel
  /** avgViews / followers, e.g. `1.4` — only meaningful for `pushDriven`. */
  ratio: string
  /** The same ratio as a percentage string, e.g. `12`. */
  percent: string
  /** {@link REACH_NORMAL_BAND} as percentage strings. */
  min: string
  max: string
}

function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return Number.isFinite(value) ? value : null
}

/**
 * One decimal for a percentage that is usually under 5, none for the ratios
 * that are usually over 1. `0.20%` reads as false precision; `0.2%` does not.
 */
function pct(fraction: number, digits = 1): string {
  return (fraction * 100).toFixed(digits)
}

/**
 * Judge an engagement rate against the peer median.
 *
 * Returns null when there is no rate — an absent metric gets no badge at all,
 * because 「unknown」 as a fourth colour would appear on more cards than the
 * three real verdicts combined and turn the whole row into decoration.
 */
export function judgeEngagement(
  rate: number | null | undefined,
  followers?: number | null,
): EngagementVerdict | null {
  const value = finite(rate)
  if (value === null || value <= 0) return null
  const median = pct(engagementMedianFor(followers))
  if (value < ENGAGEMENT_THRESHOLDS.low) {
    return { key: 'low', level: 'bad', value: pct(value), median }
  }
  if (value < ENGAGEMENT_THRESHOLDS.average) {
    return { key: 'average', level: 'warn', value: pct(value), median }
  }
  return { key: 'healthy', level: 'good', value: pct(value), median }
}

/**
 * Judge average views against the follower count.
 *
 * `pushDriven` is amber rather than green on purpose even though it is often
 * flattering: it changes what the deal should be (commission, not a flat per-
 * video rate), and a signal that changes the deal is one the operator has to
 * see before they quote.
 */
export function judgeReach(
  avgViews: number | null | undefined,
  followers: number | null | undefined,
): ReachVerdict | null {
  const views = finite(avgViews)
  const audience = finite(followers)
  if (views === null || views < 0) return null
  if (audience === null || audience <= 0) return null
  const ratio = views / audience
  const shared = {
    ratio: ratio.toFixed(1),
    percent: pct(ratio, 0),
    min: pct(REACH_NORMAL_BAND.min, 0),
    max: pct(REACH_NORMAL_BAND.max, 0),
  }
  if (ratio > REACH_THRESHOLDS.pushDriven) {
    return { key: 'pushDriven', level: 'warn', ...shared }
  }
  if (ratio < REACH_THRESHOLDS.declining) {
    return { key: 'declining', level: 'bad', ...shared }
  }
  return { key: 'normal', level: 'good', ...shared }
}
