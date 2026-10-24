/**
 * 快照 → 本机服务 `POST /v1/extension/creators`（「存入红人池」）的请求体（WP498，决策 1740 B）。
 *
 * 两段：
 *
 * 1. **插件那一段，逐行照搬**：私有插件 `src/lib/local-handlers.ts` @ 57fca9c 的 `toCreatorSaveBody`
 *    （面板「存入红人池」：`toWorkspacePayload(snapshot)` → 后台换成蛇形）。唯一的改动：插件在那一刻取
 *    `new Date()`，这里由调用方给「现在」（ego 路的钟由本机服务给；对拍时两边同一个固定钟）。
 * 2. **1740 B 多存的两格**：加入时间（`joined_date`，页面原文）与近期作品（`recent_items`，最多 12 条，
 *    与插件 `toWorkspacePayload` 里 `recentItems.slice(0, 12)` 同一个上限）。插件那边以前就地丢掉这两格，
 *    只因为本机服务的白名单里没有它们（见插件 `toCreatorSaveBody` 的注释）；白名单加上之后，插件改用这个包
 *    （WP499）时自然一起送。
 *
 * 线上形状必须与 `packages/api/src/routes/extension.ts` 的 `creatorSaveSchema`（`.strict()`）对得上：多一个键整批拒。
 */

import type { CreatorSnapshot, RecentItem } from '../kol/utils/creatorSnapshot.js'
import type { PageObservation } from '../kol/utils/pageObservation.js'
import { toWorkspacePayload } from '../kol/workspacePayload.js'
import { contentUrlOf, derivedContentUrlOf } from './contentUrl.js'

/** 近期作品一条（蛇形；全是页面上本来就渲染着的东西）。 */
export interface CreatorSaveRecentItem {
  title: string
  views?: number
  views_text?: string
  likes?: number
  comments?: number
  published_at?: string
  published_text?: string
  thumbnail_url?: string
  /**
   * WP502（决策 1764 B，只加）：原作品链接（页面上读到的，读不到就从封面 / 短码推；推不出来不带）。
   * 只认这个平台上的一条作品（`contentUrlOf`）。
   */
  url?: string
}

/** `POST /v1/extension/creators` 的请求体。 */
export interface CreatorSaveBody {
  channel: string
  handle: string
  external_id?: string
  display_name?: string
  url?: string
  page_url?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  followers?: number
  avg_views?: number
  video_count?: number
  total_views?: number
  country?: string
  contact?: { kind: 'email'; value: string; source: 'channel_about' }
  observed_at: string
  source: 'manual_save'
  /** WP498（1740 B）：加入时间（页面原文，如 `Mar 3, 2021`）。 */
  joined_date?: string
  /** WP498（1740 B）：近期作品，最多 {@link SAVE_RECENT_ITEMS_MAX} 条。 */
  recent_items?: CreatorSaveRecentItem[]
}

/** 近期作品最多带几条（= 插件 `toWorkspacePayload` 的 `recentItems.slice(0, 12)`）。 */
export const SAVE_RECENT_ITEMS_MAX = 12

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 插件那一段（= 私有插件 `local-handlers.ts` 的 `toCreatorSaveBody`，逐行照搬；`observed_at` 由调用方给）。
 *
 * 只送白名单里有的格子：`rawSignals` 里的逐条明细、`joinedDate` 这类插件那一版本机白名单没有的键就地丢掉。
 * `rawSignals.businessEmail` 是页面上明明白白渲染着的邮箱，作为 contact 走（明文当场进本机加密库）。
 */
