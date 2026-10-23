/** 移植自 agentsws-extension `src/contents/utils/tiktokProfile.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/tiktokProfile.ts` @ d25b877。 */
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

/** Take what the grid shows; see the note in youtubeChannel.ts. */
const RECENT_ITEM_LIMIT = 120

/**
 * Profile base path ("/@handle"), or null when not a profile page. Video
 * permalinks (/@handle/video/123), photo posts, and live rooms are excluded
 * — the card only renders on the profile itself.
 */
export function tiktokProfileBasePath(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("tiktok.com")) return null
    const match = url.pathname.match(/^\/(@[^/?#]+)(\/.*)?$/)
    if (!match) return null
    const rest = match[2]?.replace(/\/+$/, "")
    if (rest && rest !== "") return null
    return `/${match[1]}`
  } catch {
    return null
  }
}

type TikTokUserDetail = {
  id?: string
  uniqueId?: string
  nickname?: string
  avatarUrl?: string
  signature?: string
  region?: string
  bioLink?: string
  followerCount?: number
  videoCount?: number
}

/**
 * TikTok server-renders a JSON blob (__UNIVERSAL_DATA_FOR_REHYDRATION__)
 * whose webapp.user-detail scope carries the exact numeric user id and
 * stats. The numeric id is what Apify-sourced discovery keys TikTok
 * accounts by, so preferring it keeps plugin captures and SaaS discovery
 * pointing at the same creator. The blob is only trusted when its uniqueId
 * matches the current path — SPA navigation leaves it stale.
 */
function readRehydrationUserDetail(
  expectedHandle: string
): TikTokUserDetail | undefined {
  const script = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")
  if (!script?.textContent) return undefined

  try {
    const data = JSON.parse(script.textContent)
    const user = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo
    const info = user?.user
    if (!info?.uniqueId) return undefined
    if (info.uniqueId.toLowerCase() !== expectedHandle.toLowerCase()) {
      return undefined
    }
    return {
      id: typeof info.id === "string" ? info.id : undefined,
      uniqueId: info.uniqueId,
      nickname: info.nickname,
      avatarUrl: info.avatarLarger || info.avatarMedium || info.avatarThumb,
      signature: info.signature,
      region: info.region,
      bioLink: info.bioLink?.link,
      followerCount: user?.stats?.followerCount,
      videoCount: user?.stats?.videoCount
    }
  } catch {
    return undefined
  }
}

function dataE2eText(name: string) {
  return (
    document
      .querySelector<HTMLElement>(`[data-e2e="${name}"]`)
      ?.textContent?.trim() || undefined
  )
}

function findAvatarUrl(): string | undefined {
  const img = document.querySelector<HTMLImageElement>(
    '[data-e2e="user-avatar"] img, [data-e2e="user-page-avatar"] img'
  )
  if (img?.src?.startsWith("http")) return img.src
  return (
    document.querySelector<HTMLMetaElement>('meta[property="og:image"]')
      ?.content || undefined
  )
}

function findBioLinks(detail?: TikTokUserDetail): ProfileLink[] {
  const links: ProfileLink[] = []
  const seen = new Set<string>()

  const push = (url?: string, title?: string) => {
    if (!url) return
    const normalized = url.startsWith("http") ? url : `https://${url}`
    if (seen.has(normalized) || normalized.includes("tiktok.com")) return
    seen.add(normalized)
    links.push({ title: title || undefined, url: normalized })
  }

  push(detail?.bioLink)
  const anchor = document.querySelector<HTMLAnchorElement>(
    '[data-e2e="user-link"] a, a[data-e2e="user-link"]'
  )
  push(anchor?.href, anchor?.textContent?.trim())
  // user-link sometimes renders as a plain span next to the icon.
  if (links.length === 0) {
    const text = dataE2eText("user-link")
    if (text && /\./.test(text)) push(text)
  }

  return links
}

/**
 * Video grid tiles. TikTok shows a persistent view count on every tile
 * (data-e2e="video-views") but no publish dates — regularity is honest
 * about that. Pinned tiles are skipped: they are usually old top hits and
 * would inflate the average views the health verdict runs on.
 */
function collectRecentItems(limit = RECENT_ITEM_LIMIT): RecentItem[] {
  const tiles = Array.from(
    document.querySelectorAll<HTMLElement>('[data-e2e="user-post-item"]')
  )
  const items: RecentItem[] = []
  const seen = new Set<string>()

  for (const tile of tiles) {
    if (tile.querySelector('[data-e2e="video-card-badge"]')) continue

    const viewsText = tile
      .querySelector<HTMLElement>('[data-e2e="video-views"]')
      ?.textContent?.trim()
    const anchor = tile.querySelector<HTMLAnchorElement>("a[href]")
    const contentId = anchor?.href.match(/\/(?:video|photo)\/(\d+)/)?.[1]
    const title =
      tile.querySelector("img")?.alt?.trim() ||
      anchor?.getAttribute("title")?.trim() ||
      contentId
    if (!title || seen.has(title)) continue
    seen.add(title)

    items.push({
      title,
      viewsText,
      views: parseCompactNumber(viewsText),
      thumbnailUrl: tileThumbnailUrl(tile)
    })

    if (items.length >= limit) break
  }

  return items
}

/**
 * Read a one-click capture snapshot from the current TikTok profile page.
 * Only reads browser-visible public information; returns null when the page
 * is not an identifiable profile.
 */
export function readTikTokProfileSnapshot(): CreatorSnapshot | null {
  const basePath = tiktokProfileBasePath(window.location.href)
  if (!basePath) return null

  const handle = basePath.slice(2) // drop "/@"
  const detail = readRehydrationUserDetail(handle)

  // Prefer the compact on-page text ("162.4M"); fall back to the exact
  // rehydration count for the number, but never show that raw count as text
  // (the card formats it — "1.6亿" — via `followers`).
  const followersText = dataE2eText("followers-count")
  const followers = parseCompactNumber(followersText) ?? detail?.followerCount
  const name =
    dataE2eText("user-subtitle") || detail?.nickname || dataE2eText("user-title")
  // Followers are the "page really rendered" signal; without them the
  // capture is worthless anyway.
  if (followers == null || !name) return null

  const recentItems = collectRecentItems()
  const bio = detail?.signature || dataE2eText("user-bio")

  return {
    platform: "tiktok",
    externalId: detail?.id || handle,
    handle,
    name,
    avatarUrl: detail?.avatarUrl || findAvatarUrl(),
    followersText,
    followers,
    videoCount: detail?.videoCount,
    avgViews: averageItemViews(recentItems),
    country: detail?.region,
    links: findBioLinks(detail),
    recentItems,
    regularity: assessUploadRegularity(
      recentItems,
      platformStrings().tiktok.regularityUnknown
    ),
    pageUrl: window.location.href,
    bio,
    businessEmail: extractEmail(bio)
  }
}
