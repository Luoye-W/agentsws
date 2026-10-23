/** 移植自 agentsws-extension `src/contents/utils/relevance.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/relevance.ts` @ d25b877。 */
/**
 * Pre-screening a rail before anything is captured (0.9.18, WP-D6).
 *
 * The problem this solves is measured, not theoretical: about four entries in
 * ten of a YouTube watch page's similar column are personalised to the VIEWER
 * — last night's football, the air fryer they shopped for — rather than similar
 * to the video (owner, 2026-08-12). Capturing the column wholesale would fill a
 * discovery queue with strangers, and the queue is where a human's attention is
 * spent, so the cost lands on the one resource the product is trying to save.
 *
 * THE SCORE RANKS, IT NEVER GATES. Nothing is dropped for a low score: low
 * scorers arrive unticked and coloured, the human can tick any of them back,
 * and what goes up is what is ticked. That is deliberate — the person at the
 * keyboard can see in one glance which rail entries are theirs and which are
 * the platform's guesses about them, and no local word-overlap sum can.
 *
 * The algorithm is a simplified port of the SaaS `scoreAgainstTopics`
 * (`src/influencer/services/lookalike.ts`), kept deliberately in step so a row
 * the panel calls a 64 is a row the server would also call a 64. Two ratios,
 * averaged: how many of the seed's topics the text covers, and how much of the
 * seed's whole vocabulary it shares. Either alone misleads — topic coverage is
 * all-or-nothing on a multi-word topic, raw token overlap rewards a candidate
 * that shares one common word with every topic.
 *
 * Everything here is pure.
 */
import type { SearchCreatorCandidate } from "../kol/utils/youtubeSearch.js"

/** CJK ideographs, kana and hangul — scripts without word separators. */
const CJK_CHAR = /[㐀-鿿぀-ヿ가-힯]/

/**
 * Words that carry no topic. Same list as the SaaS scorer's, plus nothing:
 * a divergence here is a divergence in every score the two ends compute.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
  "this",
  "that",
  "from",
  "how",
  "best",
  "top",
  "new",
  "video",
  "videos",
  "channel",
  "official",
  "com",
  "www",
  "https",
  "http"
])

/** Weights, mirroring LOOKALIKE_TOPIC/TOKEN_COVERAGE_WEIGHT. Must sum to 1. */
export const TOPIC_COVERAGE_WEIGHT = 0.5
export const TOKEN_COVERAGE_WEIGHT = 0.5

/**
 * The two band edges, and the only two numbers in this file worth arguing
 * about.
 *
 * ≥ 40 arrives ticked; 20–40 is amber ("疑似无关") and unticked; under 20 is
 * red ("无关") and unticked. They sit above the SaaS `LOOKALIKE_MIN_SCORE` of
 * 25 on purpose: that constant decides whether a stranger is worth SHOWING in a
 * recommendation list, while this one decides whether a row is ticked by
 * default in front of somebody who is about to spend their own attention on it.
 * Named constants rather than inline numbers because they are a first guess and
 * will be re-tuned once anyone has watched a user un-tick a row.
 */
export const RELEVANCE_RELEVANT_MIN = 40
export const RELEVANCE_SUSPECT_MIN = 20

export type RelevanceBand = "relevant" | "suspect" | "irrelevant"

export function relevanceBand(score: number): RelevanceBand {
  if (score >= RELEVANCE_RELEVANT_MIN) return "relevant"
  if (score >= RELEVANCE_SUSPECT_MIN) return "suspect"
  return "irrelevant"
}

/**
 * Free text → a comparable token bag.
 *
 * Latin runs stay whole words (stopwords and one-character noise dropped); CJK
 * runs become character bigrams, so 「车库地垫」 overlaps 「车库收纳地垫」
 * without anybody shipping a segmenter into a content script.
 */