export function pluginCreatorSaveBodyOf(
  payload: PageObservation,
  observedAt: string,
): Omit<CreatorSaveBody, 'joined_date' | 'recent_items'> {
  const rawSignals = (payload.rawSignals ?? {}) as Record<string, unknown>
  const metrics = (payload.normalizedMetrics ?? {}) as Record<string, unknown>
  const platform = str(payload.platform) ?? ''
  // YouTube 报的是订阅数，别的平台报粉丝数——服务端只认 followers 一格。
  const followers = num(metrics.subscriberCount) ?? num(metrics.followerCount) ?? undefined
  const businessEmail = str(rawSignals.businessEmail)
  return {
    channel: platform,
    handle: str(payload.detectedHandle) ?? str(payload.detectedPlatformAccountId) ?? '',
    ...(str(payload.detectedPlatformAccountId) === undefined
      ? {}
      : { external_id: payload.detectedPlatformAccountId as string }),
    ...(str(payload.detectedDisplayName) === undefined
      ? {}
      : { display_name: payload.detectedDisplayName as string }),
    ...(str(payload.canonicalUrl) === undefined ? {} : { url: payload.canonicalUrl }),
    ...(str(payload.pageUrl) === undefined ? {} : { page_url: payload.pageUrl }),
    ...(str(payload.avatarUrl) === undefined ? {} : { avatar_url: payload.avatarUrl as string }),
    ...(str(payload.bannerUrl) === undefined ? {} : { banner_url: payload.bannerUrl as string }),
    ...(str(payload.description) === undefined ? {} : { bio: payload.description as string }),
    ...(followers === undefined ? {} : { followers }),
    ...(num(metrics.avgViews90d) === undefined ? {} : { avg_views: metrics.avgViews90d as number }),
    ...(num(metrics.videoCount) === undefined ? {} : { video_count: metrics.videoCount as number }),
    ...(num(metrics.totalViewCount) === undefined
      ? {}
      : { total_views: metrics.totalViewCount as number }),
    ...(str(rawSignals.country) === undefined ? {} : { country: rawSignals.country as string }),
    ...(businessEmail === undefined
      ? {}
      : {
          contact: {
            kind: 'email' as const,
            value: businessEmail,
            source: 'channel_about' as const,
          },
        }),
    observed_at: observedAt,
    source: 'manual_save',
  }
}

/** 近期作品一条 → 蛇形（只带读到了的格子；标题空的不带）。 */
function recentItemOf(
  item: RecentItem,
  platform: string,
  pageUrl: string | null | undefined,
): CreatorSaveRecentItem | undefined {
  const title = item.title?.trim()
  if (!title) return undefined
  // WP502（1764 B）：页面上读到的链接优先；读不到就从封面地址 / 短码推
  const url =
    contentUrlOf(pageUrl ?? undefined, platform) ??
    derivedContentUrlOf(platform, { title, thumbnail_url: item.thumbnailUrl })
  return {
    title: title.slice(0, 300),
    ...(num(item.views) === undefined || (item.views as number) < 0
      ? {}
      : { views: Math.round(item.views as number) }),
    ...(str(item.viewsText) === undefined
      ? {}
      : { views_text: (item.viewsText as string).slice(0, 120) }),
    ...(num(item.likes) === undefined || (item.likes as number) < 0
      ? {}
      : { likes: Math.round(item.likes as number) }),
    ...(num(item.comments) === undefined || (item.comments as number) < 0
      ? {}
      : { comments: Math.round(item.comments as number) }),
    ...(str(item.publishedAt) === undefined
      ? {}
      : { published_at: (item.publishedAt as string).slice(0, 60) }),
    ...(str(item.publishedText) === undefined
      ? {}
      : { published_text: (item.publishedText as string).slice(0, 120) }),
    ...(str(item.thumbnailUrl) === undefined || (item.thumbnailUrl as string).length > 600
      ? {}
      : { thumbnail_url: item.thumbnailUrl as string }),
    ...(url === undefined ? {} : { url }),
  }
}

/**
 * 「存入红人池」的整份请求体：插件那一段 + 1740 B 多存的加入时间与近期作品。
 * `observedAt` = 这一刻（ISO 时间）。`itemUrls`（WP502，1764 B）= 页面上读到的近期作品链接
 * （`PageCapture.creator_item_urls`，与 `snap.recentItems` 一一对应）；不给就只靠推。
 */
export function creatorSaveBodyOf(
  snap: CreatorSnapshot,
  observedAt: string,
  itemUrls?: readonly (string | null)[],
): CreatorSaveBody {
  const body: CreatorSaveBody = pluginCreatorSaveBodyOf(toWorkspacePayload(snap), observedAt)
  const joined = str(snap.joinedDate)?.trim()
  if (joined) body.joined_date = joined.slice(0, 80)
  const recent = (snap.recentItems ?? [])
    .slice(0, SAVE_RECENT_ITEMS_MAX)
    .map((item, i) => recentItemOf(item, snap.platform, itemUrls?.[i]))
    .filter((x): x is CreatorSaveRecentItem => x !== undefined)
  if (recent.length > 0) body.recent_items = recent
  return body
}
