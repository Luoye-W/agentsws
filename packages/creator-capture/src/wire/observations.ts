/**
 * 快照 → 本机服务 `ingest` 那几条的请求体（插件路与 ego 路**同一份**换形）。
 *
 * 出处（全是私有插件的外壳代码，不是 KOLAgents 旧插件代码；逐段照搬，只把「发请求」那一半拿掉）：
 * - 主页观测：agentsws-extension `src/lib/legacy/pluginApi.ts` @ 57fca9c 的 `toExtensionObservation`
 *   （面板 `syncObservation` 那一条：`toObservationPayload(snap)` + `publicContactsOfProfile(snap)`）；
 * - 列表页批量：同文件 `postBulkObservations` 里逐行拼观测那一段 + `postListContents` 那一路的内容观测；
 * - 内容观测 / 链接页观测：agentsws-extension `src/lib/local-handlers.ts` 的 `toContentObservationBody` 与
 *   `bio-link-observation` 那一段（旧驼峰 → 本机服务的蛇形）。
 *
 * 线上形状必须与 `packages/api/src/routes/extension.ts` 的 `.strict()` 白名单对得上：多一个键整批拒。
 * **没有正文、没有评论、没有私信**——这几样在类型上就没有格子。
 */
import { type PublicContactLink, sanitizePublicContacts } from '@agentsws/contracts'
import type { BulkObservationItem } from '../kol/bulkWire.js'
import type { BioLinkObservationPayload } from '../kol/utils/bioLink.js'
import type { ContentObservationPayload } from '../kol/utils/contentSnapshot.js'
import type { CapturePlatform, ObservationPayload } from '../kol/utils/creatorSnapshot.js'
import { followersFromText } from './followerCount.js'
import { listContentObservations, listSourcePage } from './listContent.js'

/** 一条红人观测（= 私有插件 `src/lib/wire.ts` 的 `ExtensionObservationInput`，= 本机 `ExtensionObservation`）。 */
export interface CaptureObservation {
  channel: CapturePlatform
  handle: string
  external_id?: string
  display_name?: string
  url?: string
  avatar_url?: string
  followers?: number
  /** 页面上原样那串。 */
  followers_text?: string
  avg_views?: number
  video_count?: number
  country?: string
  bio?: string
  /** 主页上公开写着的联系方式（过完 `sanitizePublicContacts`）。 */
  public_contacts?: PublicContactLink[]
  observed_at: string
  page_url?: string
  source: 'channel_page' | 'content_page' | 'search_results'
  source_page?: 'search' | 'watch_related' | 'hashtag'
  source_query?: string
  relevance_score?: number
}

/**
 * 主页那一条（= 私有插件 `pluginApi.ts` 的 `toExtensionObservation`，逐行照搬）。
 *
 * 旧载荷里没有对应格子的（recentItems 的逐条明细、joinedDate、businessEmail）**就地丢掉**；
 * 页面上**公开写着的**联系方式走 `public_contacts`，出门前**再筛一遍**。
 */
export function creatorObservationOf(
  payload: ObservationPayload,
  publicContacts?: readonly PublicContactLink[],
): CaptureObservation {
  const contacts = sanitizePublicContacts(publicContacts ?? [])
  return {
    channel: payload.platform,
    handle: payload.handle ?? payload.externalId,
    external_id: payload.externalId,
    display_name: payload.name,
    ...(payload.avatarUrl ? { avatar_url: payload.avatarUrl } : {}),
    // WP201：移植来的快照把没读到的粉丝数垫成 0；0 在这里当「没读到」——不带这一格。
    ...(payload.stats.followers > 0 ? { followers: payload.stats.followers } : {}),
    ...(payload.stats.avgViews !== undefined ? { avg_views: payload.stats.avgViews } : {}),
    ...(payload.stats.videoCount !== undefined ? { video_count: payload.stats.videoCount } : {}),
    ...(payload.bio ? { bio: payload.bio } : {}),
    ...(contacts.length === 0 ? {} : { public_contacts: contacts }),
    observed_at: payload.capturedAt,
    ...(payload.sourceUrl ? { page_url: payload.sourceUrl } : {}),
    source: 'channel_page',
  }
}

/** 列表页一批（= `postBulkObservations` 的入参里与「发给谁」无关的那几格）。 */
export interface ListBatch {
  platform: CapturePlatform
  sourceQuery: string
  pageType?: 'search' | 'watch_related'
  items: readonly BulkObservationItem[]
}

/** 列表页那一批 → 一行一条观测（= `postBulkObservations` 逐行拼的那一段，逐行照搬）。 */
export function listObservationsOf(batch: ListBatch, now: string): CaptureObservation[] {
  const sourcePage = listSourcePage(batch.pageType, batch.sourceQuery)
  const sourceQuery = batch.sourceQuery.slice(0, 600)
  return batch.items.map((item) => {
    const followers = followersFromText(item.subscriberCountText)
    const row: CaptureObservation = {
      channel: batch.platform,
      handle: item.handle ?? item.externalId,
      external_id: item.externalId,
      ...(item.displayName ? { display_name: item.displayName } : {}),
      ...(item.url ? { page_url: item.url } : {}),
      ...(item.avatarUrl ? { avatar_url: item.avatarUrl } : {}),
      ...(item.subscriberCountText ? { followers_text: item.subscriberCountText } : {}),
      ...(followers === undefined ? {} : { followers }),
      observed_at: now,
      ...(item.url ? { url: item.url } : {}),
      source: 'search_results',
      source_page: sourcePage,
      ...(sourceQuery ? { source_query: sourceQuery } : {}),
      ...(typeof item.relevanceScore === 'number' && Number.isFinite(item.relevanceScore)
        ? { relevance_score: Math.max(0, Math.min(100, Math.round(item.relevanceScore))) }
        : {}),
    }
    return row
  })
}

