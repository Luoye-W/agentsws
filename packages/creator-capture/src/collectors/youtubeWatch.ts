/** 移植自 agentsws-extension `src/contents/utils/youtubeWatch.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/youtubeWatch.ts` @ d25b877。 */
import {
  formatIsoDuration,
  isoDurationSeconds,
  type ContentSnapshot
} from "../kol/utils/contentSnapshot.js"
import { parseRelativePublishedDate } from "../kol/utils/creatorSnapshot.js"
import {
  measureVideoElement,
  primaryVideoElement
} from "./mediaProbe.js"
import { parseCompactNumber } from "../kol/utils/pageObservation.js"
import { formatDurationClock } from "../kol/format.js"

/** Video id from /watch?v=... URLs; Shorts have a different DOM and wait for P2. */
export function youTubeWatchVideoId(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("youtube.com")) return null
    if (url.pathname !== "/watch") return null
    return url.searchParams.get("v")
  } catch {
    return null
  }
}

function metaContent(selector: string) {
  return (
    document.querySelector<HTMLMetaElement>(selector)?.content?.trim() ||
    undefined
  )
}

/**
 * The watch page's <meta itemprop> block (views, datePublished, duration) is
 * only safe to read when it describes the CURRENT video — SPA navigation
 * leaves it stale. ytd-watch-flexy carries the live video-id to check against.
 */
function metaIsFresh(videoId: string) {
  const flexyId = document
    .querySelector("ytd-watch-flexy")
    ?.getAttribute("video-id")
  return !flexyId || flexyId === videoId
}

function findTitle() {
  const dom = document
    .querySelector<HTMLElement>(
      "h1.ytd-watch-metadata yt-formatted-string, #title h1, h1[class*='watch']"
    )
    ?.textContent?.trim()
  return dom || metaContent('meta[property="og:title"]')
}

/**
 * Likes live on the segmented like/dislike button. The aria-label carries the
 * exact count ("... 3,663 ..."); the visible text is the compact form.
 */
function findLikes(): number | undefined {
  const button = document.querySelector<HTMLElement>(
    "like-button-view-model button, #segmented-like-button button, ytd-toggle-button-renderer#like-button button"
  )
  const aria = button?.getAttribute("aria-label")
  const exact = aria?.match(/([\d,.]+)/)?.[1]
  if (exact) {
    const parsed = parseCompactNumber(exact)
    if (parsed != null) return parsed
  }

  const text = document
    .querySelector<HTMLElement>(
      "like-button-view-model, segmented-like-dislike-button-view-model, #segmented-like-button"
    )
    ?.textContent?.trim()
  return parseCompactNumber(text?.match(/[\d,.]+\s*[KMB万亿億]?/i)?.[0])
}

/**
 * The line under the title: "21K views  2 days ago  #tags". A bare `#info`
 * selector is unreliable — YouTube reuses that id elsewhere on the page — so
 * anchor it inside ytd-watch-metadata. This is also the "page really
 * rendered" signal for the watch capture.
 */
function findInfoText() {
  return (
    document.querySelector<HTMLElement>(
      "ytd-watch-metadata yt-formatted-string#info, ytd-watch-metadata #info"
    )?.innerText ||
    document.querySelector<HTMLElement>("ytd-watch-info-text")?.innerText ||
    undefined
  )
}

function findViewsText(infoText?: string) {
  const match = infoText?.match(/([\d,.]+\s*[KMB万亿億]?)\s*(?:views?|次观看)/i)
  return match?.[1]
}

function findPublishedText(infoText?: string) {
  return (
    infoText?.match(
      /\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago/i
    )?.[0] ||
    infoText?.match(/\d+\s*(?:秒|分钟|小时|天|日|周|星期|个月|月|年)前/)?.[0] ||
    // Absolute dates on older videos: "Jun 8, 2026" / "2026年6月8日".
    infoText?.match(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}|\d{4}年\d{1,2}月\d{1,2}日/
    )?.[0]
  )
}

