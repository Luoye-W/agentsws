/** 移植自 agentsws-extension `src/contents/utils/instagramPost.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/instagramPost.ts` @ d25b877。 */
import type { ContentSnapshot } from "../kol/utils/contentSnapshot.js"
import {
  largestImageElement,
  measureImageElement,
  measureVideoElement,
  primaryVideoElement,
  UNMEASURED,
  type MediaMeasurement
} from "./mediaProbe.js"
import { parseCompactNumber } from "../kol/utils/pageObservation.js"

/**
 * Shortcode from post/reel permalinks: /p/<code>, /reel/<code>, /tv/<code>,
 * and the profile-prefixed /<username>/p/<code> form.
 */
export function instagramPostShortcode(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("instagram.com")) return null
    return url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/)?.[1] ?? null
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
 * Logged-out meta description carries the stats:
 * "12K likes, 345 comments - username on January 1, 2026: \"caption\"".
 * Reels sometimes lead with views. Logged-in DOM (likes anchor, time tag)
 * takes precedence when present.
 */
function parseMetaDescription() {
  const description =
    metaContent('meta[property="og:description"]') ||
    metaContent('meta[name="description"]')
  if (!description) return {}

  const likes = description.match(
    /([\d,.]+[KMB万亿]?)\s*(?:likes|次赞|个赞|贊)/i
  )?.[1]
  const comments = description.match(
    /([\d,.]+[KMB万亿]?)\s*(?:comments|条评论|則留言)/i
  )?.[1]
  const views = description.match(
    /([\d,.]+[KMB万亿]?)\s*(?:views|次播放|次观看)/i
  )?.[1]
  const author = description.match(/-\s*([\w.]+)\s+on\s+/)?.[1]
  const publishedText = description.match(
    /\bon\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/
  )?.[1]

  return {
    likes: parseCompactNumber(likes),
    comments: parseCompactNumber(comments),
    views: parseCompactNumber(views),
    author,
    publishedText,
    publishedAt: publishedText
      ? new Date(publishedText).toISOString()
      : undefined
  }
}

function findDomLikes() {
  // Logged-in layout: the liked-by anchor holds the exact count.
  const anchor = document.querySelector<HTMLElement>(
    'main a[href*="/liked_by/"] span, section a[href*="/liked_by/"] span'
  )
  return parseCompactNumber(anchor?.textContent?.trim())
}

function findDomPublishedAt() {
  return (
    document
      .querySelector<HTMLTimeElement>(
        "main time[datetime], article time[datetime]"
      )
      ?.getAttribute("datetime") || undefined
  )
}

function findDomAuthor() {
  // Post header: the username link above the media.
  const anchor = document.querySelector<HTMLAnchorElement>(
    "article header a[href^='/']:not([href*='/p/']):not([href*='/reel/'])"
  )
  return anchor?.getAttribute("href")?.replaceAll("/", "") || undefined
}

/**
 * Shape and length of the post's own media.
 *
 * Scoped to the article, because Instagram's page is mostly OTHER people's
 * pictures — avatars, suggested accounts, the next post in the feed — and the
 * largest image in the document is not reliably the one on the permalink. A
 * reel measures as a video; a photo carries an orientation and no duration; a
 * carousel measures whatever slide is on screen, which is the honest answer to
 * "what shape is this post" for a format that can mix them. Nothing found
 * means nothing claimed.
 */
function measurePostMedia(): MediaMeasurement {
  const scope =
    document.querySelector("article") ?? document.querySelector("main")
  if (!scope) return UNMEASURED

  const video = primaryVideoElement(scope)
  if (video) return measureVideoElement(video)

  const image = largestImageElement(scope)
  return image ? measureImageElement(image) : UNMEASURED
}

function findCaption(username?: string) {
  // og:title: "Username | caption" or "username on Instagram: \"caption\""
  const ogTitle = metaContent('meta[property="og:title"]')
  const fromColon = ogTitle?.match(/on Instagram:\s*["“](.+?)["”]?\s*$/)?.[1]
  if (fromColon) return fromColon
  if (ogTitle && username && !ogTitle.toLowerCase().startsWith("instagram")) {
    return ogTitle
  }
  return undefined
}

/**
 * Read a capture snapshot from the current Instagram post/reel page. Only
 * reads browser-visible public information; returns null when the page is
 * not an identifiable permalink or nothing measurable rendered.
 */
export function readInstagramPostSnapshot(): ContentSnapshot | null {
  const shortcode = instagramPostShortcode(window.location.href)
  if (!shortcode) return null

  const meta = parseMetaDescription()
  const likes = findDomLikes() ?? meta.likes
  const username = findDomAuthor() || meta.author
  // Likes (or at least an identified author) are the "page really rendered"
  // signal; a login wall yields neither.
  if (likes == null && !username) return null

  const isReel = window.location.pathname.includes("/reel/")
  const caption = findCaption(username)
  const media = measurePostMedia()

  return {
    platform: "instagram",
    contentId: shortcode,
    contentType: isReel ? "reel" : "post",
    title: caption || `@${username ?? "unknown"} 的${isReel ? "Reel" : "帖子"}`,
    url: `https://www.instagram.com/${isReel ? "reel" : "p"}/${shortcode}/`,
    thumbnailUrl: metaContent('meta[property="og:image"]'),
    views: meta.views,
    likes,
    comments: meta.comments,
    publishedAt: findDomPublishedAt() || meta.publishedAt,
    publishedText: meta.publishedText,
    orientation: media.orientation,
    durationSeconds: media.durationSeconds,
    author: {
      externalId: username,
      handle: username,
      name: username,
      profileUrl: username
        ? `https://www.instagram.com/${username}/`
        : undefined
    },
    pageUrl: window.location.href
  }
}
