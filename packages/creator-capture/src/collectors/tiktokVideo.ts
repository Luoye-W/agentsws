/** 移植自 agentsws-extension `src/contents/utils/tiktokVideo.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/tiktokVideo.ts` @ d25b877。 */
import type { ContentSnapshot } from "../kol/utils/contentSnapshot.js"
import {
  measureMedia,
  measureVideoElement,
  primaryVideoElement
} from "./mediaProbe.js"
import { parseCompactNumber } from "../kol/utils/pageObservation.js"

/** Content id from /@handle/video/123 or /@handle/photo/123 permalinks. */
export function tiktokVideoId(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("tiktok.com")) return null
    return (
      url.pathname.match(/^\/@[^/?#]+\/(?:video|photo)\/(\d+)/)?.[1] ?? null
    )
  } catch {
    return null
  }
}

type VideoDetail = {
  id?: string
  desc?: string
  createTime?: number
  stats?: {
    playCount?: number
    diggCount?: number
    commentCount?: number
    shareCount?: number
  }
  video?: {
    cover?: string
    originCover?: string
    /** Animated webp preview — a cover of last resort; see resolveTikTokCover. */
    dynamicCover?: string
    /** Source pixels and whole-second runtime, when TikTok server-rendered. */
    width?: number
    height?: number
    duration?: number
  }
  author?: { id?: string; uniqueId?: string; nickname?: string }
  authorStats?: { followerCount?: number }
}

/**
 * TikTok server-renders the full item struct (exact play/like/comment/share
 * counts, unix createTime, author stats) in __UNIVERSAL_DATA_FOR_REHYDRATION__
 * under webapp.video-detail. Only trusted when its item id matches the URL —
 * SPA navigation leaves it stale.
 *
 * Reaching a video FROM a profile leaves no video-detail scope at all: the
 * blob still describes the profile that was server-rendered, so this correctly
 * returns undefined and every number below has to come off the DOM. That is
 * the path the selector fallbacks exist for.
 */
function readVideoDetail(expectedId: string): VideoDetail | undefined {
  const script = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")
  if (!script?.textContent) return undefined

  try {
    const data = JSON.parse(script.textContent)
    const item =
      data?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct
    if (!item?.id || String(item.id) !== expectedId) return undefined
    return item as VideoDetail
  } catch {
    return undefined
  }
}

/**
 * Two DOMs, one capture path.
 *
 * A video opened from a profile is not a page load: TikTok pushes the
 * permalink and paints the player as an OVERLAY on top of the still-mounted
 * profile. That overlay is a different component tree from the standalone
 * permalink and names its counters differently — `browse-like-count` where
 * the standalone page says `like-count`. Reading only one family is how the
 * capture returned null on a page that was showing the video perfectly well.
 *
 * First match wins, so the order within each list is "most specific first".
 */
const LIKE_KEYS = ["like-count", "browse-like-count"]
const COMMENT_KEYS = ["comment-count", "browse-comment-count"]
const SHARE_KEYS = ["share-count", "browse-share-count"]
const DESC_KEYS = ["browse-video-desc", "video-desc", "new-desc-span"]
const AUTHOR_NAME_KEYS = [
  "browse-username",
  "video-author-uniqueid",
  "browse-user-nickname",
  "video-author-nickname"
]

function dataE2eText(names: readonly string[]) {
  for (const name of names) {
    const text = document
      .querySelector<HTMLElement>(`[data-e2e="${name}"]`)
      ?.textContent?.trim()
    if (text) return text
  }
  return undefined
}

function dataE2eNumber(names: readonly string[]) {
  for (const name of names) {
    const parsed = parseCompactNumber(
      document
        .querySelector<HTMLElement>(`[data-e2e="${name}"]`)
        ?.textContent?.trim()
    )
    if (parsed != null) return parsed
  }
  return undefined
}

