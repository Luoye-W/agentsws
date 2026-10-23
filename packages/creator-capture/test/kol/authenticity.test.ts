/** 移植自 agentsws-extension `test/kol/authenticity.test.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：算法对拍用例逐字照搬，只改 import 路径（`src/lib/kol/` → `src/kol/`）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/__tests__/authenticity.test.ts` @ 1a9c84e。 用例数值与旧仓逐字一致；只把 runner 从 node:test 换成 vitest（assert 仍是 node:assert/strict）。 */
/**
 * 受众真实性 bands and the no-login signal rows.
 *
 * The band boundaries are load-bearing across two repos: 40 is the SaaS's
 * `LIKELY_FAKED_SCORE`, the score at which the server stops quoting a price.
 * Red here and "no valuation" there must always be the same judgement.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import type { CreatorSnapshot, RecentItem } from "../../src/kol/utils/creatorSnapshot.js"
import {
  authenticityBand,
  localAuthenticitySignals,
  MIN_LOCAL_LIKE_RATE_ITEMS
} from "../../src/kol/authenticity.js"

function snapshot(overrides: {
  followers?: number
  avgViews?: number
  items?: Array<{ views?: number; likes?: number }>
}): CreatorSnapshot {
  const recentItems: RecentItem[] = (overrides.items ?? []).map(
    (item, index) => ({
      title: `item ${index}`,
      views: item.views,
      likes: item.likes
    })
  )
  return {
    platform: "youtube",
    externalId: "@test",
    name: "Test",
    followers: overrides.followers,
    avgViews: overrides.avgViews,
    links: [],
    recentItems,
    regularity: { status: "unknown", note: "" },
    pageUrl: "https://example.com"
  }
}

test("score bands: >=70 good, 40-69 warning, <40 bad, null unknown", () => {
  assert.equal(authenticityBand(100), "good")
  assert.equal(authenticityBand(70), "good")
  assert.equal(authenticityBand(69), "warning")
  assert.equal(authenticityBand(40), "warning")
  assert.equal(authenticityBand(39), "bad")
  assert.equal(authenticityBand(0), "bad")
  assert.equal(authenticityBand(null), "unknown")
})

test("local signals always render three rows, growth always unknown", () => {
  const signals = localAuthenticitySignals(
    snapshot({ followers: 100_000, avgViews: 20_000 })
  )
  assert.deepEqual(
    signals.map((signal) => signal.key),
    ["viewsToFollowers", "likeRate", "growthSmoothness"]
  )
  // The cloud-only row is visible but empty — that absence is the upsell.
  assert.equal(signals[2].level, "unknown")
})

test("a bought-audience channel warns on views/followers", () => {
  // 100k followers, 1k average views → 1%, under the 2% guard.
  const signals = localAuthenticitySignals(
    snapshot({ followers: 100_000, avgViews: 1_000 })
  )
  assert.equal(signals[0].level, "warning")
  assert.equal(signals[0].value, "1.0%")
})

test("a healthy channel reads good on views/followers", () => {
  const signals = localAuthenticitySignals(
    snapshot({ followers: 100_000, avgViews: 30_000 })
  )
  assert.equal(signals[0].level, "good")
})

test("missing inputs report unknown rather than guessing", () => {
  const signals = localAuthenticitySignals(snapshot({}))
  assert.equal(signals[0].level, "unknown")
  assert.equal(signals[1].level, "unknown")
})

test("like rate needs a minimum sample before it means anything", () => {
  const thin = Array(MIN_LOCAL_LIKE_RATE_ITEMS - 1).fill({
    views: 1_000,
    likes: 50
  })
  assert.equal(
    localAuthenticitySignals(snapshot({ items: thin }))[1].level,
    "unknown"
  )

  const enough = Array(MIN_LOCAL_LIKE_RATE_ITEMS).fill({
    views: 1_000,
    likes: 50 // 5%
  })
  const signal = localAuthenticitySignals(snapshot({ items: enough }))[1]
  assert.equal(signal.level, "good")
  assert.match(signal.value, /5\.0%/)
})

test("a very low like rate warns", () => {
  const items = Array(5).fill({ views: 10_000, likes: 20 }) // 0.2%
  assert.equal(localAuthenticitySignals(snapshot({ items }))[1].level, "warning")
})
