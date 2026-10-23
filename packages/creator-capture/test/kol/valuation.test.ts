/** 移植自 agentsws-extension `test/kol/valuation.test.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：算法对拍用例逐字照搬，只改 import 路径（`src/lib/kol/` → `src/kol/`）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/__tests__/valuation.test.ts` @ ece2a1e。 用例数值与旧仓逐字一致；只把 runner 从 node:test 换成 vitest（assert 仍是 node:assert/strict）。 */
/**
 * 频道价值 math. These assertions are the contract with the SaaS: the no-login
 * tier must produce the same band the server would for the same inputs, so
 * every expected number here was derived from `PLATFORM_BASELINE` /
 * `buildPublicValuation` in the SaaS repo, not from this implementation.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import type { CreatorSnapshot, RecentItem } from "../../src/kol/utils/creatorSnapshot.js"
import {
  estimateLocalValuation,
  formatCentsRange,
  formatEstimateRange,
  marketBounds,
  median,
  usableViewSamples,
  valuationExportText,
  type ServerValuation
} from "../../src/kol/valuation.js"
import {
  followerTierFor,
  MIN_VALUATION_VIEW_SAMPLES,
  PLATFORM_CPM_CENTS,
  PLATFORM_CPM_CENTS_BY_TIER,
  resolvePlatformCpmCents
} from "../../src/kol/valuationConstants.js"

function snapshot(overrides: {
  platform?: CreatorSnapshot["platform"]
  followers?: number
  views?: Array<number | undefined>
  likes?: number[]
}): CreatorSnapshot {
  const views = overrides.views ?? []
  const recentItems: RecentItem[] = views.map((value, index) => ({
    title: `item ${index}`,
    views: value,
    likes: overrides.likes?.[index]
  }))
  return {
    platform: overrides.platform ?? "youtube",
    externalId: "@test",
    name: "Test",
    followers: overrides.followers,
    links: [],
    recentItems,
    regularity: { status: "unknown", note: "" },
    pageUrl: "https://example.com"
  }
}

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 4]), 3) // rounded mean of 2 and 3
  assert.equal(median([]), null)
})

test("usableViewSamples drops missing and zero view counts", () => {
  const s = snapshot({ views: [100, undefined, 0, 300] })
  assert.deepEqual(usableViewSamples(s), [100, 300])
})

test("fewer than the minimum view samples yields insufficient", () => {
  const views = Array(MIN_VALUATION_VIEW_SAMPLES - 1).fill(10_000)
  const result = estimateLocalValuation(snapshot({ views, followers: 100_000 }))
  assert.equal(result.kind, "insufficient")
  assert.equal(
    result.kind === "insufficient" ? result.reason : null,
    "thin_views"
  )
})

test("no view counts at all yields insufficient, never a follower-based number", () => {
  const result = estimateLocalValuation(
    snapshot({ followers: 2_000_000, views: [] })
  )
  assert.equal(result.kind, "insufficient")
})

test("estimate anchors on median views × the tier's CPM band", () => {
  // Median of these five is 10,000. 1,000,000 followers is the macro floor.
  const result = estimateLocalValuation(
    snapshot({
      platform: "youtube",
      followers: 1_000_000,
      views: [8_000, 9_000, 10_000, 11_000, 12_000]
    })
  )
  assert.equal(result.kind, "estimated")
  if (result.kind !== "estimated") return

  const cpm = PLATFORM_CPM_CENTS_BY_TIER.youtube.macro // 3500 cents / 1k views
  assert.equal(result.basis.medianViews, 10_000)
  assert.equal(result.basis.itemsUsed, 5)
  assert.equal(result.basis.cpmCents, cpm)
  assert.equal(result.midCents, Math.round((10_000 / 1000) * cpm)) // $350
  assert.equal(result.lowCents, Math.round((10_000 / 1000) * cpm * 0.6)) // $210
  assert.equal(result.highCents, Math.round((10_000 / 1000) * cpm * 1.4)) // $490
})

test("follower tiers are half-open [min, max) at every boundary", () => {
  // The boundary values themselves, where an off-by-one changes the price.
  assert.equal(followerTierFor(0), "nano")
  assert.equal(followerTierFor(9_999), "nano")
  assert.equal(followerTierFor(10_000), "micro")
  assert.equal(followerTierFor(99_999), "micro")
  assert.equal(followerTierFor(100_000), "mid")
  assert.equal(followerTierFor(999_999), "mid")
  assert.equal(followerTierFor(1_000_000), "macro")
  assert.equal(followerTierFor(50_000_000), "macro")
})

test("an unknown follower count has no tier, and prices at the mid rate", () => {
  // Null rather than a guess — bucketing an unmeasured account as nano would
  // underbid exactly the creators we know least about.
  assert.equal(followerTierFor(null), null)
  assert.equal(followerTierFor(undefined), null)
  assert.equal(followerTierFor(Number.NaN), null)

  for (const platform of ["youtube", "instagram", "tiktok"] as const) {
    assert.equal(
      resolvePlatformCpmCents(platform, undefined),
      PLATFORM_CPM_CENTS_BY_TIER[platform].mid,
      `${platform}: unknown followers must fall back to the mid rate`
    )
    // The flat constant IS the mid row — same rule as the server's
    // `targetCpmCents` being equal to `targetCpmByTier.mid`.
    assert.equal(
      PLATFORM_CPM_CENTS[platform],
      PLATFORM_CPM_CENTS_BY_TIER[platform].mid
    )
  }
})

/**
 * The sync obligation, asserted rather than trusted.
 *
 * Every number below was read off the SaaS `PLATFORM_BASELINE[platform]
 * .targetCpmByTier` (src/influencer/pricing-presets.ts, W33 / 2026-08-05), NOT
 * off this repo's table. If the SaaS moves a rate and this file does not, the
 * same channel is worth two different amounts depending on whether the user is
 * signed in — and this test is what fails first.
 */