/** Every rung of the cover ladder, gathered so the choice can be tested. */
export type TikTokCoverSources = {
  /** `video.cover` off the rehydrated item struct. */
  cover?: string
  /** `video.originCover` — the first frame, same CDN, same size class. */
  originCover?: string
  /** `video.dynamicCover` — animated webp. */
  dynamicCover?: string
  /** `<video poster>` of the player on screen. */
  poster?: string
  /** Cover of the grid tile that links to THIS video (see coverFromTile). */
  tileCover?: string
  /** `og:image`, useless without the URL the head claims to describe. */
  ogImage?: string
  /** `og:url` / canonical — which page the head is actually about. */
  ogUrl?: string
}

/** A cover has to be an absolute http(s) URL; "" and a data: blob are not. */
function usableCover(url?: string): string | undefined {
  const trimmed = url?.trim()
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : undefined
}

/**
 * Which of the covers on offer to keep — and why the obvious one is not enough.
 *
 * The capture used to be `video.cover || player.poster`, which has a hole at
 * each end. The rehydrated struct is absent on the overlay route (a video
 * opened from a profile carries no video-detail scope at all — see
 * readVideoDetail), and `poster` is an attribute TikTok's player does not
 * always set, so both rungs can miss on the same page and the row lands in the
 * SaaS with an empty thumbnail. That is what a fresh 0.9.12 capture did.
 *
 * The order is trust, not convenience:
 *
 *  1. `cover` / `originCover` — TikTok's own stills for this exact item, and
 *     the struct is only ever returned when its id matches the URL, so they
 *     cannot describe a neighbouring video.
 *  2. `poster` — the cover of the player the user is watching. Right whenever
 *     it exists; it simply often does not.
 *  3. the grid tile — on the overlay route the profile behind the player is
 *     still mounted, and the tile for this video is holding its cover. Matched
 *     by parsing each candidate anchor's href, never by string containment: a
 *     19-digit id is a prefix of nothing, but "contains" is the kind of match
 *     that silently attaches the wrong video's picture.
 *  4. `og:image` — ONLY when the head is describing this video. On the overlay
 *     route the head still belongs to the profile, so its og:image is the
 *     creator's avatar; storing that as a video cover would be a wrong answer
 *     dressed as a right one, and worse than the empty cell we are fixing.
 *  5. `dynamicCover` last: it is a correct cover for this video and an
 *     animated webp, which is neither the medium still the house style asks
 *     for nor something every downstream table will render. Better than
 *     nothing, worse than anything above it.
 *
 * A paused first-frame canvas grab is deliberately NOT a rung: cross-origin
 * frames taint the canvas and the resulting data URL is far too heavy to ship
 * in a capture payload. When every rung misses we send no cover at all, which
 * is at least true.
 */
export function resolveTikTokCover(
  contentId: string,
  sources: TikTokCoverSources
): string | undefined {
  const headIsAboutThisVideo =
    Boolean(sources.ogUrl) && tiktokVideoId(sources.ogUrl!) === contentId

  return (
    usableCover(sources.cover) ??
    usableCover(sources.originCover) ??
    usableCover(sources.poster) ??
    usableCover(sources.tileCover) ??
    (headIsAboutThisVideo ? usableCover(sources.ogImage) : undefined) ??
    usableCover(sources.dynamicCover)
  )
}

function metaContent(selector: string) {
  return (
    document.querySelector<HTMLMetaElement>(selector)?.content?.trim() ||
    undefined
  )
}

/** What the page head says it is about, for the og:image guard above. */
function headSubjectUrl(): string | undefined {
  return (
    metaContent('meta[property="og:url"]') ||
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ||
    undefined
  )
}

/**
 * The cover of the grid tile pointing at this video, when one is on the page.
 *
 * This is the overlay route's answer: TikTok paints the player on top of a
 * profile that is still fully mounted, tiles and all. `href*=` only narrows
 * the candidates — the id is confirmed by parsing each href.
 */