/**
 * Player fallback for duration when the meta block is absent ("17:31").
 * "0:00" is the pre-playback placeholder, not a real duration.
 */
function findDurationFromPlayer() {
  const text = document
    .querySelector<HTMLElement>(".ytp-time-duration")
    ?.textContent?.trim()
  if (!text || !/^\d+(?::\d{2})+$/.test(text)) return undefined
  return /^0?0:00$/.test(text) ? undefined : text
}

/**
 * The main player, not the first `<video>` in the document — YouTube keeps
 * miniplayer and inline-preview elements mounted alongside it.
 */
function findPlayerVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>(
      "#movie_player video, video.html5-main-video"
    ) ?? primaryVideoElement()
  )
}

function findAuthor(): ContentSnapshot["author"] {
  const owner = document.querySelector<HTMLElement>("ytd-video-owner-renderer")
  const link = owner?.querySelector<HTMLAnchorElement>(
    "#channel-name a, a.yt-simple-endpoint"
  )
  const name = link?.textContent?.trim() || undefined
  const href = link?.href
  const handle = href?.match(/youtube\.com\/(@[^/?#]+)/)?.[1]
  const channelId = href?.match(/\/channel\/(UC[0-9A-Za-z_-]{10,})/)?.[1]
  const followersText = owner
    ?.querySelector<HTMLElement>("#owner-sub-count")
    ?.textContent?.trim()

  return {
    externalId: channelId || handle,
    handle,
    name,
    followers: parseCompactNumber(followersText),
    followersText,
    profileUrl: href
  }
}

/**
 * Read a capture snapshot from the current YouTube watch page. Only reads
 * browser-visible public information; returns null when the page is not an
 * identifiable watch page.
 */
export function readYouTubeWatchSnapshot(): ContentSnapshot | null {
  const videoId = youTubeWatchVideoId(window.location.href)
  if (!videoId) return null

  const title = findTitle()
  const infoText = findInfoText()
  const fresh = metaIsFresh(videoId)
  const metaViews = fresh
    ? metaContent('meta[itemprop="interactionCount"]')
    : undefined
  // Without the info line (or a fresh meta block) the page has not hydrated
  // yet — return null so the card's retry loop waits for it.
  if (!title || (!infoText && !metaViews)) return null

  /*
    Length and shape. The head's ISO duration is exact and arrives before the
    player has metadata, so it leads; the element answers when the meta block
    is stale or missing. Orientation can only come from the element — nothing
    in the head describes it — and it is measured rather than read off the
    URL, because /watch serves Shorts too and a portrait video filed as
    landscape is a briefing sent to the wrong kind of creator. (A /shorts/
    path is a fair corroborator of a portrait measurement; it is not a
    substitute for one.)
  */
  const player = measureVideoElement(findPlayerVideo())
  const metaDurationSeconds = fresh
    ? isoDurationSeconds(metaContent('meta[itemprop="duration"]'))
    : null
  const durationSeconds = metaDurationSeconds ?? player.durationSeconds

  const viewsText = metaViews || findViewsText(infoText)
  const publishedText = findPublishedText(infoText)
  const publishedAt =
    (fresh
      ? metaContent('meta[itemprop="datePublished"]') ||
        metaContent('meta[itemprop="uploadDate"]')
      : undefined) || parseRelativePublishedDate(publishedText)

  return {
    platform: "youtube",
    contentId: videoId,
    contentType: "video",
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    // mqdefault = 320x180: deliberately the medium variant, not maxres.
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    views: parseCompactNumber(viewsText),
    viewsText,
    likes: findLikes(),
    publishedAt,
    publishedText,
    durationText:
      (fresh
        ? formatIsoDuration(metaContent('meta[itemprop="duration"]'))
        : undefined) ||
      findDurationFromPlayer() ||
      formatDurationClock(durationSeconds),
    orientation: player.orientation,
    durationSeconds,
    author: findAuthor(),
    pageUrl: window.location.href
  }
}
