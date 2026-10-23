/** 移植自 agentsws-extension `test/kol/bulkCapture.test.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：算法对拍用例逐字照搬，只改 import 路径（`src/lib/kol/` → `src/kol/`）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/__tests__/bulkCapture.test.ts` @ f0de89a。 用例数值与旧仓逐字一致；只把 runner 从 node:test 换成 vitest，并把 pluginApi 的 import 指向 bulkWire。 */
/**
 * The shape of the traffic a bulk capture produces, and the arithmetic of what
 * it reports afterwards.
 *
 * Both matter for the same reason: a capture of forty creators is forty rows
 * the user cannot individually watch. If the pacing is wrong they get rate
 * limited and blame us; if the tally is wrong they are told thirty-nine landed
 * when thirty-one did, and they find out weeks later from an empty pool.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  MAX_VIDEOS_PER_CREATOR,
  type SearchCreatorCandidate
} from "../../src/kol/utils/youtubeSearch.js"
import {
  applyBulkFailure,
  applyBulkResult,
  BULK_CHUNK_SIZE,
  BULK_MAX_DELAY_MS,
  BULK_MIN_DELAY_MS,
  chunkItems,
  emptyTally,
  randomBatchDelayMs,
  toBulkObservationItem
} from "../../src/kol/bulkCapture.js"
import { BULK_OBSERVATION_ITEM_LIMIT } from "../../src/kol/bulkWire.js"

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

/* ------------------------------------------------------------------ pacing */

test("a batch is cut into chunks that fit the server's contract", () => {
  const items = Array.from({ length: 47 }, (_, index) => index)
  const chunks = chunkItems(items)
  assert.equal(chunks.length, 3)
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [20, 20, 7]
  )
  // Everything, once, in order — a chunker that drops or repeats a row is a
  // capture that silently misses creators.
  assert.deepEqual(chunks.flat(), items)
  assert.ok(BULK_CHUNK_SIZE <= BULK_OBSERVATION_ITEM_LIMIT)
})

test("an empty selection produces no requests at all", () => {
  assert.deepEqual(chunkItems([]), [])
})

test("the gap between chunks stays inside 300–800ms, and varies", () => {
  assert.equal(
    randomBatchDelayMs(() => 0),
    BULK_MIN_DELAY_MS
  )
  assert.equal(
    randomBatchDelayMs(() => 1),
    BULK_MAX_DELAY_MS
  )
  assert.equal(
    randomBatchDelayMs(() => 0.5),
    550
  )
  for (const roll of [0.01, 0.33, 0.72, 0.99]) {
    const delay = randomBatchDelayMs(() => roll)
    assert.ok(delay >= BULK_MIN_DELAY_MS && delay <= BULK_MAX_DELAY_MS)
  }
})

/* ------------------------------------------------------------- the payload */

test("a field the page did not show is absent, not empty", () => {
  const item = toBulkObservationItem(candidate())
  assert.equal(item.externalId, "@someone")
  assert.equal("displayName" in item, false)
  assert.equal("avatarUrl" in item, false)
  assert.equal("subscriberCountText" in item, false)
  // Provenance always rides along: a channel card and a video byline are
  // different amounts of evidence about the same creator.
  assert.deepEqual(item.rawSignals, { listCaptureSource: "video_attribution" })
})

test("the pre-screen's verdict rides along, and only when there was one", () => {
  /*
    Three cases, and the middle one is the whole point.

    A row nobody scored sends NOTHING: `undefined` must not become a 0 on the
    wire, because the inbox sinks rows on a low score and a fabricated zero
    would bury a creator the pre-screen never looked at.

    A row scored zero DOES send it: that is a real judgement — nothing this
    creator was seen with matched the seed's words — and the inbox is entitled
    to it.
  */
  assert.equal("relevanceScore" in toBulkObservationItem(candidate()), false)
  assert.equal(
    toBulkObservationItem(candidate({ relevanceScore: 0 })).relevanceScore,
    0
  )
  assert.equal(
    toBulkObservationItem(candidate({ relevanceScore: 78 })).relevanceScore,
    78
  )
})

test("a rail video's age is panel-only and never reaches the wire", () => {
  // The bulk schema has no field for it, and padding every row of every batch
  // with a string nobody parses is not a reason to invent one.
  const item = toBulkObservationItem(
    candidate({
      videos: [
        {
          contentId: "v1",
          title: "Modern garage overhaul",
          viewsText: "9.4M",
          publishedText: "8y ago"
        }
      ]
    })
  )
  assert.equal(item.videos?.[0].viewsText, "9.4M")
  assert.equal("publishedText" in (item.videos?.[0] ?? {}), false)
})

test("everything the page did show is carried through verbatim", () => {
  const item = toBulkObservationItem(
    candidate({
      displayName: "Someone",
      url: "https://www.youtube.com/@someone",
      avatarUrl: "https://yt3.ggpht.com/a=s88",
      subscriberCountText: "3.5M subscribers",
      videoCountText: "683 videos",
      source: "channel_result"
    })
  )
  // The subscriber line is NOT parsed on the way out — "3.5M" means different
  // things in different locales and the server is the one place that decides.
  assert.equal(item.subscriberCountText, "3.5M subscribers")
  assert.equal(item.videoCountText, "683 videos")
  assert.equal(item.avatarUrl, "https://yt3.ggpht.com/a=s88")
})

