/** 移植自 agentsws-extension `src/contents/utils/searchFilters.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/searchFilters.ts` @ d25b877。 */
/**
 * Client-side filtering for a list capture (0.9.17).
 *
 * A search page is a list somebody else ranked, and the first thing anyone
 * does with it is throw away the small channels. Doing that by unticking rows
 * one at a time is the same tedium bulk capture exists to remove, one level up.
 *
 * TWO RULES, and they are the whole design.
 *
 *   PARSING HAPPENS HERE AND GOES NOWHERE. The wire still carries the count
 *   text exactly as the page rendered it (`subscriberCountText`, `viewsText`)
 *   — see the note on `listCaptureItemSchema` in the SaaS: a client that
 *   parses "1.2万位订阅者" wrong writes a wrong number into a library that
 *   shares it with everyone. Filtering is a decision about what to SEND, made
 *   in the user's own browser, and a mistake in it costs them one row on their
 *   own screen. So the parser below is allowed to exist, and its output is
 *   allowed nowhere near a payload.
 *
 *   ⚠️ WP131（Luoye 09-23 定，推翻上面这一条的后半句）：列表页收进来的人**也要上公共库**，
 *   而公共库的卡要粉丝数——于是插件用**这同一个解析器**把订阅 / 粉丝原文换算成
 *   `followers` 一起送（`followers_text` 原文照带，服务端仍可复核）；**换算不了就不带**，
 *   那一行照旧只进本机。见 `src/lib/follower-count.ts`。
 *
 *   UNKNOWN IS NOT ZERO. A row whose count the page never printed is NOT
 *   hidden by a threshold. A video byline genuinely carries no subscriber
 *   line, and hiding those would quietly delete exactly the creators this
 *   feature is best at finding — the ones who ranked without a channel card.
 *   The panel says so on the same line as the count, because a filter that
 *   silently keeps things is as confusing as one that silently drops them.
 */
import type {
  SearchCreatorCandidate,
  SearchVideoEvidence
} from "../kol/utils/youtubeSearch.js"

/** Multipliers for a latin unit written after a number. */
const UNIT_MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(k|thousand|thousands)$/i, 1e3],
  [/^(m|mn|mio|mil|million|millions)$/i, 1e6],
  [/^(b|bn|billion|billions)$/i, 1e9]
]

/**
 * The multiplier implied by whatever follows the digits.
 *
 * A latin suffix counts only as a whole word: `1.2M` multiplies, `1234
 * members` does not. Reading the `m` of "members" as a million is the one
 * failure mode that produces a plausible wrong answer instead of an obviously
 * wrong one.
 */
function unitMultiplier(rest: string): number {
  if (!rest) return 1

  const cjk = rest[0]
  if (cjk === "万" || cjk === "萬" || cjk === "만") return 1e4
  // WP131：补 '억'（韩语的亿）——旧插件云端 parseVisibleCount 后来补上的那一条，
  // 这里原先漏了：1.2억 会读成 1.2。
  if (cjk === "亿" || cjk === "億" || cjk === "억") return 1e8
  if (cjk === "千") return 1e3

  const word = rest.match(/^[a-zA-Z]+/)?.[0]
  if (!word) return 1
  for (const [pattern, multiplier] of UNIT_MULTIPLIERS) {
    if (pattern.test(word)) return multiplier
  }
  return 1
}

/**
 * A rendered count → a number, or nothing.
 *
 * Mirrors `parseVisibleCount` in the SaaS (`src/influencer/list-capture.ts`)
 * on purpose: when both ends read "1.2万次观看" the same way, a row the panel
 * hides is a row the server would have counted the same, and a threshold means
 * one thing rather than two.
 *
 * `undefined` rather than 0 when nothing can be read — those are different
 * claims, and the difference is exactly what keeps a byline with no subscriber
 * line from being filtered out as a zero-subscriber channel.
 */
export function parseCompactCount(raw?: string | null): number | undefined {
  if (raw == null) return undefined
  const text = String(raw).trim()
  if (!text) return undefined

  // Thousands are grouped with a space in fr/ru — ordinary, non-breaking or
  // narrow — so those belong to the number rather than ending it.
  const match = text.match(/(\d[\d.,\u0020\u00a0\u202f]*\d|\d)/)
  if (!match) return undefined

  const digits = match[1].replace(/[\u0020\u00a0\u202f]/g, "")
  const rest = text.slice((match.index ?? 0) + match[1].length).trimStart()
  const multiplier = unitMultiplier(rest)

  let normalized: string
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(digits)) {
    // 1,234,567.8 — the comma groups thousands.
    normalized = digits.replace(/,/g, "")
  } else if (multiplier === 1 && /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(digits)) {
    // 1.234.567,8 — the de/es inversion of the same thing. Only without a
    // unit: `1.234M` is a decimal followed by a magnitude, and reading its dot
    // as a thousands separator reports a thousandfold.
    normalized = digits.replace(/\./g, "").replace(",", ".")
  } else {
    // A lone comma at this point is a decimal point ("1,2 Mio.").
    normalized = digits.replace(",", ".")
  }

  const value = Number.parseFloat(normalized)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * multiplier)
}

