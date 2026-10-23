/** 移植自 agentsws-extension `src/lib/kol/utils/pageObservation.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/pageObservation.ts` @ d25b877（原移植基准 c53ee4a；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
export type SupportedPlatform = "youtube" | "tiktok" | "instagram" | "unknown"

export type PageObservation = {
  platform: SupportedPlatform
  pageType: string
  pageUrl: string
  canonicalUrl: string
  detectedHandle?: string
  detectedPlatformAccountId?: string
  detectedPlatformContentId?: string
  detectedDisplayName?: string
  /** Creator avatar; the SaaS shows it on the pool card. */
  avatarUrl?: string
  /** Channel banner (YouTube); rendered behind the creator drawer header. */
  bannerUrl?: string
  /** The creator's own channel/profile description. */
  description?: string
  rawSignals: Record<string, unknown>
  normalizedMetrics: Record<string, unknown>
}

function detectPlatform(hostname: string): SupportedPlatform {
  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube"
  if (hostname.includes("tiktok.com")) return "tiktok"
  if (hostname.includes("instagram.com")) return "instagram"
  return "unknown"
}

function detectPageType(platform: SupportedPlatform, url: URL) {
  const pathname = url.pathname

  if (platform === "youtube") {
    if (pathname.includes("/watch") || pathname.includes("/shorts/")) return "video"
    if (pathname.startsWith("/@") || pathname.includes("/channel/") || pathname.includes("/c/")) return "profile"
  }

  if (platform === "tiktok") {
    if (pathname.includes("/video/")) return "video"
    if (pathname.startsWith("/@")) return "profile"
  }

  if (platform === "instagram") {
    if (pathname.includes("/p/")) return "post"
    if (pathname.includes("/reel/")) return "reel"
    return "profile"
  }

  return "page"
}

function getCanonicalUrl() {
  return (
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ||
    document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ||
    window.location.href
  )
}

function getMetaContent(selector: string) {
  return document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined
}

function firstTextMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[0]) return match[0]
  }
  return undefined
}

export function parseCompactNumber(value?: string) {
  if (!value) return undefined
  const normalized = value.replace(/,/g, "")
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB万億亿]?)/i)
  if (!match) return undefined

  const base = Number(match[1])
  if (!Number.isFinite(base)) return undefined

  const suffix = match[2]?.toLowerCase()
  const multiplier =
    suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "b"
          ? 1_000_000_000
          : suffix === "万"
            ? 10_000
            : suffix === "亿" || suffix === "億"
              ? 100_000_000
              : 1

  return Math.round(base * multiplier)
}

function extractIds(platform: SupportedPlatform, url: URL) {
  const pathname = url.pathname

  if (platform === "youtube") {
    const contentId = url.searchParams.get("v") || pathname.match(/\/shorts\/([^/?#]+)/)?.[1]
    const channelId = pathname.match(/\/channel\/([^/?#]+)/)?.[1]
    const handle = pathname.match(/^\/(@[^/?#]+)/)?.[1]
    return {
      detectedHandle: handle,
      detectedPlatformAccountId: channelId || handle,
      detectedPlatformContentId: contentId || undefined
    }
  }

  if (platform === "tiktok") {
    const handle = pathname.match(/^\/(@[^/?#]+)/)?.[1]
    const contentId = pathname.match(/\/video\/([^/?#]+)/)?.[1]
    return {
      detectedHandle: handle,
      detectedPlatformAccountId: handle,
      detectedPlatformContentId: contentId || undefined
    }
  }

  if (platform === "instagram") {
    const contentId = pathname.match(/\/(?:p|reel)\/([^/?#]+)/)?.[1]
    const firstSegment = pathname.split("/").filter(Boolean)[0]
    const handle = firstSegment && !["p", "reel", "tv"].includes(firstSegment) ? firstSegment : undefined
    return {
      detectedHandle: handle,
      detectedPlatformAccountId: handle,
      detectedPlatformContentId: contentId || undefined
    }
  }

  return {}
}

function findOutboundLinks() {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map((anchor) => anchor.href)
    .filter((href) => href.startsWith("http") || href.startsWith("mailto:"))
    .filter((href, index, array) => array.indexOf(href) === index)
    .slice(0, 40)
}

export function findVisibleContactEmail() {
  const mailto = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]'))
    .map((anchor) => anchor.href.replace(/^mailto:/i, "").split("?")[0])
    .find(Boolean)

  if (mailto) return mailto.trim().toLowerCase()

  const bodyText = document.body?.innerText || ""
  const match = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0]?.trim().toLowerCase()
}

export function readPageObservation(): PageObservation {
  const canonicalUrl = getCanonicalUrl()
  const url = new URL(canonicalUrl || window.location.href)
  const platform = detectPlatform(window.location.hostname)
  const pageType = detectPageType(platform, url)
  const bodyText = document.body?.innerText?.slice(0, 16000) || ""
  const title = getMetaContent('meta[property="og:title"]') || document.title || "Unknown creator page"
  const description =
    getMetaContent('meta[name="description"]') || getMetaContent('meta[property="og:description"]') || ""
  const subscriberText = firstTextMatch(bodyText, [
    /[\d,.]+\s*[KMB]?\s+subscribers/i,
    /[\d,.]+\s*[KMB]?\s+followers/i,
    /[\d,.]+\s*万\s*粉丝/i
  ])
  const viewText = firstTextMatch(bodyText, [/[\d,.]+\s*[KMB]?\s+views/i, /[\d,.]+\s*万\s*次观看/i])
  const likeText = firstTextMatch(bodyText, [/[\d,.]+\s*[KMB]?\s+likes/i])
  const commentText = firstTextMatch(bodyText, [/[\d,.]+\s*[KMB]?\s+comments/i])
  const ids = extractIds(platform, url)

  return {
    platform,
    pageType,
    pageUrl: window.location.href,
    canonicalUrl: canonicalUrl || window.location.href,
    ...ids,
    detectedDisplayName: title.replace(/ - YouTube$/i, "").replace(/ \| TikTok$/i, ""),
    rawSignals: {
      title,
      description,
      subscriberText,
      viewText,
      likeText,
      commentText,
      outboundLinks: findOutboundLinks(),
      visibleEmail: findVisibleContactEmail()
    },
    normalizedMetrics: {
      subscriberCount: parseCompactNumber(subscriberText),
      followerCount: parseCompactNumber(subscriberText),
      viewCount: parseCompactNumber(viewText),
      likeCount: parseCompactNumber(likeText),
      commentCount: parseCompactNumber(commentText)
    }
  }
}
