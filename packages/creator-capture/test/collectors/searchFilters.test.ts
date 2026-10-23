/** 移植自 agentsws-extension `test/contents/searchFilters.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * The thresholds, and the one decision that makes them safe.
 *
 * Two things are being pinned here.
 *
 * The PARSER, because a filter is only as honest as its reading of the page:
 * "1.2万次观看" and "1.2M views" are the same channel in two locales, and a
 * parser that gets one of them wrong by a factor of ten thousand hides
 * creators the user asked to see. It exists only to decide what to show and
 * what to send — the payload still carries the text as rendered — which is why
 * it is allowed to exist at all.
 *
 * And UNKNOWN IS NOT ZERO, which is the actual product decision. A video
 * byline carries no subscriber line, so a min-subscribers threshold that
 * treated absence as zero would silently delete exactly the creators list
 * capture is best at finding: the ones who ranked without a channel card.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  applyCaptureFilters,
  availableFilters,
  candidatePassesFilters,
  parseCompactCount,
  parseFilterPrefs,
  summarizeVideoEvidence
} from "../../src/collectors/searchFilters.js"
import type { SearchCreatorCandidate } from "../../src/kol/utils/youtubeSearch.js"

function candidate(
  overrides: Partial<SearchCreatorCandidate> = {}
): SearchCreatorCandidate {
  return {
    key: "@someone",
    externalId: "@someone",
    handle: "@someone",
    source: "video_attribution",
    ...overrides
  }
}

/* ------------------------------------------------------------------ parsing */

test("the latin compact forms", () => {
  assert.equal(parseCompactCount("3.5M subscribers"), 3_500_000)
  assert.equal(parseCompactCount("12.3K subscribers"), 12_300)
  assert.equal(parseCompactCount("1.2M views"), 1_200_000)
  assert.equal(parseCompactCount("1,234 views"), 1_234)
  assert.equal(parseCompactCount("890K views"), 890_000)
  assert.equal(parseCompactCount("2.1B views"), 2_100_000_000)
  assert.equal(parseCompactCount("742 views"), 742)
})

test("the CJK compact forms, which are a different multiplier entirely", () => {
  assert.equal(parseCompactCount("1.2万位订阅者"), 12_000)
  assert.equal(parseCompactCount("1.2万次观看"), 12_000)
  assert.equal(parseCompactCount("10万"), 100_000)
  assert.equal(parseCompactCount("3.4萬次觀看"), 34_000)
  assert.equal(parseCompactCount("1.5亿次观看"), 150_000_000)
  assert.equal(parseCompactCount("2億"), 200_000_000)
})

test("a latin unit counts only as a whole word", () => {
  // The one failure mode that produces a plausible wrong number instead of an
  // obviously wrong one: the `m` of "members" read as a million.
  assert.equal(parseCompactCount("1234 members"), 1_234)
  assert.equal(parseCompactCount("15 min"), 15)
})

test("thousands separators, in the three shapes the world writes them", () => {
  assert.equal(parseCompactCount("1,234,567 views"), 1_234_567)
  assert.equal(parseCompactCount("1.234.567 Aufrufe"), 1_234_567)
  assert.equal(parseCompactCount("1 234 567 просмотров"), 1_234_567)
  // A dot before a magnitude is a DECIMAL, not a group separator — reading it
  // the other way reports a thousandfold.
  assert.equal(parseCompactCount("1.234M views"), 1_234_000)
  assert.equal(parseCompactCount("1,2 Mio. Aufrufe"), 1_200_000)
})

test("nothing readable yields nothing, never zero", () => {
  assert.equal(parseCompactCount("No views"), undefined)
  assert.equal(parseCompactCount(""), undefined)
  assert.equal(parseCompactCount(undefined), undefined)
  assert.equal(parseCompactCount(null), undefined)
  assert.equal(parseCompactCount("订阅数未显示"), undefined)
})

test("the threshold box reads the same forms the page prints", () => {
  // Someone filtering a page of 「1.2万次观看」 types 「10万」, and someone
  // reading "1.2M views" types "500k". Both are the number they mean.
  assert.deepEqual(parseFilterPrefs({ minViewsText: "10万" }), {
    minViews: 100_000
  })
  assert.deepEqual(parseFilterPrefs({ minSubscribersText: "500k" }), {
    minSubscribers: 500_000
  })
  assert.deepEqual(parseFilterPrefs({ minViewsText: "100000" }), {
    minViews: 100_000
  })
  // An empty or zero box is not a filter — it is an unset filter.
  assert.deepEqual(parseFilterPrefs({}), {})
  assert.deepEqual(parseFilterPrefs({ minViewsText: "  " }), {})
  assert.deepEqual(parseFilterPrefs({ minViewsText: "0" }), {})
  assert.deepEqual(parseFilterPrefs({ minSubscribersText: "abc" }), {})
})

