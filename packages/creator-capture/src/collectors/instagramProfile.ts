/** 移植自 agentsws-extension `src/contents/utils/instagramProfile.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/instagramProfile.ts` @ d25b877。 */
import {
  assessUploadRegularity,
  averageItemViews,
  extractEmail,
  tileThumbnailUrl,
  type CreatorSnapshot,
  type ProfileLink,
  type RecentItem
} from "../kol/utils/creatorSnapshot.js"
import { parseCompactNumber } from "../kol/utils/pageObservation.js"
import { platformStrings } from "./platformStrings.js"

/**
 * First path segments that are Instagram surfaces, not usernames. A username
 * page is /<username>/ plus optional profile tabs (/reels, /tagged, ...).
 */
const RESERVED_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "stories",
  "explore",
  "accounts",
  "direct",
  "about",
  "developer",
  "legal",
  "directory",
  "lite",
  "session",
  "challenge",
  "graphql",
  "api",
  "web",
  "emails",
  "oauth",
  "your_activity",
  "settings"
])

const PROFILE_TAB_SEGMENTS = new Set(["reels", "tagged", "saved", "channel"])
/** Take what the grid shows; see the note in youtubeChannel.ts. */
const RECENT_ITEM_LIMIT = 120

/**
 * Profile base path shared by all tabs of one profile ("/username" for
 * "/username/reels/"), or null when the page is not a profile. Post/reel
 * permalinks (/p/..., /username/p/...) are excluded — the card only renders
 * on profile pages.
 */
export function instagramProfileBasePath(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("instagram.com")) return null
    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length === 0) return null
    const username = segments[0].toLowerCase()
    if (RESERVED_SEGMENTS.has(username)) return null
    if (segments.length >= 2 && !PROFILE_TAB_SEGMENTS.has(segments[1])) {
      return null
    }
    return `/${segments[0]}`
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
 * Instagram embeds the profile owner's numeric id in inline script JSON
 * ("profilePage_<id>" analytics marker, or profile_id fields). The numeric
 * id is what Apify-sourced discovery keys IG accounts by, so preferring it
 * keeps plugin captures and SaaS discovery pointing at the same creator.
 */
function findNumericUserId(): string | undefined {
  for (const script of Array.from(document.querySelectorAll("script"))) {
    const text = script.textContent
    if (!text || text.length < 20) continue
    const match =
      text.match(/"profilePage_(\d{3,})"/) ||
      text.match(/"profile_id"\s*:\s*"?(\d{3,})"?/) ||
      text.match(/"profileId"\s*:\s*"?(\d{3,})"?/)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/**
 * Header stat rows. The current layout renders followers/following/posts as
 * plain <li> text ("3.9M followers"), with no /followers anchor — scan the
 * list items and pull the number out of the one whose label matches.
 */
function findHeaderStat(labelPattern: RegExp): string | undefined {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>("header li, header section ul li")
  )
  for (const item of items) {
    const text = item.textContent || ""
    if (labelPattern.test(text)) {
      const match = text.match(/[\d,.]+\s*[KMB万亿]?/i)
      if (match?.[0]) return match[0]
    }
  }
  return undefined
}

/**
 * Followers, DOM first (the header <li>, or the legacy anchor's title attr),
 * meta description as the logged-out fallback ("4M Followers, ...").
 */
function findFollowersText(): string | undefined {
  const fromHeader = findHeaderStat(/followers|粉丝/i)
  if (fromHeader) return fromHeader

  // Legacy layout: exact count in the followers anchor's title attribute.
  const exact = document
    .querySelector<HTMLElement>('header a[href*="/followers"] span[title]')
    ?.getAttribute("title")
  if (exact) return exact

  const description =
    metaContent('meta[property="og:description"]') ||
    metaContent('meta[name="description"]')
  const match = description?.match(
    /([\d,.]+\s*[KMB万亿]?)\s*(?:Followers|位?粉丝)/i
  )
  return match?.[1]
}

function findPostCount(): number | undefined {
  const fromHeader = findHeaderStat(/posts?|帖子|貼文/i)
  if (fromHeader) return parseCompactNumber(fromHeader)

  const description =
    metaContent('meta[property="og:description"]') ||
    metaContent('meta[name="description"]')
  const match = description?.match(
    /([\d,.]+\s*[KMB万亿]?)\s*(?:Posts|篇?帖子|篇貼文)/i
  )
  return match?.[1] ? parseCompactNumber(match[1]) : undefined
}

function findDisplayName(username: string): string | undefined {
  // og:title: "Full Name (@username) • Instagram photos and videos"
  const ogTitle = metaContent('meta[property="og:title"]')
  const fromOg = ogTitle?.match(/^(.*?)\s*\(@[^)]+\)/)?.[1]?.trim()
  if (fromOg) return fromOg

  const headerName = document
    .querySelector<HTMLElement>("header section h1, header h1")
    ?.textContent?.trim()
  if (headerName && headerName !== username) return headerName

  return username
}

