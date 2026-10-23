/** 移植自 agentsws-extension `src/contents/utils/socialList.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/socialList.ts` @ d25b877（原移植基准 6259a1c；与 d25b877 相比只差 import 路径与下面写明的本仓改动）（WP130 时是基于 1f824f1 的工作区未提交改动，旧仓 09-23 以 6259a1c 正式提交，内容逐字相同；WP130 整块搬入，只改 import 路径）。 */
/** Read only creator identities visible in TikTok/Instagram list cards. */
import {
  MAX_VIDEOS_PER_CREATOR,
  type SearchCreatorCandidate,
  type SearchVideoEvidence
} from "../kol/utils/youtubeSearch.js"

type SocialPlatform = "tiktok" | "instagram"

function platformUrl(raw: string | null, platform: SocialPlatform): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw, `https://www.${platform}.com`)
    const host = url.hostname.toLowerCase().replace(/^www\./, "")
    return host === `${platform}.com` ? url : null
  } catch {
    return null
  }
}

function creatorHandle(url: URL, platform: SocialPlatform): string | null {
  if (platform === "tiktok") {
    return url.pathname.match(/^\/@([^/?#]+)(?:\/|$)/)?.[1] ?? null
  }
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length !== 1) return null
  const first = parts[0]
  if (
    ["p", "reel", "reels", "explore", "accounts", "stories"].includes(first)
  ) {
    return null
  }
  return /^[\w.]+$/.test(first) ? first : null
}

function contentId(url: URL, platform: SocialPlatform): string | null {
  return platform === "tiktok"
    ? url.pathname.match(/^\/@[^/]+\/(?:video|photo)\/(\d+)/)?.[1] ?? null
    : url.pathname.match(/^\/(?:p|reel)\/([\w-]+)/)?.[1] ?? null
}

function cardFor(link: Element, platform: SocialPlatform): Element {
  if (platform === "instagram") {
    let node = link.parentElement
    while (node && node.tagName.toLowerCase() !== "body") {
      const mediaIds = new Set(
        Array.from(node.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((anchor) => platformUrl(anchor.getAttribute("href"), platform))
          .map((mediaUrl) => mediaUrl && contentId(mediaUrl, platform))
          .filter(Boolean)
      )
      if (mediaIds.size > 1) return node
      if (mediaIds.size === 1 && visibleHandle(node, platform)) return node
      node = node.parentElement
    }
    return link.parentElement ?? link
  }
  const tiktokTile = link.closest('[data-e2e="search_top-item"]')
  if (tiktokTile?.parentElement) return tiktokTile.parentElement
  return (
    link.closest(
      'article, li, [role="listitem"], [data-e2e="search-video-item"], [data-e2e="search-user-item"]'
    ) ??
    link.parentElement ??
    link
  )
}

function visibleHandle(card: Element, platform: SocialPlatform): string | null {
  for (const link of Array.from(
    card.querySelectorAll<HTMLAnchorElement>("a[href]")
  )) {
    const url = platformUrl(link.getAttribute("href"), platform)
    const handle = url && creatorHandle(url, platform)
    if (handle) return handle
  }
  // Instagram's tag grid sometimes prints the author in the image alt text.
  // A name without an @handle is ambiguous and is deliberately ignored.
  if (platform === "instagram") {
    for (const image of Array.from(
      card.querySelectorAll<HTMLImageElement>("img[alt]")
    )) {
      const handle = image.alt.match(/(?:by|from|作者)\s+@([\w.]+)/i)?.[1]
      if (handle) return handle
    }
  }
  return null
}

function visibleCount(
  card: Element,
  platform: SocialPlatform
): string | undefined {
  const selector =
    platform === "tiktok"
      ? '[data-e2e="user-follower-count"], [data-e2e="followers-count"]'
      : '[data-testid="follower-count"]'
  const text = card.querySelector(selector)?.textContent?.trim()
  return text || undefined
}

/** No fetch, scroll, hidden-state parsing or guessed video ownership. */
export function collectSocialListCreators(
  platform: SocialPlatform,
  root: ParentNode = document
): SearchCreatorCandidate[] {
  const byHandle = new Map<string, SearchCreatorCandidate>()
  for (const link of Array.from(
    root.querySelectorAll<HTMLAnchorElement>("a[href]")
  )) {
    const url = platformUrl(link.getAttribute("href"), platform)
    if (!url) continue
    const id = contentId(url, platform)
    const profileHandle = creatorHandle(url, platform)
    if (!id && !profileHandle) continue
    // A profile link in the page header or navigation is not a search result.
    // Instagram tag capture needs a post with a visible author; TikTok also
    // has explicit user-result cards we can recognize.
    if (!id && platform === "instagram") continue
    if (
      !id &&
      platform === "tiktok" &&
      !link.closest('[data-e2e="search-user-item"]')
    )
      continue

    const card = cardFor(link, platform)
    if (id && platform === "instagram") {
      const mediaIds = new Set(
        Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((anchor) => platformUrl(anchor.getAttribute("href"), platform))
          .map((mediaUrl) => mediaUrl && contentId(mediaUrl, platform))
          .filter(Boolean)
      )
      // An article may wrap the entire grid. Its first profile link must not
      // be assigned to every post below it.
      if (mediaIds.size > 1) continue
    }
    const handle = visibleHandle(card, platform) ?? profileHandle
    if (!handle) continue
    const key = handle.toLowerCase()
    const existing = byHandle.get(key)
    const profileUrl = `https://www.${platform}.com/${platform === "tiktok" ? "@" : ""}${handle}${platform === "instagram" ? "/" : ""}`
    const candidate: SearchCreatorCandidate = existing ?? {
      key,
      externalId: handle,
      handle,
      url: profileUrl,
      source: id ? "video_attribution" : "channel_result"
    }
    if (!existing) byHandle.set(key, candidate)
    if (!candidate.subscriberCountText) {
      candidate.subscriberCountText = visibleCount(card, platform)
    }
    if (!candidate.displayName) {
      const label = card
        .querySelector('[data-e2e="search-card-user-unique-id"]')
        ?.textContent?.trim()
      if (label) candidate.displayName = label.slice(0, 300)
    }
    if (!candidate.avatarUrl) {
      for (const profileLink of Array.from(
        card.querySelectorAll<HTMLAnchorElement>("a[href]")
      )) {
        const profile = platformUrl(profileLink.getAttribute("href"), platform)
        if (
          !profile ||
          contentId(profile, platform) ||
          creatorHandle(profile, platform) !== handle
        ) {
          continue
        }
        const avatar = profileLink.querySelector<HTMLImageElement>("img")
        if (avatar?.src) candidate.avatarUrl = avatar.src
        break
      }
    }
    if (id) {
      const videos = candidate.videos ?? []
      if (
        videos.length >= MAX_VIDEOS_PER_CREATOR ||
        videos.some((v) => v.contentId === id)
      ) {
        continue
      }
      const title = card
        .querySelector('[data-e2e="new-desc-span"]')
        ?.textContent?.trim()
      const viewsText = card
        .querySelector('[data-e2e="video-views"]')
        ?.textContent?.trim()
      const evidence: SearchVideoEvidence = {
        contentId: id,
        url: url.toString(),
        ...(title ? { title: title.slice(0, 500) } : {}),
        ...(viewsText ? { viewsText: viewsText.slice(0, 50) } : {}),
        ...(platform === "instagram"
          ? {
              contentType: url.pathname.startsWith("/reel/")
                ? ("reel" as const)
                : ("post" as const)
            }
          : url.pathname.includes("/photo/")
            ? { contentType: "post" as const }
            : {})
      }
      candidate.videos = [...videos, evidence]
    }
  }
  return [...byHandle.values()]
}
