/** 移植自 agentsws-extension `src/lib/kol/authenticity.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/authenticity.ts` @ d25b877（原移植基准 627bd0f；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * 受众真实性 — the report-v2 authenticity block, both tiers.
 *
 * Login tier: the server's `authenticity` block (GET .../report, version 2)
 * carries a 0-100 score, a confidence, a per-signal list and a teaser for the
 * paid deep report. It is rendered as sent — this module only mirrors the
 * types and maps a score to a colour band.
 *
 * No-login tier: two simple signals computed from the page, in the same shape,
 * so the row layout is identical on both tiers and a user who signs in sees
 * the block get RICHER rather than change shape. The local signals deliberately
 * carry no blended score: two page-derived numbers do not earn a headline.
 */
import type { CreatorSnapshot } from "./utils/creatorSnapshot.js"
import { pick } from "./language.js"
import { computeLocalHealth } from "./localHealth.js"

// ---------------------------------------------------------------------------
// Server contract — mirrored, not computed
// ---------------------------------------------------------------------------

export type AuthenticityLevel = "good" | "normal" | "warning" | "unknown"
export type AuthenticityConfidence = "high" | "medium" | "low"

export type AuthenticitySignal = {
  /** Stable machine key (English) — the panel re-labels the ones it knows. */
  key: string
  /** Server-side label; Chinese by contract. Used when the key is unknown. */
  label: string
  /** Pre-formatted value, or an em dash. */
  value: string
  level: AuthenticityLevel
}

export type AuthenticityTeaser = {
  fullReport: "available" | "purchasable"
  headlineScore: number | null
  confidence: AuthenticityConfidence | null
  generatedAt: string | null
  reportType: string | null
}

export type ServerAuthenticity = {
  /** Always true — public signals only, never platform-official data. */
  estimated: true
  /** 0-100, higher = more authentic. Null when the data is too thin. */
  score: number | null
  confidence: AuthenticityConfidence
  likelyFaked: boolean
  signals: AuthenticitySignal[]
  notes: string[]
  teaser: AuthenticityTeaser
}

/**
 * Score → colour band. ≥70 green, 40-69 amber, <40 red, null → 数据不足.
 *
 * The 40 boundary is not cosmetic: it is `LIKELY_FAKED_SCORE` on the server,
 * the point at which the valuation block refuses to quote a price at all. Red
 * here and "no price" there are the same judgement.
 */
export function authenticityBand(
  score: number | null
): "good" | "warning" | "bad" | "unknown" {
  if (score === null || !Number.isFinite(score)) return "unknown"
  if (score >= 70) return "good"
  if (score >= 40) return "warning"
  return "bad"
}

// ---------------------------------------------------------------------------
// Local (no-login) signals
// ---------------------------------------------------------------------------

const EMPTY_VALUE = "—"

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

/** Median of a numeric list, or null. */
function median(values: number[]): number | null {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Items carrying both a view count and a like count. */
function likeRates(snapshot: CreatorSnapshot): number[] {
  return snapshot.recentItems
    .filter(
      (item) =>
        Number.isFinite(item.views) &&
        (item.views as number) > 0 &&
        Number.isFinite(item.likes)
    )
    .map((item) => (item.likes as number) / (item.views as number))
}

/** Enough items before a like-rate median means anything. */
export const MIN_LOCAL_LIKE_RATE_ITEMS = 3

/**
 * The two signals a page alone can support.
 *
 * Growth smoothness — the server's second signal — needs history the page
 * does not have, so it is reported as `unknown` rather than faked from one
 * observation. That absence IS the upsell: it is the row that fills in once
 * the cloud has been watching.
 */
export function localAuthenticitySignals(
  snapshot: CreatorSnapshot
): AuthenticitySignal[] {
  const health = computeLocalHealth(snapshot)
  const signals: AuthenticitySignal[] = []

  const ratio = health.viewsToSubsRatio
  signals.push({
    key: "viewsToFollowers",
    label: pick("播放/粉丝比", "Views per follower"),
    value: ratio === undefined ? EMPTY_VALUE : percent(ratio),
    level:
      ratio === undefined
        ? "unknown"
        : health.boughtAudienceSuspected
          ? "warning"
          : ratio >= 0.1
            ? "good"
            : ratio >= 0.03
              ? "normal"
              : "warning"
  })

  const rates = likeRates(snapshot)
  const medianLikeRate = rates.length >= MIN_LOCAL_LIKE_RATE_ITEMS ? median(rates) : null
  signals.push({
    key: "likeRate",
    label: pick("点赞率中位数", "Median like rate"),
    value:
      medianLikeRate === null
        ? pick(
            `近期作品点赞数据不足（<${MIN_LOCAL_LIKE_RATE_ITEMS} 条）`,
            `Too few recent items with likes (<${MIN_LOCAL_LIKE_RATE_ITEMS})`
          )
        : pick(
            `${percent(medianLikeRate)}（${rates.length} 条）`,
            `${percent(medianLikeRate)} (${rates.length} items)`
          ),
    level:
      medianLikeRate === null
        ? "unknown"
        : medianLikeRate >= 0.03
          ? "good"
          : medianLikeRate >= 0.01
            ? "normal"
            : "warning"
  })

  signals.push({
    key: "growthSmoothness",
    label: pick("增长平滑度", "Growth smoothness"),
    value: pick("需要历史快照，登录后由云端积累", "Needs history — signed-in only"),
    level: "unknown"
  })

  return signals
}