test("local CPM table equals the server's at all four sizes", () => {
  assert.deepEqual(PLATFORM_CPM_CENTS_BY_TIER, {
    youtube: { nano: 1_000, micro: 1_400, mid: 2_200, macro: 3_500 },
    instagram: { nano: 550, micro: 775, mid: 1_200, macro: 1_900 },
    tiktok: { nano: 400, micro: 575, mid: 900, macro: 1_425 }
  })
})

test("a captured follower count resolves the CPM the server would use", () => {
  // One representative channel per tier, priced end-to-end through the
  // estimate rather than through the lookup alone.
  const sizes = [
    { followers: 4_600, tier: "nano" },
    { followers: 42_000, tier: "micro" },
    { followers: 380_000, tier: "mid" },
    { followers: 19_000_000, tier: "macro" }
  ] as const

  for (const platform of ["youtube", "instagram", "tiktok"] as const) {
    for (const { followers, tier } of sizes) {
      const expected = PLATFORM_CPM_CENTS_BY_TIER[platform][tier]
      assert.equal(resolvePlatformCpmCents(platform, followers), expected)

      const result = estimateLocalValuation(
        snapshot({
          platform,
          followers,
          // Views well under the follower ceiling so the clamp cannot mask
          // which CPM was applied.
          views: [1_000, 1_000, 1_000, 1_000, 1_000]
        })
      )
      assert.equal(result.kind, "estimated")
      if (result.kind !== "estimated") return
      assert.equal(
        result.basis.cpmCents,
        expected,
        `${platform}/${tier}: estimate used the wrong CPM row`
      )
    }
  }
})

test("the platform premium survives at every tier, not just the mid one", () => {
  // The W32 invariant the SaaS kept when it tiered the table: for any given
  // creator size, youtube >= instagram >= tiktok.
  for (const tier of ["nano", "micro", "mid", "macro"] as const) {
    assert.ok(
      PLATFORM_CPM_CENTS_BY_TIER.youtube[tier] >
        PLATFORM_CPM_CENTS_BY_TIER.instagram[tier],
      `youtube should out-price instagram at ${tier}`
    )
    assert.ok(
      PLATFORM_CPM_CENTS_BY_TIER.instagram[tier] >
        PLATFORM_CPM_CENTS_BY_TIER.tiktok[tier],
      `instagram should out-price tiktok at ${tier}`
    )
  }
})

test("CPM rises with audience size on every platform", () => {
  for (const platform of ["youtube", "instagram", "tiktok"] as const) {
    const t = PLATFORM_CPM_CENTS_BY_TIER[platform]
    assert.ok(
      t.nano < t.micro && t.micro < t.mid && t.mid < t.macro,
      `${platform}: tiers must be strictly increasing`
    )
  }
})

test("platform CPMs stay ordered youtube > instagram > tiktok", () => {
  const views = [10_000, 10_000, 10_000, 10_000, 10_000]
  const value = (platform: CreatorSnapshot["platform"]) => {
    const result = estimateLocalValuation(
      snapshot({ platform, views, followers: 500_000 })
    )
    assert.equal(result.kind, "estimated")
    return result.kind === "estimated" ? result.midCents : 0
  }
  assert.ok(value("youtube") > value("instagram"))
  assert.ok(value("instagram") > value("tiktok"))
})

