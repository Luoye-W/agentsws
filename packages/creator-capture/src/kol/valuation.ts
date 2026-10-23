/** 移植自 agentsws-extension `src/lib/kol/valuation.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/valuation.ts` @ d25b877（原移植基准 ece2a1e；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * 频道价值 — the report-v2 valuation model, both tiers.
 *
 * Replaces `priceEstimate.ts`, whose follower-rate fallback is the reason beta
 * users said the number "reads too high": a channel with 2M subscribers and
 * 20k views per video was quoted off the 2M, i.e. off an audience that stopped
 * watching years ago.
 *
 * The model now has ONE anchor on both tiers — the MEDIAN VIEWS of the recent
 * items actually visible on the page — because views are what a brand buys.
 * Follower count survives only as an upper clamp.
 *
 * Login tier: the server's `valuation` block is rendered verbatim; nothing in
 * this file computes anything for a signed-in user. No-login tier:
 * `estimateLocalValuation` runs the identical formula offline from
 * `valuationConstants` (see that file — the constants are copies and must be
 * kept in sync with the SaaS).
 */
import type { CapturePlatform, CreatorSnapshot } from "./utils/creatorSnapshot.js"
import {
  FOLLOWER_RULE_CENTS_PER_1K,
  MIN_VALUATION_VIEW_SAMPLES,
  resolvePlatformCpmCents,
  VALUATION_CPM_BAND
} from "./valuationConstants.js"

// ---------------------------------------------------------------------------
// Server contract (GET .../report, reportVersion 2) — mirrored, not computed
// ---------------------------------------------------------------------------

export type ValuationBasis = {
  anchor: "median_recent_views"
  medianViews: number
  itemsUsed: number
  cpmCents: number
  cpmLowCents: number
  cpmHighCents: number
  followerCapCents: number | null
  capApplied: boolean
}

export type ServerValuationMarket = {
  kind: "market"
  estimated: false
  currency: string
  dealCount: number
  p25Cents: number | null
  medianCents: number | null
  p75Cents: number | null
  lastAggregatedAt: string | null
  note: string
}

export type ServerValuationEstimated = {
  kind: "estimated"
  estimated: true
  currency: "USD"
  lowCents: number
  midCents: number
  highCents: number
  basis: ValuationBasis
  note: string
}

export type ServerValuationInsufficient = {
  kind: "insufficient"
  reason: "thin_views" | "suspected_fake" | "unsupported_platform"
  note: string
}

export type ServerValuationDisabled = { kind: "disabled"; note: string }

export type ServerValuation =
  | ServerValuationMarket
  | ServerValuationEstimated
  | ServerValuationInsufficient
  | ServerValuationDisabled

// ---------------------------------------------------------------------------
// Local (no-login) valuation — the same formula, offline
// ---------------------------------------------------------------------------

export type LocalValuation =
  | {
      kind: "estimated"
      currency: "USD"
      lowCents: number
      midCents: number
      highCents: number
      basis: ValuationBasis
    }
  | {
      kind: "insufficient"
      reason: "thin_views" | "suspected_fake" | "unsupported_platform"
      /**
       * How many usable view counts the page actually offered. Only the LOCAL
       * tier can know this — the server's insufficient block carries a prose
       * note and no count, and printing "0/5" for it would be inventing a
       * number to fill a template.
       */
      itemsUsed?: number
    }