/**
 * What the user typed into a threshold box.
 *
 * Stored as TEXT, not as a number, and parsed by the same function that reads
 * the page. Someone filtering a page that says 「12万次观看」 types 「10万」,
 * and someone reading "1.2M views" types "500k" — a numeric input would make
 * both of them count zeros to say the thing they already know how to say.
 */
export type CaptureFilterPrefs = {
  /** Minimum views on the creator's best video seen on this page. */
  minViewsText?: string
  minSubscribersText?: string
}

export const EMPTY_FILTER_PREFS: CaptureFilterPrefs = {}

export type CaptureFilterThresholds = {
  minViews?: number
  minSubscribers?: number
}

export function parseFilterPrefs(
  prefs: CaptureFilterPrefs
): CaptureFilterThresholds {
  const thresholds: CaptureFilterThresholds = {}
  const views = parseCompactCount(prefs.minViewsText)
  if (views !== undefined && views > 0) thresholds.minViews = views
  const subscribers = parseCompactCount(prefs.minSubscribersText)
  if (subscribers !== undefined && subscribers > 0) {
    thresholds.minSubscribers = subscribers
  }
  return thresholds
}

/**
 * The best view count among the videos seen for this creator.
 *
 * The BEST rather than the average, because the question a threshold answers
 * is "can this creator reach that many people", and one video that did is
 * proof while a mean dragged down by four Shorts is not.
 */
export function candidateBestViews(
  candidate: SearchCreatorCandidate
): { value: number; text: string } | undefined {
  let best: { value: number; text: string } | undefined
  for (const video of candidate.videos ?? []) {
    const value = parseCompactCount(video.viewsText)
    if (value === undefined) continue
    if (!best || value > best.value) {
      best = { value, text: video.viewsText as string }
    }
  }
  return best
}

export function candidateSubscribers(
  candidate: SearchCreatorCandidate
): number | undefined {
  return parseCompactCount(candidate.subscriberCountText)
}

/**
 * Does this row survive the thresholds?
 *
 * A row is dropped only when the page gave a number AND that number is below
 * the bar. Unknown survives — see the header.
 */
export function candidatePassesFilters(
  candidate: SearchCreatorCandidate,
  thresholds: CaptureFilterThresholds
): boolean {
  if (thresholds.minViews !== undefined) {
    const views = candidateBestViews(candidate)
    if (views && views.value < thresholds.minViews) return false
  }
  if (thresholds.minSubscribers !== undefined) {
    const subscribers = candidateSubscribers(candidate)
    if (subscribers !== undefined && subscribers < thresholds.minSubscribers) {
      return false
    }
  }
  return true
}

export type FilteredCandidates = {
  /** The rows that survived, in page order. */
  visible: SearchCreatorCandidate[]
  /** How many were dropped — the number the panel prints. */
  hidden: number
  /**
   * Of the survivors, how many survived because nothing was known about them
   * rather than because they cleared the bar. Printed so "已过滤 3 个" is not
   * read as "the other twelve all have 100K views".
   */
  unknown: number
}

export function applyCaptureFilters(
  candidates: readonly SearchCreatorCandidate[],
  thresholds: CaptureFilterThresholds
): FilteredCandidates {
  const active =
    thresholds.minViews !== undefined || thresholds.minSubscribers !== undefined
  if (!active) return { visible: [...candidates], hidden: 0, unknown: 0 }

  const visible: SearchCreatorCandidate[] = []
  let unknown = 0
  for (const candidate of candidates) {
    if (!candidatePassesFilters(candidate, thresholds)) continue
    visible.push(candidate)
    const measured =
      (thresholds.minViews !== undefined &&
        candidateBestViews(candidate) !== undefined) ||
      (thresholds.minSubscribers !== undefined &&
        candidateSubscribers(candidate) !== undefined)
    if (!measured) unknown += 1
  }
  return { visible, hidden: candidates.length - visible.length, unknown }
}

/**
 * Which threshold boxes are worth rendering.
 *
 * Same rule as everything else on this surface: offer what the page can
 * actually answer. A min-subscribers box above a page of pure video results
 * would filter nothing no matter what was typed into it, and a control that
 * cannot work is worse than an absent one — it gets typed into.
 */
export function availableFilters(
  candidates: readonly SearchCreatorCandidate[]
): { views: boolean; subscribers: boolean } {
  let views = false
  let subscribers = false
  for (const candidate of candidates) {
    if (!views && candidateBestViews(candidate)) views = true
    if (!subscribers && candidateSubscribers(candidate) !== undefined) {
      subscribers = true
    }
    if (views && subscribers) break
  }
  return { views, subscribers }
}

export type VideoEvidenceSummary = {
  /** Videos attached to this creator (never more than five — see the cap). */
  total: number
  shorts: number
  longform: number
  /** The best view count, as rendered. Undefined when none was printed. */
  topViewsText?: string
}

/** What the chips on a candidate row say. */
export function summarizeVideoEvidence(
  candidate: SearchCreatorCandidate
): VideoEvidenceSummary | undefined {
  const videos: SearchVideoEvidence[] = candidate.videos ?? []
  if (videos.length === 0) return undefined
  const shorts = videos.filter((video) => video.isShort === true).length
  return {
    total: videos.length,
    shorts,
    longform: videos.length - shorts,
    topViewsText: candidateBestViews(candidate)?.text
  }
}