export function tokenizeRelevanceText(text: string | null | undefined) {
  const cleaned = (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  if (!cleaned) return []

  const tokens: string[] = []
  let cjkRun = ""
  let latinRun = ""

  const flushCjk = () => {
    if (cjkRun.length === 1) tokens.push(cjkRun)
    for (let index = 0; index + 1 < cjkRun.length; index += 1) {
      tokens.push(cjkRun.slice(index, index + 2))
    }
    cjkRun = ""
  }
  const flushLatin = () => {
    if (latinRun.length >= 2 && !STOPWORDS.has(latinRun)) tokens.push(latinRun)
    latinRun = ""
  }

  for (const char of cleaned) {
    if (char === " ") {
      flushCjk()
      flushLatin()
    } else if (CJK_CHAR.test(char)) {
      flushLatin()
      cjkRun += char
    } else {
      flushCjk()
      latinRun += char
    }
  }
  flushCjk()
  flushLatin()
  return tokens
}

export type RelevanceMatch = {
  /** 0–100. */
  score: number
  /** The seed topics this text actually covers, best first. */
  matchedTopics: string[]
}

/**
 * One candidate's text against the seed's topic keywords.
 *
 * A topic counts as matched once at least half of its tokens appear, which is
 * what makes "garage floor coating" match a title about 「garage floor」
 * without matching one that merely says 「floor」.
 */
export function scoreAgainstTopics(
  topics: readonly string[],
  candidateText: string
): RelevanceMatch {
  const candidateTokens = new Set(tokenizeRelevanceText(candidateText))
  if (candidateTokens.size === 0) return { score: 0, matchedTopics: [] }

  const allTopicTokens = new Set<string>()
  const matchedTopicTokens = new Set<string>()
  const ranked: Array<{ topic: string; ratio: number }> = []
  let usableTopics = 0

  for (const topic of topics) {
    const topicTokens = [...new Set(tokenizeRelevanceText(topic))]
    if (topicTokens.length === 0) continue
    usableTopics += 1

    let hits = 0
    for (const token of topicTokens) {
      allTopicTokens.add(token)
      if (candidateTokens.has(token)) {
        hits += 1
        matchedTopicTokens.add(token)
      }
    }
    const ratio = hits / topicTokens.length
    if (ratio >= 0.5) ranked.push({ topic, ratio })
  }

  if (usableTopics === 0 || allTopicTokens.size === 0) {
    return { score: 0, matchedTopics: [] }
  }

  const topicCoverage = ranked.length / usableTopics
  const tokenCoverage = matchedTopicTokens.size / allTopicTokens.size
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (topicCoverage * TOPIC_COVERAGE_WEIGHT +
          tokenCoverage * TOKEN_COVERAGE_WEIGHT) *
          100
      )
    )
  )

  ranked.sort((left, right) => right.ratio - left.ratio)
  return { score, matchedTopics: ranked.map((entry) => entry.topic) }
}

/**
 * What gets scored: the videos we saw this creator with, plus their name.
 *
 * The TITLES carry the topic — a channel called "BuildBay North" says nothing
 * about garages while "Modern garage overhaul ep.2" says everything — and the
 * name is included because a channel that names its niche is the easiest
 * possible match and excluding it would throw that away.
 */
export function candidateRelevanceText(
  candidate: SearchCreatorCandidate
): string {
  const parts = [candidate.displayName, candidate.handle]
  for (const video of candidate.videos ?? []) parts.push(video.title)
  return parts.filter(Boolean).join(" ")
}

/**
 * Score a whole page of candidates.
 *
 * With no topic keywords — which is what a 204 from the signature endpoint
 * means — the candidates come back UNTOUCHED, without a score. That is not the
 * same as scoring them zero: a zero would paint every row red and untick it,
 * turning "we have nothing to compare against" into "we judged these and found
 * them irrelevant", and the human would be looking at a wall of warnings about
 * a judgement nobody made.
 */
export function scoreCandidates(
  candidates: readonly SearchCreatorCandidate[],
  topicKeywords: readonly string[] | null | undefined
): SearchCreatorCandidate[] {
  if (!topicKeywords || topicKeywords.length === 0) {
    return candidates.map((candidate) => ({
      ...candidate,
      relevanceScore: undefined
    }))
  }
  return candidates.map((candidate) => ({
    ...candidate,
    relevanceScore: scoreAgainstTopics(
      topicKeywords,
      candidateRelevanceText(candidate)
    ).score
  }))
}

/**
 * The rows the pre-screen is unhappy about: amber AND red, in one set.
 *
 * ONE function for two jobs on purpose. It decides which rows arrive unticked,
 * and it is exactly what 「一键去除不相关」 removes — if those two answers
 * could ever differ, the button would be un-ticking rows the panel had ticked
 * for a reason it no longer remembers. An unscored row is never in the set.
 */
export function irrelevantKeys(
  candidates: readonly SearchCreatorCandidate[]
): string[] {
  return candidates
    .filter(
      (candidate) =>
        typeof candidate.relevanceScore === "number" &&
        relevanceBand(candidate.relevanceScore) !== "relevant"
    )
    .map((candidate) => candidate.key)
}

export type RelevanceTally = {
  relevant: number
  suspect: number
  irrelevant: number
  /** Rows with no score at all — no signature, or nothing to read. */
  unscored: number
}

export function relevanceTally(
  candidates: readonly SearchCreatorCandidate[]
): RelevanceTally {
  const tally: RelevanceTally = {
    relevant: 0,
    suspect: 0,
    irrelevant: 0,
    unscored: 0
  }
  for (const candidate of candidates) {
    if (typeof candidate.relevanceScore !== "number") {
      tally.unscored += 1
      continue
    }
    tally[relevanceBand(candidate.relevanceScore)] += 1
  }
  return tally
}