/** Median of a numeric list (mean of the two middles when even), or null. */
export function median(values: number[]): number | null {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** Usable per-item view counts from the page-visible recent items. */
export function usableViewSamples(snapshot: CreatorSnapshot): number[] {
  return snapshot.recentItems
    .map((item) => item.views)
    .filter((views): views is number => Number.isFinite(views) && (views as number) > 0)
}

/**
 * The no-login estimate. Mirrors the SaaS `buildPublicValuation` 'estimated'
 * branch exactly: median recent views × the conservative platform CPM FOR THIS
 * CREATOR'S SIZE, widened ±40%, then clamped by the follower rule of thumb.
 *
 * `likelyFaked` comes from the local 体检 (`computeLocalHealth`): a channel we
 * suspect of buying its audience is not priced at all. A wrong price is worse
 * than no price.
 */
export function estimateLocalValuation(
  snapshot: CreatorSnapshot,
  options: { likelyFaked?: boolean } = {}
): LocalValuation {
  if (options.likelyFaked) {
    return { kind: "insufficient", reason: "suspected_fake" }
  }

  /**
   * The CPM is chosen by AUDIENCE SIZE, not by platform alone (W33). Follower
   * count still never sets the price — it only picks which published band we
   * price the views against, and then clamps the result from above.
   *
   * An unknown follower count resolves to the mid rate, the same rule the
   * server follows: an account we could not size is not automatically a nano
   * channel, and treating it as one would underbid the creators we know least
   * about.
   */
  const cpmCents = resolvePlatformCpmCents(
    snapshot.platform as CapturePlatform,
    snapshot.followers
  )
  if (!cpmCents) {
    return { kind: "insufficient", reason: "unsupported_platform" }
  }

  const views = usableViewSamples(snapshot)
  const medianViews = median(views)
  if (views.length < MIN_VALUATION_VIEW_SAMPLES || medianViews === null) {
    return {
      kind: "insufficient",
      reason: "thin_views",
      itemsUsed: views.length
    }
  }

  const cpmLowCents = Math.round(cpmCents * (1 - VALUATION_CPM_BAND))
  const cpmHighCents = Math.round(cpmCents * (1 + VALUATION_CPM_BAND))
  const perCpm = (cpm: number) => Math.round((medianViews / 1000) * cpm)

  let lowCents = perCpm(cpmLowCents)
  let midCents = perCpm(cpmCents)
  let highCents = perCpm(cpmHighCents)

  // Follower count enters HERE and only here: as a ceiling.
  const followerCapCents =
    snapshot.followers && snapshot.followers > 0
      ? Math.round((snapshot.followers / 1000) * FOLLOWER_RULE_CENTS_PER_1K)
      : null
  const capApplied = followerCapCents !== null && highCents > followerCapCents
  if (followerCapCents !== null) {
    highCents = Math.min(highCents, followerCapCents)
    midCents = Math.min(midCents, highCents)
    lowCents = Math.min(lowCents, highCents)
  }

  return {
    kind: "estimated",
    currency: "USD",
    lowCents,
    midCents,
    highCents,
    basis: {
      anchor: "median_recent_views",
      medianViews,
      itemsUsed: views.length,
      cpmCents,
      cpmLowCents,
      cpmHighCents,
      followerCapCents,
      capApplied
    }
  }
}

// ---------------------------------------------------------------------------
// Display + export formatting
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CNY: "¥",
  JPY: "¥"
}

/** Round to two significant digits so a range reads as an estimate, not a quote. */
function roundedDollars(cents: number): number {
  const dollars = cents / 100
  if (dollars <= 0) return 0
  if (dollars < 10) return Math.round(dollars)
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(dollars)) - 1)
  return Math.round(dollars / magnitude) * magnitude
}

export function formatMoneyCents(cents: number, currency = "USD"): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
  return `${symbol}${new Intl.NumberFormat("en-US").format(roundedDollars(cents))}`
}

/**
 * "$120-$280" — the one string every surface prints, panel and export alike.
 *
 * A range is not decoration: a single number gets quoted back to the creator
 * as if it were a rate card, which is how an estimate turns into a commitment.
 */
export function formatCentsRange(
  lowCents: number,
  highCents: number,
  currency = "USD"
): string {
  const low = formatMoneyCents(lowCents, currency)
  const high = formatMoneyCents(highCents, currency)
  return low === high ? low : `${low}-${high}`
}

/**
 * An ESTIMATE's range, as text. "$120-$280", or "≤$460" when the follower
 * ceiling bit hard enough to flatten the band.
 *
 * That flattening is not hypothetical: a 4,600-subscriber channel whose videos
 * take 217,000 views has a CPM-derived low of $2,600 and a follower ceiling of
 * $462, and the ceiling wins on all three bounds. Printing "$460" there would
 * be the exact failure this rewrite exists to prevent — a bare number the user
 * quotes back to the creator as if we had priced them. "≤$460" says the one
 * true thing: we know a ceiling, we do not know a price.
 */
export function formatEstimateRange(
  lowCents: number,
  highCents: number,
  currency = "USD"
): string {
  return lowCents >= highCents
    ? `≤${formatMoneyCents(highCents, currency)}`
    : formatCentsRange(lowCents, highCents, currency)
}

/**
 * The market block's range bounds. P25/P75 are non-null in practice (the
 * aggregator computes all three percentiles off the same fee list), but the
 * columns are nullable, so fall back to the median rather than print a blank.
 */
export function marketBounds(
  valuation: ServerValuationMarket
): { lowCents: number; highCents: number } | null {
  const low = valuation.p25Cents ?? valuation.medianCents
  const high = valuation.p75Cents ?? valuation.medianCents
  if (low === null || high === null) return null
  return { lowCents: low, highCents: high }
}

/**
 * Export/clipboard text for whatever valuation the panel is showing — a range
 * as plain text, or "" when there is nothing honest to print. Never a bare
 * number, and never a number without provenance the user can read.
 */
export function valuationExportText(
  valuation: ServerValuation | LocalValuation | null
): string {
  if (!valuation) return ""
  if (valuation.kind === "estimated") {
    return formatEstimateRange(
      valuation.lowCents,
      valuation.highCents,
      "currency" in valuation ? valuation.currency : "USD"
    )
  }
  if (valuation.kind === "market") {
    const bounds = marketBounds(valuation)
    return bounds
      ? formatCentsRange(bounds.lowCents, bounds.highCents, valuation.currency)
      : ""
  }
  return ""
}
