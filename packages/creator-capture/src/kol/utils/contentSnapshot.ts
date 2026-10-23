/** 移植自 agentsws-extension `src/lib/kol/utils/contentSnapshot.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/contentSnapshot.ts` @ d25b877（原移植基准 367cede；与 d25b877 相比只差 import 路径与下面写明的本仓改动）；WP130 本仓加 `paidPromotion` / `shoppable` 两格（旧仓没有）。 */
/**
 * Platform-generic snapshot of ONE piece of content (a YouTube video, an
 * Instagram post/reel, a TikTok video) — the M2.5 content-level capture
 * (strategy doc §十). Content detail pages expose richer per-item data than
 * profile grids (dates, likes, comments), and repeat captures of the same
 * contentId form a time series for campaign tracking. The author block
 * carries whatever the same page reveals about the creator; full creator
 * capture stays on the profile page (CreatorSnapshot).
 */
import type { CapturePlatform } from "./creatorSnapshot.js"

/**
 * 移植说明（WP119b A 第一阶段）：下面两个 type 在旧仓分别住在
 * `src/contents/utils/commentCollector.ts` @ b5edfd6 与
 * `src/contents/utils/mediaProbe.ts` @ 25bbeae —— 那两个模块是**视频页的采集器**
 * （评论收集、播放器尺寸测量），按派工单属于第二阶段「视频页」那一档。
 * 这里先把类型声明逐字抄过来，好让 `ContentSnapshot` 这个形状完整；
 * 第二阶段把真模块搬进来时，这两段删掉、改回 import 即可（同名同形，
 * 不会出现第二种真相）。
 */

export type CapturedComment = {
  /** 1..2000 chars after trimming; a blank comment is dropped, not sent. */
  text: string
  author?: string
  likeCount?: number
  /** RAW page text — see CollectedComment.publishedText. */
  publishedAt?: string
}

export type MediaOrientation = "landscape" | "portrait"

export type ContentAuthor = {
  /** Same keying rules as CreatorSnapshot.externalId when derivable. */
  externalId?: string
  handle?: string
  name?: string
  followers?: number
  followersText?: string
  /** Absolute URL of the author's profile page, for 去主页完整采集. */
  profileUrl?: string
}

export type ContentSnapshot = {
  platform: CapturePlatform
  /** The platform's stable content id (video id, shortcode). */
  contentId: string
  contentType: "video" | "post" | "reel"
  title: string
  url: string
  /**
   * Cover image, deliberately a MEDIUM-size variant (owner ask: hi-res
   * covers break downstream table/dashboard layouts).
   */
  thumbnailUrl?: string
  views?: number
  viewsText?: string
  likes?: number
  comments?: number
  shares?: number
  /** ISO timestamp when the page exposes it. */
  publishedAt?: string
  publishedText?: string
  durationText?: string
  /**
   * Shape and length of the media itself, both MEASURED off the page — see
   * mediaProbe. Required rather than optional, and nullable rather than
   * absent, so a scraper has to answer the question: "we looked and could not
   * tell" is a different fact from "nobody asked", and only the first one is
   * safe to store.
   */
  orientation: MediaOrientation | null
  durationSeconds: number | null
  /**
   * WP130（本仓加，旧仓没有）：平台自己打的「含付费推广」/ 带货入口标识。
   * **只有 `true` 或没有**——没看到不写 `false`（见 contents/utils/commerceSignals.ts）。
   */
  paidPromotion?: boolean
  shoppable?: boolean
  author: ContentAuthor
  pageUrl: string
}

/** Body of POST /api/plugin/public/content-observations (SaaS contract). */
export type ContentObservationPayload = {
  platform: CapturePlatform
  externalId: string
  contentType: "video" | "post" | "reel"
  /**
   * WP131（本仓改，Luoye 09-23 定）：标题**可选**——IG 网格 / TikTok hashtag 格子上的帖子
   * 没有标题，照样报内容观测。没有就不带（不编一个）。
   */
  title?: string
  url: string
  thumbnailUrl?: string
  publishedAt?: string
  stats: {
    views?: number
    likes?: number
    comments?: number
    shares?: number
  }
  author: {
    externalId: string
    handle?: string
    name?: string
    followers?: number
  }
  /**
   * Additive since 2026-08 — see toContentObservationPayload for why sending
   * these to a server that predates them is safe.
   */
  orientation?: MediaOrientation
  durationSeconds?: number
  /** WP130：见 ContentSnapshot 同名两格。没看到就不带。 */
  paidPromotion?: boolean
  shoppable?: boolean
  capturedAt: string
  sourceUrl: string
}

