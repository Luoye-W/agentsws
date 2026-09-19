/**
 * 搜索结果页的**批量采集**：候选、阈值筛选、分块节流（WP119 定论 2）。
 *
 * 「批量」这两个字最容易被做成「静默扫全站」。这里三条把它按住：
 *
 * 1. **一次只对一页**。候选只来自用户当前那一屏搜索结果，插件不翻页、
 *    不自动滚动、不跟着链接走。用户换一次搜索词 = 一个新批次。
 * 2. **未知一律放行**。阈值只滤掉「量到了并且不达标」的行；页面没印那个数字的
 *    行照样留着，面板上单说一句「其中 N 条没印这个数」。
 * 3. **一次发 20 条、间隔随机**。服务端收得下 100，这里只发 20：进度看得见，
 *    某一块失败也只赔那 20 行。间隔随机是因为**固定间隔本身就是一种指纹**。
 */

import { parseCompactCount } from './counts.js'

/** 一块发多少条。 */
export const BULK_CHUNK_SIZE = 20

/** 块与块之间随机等多久。 */
export const BULK_MIN_DELAY_MS = 300
export const BULK_MAX_DELAY_MS = 800

/** 搜索结果里一个创作者最多带几条视频作为佐证。 */
export const MAX_VIDEOS_PER_CANDIDATE = 5

/** 一条视频佐证。全是**原文**，一个解析出来的数都没有。 */
export interface VideoEvidence {
  content_id: string
  url?: string | undefined
  title?: string | undefined
  views_text?: string | undefined
  duration_text?: string | undefined
  is_short?: boolean | undefined
}

/** 搜索结果页上的一个候选。 */
export interface BulkCandidate {
  /** 去重键：优先平台 id（`UC…`），否则 `@handle`。 */
  external_id: string
  handle?: string | undefined
  display_name?: string | undefined
  url?: string | undefined
  avatar_url?: string | undefined
  /** 页面上那串订阅数原文。**不在这里解析后上行**。 */
  subscriber_count_text?: string | undefined
  video_count_text?: string | undefined
  videos: VideoEvidence[]
  /** 这一行是从频道结果来的，还是从某条视频的作者署名来的。 */
  source: 'channel_result' | 'video_attribution'
}

/** 用户填的阈值。**存文本不存数字**——用户写的是「1万」，不是 10000。 */
export interface CaptureFilterPrefs {
  min_views_text?: string | undefined
  min_subscribers_text?: string | undefined
}

export interface CaptureThresholds {
  min_views?: number | undefined
  min_subscribers?: number | undefined
}

/** 文本阈值 → 数字阈值。解析不出来或 ≤ 0 的当没填。 */
export function parseFilterPrefs(prefs: CaptureFilterPrefs): CaptureThresholds {
  const views = parseCompactCount(prefs.min_views_text)
  const subs = parseCompactCount(prefs.min_subscribers_text)
  return {
    ...(views !== undefined && views > 0 ? { min_views: views } : {}),
    ...(subs !== undefined && subs > 0 ? { min_subscribers: subs } : {}),
  }
}

/**
 * 这个候选身上**播放最高**的那条视频是多少。
 *
 * 取最大值而不是平均：搜索结果里一个人只露两三条，平均会被一条新片拉垮，
 * 而用户心里那句话是「这个人能不能打到 10 万」。
 */
export function candidateBestViews(candidate: BulkCandidate): number | undefined {
  let best: number | undefined
  for (const video of candidate.videos) {
    const value = parseCompactCount(video.views_text)
    if (value === undefined) continue
    if (best === undefined || value > best) best = value
  }
  return best
}

export function candidateSubscribers(candidate: BulkCandidate): number | undefined {
  return parseCompactCount(candidate.subscriber_count_text)
}

/** 量得到并且不达标才滤掉；量不到一律放行。 */
export function candidatePassesFilters(
  candidate: BulkCandidate,
  thresholds: CaptureThresholds,
): boolean {
  if (thresholds.min_views !== undefined) {
    const views = candidateBestViews(candidate)
    if (views !== undefined && views < thresholds.min_views) return false
  }
  if (thresholds.min_subscribers !== undefined) {
    const subs = candidateSubscribers(candidate)
    if (subs !== undefined && subs < thresholds.min_subscribers) return false
  }
  return true
}

