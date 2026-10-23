/** 移植自 agentsws-extension `src/lib/kol/valuationConstants.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/valuationConstants.ts` @ d25b877（原移植基准 ece2a1e；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Valuation constants for the no-login local tier.
 *
 * SOURCE OF TRUTH: KOLAgents SaaS `src/influencer/pricing-presets.ts`
 * (`PLATFORM_BASELINE`) and the valuation tunables in
 * `src/influencer/services/public-library.ts`. These are COPIES, kept here so
 * the anonymous tier can price a channel with no network call at all.
 *
 * CHANGES MUST BE SYNCED. The login tier renders the server's `valuation`
 * block verbatim; the no-login tier runs this table locally. If the two drift,
 * the same channel is worth two different amounts depending on whether the
 * user happens to be signed in, which is precisely the kind of contradiction
 * that made beta users stop believing the old number.
 *
 * PROVENANCE: Modash 2026 influencer-pricing bands, retrieved 2026-08-05,
 * held at the conservative end (these are DTC brands negotiating directly,
 * not agencies buying at rate card). Values re-synced from the SaaS on
 * 2026-08-05, when `PLATFORM_BASELINE` went from one flat CPM per platform to
 * a per-follower-tier table (W33) — see `PLATFORM_CPM_CENTS_BY_TIER` below.
 */
import type { CapturePlatform } from "./utils/creatorSnapshot.js"

/**
 * Build-time fuse. Flip to false and the local (no-login) valuation
 * disappears from the panel entirely — no section, no teaser, no export
 * column. The login tier is unaffected: the server has its own kill switch
 * (`PLUGIN_VALUATION_ENABLED` → `valuation.kind = 'disabled'`), which this
 * panel already honours by rendering nothing.
 */
export const SHOW_LOCAL_VALUATION = true

/**
 * Follower-size tiers. COPY of the SaaS `src/influencer/follower-tiers.ts`.
 *
 * Bounds are half-open `[min, max)` so adjacent tiers can never both claim the
 * same creator, and `max: null` is unbounded. The boundaries have to match the
 * server's exactly: a channel that the plugin calls micro and the SaaS calls
 * mid is priced off two different CPM rows, which is the drift this whole file
 * exists to prevent.
 */
export const FOLLOWER_TIERS = [
  { id: "nano", min: 0, max: 10_000 },
  { id: "micro", min: 10_000, max: 100_000 },
  { id: "mid", min: 100_000, max: 1_000_000 },
  { id: "macro", min: 1_000_000, max: null }
] as const

export type FollowerTierId = (typeof FOLLOWER_TIERS)[number]["id"]

export type TieredCpmCents = Record<FollowerTierId, number>

/**
 * Conservative per-platform CPM in cents per 1,000 VIEWS, BY FOLLOWER TIER.
 * Mirrors `PLATFORM_BASELINE[platform].targetCpmByTier`.
 *
 * TIERED SINCE W33 (SaaS owner decision, 2026-08-05). One CPM per platform was
 * wrong at both ends at once: a 15-channel calibration against Modash's
 * published bands put nano/micro channels ABOVE the small-channel band while
 * a 1M+ channel came out at ~44% of Modash's low. CPM is not a platform
 * constant — it rises with audience size, because scarcity, production value
 * and brand-safety review all rise with it.
 *
 * The category multiplier (`CATEGORY_PRESETS`) is still deliberately NOT
 * applied: the plugin stands on a creator page and has no idea which brand is
 * looking, so the un-multiplied baseline is the honest floor.
 *
 * The platform premium holds at EVERY tier (youtube >= instagram >= tiktok),
 * because Instagram and TikTok kept their old flat value as the `mid` row and
 * took YouTube's tier shape from there.
 */
export const PLATFORM_CPM_CENTS_BY_TIER: Record<
  CapturePlatform,
  TieredCpmCents
> = {
  // Modash 2026 bands, retrieved 2026-08-05: sub-100K integrations run under a
  // $10-15 CPM; 100K-1M is implied by the $500-5K / $5-20K flat-fee tables;
  // 1M+ is $20-80K at a $30-60+ CPM, held at that band's floor.
  youtube: { nano: 1_000, micro: 1_400, mid: 2_200, macro: 3_500 },
  // Modash 2026 bands, retrieved 2026-08-05: nano Reels clear at gifting or low
  // three figures; mid is the published $8-20 band held at the conservative
  // end; 1M+ commands the top of it and still lands ~half YouTube's macro.
  instagram: { nano: 550, micro: 775, mid: 1_200, macro: 1_900 },
  // Modash 2026 bands, retrieved 2026-08-05: 1-10K TikToks close at $50-200,
  // 10-100K at $200-1,000, 100-500K at $1,000-5,000, >1M at $10,000+. The
  // shortest shelf life on any platform keeps macro the cheapest macro rate.
  tiktok: { nano: 400, micro: 575, mid: 900, macro: 1_425 }
}

/**
 * The rate used when the page did not give us a follower count.
 *
 * The MID row, mirroring the SaaS `PLATFORM_BASELINE[platform].targetCpmCents`
 * and the rule in its `tieredCpmCents`: an account we could not size is not
 * automatically a nano channel, and pricing it as one would systematically
 * underbid exactly the creators we have the least information about.
 */
export const PLATFORM_CPM_CENTS: Record<CapturePlatform, number> = {
  youtube: PLATFORM_CPM_CENTS_BY_TIER.youtube.mid,
  instagram: PLATFORM_CPM_CENTS_BY_TIER.instagram.mid,
  tiktok: PLATFORM_CPM_CENTS_BY_TIER.tiktok.mid
}

/**
 * Which tier a follower count falls in, or null when we do not know.
 *
 * Null rather than a guess: `resolvePlatformCpmCents` turns that into the mid
 * rate, which is the server's rule, and a tier we invented here would silently
 * become a price.
 */
export function followerTierFor(
  followers: number | null | undefined
): FollowerTierId | null {
  if (followers === null || followers === undefined) return null
  const parsed = Number(followers)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  const tier = FOLLOWER_TIERS.find(
    (entry) => parsed >= entry.min && (entry.max === null || parsed < entry.max)
  )
  return tier ? tier.id : null
}

/** The CPM governing one creator on one platform. Mirrors `tieredCpmCents`. */
export function resolvePlatformCpmCents(
  platform: CapturePlatform,
  followers: number | null | undefined
): number | undefined {
  const byTier = PLATFORM_CPM_CENTS_BY_TIER[platform]
  if (!byTier) return undefined
  const tier = followerTierFor(followers)
  if (!tier) return PLATFORM_CPM_CENTS[platform]
  const value = byTier[tier]
  return Number.isFinite(value) ? value : PLATFORM_CPM_CENTS[platform]
}

/** Half-width of the CPM band around the baseline. Mirrors `VALUATION_CPM_BAND`. */
export const VALUATION_CPM_BAND = 0.4

/** Recent items carrying a usable view count before we will estimate at all. */
export const MIN_VALUATION_VIEW_SAMPLES = 5

/**
 * The "~$100 per 1,000 followers" rule of thumb, in cents.
 *
 * UPPER CLAMP ONLY — never a base. Using follower count as the base is exactly
 * what inflated the old estimate; here it can only ever pull a number DOWN.
 */
export const FOLLOWER_RULE_CENTS_PER_1K = 10_000