/**
 * Map a snapshot to the content-observations body, or null when the author
 * could not be identified (the SaaS requires the creator linkage).
 *
 * ── RED LINE ──────────────────────────────────────────────────────────────
 * This body feeds the PUBLIC shared library and must never carry comment
 * text. Product policy §12.4: the public library accepts metrics about a
 * piece of content, never the words strangers wrote under it — those belong
 * to one tenant, under one tenant's consent, and the public pool has no
 * consent conversation to attach them to. `capturedComments` therefore exists
 * on `toContentCapturePayload` (the tenant's own save) and nowhere else.
 * If a future field looks like it wants to ride along here, it does not.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `orientation` / `durationSeconds` are OMITTED when unmeasured rather than
 * sent as null: an older server's zod object strips keys it does not know
 * (verified — `publicContentObservationSchema` is a plain `z.object`, which
 * strips rather than rejects), and a newer one should be able to tell "we
 * could not measure it" from "this plugin never looked".
 */
export function toContentObservationPayload(
  snapshot: ContentSnapshot
): ContentObservationPayload | null {
  if (!snapshot.author.externalId) return null
  return {
    ...(snapshot.orientation ? { orientation: snapshot.orientation } : {}),
    ...(snapshot.durationSeconds != null
      ? { durationSeconds: snapshot.durationSeconds }
      : {}),
    // WP130：两个标识，看到了才带
    ...(snapshot.paidPromotion !== undefined ? { paidPromotion: snapshot.paidPromotion } : {}),
    ...(snapshot.shoppable !== undefined ? { shoppable: snapshot.shoppable } : {}),
    platform: snapshot.platform,
    externalId: snapshot.contentId,
    contentType: snapshot.contentType,
    title: snapshot.title,
    url: snapshot.url,
    thumbnailUrl: snapshot.thumbnailUrl,
    publishedAt: snapshot.publishedAt,
    stats: {
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares
    },
    author: {
      externalId: snapshot.author.externalId,
      handle: snapshot.author.handle,
      name: snapshot.author.name,
      followers: snapshot.author.followers
    },
    capturedAt: new Date().toISOString(),
    sourceUrl: snapshot.pageUrl
  }
}

/** ISO 8601 duration ("PT17M31S") → "17:31"; null-safe passthrough. */
export function formatIsoDuration(iso?: string): string | undefined {
  if (!iso) return undefined
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return undefined
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes)
  const ss = String(seconds).padStart(2, "0")
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * The same ISO duration as a number ("PT17M31S" → 1051). YouTube publishes it
 * in the page head, which is exact and available before the player has
 * metadata — a better source than the element for the one platform that
 * offers it.
 */
export function isoDurationSeconds(iso?: string): number | null {
  if (!iso) return null
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  if (!match) return null
  const total =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0)
  return total > 0 ? total : null
}

/**
 * The same capture, shaped for the tenant's own library.
 *
 * The public payload above feeds the shared library and stops there. Saving a
 * video into the workspace needs its author spelled out at the top level,
 * because the SaaS resolves the creator first and hangs the video off them —
 * a video with no creator behind it cannot be scored, pitched or attributed.
 *
 * `capturedComments` is the ONLY route comment text has out of the browser,
 * and it is optional in the strongest sense: absent unless the user turned the
 * consent toggle on AND the page had comments rendered. An empty array is
 * never sent — "we looked and the page had none" and "we did not look" are
 * both silence as far as this endpoint is concerned, and neither is worth a
 * key. See the red line on toContentObservationPayload for where it may not go.
 */
export function toContentCapturePayload(
  snapshot: ContentSnapshot,
  capturedComments?: readonly CapturedComment[]
): Record<string, unknown> | null {
  if (!snapshot.author.externalId) return null
  return {
    ...(capturedComments?.length
      ? { capturedComments: capturedComments.slice() }
      : {}),
    platform: snapshot.platform,
    contentExternalId: snapshot.contentId,
    contentUrl: snapshot.url,
    contentType: snapshot.contentType || "video",
    title: snapshot.title,
    thumbnailUrl: snapshot.thumbnailUrl,
    publishedAt: snapshot.publishedAt,
    views: snapshot.views,
    likes: snapshot.likes,
    comments: snapshot.comments,
    ...(snapshot.orientation ? { orientation: snapshot.orientation } : {}),
    ...(snapshot.durationSeconds != null
      ? { durationSeconds: snapshot.durationSeconds }
      : {}),
    // WP130：两个标识，看到了才带（存入自己的内容库也记下）
    ...(snapshot.paidPromotion !== undefined ? { paidPromotion: snapshot.paidPromotion } : {}),
    ...(snapshot.shoppable !== undefined ? { shoppable: snapshot.shoppable } : {}),
    authorExternalId: snapshot.author.externalId,
    authorHandle: snapshot.author.handle,
    authorName: snapshot.author.name,
    authorUrl: snapshot.author.profileUrl,
    authorFollowers: snapshot.author.followers,
    /*
      Also inside rawSignals, which today's server already persists verbatim.
      The top-level pair is what the server will read once it has columns for
      them; until then the strip-unknown-keys behaviour would drop the
      measurement on the floor, and a shape we measured once and threw away is
      a capture we have to redo.
    */
    rawSignals: {
      capturedAt: new Date().toISOString(),
      pageUrl: snapshot.pageUrl,
      orientation: snapshot.orientation,
      durationSeconds: snapshot.durationSeconds
    }
  }
}
