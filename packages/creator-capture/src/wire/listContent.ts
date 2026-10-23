/** 移植自 agentsws-extension `src/lib/list-content.ts` @ 57fca9c（WP130 / WP131，私有插件外壳，不是 KOLAgents 旧插件代码），逐字照搬（只改 import 路径与排版）。 */
/**
 * 列表页批量采集的**帖子级那一半**（WP130，本仓新写，不是移植）。
 *
 * 旧插件把「这位红人在列表上带着哪几条视频 / 帖子」当证据随批量观测一起报给
 * 云端（`videos[]`）；本机服务的红人观测是窄行，没有这一格——于是这里把证据
 * 逐条折成**内容观测**（`POST /v1/extension/content-observations`，docs/76 §10），
 * 走已有的 `content-observation` 通道。登录了云账号时，本机服务照默认规则把它
 * 送进公共库（WP129 的内容路；没合入之前先落本机）。
 *
 * 三条纪律：
 * - **只报页面上印着的**：标题、播放数原文解析出来的数、链接。
 *   WP131（Luoye 09-23 定）：**没有标题的帖子也报**（Instagram 网格、TikTok hashtag 格子
 *   的大多数格子）——标题这一格空着，不编一个；服务端从 WP131 起标题可选。界面上
 *   这种条目显示「（无标题）· 平台 · 编号」（`untitledLabel`）。
 * - **没有评论这一格**：载荷类型 `ContentObservationPayload` 就没有它（红线）。
 * - 调用方负责「用户点了才报」：这个文件只做形状，不发请求。
 */

import { parseCompactCount } from '../collectors/searchFilters.js'
import type { BulkObservationItem } from '../kol/bulkWire.js'
import type { ContentObservationPayload } from '../kol/utils/contentSnapshot.js'
import type { CapturePlatform } from '../kol/utils/creatorSnapshot.js'

/** 服务端 schema 的上限（`title` ≤ 300、网址 ≤ 600）。 */
const TITLE_MAX = 300
const URL_MAX = 600

/** 这一批读自哪里 → 一个网址。YouTube 搜索页的 `sourceQuery` 是搜索词，其余本来就是网址。 */
export function listSourceUrl(platform: CapturePlatform, sourceQuery: string): string {
  if (/^https?:\/\//i.test(sourceQuery)) return sourceQuery.slice(0, URL_MAX)
  if (platform === 'youtube') {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(sourceQuery)}`.slice(
      0,
      URL_MAX,
    )
  }
  return sourceQuery.slice(0, URL_MAX)
}

/** 列表类型：搜索 / 相关视频 / hashtag。hashtag 从网址认（旧插件把它也算作 `search` 页型）。 */
export function listSourcePage(
  pageType: 'search' | 'watch_related' | undefined,
  sourceQuery: string,
): 'search' | 'watch_related' | 'hashtag' {
  if (pageType === 'watch_related') return 'watch_related'
  if (/^https?:\/\/[^/]+\/(?:tag|explore\/tags)\//i.test(sourceQuery)) return 'hashtag'
  return 'search'
}

const PLATFORM_NAMES: Record<CapturePlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

/**
 * WP131：没有标题的内容在界面上叫什么——「（无标题）· 平台 · 编号」。
 * 不编标题（编的就是假话），但要让人认得出是哪一条：平台 + 平台自己的编号。
 */
export function untitledLabel(platform: CapturePlatform | string, contentId: string): string {
  const name = PLATFORM_NAMES[platform as CapturePlatform] ?? platform
  return `（无标题）· ${name} · ${contentId}`
}

/** 有标题就用标题，没有就是「（无标题）· 平台 · 编号」。 */
export function contentLabel(
  platform: CapturePlatform | string,
  contentId: string,
  title: string | undefined | null,
): string {
  const trimmed = title?.trim()
  return trimmed ? trimmed : untitledLabel(platform, contentId)
}

function contentUrl(platform: CapturePlatform, id: string, given: string | undefined): string {
  if (given) return given.slice(0, URL_MAX)
  if (platform === 'youtube') return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  if (platform === 'instagram') return `https://www.instagram.com/p/${encodeURIComponent(id)}/`
  return ''
}

/**
 * 勾选的这一批红人 → 他们在页面上带着的内容观测。
 *
 * 同一条内容在一批里只出现一次（旧解析器已按人去重，这里再按内容 id 兜一次，
 * 防两个候选指向同一条视频）。
 */
export function listContentObservations(input: {
  platform: CapturePlatform
  sourceQuery: string
  items: readonly BulkObservationItem[]
  capturedAt: string
}): ContentObservationPayload[] {
  const sourceUrl = listSourceUrl(input.platform, input.sourceQuery)
  const seen = new Set<string>()
  const out: ContentObservationPayload[] = []
  for (const item of input.items) {
    for (const video of item.videos ?? []) {
      const title = video.title?.trim()
      if (!video.contentId || seen.has(video.contentId)) continue
      const url = contentUrl(input.platform, video.contentId, video.url)
      if (!url) continue
      seen.add(video.contentId)
      const views = parseCompactCount(video.viewsText)
      out.push({
        platform: input.platform,
        externalId: video.contentId,
        contentType: video.contentType ?? (input.platform === 'instagram' ? 'post' : 'video'),
        ...(title ? { title: title.slice(0, TITLE_MAX) } : {}),
        url,
        stats: views === undefined ? {} : { views },
        author: {
          externalId: item.externalId,
          ...(item.handle ? { handle: item.handle } : {}),
          ...(item.displayName ? { name: item.displayName } : {}),
        },
        // Shorts 是竖屏，这是 YouTube 自己的定义；别的平台不猜。
        ...(video.isShort ? { orientation: 'portrait' as const } : {}),
        capturedAt: input.capturedAt,
        sourceUrl,
      })
    }
  }
  return out
}