/* ---------------------------------------------------------------- filtering */

const BIG = candidate({
  key: "@big",
  externalId: "@big",
  subscriberCountText: "3.5M subscribers",
  videos: [
    { contentId: "a", viewsText: "1.2M views" },
    { contentId: "b", viewsText: "40K views" }
  ]
})

const SMALL = candidate({
  key: "@small",
  externalId: "@small",
  subscriberCountText: "8.2K subscribers",
  videos: [{ contentId: "c", viewsText: "3.1K views" }]
})

const UNKNOWN = candidate({ key: "@unknown", externalId: "@unknown" })

test("a threshold reads the BEST video, not the worst or the mean", () => {
  // The question is whether this creator can reach that many people. One video
  // that did is proof; an average dragged down by four Shorts is not.
  assert.equal(candidatePassesFilters(BIG, { minViews: 1_000_000 }), true)
  assert.equal(candidatePassesFilters(BIG, { minViews: 2_000_000 }), false)
})

test("the bar is inclusive — a creator exactly on it is above it", () => {
  assert.equal(candidatePassesFilters(BIG, { minViews: 1_200_000 }), true)
  assert.equal(candidatePassesFilters(BIG, { minSubscribers: 3_500_000 }), true)
})

test("a row the page printed no figure for is KEPT", () => {
  /*
    The decision this whole file exists to protect. A video byline genuinely
    carries no subscriber line, and treating absence as zero would delete the
    creators who ranked without a channel card — the ones list capture finds
    that nothing else does.
  */
  assert.equal(candidatePassesFilters(UNKNOWN, { minSubscribers: 1e6 }), true)
  assert.equal(candidatePassesFilters(UNKNOWN, { minViews: 1e6 }), true)
  // And a row with subscribers but no videos is not judged on views it never
  // claimed to have.
  const noVideos = candidate({ subscriberCountText: "3.5M subscribers" })
  assert.equal(candidatePassesFilters(noVideos, { minViews: 1e6 }), true)
})

test("both thresholds apply, and either one is enough to drop a row", () => {
  assert.equal(
    candidatePassesFilters(BIG, { minViews: 100, minSubscribers: 10_000_000 }),
    false
  )
})

test("the filtered set reports what it dropped and what it could not judge", () => {
  const result = applyCaptureFilters([BIG, SMALL, UNKNOWN], {
    minViews: 100_000
  })
  assert.deepEqual(
    result.visible.map((item) => item.key),
    ["@big", "@unknown"]
  )
  assert.equal(result.hidden, 1)
  // Said out loud in the panel, so "已过滤 1 个" is not read as "the other two
  // both clear 100K".
  assert.equal(result.unknown, 1)
})

test("no threshold means no filtering, and no copies of the list", () => {
  const result = applyCaptureFilters([BIG, SMALL, UNKNOWN], {})
  assert.equal(result.visible.length, 3)
  assert.equal(result.hidden, 0)
  assert.equal(result.unknown, 0)
})

test("a box is only offered when the page can answer it", () => {
  assert.deepEqual(availableFilters([BIG]), { views: true, subscribers: true })
  assert.deepEqual(availableFilters([UNKNOWN]), {
    views: false,
    subscribers: false
  })
  assert.deepEqual(
    availableFilters([candidate({ videos: [{ contentId: "x" }] })]),
    { views: false, subscribers: false }
  )
})

/* ------------------------------------------------------------------- chips */

test("the chips count what was seen, split by what it was", () => {
  const summary = summarizeVideoEvidence(
    candidate({
      videos: [
        { contentId: "a", viewsText: "1.2M views" },
        { contentId: "b", viewsText: "40K views", isShort: true },
        { contentId: "c", isShort: true }
      ]
    })
  )
  assert.deepEqual(summary, {
    total: 3,
    shorts: 2,
    longform: 1,
    topViewsText: "1.2M views"
  })
})

test("no videos means no chips at all, rather than three zeroes", () => {
  assert.equal(summarizeVideoEvidence(UNKNOWN), undefined)
})