test("follower count can only pull the number DOWN (upper clamp)", () => {
  // 1,000 followers → $100 ceiling; median 100k views would otherwise be $2,200.
  const result = estimateLocalValuation(
    snapshot({
      platform: "youtube",
      followers: 1_000,
      views: [100_000, 100_000, 100_000, 100_000, 100_000]
    })
  )
  assert.equal(result.kind, "estimated")
  if (result.kind !== "estimated") return
  assert.equal(result.basis.capApplied, true)
  assert.equal(result.highCents, 10_000) // $100
  assert.ok(result.midCents <= result.highCents)
  assert.ok(result.lowCents <= result.highCents)
})

test("a high-followers-low-views channel lands far below the old follower math", () => {
  // 2M subscribers, 20k views: views/followers = 0.01.
  const s = snapshot({
    platform: "youtube",
    followers: 2_000_000,
    views: [20_000, 20_000, 20_000, 20_000, 20_000]
  })
  const result = estimateLocalValuation(s)
  assert.equal(result.kind, "estimated")
  if (result.kind !== "estimated") return

  // OLD formula's follower fallback: followers/1000 × $20-$50 = $40k-$100k.
  const oldLowCents = (2_000_000 / 1000) * 20 * 100
  // The margin was 50x before W33 tiered the CPM. A 2M-subscriber channel is
  // macro, so it now prices off $35 rather than $22 and the same channel comes
  // out ~59% higher — deliberately, because the flat rate had 1M+ channels at
  // ~44% of Modash's published low. Still more than an order of magnitude
  // under the follower math, which is the property this test is for.
  assert.ok(
    result.highCents < oldLowCents / 20,
    `new high ${result.highCents} should be far under old low ${oldLowCents}`
  )
})

test("a suspected bought audience is not priced at all", () => {
  const result = estimateLocalValuation(
    snapshot({ views: [10_000, 10_000, 10_000, 10_000, 10_000] }),
    { likelyFaked: true }
  )
  assert.equal(result.kind, "insufficient")
  assert.equal(
    result.kind === "insufficient" ? result.reason : null,
    "suspected_fake"
  )
})

test("a follower ceiling that flattens the band prints as a ceiling, not a price", () => {
  // 52 subscribers, 6,475 views a video: the $100-per-1k-followers ceiling is
  // $5.20 and beats every CPM bound, so all three collapse onto it.
  const result = estimateLocalValuation(
    snapshot({
      platform: "youtube",
      followers: 52,
      views: [6_000, 6_400, 6_475, 6_500, 7_000]
    })
  )
  assert.equal(result.kind, "estimated")
  if (result.kind !== "estimated") return
  assert.equal(result.lowCents, result.highCents)
  assert.equal(
    formatEstimateRange(result.lowCents, result.highCents),
    "≤$5"
  )
  assert.equal(valuationExportText(result), "≤$5")
})

test("formatEstimateRange keeps a real band as a band", () => {
  assert.equal(formatEstimateRange(13_200, 30_800), "$130-$310")
})

test("formatCentsRange prints a range, rounded to two significant digits", () => {
  assert.equal(formatCentsRange(13_200, 30_800), "$130-$310")
  assert.equal(formatCentsRange(100, 100), "$1")
  assert.equal(formatCentsRange(500_000, 900_000), "$5,000-$9,000")
  assert.equal(formatCentsRange(1_000, 2_000, "EUR"), "€10-€20")
})

test("marketBounds falls back to the median when a percentile is null", () => {
  const base = {
    kind: "market" as const,
    estimated: false as const,
    currency: "USD",
    dealCount: 6,
    lastAggregatedAt: null,
    note: ""
  }
  assert.deepEqual(
    marketBounds({ ...base, p25Cents: 50_000, medianCents: 80_000, p75Cents: 120_000 }),
    { lowCents: 50_000, highCents: 120_000 }
  )
  assert.deepEqual(
    marketBounds({ ...base, p25Cents: null, medianCents: 80_000, p75Cents: null }),
    { lowCents: 80_000, highCents: 80_000 }
  )
  assert.equal(
    marketBounds({ ...base, p25Cents: null, medianCents: null, p75Cents: null }),
    null
  )
})

test("export text: a range for priced states, empty for the rest", () => {
  const market: ServerValuation = {
    kind: "market",
    estimated: false,
    currency: "USD",
    dealCount: 6,
    p25Cents: 12_000,
    medianCents: 20_000,
    p75Cents: 28_000,
    lastAggregatedAt: null,
    note: ""
  }
  assert.equal(valuationExportText(market), "$120-$280")

  assert.equal(
    valuationExportText({
      kind: "insufficient",
      reason: "thin_views",
      note: ""
    }),
    ""
  )
  assert.equal(valuationExportText({ kind: "disabled", note: "" }), "")
  assert.equal(valuationExportText(null), "")
})