function coverFromTile(contentId: string): string | undefined {
  // Ids come out of tiktokVideoId as digits, but the value is about to be
  // spliced into a selector, so it is checked rather than assumed.
  if (!/^\d+$/.test(contentId)) return undefined

  for (const anchor of Array.from(
    document.querySelectorAll<HTMLAnchorElement>(`a[href*="${contentId}"]`)
  )) {
    if (tiktokVideoId(anchor.href) !== contentId) continue
    const tile =
      anchor.closest<HTMLElement>('[data-e2e="user-post-item"]') ?? anchor
    const found = usableCover(tile.querySelector("img")?.src)
    if (found) return found
  }
  return undefined
}

/**
 * Read a capture snapshot from the current TikTok video/photo page. Only
 * reads browser-visible public information; returns null when the page is
 * not an identifiable content permalink, or when the player has not rendered
 * yet — the card's retry loop waits on that null.
 */
export function readTikTokVideoSnapshot(): ContentSnapshot | null {
  const contentId = tiktokVideoId(window.location.href)
  if (!contentId) return null

  const handle = window.location.pathname.match(/^\/@([^/?#]+)/)?.[1]
  const detail = readVideoDetail(contentId)

  const desc = detail?.desc || dataE2eText(DESC_KEYS)
  const authorName = detail?.author?.nickname || dataE2eText(AUTHOR_NAME_KEYS)

  const likes = detail?.stats?.diggCount ?? dataE2eNumber(LIKE_KEYS)
  const comments = detail?.stats?.commentCount ?? dataE2eNumber(COMMENT_KEYS)
  const shares = detail?.stats?.shareCount ?? dataE2eNumber(SHARE_KEYS)

  /*
    Shape and length. The rehydrated struct is exact when it exists; the
    element is the answer on the overlay route, where it does not. Never
    defaulted to portrait: TikTok hosts landscape uploads, and a guess that
    is usually right is the worst kind of wrong once it is in the database.
  */
  const player = primaryVideoElement()
  const measured = measureVideoElement(player)
  const rehydrated = measureMedia({
    width: detail?.video?.width,
    height: detail?.video?.height,
    duration: detail?.video?.duration
  })
  const orientation = rehydrated.orientation ?? measured.orientation
  const durationSeconds = rehydrated.durationSeconds ?? measured.durationSeconds

  /*
    The "this page really rendered the video" signal.

    On the overlay route the profile behind it is still fully mounted, so the
    presence of TikTok DOM proves nothing at all — the profile's own markup
    would sail through a laxer check and yield a snapshot with no numbers in
    it. An engagement counter, the rehydrated item, or a player we could
    actually measure are the three things only the video can produce.
  */
  if (!detail && likes == null && comments == null && durationSeconds == null) {
    return null
  }

  const authorHandle = detail?.author?.uniqueId || handle

  return {
    platform: "tiktok",
    contentId,
    contentType: window.location.pathname.includes("/photo/")
      ? "post"
      : "video",
    title: desc || `@${authorHandle} 的视频`,
    url: `https://www.tiktok.com/@${authorHandle}/video/${contentId}`,
    thumbnailUrl: resolveTikTokCover(contentId, {
      cover: detail?.video?.cover,
      originCover: detail?.video?.originCover,
      dynamicCover: detail?.video?.dynamicCover,
      poster: player?.poster,
      tileCover: coverFromTile(contentId),
      ogImage: metaContent('meta[property="og:image"]'),
      ogUrl: headSubjectUrl()
    }),
    views: detail?.stats?.playCount,
    likes,
    comments,
    shares,
    publishedAt: detail?.createTime
      ? new Date(detail.createTime * 1000).toISOString()
      : undefined,
    orientation,
    durationSeconds,
    author: {
      externalId: detail?.author?.id || authorHandle,
      handle: authorHandle,
      name: authorName,
      followers: detail?.authorStats?.followerCount,
      profileUrl: authorHandle
        ? `https://www.tiktok.com/@${authorHandle}`
        : undefined
    },
    pageUrl: window.location.href
  }
}
