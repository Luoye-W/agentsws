/** 移植自 agentsws-extension `test/contents/relevance.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * The pre-screen: what it scores, where it draws its three lines, and the one
 * case where it must do nothing at all.
 *
 * The last of those is the important one. A 204 from the signature endpoint —
 * "this channel is not a seed" — must leave every row unscored and TICKED. The
 * failure mode it guards against is subtle and would look like a working
 * feature: score everything zero, paint the whole rail red, untick it, and the
 * user is now looking at a wall of verdicts about a judgement nobody made.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  irrelevantKeys,
  RELEVANCE_RELEVANT_MIN,
  RELEVANCE_SUSPECT_MIN,
  relevanceBand,
  relevanceTally,
  scoreAgainstTopics,
  scoreCandidates,
  tokenizeRelevanceText
} from "../../src/collectors/relevance.js"
import type { SearchCreatorCandidate } from "../../src/kol/utils/youtubeSearch.js"

const TOPICS = ["garage floor mat", "epoxy coating", "garage storage"]

function candidate(
  key: string,
  displayName: string,
  titles: string[]
): SearchCreatorCandidate {
  return {
    key,
    externalId: key.toUpperCase(),
    handle: `@${key}`,
    displayName,
    source: "video_attribution",
    videos: titles.map((title, index) => ({
      contentId: `${key}-${index}`,
      title
    }))
  }
}

/* ------------------------------------------------------------ tokenisation */

test("latin runs stay words, CJK runs become bigrams", () => {
  assert.deepEqual(tokenizeRelevanceText("Garage Floor Mat!"), [
    "garage",
    "floor",
    "mat"
  ])
  // No segmenter ships into a content script, so 车库地垫 has to overlap
  // 车库收纳地垫 by construction.
  assert.deepEqual(tokenizeRelevanceText("车库地垫"), ["车库", "库地", "地垫"])
  // Stopwords and one-character noise carry no topic.
  assert.deepEqual(tokenizeRelevanceText("the best video of a"), ["of"])
  assert.deepEqual(tokenizeRelevanceText(""), [])
})

/* ------------------------------------------------------------------ scoring */

test("a candidate on topic outscores one that shares a stray word", () => {
  const onTopic = scoreAgainstTopics(
    TOPICS,
    "Modern garage overhaul: epoxy coating vs garage floor mat"
  )
  const strayWord = scoreAgainstTopics(TOPICS, "Kitchen floor cleaning hacks")
  const unrelated = scoreAgainstTopics(TOPICS, "NBA top plays tonight")

  assert.ok(onTopic.score > strayWord.score)
  assert.ok(strayWord.score > unrelated.score)
  assert.equal(unrelated.score, 0)
  assert.ok(onTopic.matchedTopics.includes("garage floor mat"))
})

test("no topics and no text both score zero without throwing", () => {
  assert.deepEqual(scoreAgainstTopics([], "anything"), {
    score: 0,
    matchedTopics: []
  })
  assert.deepEqual(scoreAgainstTopics(TOPICS, ""), {
    score: 0,
    matchedTopics: []
  })
  // A topic that tokenises to nothing is not a topic anybody can miss.
  assert.equal(scoreAgainstTopics(["!!!", "###"], "garage").score, 0)
})

test("a score is never outside 0–100", () => {
  const perfect = scoreAgainstTopics(["garage"], "garage garage garage")
  assert.ok(perfect.score <= 100)
  assert.ok(perfect.score >= 0)
})

/* -------------------------------------------------------------- the bands */

test("the three bands sit where the mockup says they do", () => {
  assert.equal(relevanceBand(100), "relevant")
  assert.equal(relevanceBand(RELEVANCE_RELEVANT_MIN), "relevant")
  assert.equal(relevanceBand(RELEVANCE_RELEVANT_MIN - 1), "suspect")
  assert.equal(relevanceBand(RELEVANCE_SUSPECT_MIN), "suspect")
  assert.equal(relevanceBand(RELEVANCE_SUSPECT_MIN - 1), "irrelevant")
  assert.equal(relevanceBand(0), "irrelevant")
})