function findAvatarUrl(): string | undefined {
  const img = document.querySelector<HTMLImageElement>(
    'header img[alt*="profile picture" i], header img[alt*="头像"], header img'
  )
  if (img?.src?.startsWith("http")) return img.src
  return metaContent('meta[property="og:image"]')
}

/** Unwrap Instagram's l.instagram.com/?u=<target> outbound link shim. */
function unwrapLinkShim(href: string): string {
  try {
    const url = new URL(href)
    if (url.hostname === "l.instagram.com") {
      const target = url.searchParams.get("u")
      if (target) return decodeURIComponent(target)
    }
    return href
  } catch {
    return href
  }
}

function findBioLinks(): ProfileLink[] {
  const links: ProfileLink[] = []
  const seen = new Set<string>()

  for (const anchor of Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'header a[href*="l.instagram.com"], header a[rel*="nofollow"][href^="http"]'
    )
  )) {
    const url = unwrapLinkShim(anchor.href)
    if (!url.startsWith("http") || url.includes("instagram.com")) continue
    if (seen.has(url)) continue
    seen.add(url)
    links.push({ title: anchor.textContent?.trim() || undefined, url })
    if (links.length >= 10) break
  }

  return links
}

/** Bio text — the quoted part of the meta description ("on Instagram: …"). */
function findBio(): string | undefined {
  const description =
    metaContent('meta[name="description"]') ||
    metaContent('meta[property="og:description"]')
  const quoted = description?.match(/on Instagram:\s*["“](.+?)["”]?\s*$/)?.[1]
  return quoted?.trim() || undefined
}

/**
 * Grid tiles (/p/ and /reel/ permalink anchors under main). Reel tiles show a
 * persistent play-count overlay; the tile <img> alt carries the publish date
 * ("Photo by X on July 11, 2026") — enough to judge update regularity. Likes
 * and comments only render on real hover, so they stay undefined here.
 */
function collectRecentItems(limit = RECENT_ITEM_LIMIT): RecentItem[] {
  const anchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'main a[href*="/reel/"], main a[href*="/p/"]'
    )
  )
  const seen = new Set<string>()
  const items: RecentItem[] = []

  for (const anchor of anchors) {
    const shortcode = anchor.href.match(/\/(?:p|reel)\/([^/?#]+)/)?.[1]
    if (!shortcode || seen.has(shortcode)) continue
    seen.add(shortcode)

    const alt = anchor.querySelector("img")?.alt?.trim()
    const viewsText = anchor.textContent
      ?.trim()
      .match(/^[\d,.]+\s*[KMB万亿]?$/i)?.[0]
    const dateText = alt?.match(
      /on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/
    )?.[1]
    const publishedAt = dateText ? new Date(dateText).toISOString() : undefined

    items.push({
      title: shortcode,
      viewsText,
      views: parseCompactNumber(viewsText),
      publishedAt,
      publishedText: dateText,
      // A calendar date, not a relative label — exact to the day, and the
      // cadence maths may measure gaps between these.
      publishedPrecision: publishedAt ? ("day" as const) : undefined,
      thumbnailUrl: tileThumbnailUrl(anchor)
    })

    if (items.length >= limit) break
  }

  return items
}

/**
 * Read a one-click capture snapshot from the current Instagram profile page.
 * Only reads browser-visible public information; returns null when the page
 * is not an identifiable profile.
 */
export function readInstagramProfileSnapshot(): CreatorSnapshot | null {
  const basePath = instagramProfileBasePath(window.location.href)
  if (!basePath) return null

  const username = basePath.slice(1)

  // Guard against SPA profile-switch staleness: og:url lags to the previous
  // profile for a beat after navigation. If it names a different user, the
  // header/grid still belong to that user — treat as not ready and retry.
  const ogUsername = metaContent('meta[property="og:url"]')
    ?.match(/instagram\.com\/([^/?#]+)/)?.[1]
    ?.toLowerCase()
  if (ogUsername && ogUsername !== username.toLowerCase()) return null

  const followersText = findFollowersText()
  // Followers are the "page really rendered" signal: header hydrated or
  // logged-out meta present. Without them the capture is worthless anyway.
  if (!followersText) return null

  const recentItems = collectRecentItems()
  const postCount = findPostCount()
  // The header can hydrate before the grid. If the account has posts but the
  // grid is still empty, treat the page as not ready so the card retries.
  if (recentItems.length === 0 && postCount && postCount > 0) return null

  const bio = findBio()

  return {
    platform: "instagram",
    externalId: findNumericUserId() || username,
    handle: username,
    name: findDisplayName(username) || username,
    avatarUrl: findAvatarUrl(),
    followersText,
    followers: parseCompactNumber(followersText),
    videoCount: postCount,
    avgViews: averageItemViews(recentItems),
    links: findBioLinks(),
    recentItems,
    regularity: assessUploadRegularity(
      recentItems,
      platformStrings().instagram.regularityUnknown
    ),
    pageUrl: window.location.href,
    bio,
    businessEmail: extractEmail(bio)
  }
}