test("the videos ride along, as rendered, with absent fields left absent", () => {
  const item = toBulkObservationItem(
    candidate({
      videos: [
        {
          contentId: "abc123",
          url: "https://www.youtube.com/watch?v=abc123",
          title: "Next.js in 100 Seconds",
          viewsText: "1.2M views",
          durationText: "2:34"
        },
        { contentId: "xyz789", isShort: true }
      ]
    })
  )
  assert.equal(item.videos?.length, 2)
  // Same rule as the subscriber line: the view count goes up as the page
  // printed it, and nothing on this side turns it into a number.
  assert.equal(item.videos?.[0].viewsText, "1.2M views")
  assert.equal(item.videos?.[0].durationText, "2:34")
  assert.equal("isShort" in (item.videos?.[0] ?? {}), false)
  assert.deepEqual(item.videos?.[1], { contentId: "xyz789", isShort: true })
})

test("a creator with no videos carries no videos key", () => {
  // Absent means "this result was not about a video", which is a different
  // claim from "this creator has no videos" — an empty array would make it.
  const item = toBulkObservationItem(candidate({ source: "channel_result" }))
  assert.equal("videos" in item, false)
})

test("the five-video cap is enforced on the wire, not only by the collector", () => {
  // The collector caps too. This is the promise about the PAYLOAD, and the
  // payload is what this function is answerable for — a future caller building
  // candidates some other way must not be able to widen it by accident.
  const item = toBulkObservationItem(
    candidate({
      videos: Array.from({ length: 9 }, (_, index) => ({
        contentId: `v${index}`
      }))
    })
  )
  assert.equal(item.videos?.length, MAX_VIDEOS_PER_CREATOR)
  assert.deepEqual(
    item.videos?.map((video) => video.contentId),
    ["v0", "v1", "v2", "v3", "v4"]
  )
})

/* -------------------------------------------------------------- the tally */

test("per-item statuses are counted apart, because they mean different things", () => {
  const tally = applyBulkResult(
    emptyTally(),
    {
      results: [
        { externalId: "a", status: "ok" },
        { externalId: "b", status: "deduped" },
        { externalId: "c", status: "capped" },
        { externalId: "d", status: "invalid" }
      ],
      capturedToday: 50,
      dailyLimit: 50
    },
    4
  )
  assert.deepEqual(
    { ok: tally.ok, deduped: tally.deduped, capped: tally.capped },
    { ok: 1, deduped: 1, capped: 1 }
  )
  assert.equal(tally.invalid, 1)
  assert.equal(tally.failed, 0)
  // The counts the capped banner quotes come from the server, never from a
  // constant we shipped and cannot keep current.
  assert.equal(tally.capturedToday, 50)
  assert.equal(tally.dailyLimit, 50)
})

test("rows the server never answered for are unfinished, not successful", () => {
  const tally = applyBulkResult(
    emptyTally(),
    { results: [{ externalId: "a", status: "ok" }] },
    5
  )
  assert.equal(tally.ok, 1)
  assert.equal(tally.failed, 4)
})

test("a chunk that throws is skipped, and the totals still add up", () => {
  let tally = emptyTally()
  tally = applyBulkResult(
    tally,
    { results: [{ externalId: "a", status: "ok" }] },
    1
  )
  tally = applyBulkFailure(tally, 20)
  tally = applyBulkResult(
    tally,
    { results: [{ externalId: "b", status: "deduped" }] },
    1
  )
  assert.equal(tally.ok, 1)
  assert.equal(tally.deduped, 1)
  assert.equal(tally.failed, 20)
  assert.equal(
    tally.ok + tally.deduped + tally.capped + tally.invalid + tally.failed,
    22
  )
})

test("an unknown status is counted, never dropped", () => {
  // A server that grows a fifth status must not make the summary stop adding
  // up to the number of creators the user ticked.
  const tally = applyBulkResult(
    emptyTally(),
    { results: [{ externalId: "a", status: "quarantined" as never }] },
    1
  )
  assert.equal(tally.invalid, 1)
})

test("scoring totals accumulate across chunks", () => {
  let tally = emptyTally()
  tally = applyBulkResult(
    tally,
    {
      results: [{ externalId: "a", status: "ok" }],
      scoredCount: 1,
      scoreCreditsCharged: 1
    },
    1
  )
  tally = applyBulkResult(
    tally,
    {
      results: [{ externalId: "b", status: "ok" }],
      scoredCount: 1,
      scoreCreditsCharged: 1
    },
    1
  )
  assert.equal(tally.scoredCount, 2)
  assert.equal(tally.scoreCreditsCharged, 2)
})

test("a server that scores nothing leaves the scoring line off entirely", () => {
  const tally = applyBulkResult(
    emptyTally(),
    { results: [{ externalId: "a", status: "ok" }] },
    1
  )
  assert.equal(tally.scoredCount, undefined)
  assert.equal(tally.scoreCreditsCharged, undefined)
})