test("the default un-tick and the remove button are the same set", () => {
  /*
    One function, two callers, by design: if these could ever differ, the
    button would be un-ticking rows the panel had ticked for a reason it no
    longer remembers.
  */
  const scored: SearchCreatorCandidate[] = [
    { ...candidate("a", "A", []), relevanceScore: 78 },
    { ...candidate("b", "B", []), relevanceScore: 40 },
    { ...candidate("c", "C", []), relevanceScore: 22 },
    { ...candidate("d", "D", []), relevanceScore: 4 },
    // Unscored: nobody judged this one, so nobody un-ticks it.
    candidate("e", "E", [])
  ]
  assert.deepEqual(irrelevantKeys(scored), ["c", "d"])
  assert.deepEqual(relevanceTally(scored), {
    relevant: 2,
    suspect: 1,
    irrelevant: 1,
    unscored: 1
  })
})

/* ------------------------------------------------------- scoring a page */

test("titles and the channel name are what get scored", () => {
  const [scored] = scoreCandidates(
    [candidate("bay", "BuildBayNorth", ["Modern garage overhaul ep.2"])],
    TOPICS
  )
  assert.ok((scored.relevanceScore ?? 0) > 0)

  // A channel that names its niche is the easiest match there is, and
  // excluding the name would throw that away.
  const [named] = scoreCandidates(
    [candidate("gs", "Garage Storage Pro", ["Ep. 14"])],
    TOPICS
  )
  assert.ok((named.relevanceScore ?? 0) > 0)
})

test("204 — no seed — leaves every row UNSCORED, not scored zero", () => {
  const rows = [
    candidate("a", "BuildBayNorth", ["Modern garage overhaul"]),
    candidate("b", "AirFryerDaily", ["Best air fryer 2026 ranked"])
  ]
  for (const signature of [null, undefined, []]) {
    const scored = scoreCandidates(rows, signature)
    assert.deepEqual(
      scored.map((row) => row.relevanceScore),
      [undefined, undefined]
    )
    // Nothing to un-tick: the whole rail stays ticked and the human decides.
    assert.deepEqual(irrelevantKeys(scored), [])
    assert.equal(relevanceTally(scored).unscored, 2)
  }
})

test("a rail split against a real derived signature", () => {
  /*
    A FREE seed signature is a bag of single words counted off the seed's own
    titles (`deriveTopicKeywords` in the SaaS), so that is what this scores
    against — not the multi-word topics only a paid word pack produces.

    What it pins is the SPLIT and the ORDER, not the numbers. The numbers are a
    first guess and this test is deliberately written so re-tuning the bands
    does not require re-writing it: heavy overlap is ticked, one shared word is
    not (and is one click away from being ticked back), nothing in common is
    red. Worth knowing while reading it: against a six-word signature, a title
    that shares ONE word scores ~17 — the pre-screen is strict, which is the
    right way round for a list that is 40% noise and a button that un-ticks in
    bulk.
  */
  const derived = ["garage", "epoxy", "floor", "coating", "storage", "workshop"]
  const scored = scoreCandidates(
    [
      candidate("pro", "GarageFloorPro", [
        "Epoxy garage floor coating install"
      ]),
      candidate("bay", "BuildBayNorth", ["Modern garage overhaul ep.2"]),
      candidate("fry", "KitchenDaily", ["Best air fryer 2026 ranked"]),
      candidate("nba", "HoopsNightly", ["NBA top plays tonight"])
    ],
    derived
  )
  const score = (index: number) => scored[index].relevanceScore ?? -1

  assert.equal(relevanceBand(score(0)), "relevant")
  assert.ok(score(0) > score(1))
  assert.ok(score(1) > score(2))
  assert.equal(score(2), 0)
  assert.equal(score(3), 0)
  // Everything the human did not have to think about is already ticked; the
  // rest arrives unticked with its number showing.
  assert.deepEqual(irrelevantKeys(scored), ["bay", "fry", "nba"])
})