/** 列表页那一批里红人带着的视频 / 帖子 → 内容观测（= `postListContents` 那一路要发的那几条）。 */
export function listContentBodiesOf(batch: ListBatch, now: string): ContentObservationBody[] {
  return listContentObservations({
    platform: batch.platform,
    sourceQuery: batch.sourceQuery,
    items: batch.items,
    capturedAt: now,
  }).map(contentObservationBodyOf)
}

/** 本机 `POST /v1/extension/content-observations` 的请求体。**没有评论这一格**（红线）。 */
export interface ContentObservationBody {
  channel: string
  content_external_id: string
  content_type?: string
  title?: string
  url?: string
  thumbnail_url?: string
  published_at?: string
  stats: { views?: number; likes?: number; comments?: number; shares?: number }
  author: { external_id: string; handle?: string; name?: string; followers?: number }
  orientation?: string
  duration_seconds?: number
  paid_promotion?: boolean
  shoppable?: boolean
  captured_at: string
  source_url?: string
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** 旧 ContentObservationPayload（驼峰）→ 本机内容观测的蛇形体（= `local-handlers.ts` 的 `toContentObservationBody`）。 */
export function contentObservationBodyOf(
  payload: ContentObservationPayload,
): ContentObservationBody {
  const p = payload as unknown as Record<string, unknown>
  const stats = (p.stats ?? {}) as Record<string, unknown>
  const author = (p.author ?? {}) as Record<string, unknown>
  return {
    channel: str(p.platform) ?? '',
    content_external_id: str(p.externalId) ?? '',
    ...(str(p.contentType) === undefined ? {} : { content_type: p.contentType as string }),
    ...(str(p.title) === undefined ? {} : { title: p.title as string }),
    ...(str(p.url) === undefined ? {} : { url: p.url as string }),
    ...(str(p.thumbnailUrl) === undefined ? {} : { thumbnail_url: p.thumbnailUrl as string }),
    ...(str(p.publishedAt) === undefined ? {} : { published_at: p.publishedAt as string }),
    stats: {
      ...(num(stats.views) === undefined ? {} : { views: stats.views as number }),
      ...(num(stats.likes) === undefined ? {} : { likes: stats.likes as number }),
      ...(num(stats.comments) === undefined ? {} : { comments: stats.comments as number }),
      ...(num(stats.shares) === undefined ? {} : { shares: stats.shares as number }),
    },
    author: {
      external_id: str(author.externalId) ?? str(author.external_id) ?? '',
      ...(str(author.handle) === undefined ? {} : { handle: author.handle as string }),
      ...(str(author.name) === undefined ? {} : { name: author.name as string }),
      ...(num(author.followers) === undefined ? {} : { followers: author.followers as number }),
    },
    ...(str(p.orientation) === undefined ? {} : { orientation: p.orientation as string }),
    ...(num(p.durationSeconds) === undefined
      ? {}
      : { duration_seconds: p.durationSeconds as number }),
    ...(typeof p.paidPromotion === 'boolean' ? { paid_promotion: p.paidPromotion } : {}),
    ...(typeof p.shoppable === 'boolean' ? { shoppable: p.shoppable } : {}),
    captured_at: str(p.capturedAt) ?? new Date().toISOString(),
    ...(str(p.sourceUrl) === undefined ? {} : { source_url: p.sourceUrl as string }),
  }
}

/** 本机 `POST /v1/extension/bio-link-observations` 的请求体。 */
export interface BioLinkObservationBody {
  platform: string
  slug: string
  source_url: string
  links: unknown[]
  social_links: unknown[]
  emails: unknown[]
  bio?: string
  captured_at: string
}

/** 链接页观测（= `local-handlers.ts` 的 `bio-link-observation` 那一段）。 */
export function bioLinkObservationBodyOf(
  payload: BioLinkObservationPayload,
): BioLinkObservationBody {
  const ref = payload as unknown as Record<string, unknown>
  return {
    platform: str(ref.platform) ?? '',
    slug: str(ref.slug) ?? '',
    source_url: str(ref.sourceUrl) ?? '',
    links: Array.isArray(ref.links) ? ref.links : [],
    social_links: Array.isArray(ref.socialLinks) ? ref.socialLinks : [],
    emails: Array.isArray(ref.emails) ? ref.emails : [],
    ...(str(ref.bio) === undefined ? {} : { bio: ref.bio as string }),
    captured_at: str(ref.capturedAt) ?? new Date().toISOString(),
  }
}
