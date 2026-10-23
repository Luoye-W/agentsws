/** 移植自 agentsws-extension `src/lib/kol/bulkCapture.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/bulkCapture.ts` @ d25b877。 */
/**
 * Pacing and bookkeeping for a bulk list capture (P4).
 *
 * Pure functions, deliberately: what makes bulk capture safe is the SHAPE of
 * the traffic it produces — how many rows per request, how long between
 * requests, and whether one bad chunk stops the rest — and none of that is
 * testable while it is tangled up with React state and a live endpoint.
 *
 * 移植自 KOLAgents 浏览器插件 `src/lib/bulkCapture.ts` @ f0de89a。
 * 只改了两处 import：`~contents/utils/youtubeSearch` → `./utils/youtubeSearch.js`，
 * `~lib/pluginApi` → `./bulkWire.js`（那四个 type 与 `BULK_OBSERVATION_ITEM_LIMIT`
 * 现在住在 `bulkWire.ts`，因为传输从 旧云端 API 换成了本机服务）。
 * 节奏、分块、计数的算法一个字没动。
 * WP130：补搬旧仓提交 6259a1c 里的一行——`contentType` 随证据带上。
 */
import {
  MAX_VIDEOS_PER_CREATOR,
  type SearchCreatorCandidate,
  type SearchVideoEvidence
} from "./utils/youtubeSearch.js"
import type {
  BulkObservationItem,
  BulkObservationResult,
  BulkObservationStatus,
  BulkVideoEvidence
} from "./bulkWire.js"

/**
 * Rows per request. The server's contract allows 100; we send 20.
 *
 * Twenty is not caution about the server, it is about the user: the progress
 * line moves five times during a hundred-creator capture instead of once, and
 * a chunk that fails costs twenty rows rather than a hundred.
 */
export const BULK_CHUNK_SIZE = 20

/**
 * Gap between chunks, randomised.
 *
 * A fixed interval is a fingerprint, and a burst of back-to-back requests from
 * one API key is the shape of traffic that gets rate-limited. Between 300ms
 * and 800ms is slow enough to look like a person and fast enough that nobody
 * goes to make tea.
 */
export const BULK_MIN_DELAY_MS = 300
export const BULK_MAX_DELAY_MS = 800

/** Credits per AI score, mirroring the SaaS constant (PRICING v3.2 §二). */
export const SCORE_CREDITS_PER_CREATOR = 1

export function chunkItems<T>(
  items: readonly T[],
  size: number = BULK_CHUNK_SIZE
): T[][] {
  if (size < 1) return items.length ? [[...items]] : []
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/** `random` is injectable so the bounds can be pinned without flaking. */
export function randomBatchDelayMs(random: () => number = Math.random): number {
  const span = BULK_MAX_DELAY_MS - BULK_MIN_DELAY_MS
  return Math.round(BULK_MIN_DELAY_MS + random() * span)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A page candidate → the wire item.
 *
 * Undefined fields are LEFT OUT rather than sent as empty strings: absent
 * means "not on the page", and "" would tell the library we looked at the
 * creator's avatar and found there wasn't one.
 */
export function toBulkObservationItem(
  candidate: SearchCreatorCandidate
): BulkObservationItem {
  const item: BulkObservationItem = { externalId: candidate.externalId }
  if (candidate.handle) item.handle = candidate.handle
  if (candidate.displayName) item.displayName = candidate.displayName
  if (candidate.url) item.url = candidate.url
  if (candidate.avatarUrl) item.avatarUrl = candidate.avatarUrl
  if (candidate.subscriberCountText) {
    item.subscriberCountText = candidate.subscriberCountText
  }
  if (candidate.videoCountText) item.videoCountText = candidate.videoCountText

  /*
    The videos this creator was seen with, capped again HERE.

    The collector already caps at five, and this is not distrust of it: the
    cap is a promise about the wire, and the wire is what this function is
    responsible for. A future caller building candidates some other way must
    not be able to widen the payload by accident.
  */
  const videos = (candidate.videos ?? [])
    .slice(0, MAX_VIDEOS_PER_CREATOR)
    .map(toBulkVideoEvidence)
  if (videos.length) item.videos = videos

  /*
    The pre-screen's verdict, when there was one.

    `Number.isFinite` rather than a truthiness check on purpose: a genuine 0 is
    a real judgement ("nothing this creator was seen with matched the seed") and
    must reach the inbox so the row sinks, while `undefined` — no seed, nothing
    to compare against — must not become a 0 on the way out.
  */
  if (Number.isFinite(candidate.relevanceScore)) {
    item.relevanceScore = candidate.relevanceScore
  }

  // Which kind of card this came off: a channel result is the creator's own
  // page, a video byline is an attribution. Provenance the server can weigh.
  item.rawSignals = { listCaptureSource: candidate.source }
  return item
}

/**
 * One video → the wire shape. Absent fields stay absent, for the same reason
 * they do above: "" would claim we looked at the duration badge and found it
 * empty, which is a different fact from the page not having printed one.
 */
function toBulkVideoEvidence(video: SearchVideoEvidence): BulkVideoEvidence {
  const item: BulkVideoEvidence = { contentId: video.contentId }
  if (video.url) item.url = video.url
  if (video.title) item.title = video.title
  if (video.viewsText) item.viewsText = video.viewsText
  if (video.durationText) item.durationText = video.durationText
  if (video.isShort) item.isShort = true
  if (video.contentType) item.contentType = video.contentType
  return item
}

export type BulkTally = {
  ok: number
  deduped: number
  capped: number
  invalid: number
  /** Items in a chunk whose request never returned an answer at all. */
  failed: number
  capturedToday?: number
  dailyLimit?: number
  scoredCount?: number
  scoreCreditsCharged?: number
}

export function emptyTally(): BulkTally {
  return { ok: 0, deduped: 0, capped: 0, invalid: 0, failed: 0 }
}

/**
 * Fold one chunk's answer into the running tally.
 *
 * An unrecognised status counts as `invalid` rather than being dropped: the
 * totals have to add up to the number of creators the user selected, or the
 * summary line is quietly lying about what happened to the rest.
 */
export function applyBulkResult(
  tally: BulkTally,
  result: BulkObservationResult,
  chunkSize: number
): BulkTally {
  const next: BulkTally = { ...tally }
  const answered = result.results ?? []

  for (const row of answered) {
    const status = row?.status as BulkObservationStatus
    if (status === "ok") next.ok += 1
    else if (status === "deduped") next.deduped += 1
    else if (status === "capped") next.capped += 1
    else next.invalid += 1
  }

  // A server that answers fewer rows than we sent has not accounted for the
  // rest; they are unfinished business, not successes.
  const unanswered = chunkSize - answered.length
  if (unanswered > 0) next.failed += unanswered

  if (Number.isFinite(result.capturedToday)) {
    next.capturedToday = result.capturedToday
  }
  if (Number.isFinite(result.dailyLimit)) next.dailyLimit = result.dailyLimit
  if (Number.isFinite(result.scoredCount)) {
    next.scoredCount = (next.scoredCount ?? 0) + (result.scoredCount as number)
  }
  if (Number.isFinite(result.scoreCreditsCharged)) {
    next.scoreCreditsCharged =
      (next.scoreCreditsCharged ?? 0) + (result.scoreCreditsCharged as number)
  }

  return next
}

/** A chunk that threw. Its rows are skipped, and the run carries on. */
export function applyBulkFailure(
  tally: BulkTally,
  chunkSize: number
): BulkTally {
  return { ...tally, failed: tally.failed + chunkSize }
}
