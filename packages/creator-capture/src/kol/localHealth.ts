/** 移植自 agentsws-extension `src/lib/kol/localHealth.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/localHealth.ts` @ d25b877（原移植基准 cca4099；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Local, offline creator health check (免登录本地档).
 *
 * Runs entirely on data scraped from the page — NO API calls — so the
 * no-login tier can show the "红人体检" verdict instantly. Thresholds mirror
 * the SaaS scoring heuristics (heuristic_v0.5 bought-audience guard:
 * followers >= 10k with average views/plays under 2% of followers), so the
 * free local verdict and the paid pipeline never contradict each other.
 * Logged-in users additionally get the cloud report (/report) with follower
 * trend history the page alone cannot provide.
 */
import type { ContentSnapshot } from "./utils/contentSnapshot.js"
import type { CreatorSnapshot } from "./utils/creatorSnapshot.js"

export type HealthVerdict = "excellent" | "normal" | "weak" | "suspicious"

export type LocalHealth = {
  /** avgViews / subscribers, in [0, ∞); undefined when inputs are missing. */
  viewsToSubsRatio?: number
  /** Same deterministic guard the paid scoring applies. */
  boughtAudienceSuspected: boolean
  verdict: HealthVerdict | "unknown"
}

const BOUGHT_AUDIENCE_MIN_SUBS = 10_000
const BOUGHT_AUDIENCE_RATIO = 0.02

export function computeLocalHealth(snapshot: CreatorSnapshot): LocalHealth {
  const subs = snapshot.followers
  const avgViews = snapshot.avgViews

  if (!subs || subs <= 0 || !Number.isFinite(avgViews) || !avgViews) {
    return { boughtAudienceSuspected: false, verdict: "unknown" }
  }

  const ratio = avgViews / subs
  const boughtAudienceSuspected =
    subs >= BOUGHT_AUDIENCE_MIN_SUBS && ratio < BOUGHT_AUDIENCE_RATIO

  const verdict: HealthVerdict = boughtAudienceSuspected
    ? "suspicious"
    : ratio >= 0.1
      ? "excellent"
      : ratio >= 0.03
        ? "normal"
        : "weak"

  return { viewsToSubsRatio: ratio, boughtAudienceSuspected, verdict }
}

export function formatRatioPercent(ratio?: number): string {
  if (!Number.isFinite(ratio)) return "-"
  return `${((ratio as number) * 100).toFixed(1)}%`
}

export type ContentVerdict = "viral" | "good" | "normal" | "below" | "unknown"

export type ContentHealth = {
  /** This content's views relative to the author's follower base. */
  viewsToFollowersRatio?: number
  /** likes / views, when both are visible. */
  engagementRate?: number
  verdict: ContentVerdict
}

/**
 * Single-content verdict (§十 内容体检), local tier: how this one piece
 * performs relative to the author's follower base visible on the same page.
 * Thresholds are content-level (one item can far exceed the channel AVERAGE
 * the creator verdict uses): >=100% of followers is a breakout hit.
 */
export function computeContentHealth(snapshot: ContentSnapshot): ContentHealth {
  const views = snapshot.views
  const followers = snapshot.author.followers
  const engagementRate =
    snapshot.likes != null && views ? snapshot.likes / views : undefined

  if (!views || !followers || followers <= 0) {
    return { engagementRate, verdict: "unknown" }
  }

  const ratio = views / followers
  const verdict: ContentVerdict =
    ratio >= 1 ? "viral" : ratio >= 0.1 ? "good" : ratio >= 0.02 ? "normal" : "below"

  return { viewsToFollowersRatio: ratio, engagementRate, verdict }
}