export interface FilterOutcome {
  visible: BulkCandidate[]
  /** 被滤掉几条。 */
  hidden: number
  /**
   * 留下来的里面，有几条**从来没被任何一条启用中的阈值量到**。
   *
   * 面板上要单说这一句：「过滤掉 3 个」不等于「剩下的都达标」。
   */
  unknown: number
}

export function applyCaptureFilters(
  candidates: readonly BulkCandidate[],
  thresholds: CaptureThresholds,
): FilterOutcome {
  const active = thresholds.min_views !== undefined || thresholds.min_subscribers !== undefined
  if (!active) return { visible: [...candidates], hidden: 0, unknown: 0 }

  const visible: BulkCandidate[] = []
  let hidden = 0
  let unknown = 0
  for (const candidate of candidates) {
    if (!candidatePassesFilters(candidate, thresholds)) {
      hidden += 1
      continue
    }
    const measured =
      (thresholds.min_views !== undefined && candidateBestViews(candidate) !== undefined) ||
      (thresholds.min_subscribers !== undefined && candidateSubscribers(candidate) !== undefined)
    if (!measured) unknown += 1
    visible.push(candidate)
  }
  return { visible, hidden, unknown }
}

/** 同一个人出现在多行里（频道结果 + 好几条视频署名）时合成一行。 */
export function dedupeCandidates(rows: readonly BulkCandidate[]): BulkCandidate[] {
  const byId = new Map<string, BulkCandidate>()
  for (const row of rows) {
    const existing = byId.get(row.external_id)
    if (existing === undefined) {
      byId.set(row.external_id, { ...row, videos: row.videos.slice(0, MAX_VIDEOS_PER_CANDIDATE) })
      continue
    }
    // 频道结果那一行的身份更全，优先保留它的字段；视频佐证两边合并。
    const merged: BulkCandidate = {
      ...existing,
      handle: existing.handle ?? row.handle,
      display_name: existing.display_name ?? row.display_name,
      url: existing.url ?? row.url,
      avatar_url: existing.avatar_url ?? row.avatar_url,
      subscriber_count_text: existing.subscriber_count_text ?? row.subscriber_count_text,
      video_count_text: existing.video_count_text ?? row.video_count_text,
      videos: [...existing.videos, ...row.videos].slice(0, MAX_VIDEOS_PER_CANDIDATE),
      source: existing.source === 'channel_result' ? 'channel_result' : row.source,
    }
    byId.set(row.external_id, merged)
  }
  return [...byId.values()]
}

/** 分块。`size < 1` 时整包一块（不然会死循环）。 */
export function chunkItems<T>(items: readonly T[], size = BULK_CHUNK_SIZE): T[][] {
  if (size < 1) return items.length === 0 ? [] : [[...items]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 块间隔：300–800ms 随机。注入随机源，测试里不掷骰子。 */
export function randomBatchDelayMs(random: () => number = Math.random): number {
  return Math.round(BULK_MIN_DELAY_MS + random() * (BULK_MAX_DELAY_MS - BULK_MIN_DELAY_MS))
}

/** 一次批量跑完的账。`ok + deduped + invalid + failed` 必须等于发出去的条数。 */
export interface BulkTally {
  ok: number
  deduped: number
  invalid: number
  failed: number
}

export const emptyTally = (): BulkTally => ({ ok: 0, deduped: 0, invalid: 0, failed: 0 })

/**
 * 把一块的回执折进总账。
 *
 * **没答上来的也要记**：发了 20 条只回了 17 条回执，那 3 条记 `failed`——
 * 账对不上比数字难看更糟。
 */
export function applyBulkResult(
  tally: BulkTally,
  rows: readonly { status: string }[],
  chunkSize: number,
): BulkTally {
  const next = { ...tally }
  for (const row of rows) {
    if (row.status === 'ok') next.ok += 1
    else if (row.status === 'deduped') next.deduped += 1
    else next.invalid += 1
  }
  const unanswered = chunkSize - rows.length
  if (unanswered > 0) next.failed += unanswered
  return next
}

export function applyBulkFailure(tally: BulkTally, chunkSize: number): BulkTally {
  return { ...tally, failed: tally.failed + chunkSize }
}
