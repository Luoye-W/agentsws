/**
 * 列表页的预筛（WP498，决策 1742 C）：插件列表按钮在「采集」之前给每一行打的相关度分，ego 路用**同一套**算。
 *
 * 新写的接线，算法一个字不动——打分、分档、「哪些行插件会不勾」全调 `collectors/relevance.ts`
 * （私有插件 `src/contents/utils/relevance.ts` @ 57fca9c 的逐字移植）。接法照插件列表按钮：
 *
 * - **只有视频页右栏打分**：插件只在视频页向本机要种子频道的主题词（`/v1/extension/seed-signature`），
 *   搜索 / 话题页不打分（`scoreCandidates(rows, undefined)`，每行「没有分」而不是 0 分）；
 * - 种子不在红人库里（本机回 404）= 没有主题词 = 同样不打分；
 * - 分档 / 不勾哪些行：`relevanceBand` / `irrelevantKeys`（琥珀与红两档都不勾）。
 *
 * 和插件**不一样的只有一处**（1742 C）：插件把不勾的行留在面板上、不送；ego 路**全记**，只是每行带上分、
 * 标出「插件会筛掉」，回给 AI 时按分排在后面。
 */
import {
  candidateRelevanceText,
  irrelevantKeys,
  type RelevanceBand,
  type RelevanceTally,
  relevanceBand,
  relevanceTally,
  scoreAgainstTopics,
  scoreCandidates,
} from '../collectors/relevance.js'
import type { SearchCreatorCandidate } from '../kol/utils/youtubeSearch.js'
import type { PageListCapture } from '../page/capture.js'

/** 这一页用不用种子主题词（= 插件面板 `onWatchPage` 那一判）。 */
export function listWantsSeedTopics(list: PageListCapture): boolean {
  return list.target.pageType === 'watch_related'
}

export interface ListPrescreen {
  /** 打过分的候选（页面顺序不变；没打分的行没有 `relevanceScore`）。交给 `ingestPlanOf` 的就是这一份。 */
  candidates: SearchCreatorCandidate[]
  /** 这一页有没有打分（右栏且种子有主题词）。 */
  scored: boolean
  /** 拿来打分的种子主题词（没打分 = 空）。 */
  topics: string[]
  /** 四档各几行（插件面板顶上那一行数）。 */
  tally: RelevanceTally
  /** 插件会筛掉（不勾、不送）的那些行的 key（= `irrelevantKeys`）。 */
  skipped_keys: string[]
  /** 回给 AI 的顺序：有分的按分从高到低（同分照页面顺序），没分的照页面顺序排在后面。 */
  ranked: Array<{
    candidate: SearchCreatorCandidate
    band?: RelevanceBand
    matched_topics: string[]
    plugin_would_skip: boolean
  }>
}

/**
 * 给一页列表打分。`topicKeywords` = 本机给的种子主题词（不是右栏、或种子不在库里就传 `undefined`）；
 * 不是右栏的页面传了也不用（与插件一样，只在视频页拿种子来比）。
 */
export function prescreenList(
  list: PageListCapture,
  topicKeywords: readonly string[] | null | undefined,
): ListPrescreen {
  const topics = listWantsSeedTopics(list) ? [...(topicKeywords ?? [])] : []
  const candidates = scoreCandidates(list.candidates, topics.length > 0 ? topics : undefined)
  const skipped = new Set(irrelevantKeys(candidates))
  const scored = candidates.some((c) => typeof c.relevanceScore === 'number')
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const sa = a.candidate.relevanceScore
      const sb = b.candidate.relevanceScore
      const ha = typeof sa === 'number'
      const hb = typeof sb === 'number'
      if (ha && hb && sa !== sb) return (sb as number) - (sa as number)
      if (ha !== hb) return ha ? -1 : 1
      return a.index - b.index
    })
    .map(({ candidate }) => {
      const score = candidate.relevanceScore
      return {
        candidate,
        ...(typeof score === 'number' ? { band: relevanceBand(score) } : {}),
        matched_topics:
          typeof score === 'number'
            ? scoreAgainstTopics(topics, candidateRelevanceText(candidate)).matchedTopics
            : [],
        plugin_would_skip: skipped.has(candidate.key),
      }
    })
  return {
    candidates,
    scored,
    topics: scored ? topics : [],
    tally: relevanceTally(candidates),
    skipped_keys: [...skipped],
    ranked,
  }
}
