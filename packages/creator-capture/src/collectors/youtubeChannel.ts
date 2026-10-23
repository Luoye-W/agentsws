/** 移植自 agentsws-extension `src/contents/utils/youtubeChannel.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词、点名一个真实频道与它 id 的那一句），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/youtubeChannel.ts` @ d25b877。 */
import {
  assessUploadRegularity,
  averageItemViews,
  extractEmail,
  parseRelativePublished,
  tileThumbnailUrl,
  type CreatorSnapshot,
  type ProfileLink,
  type RecentItem
} from "../kol/utils/creatorSnapshot.js"
import { parseCompactNumber } from "../kol/utils/pageObservation.js"
import { platformStrings } from "./platformStrings.js"

const CHANNEL_ID_PATTERN = /\/channel\/(UC[0-9A-Za-z_-]{10,})/
const CHANNEL_PATH_PATTERN = /^\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+)/
/**
 * Take what the page is already showing.
 *
 * Ten was an arbitrary floor that made every derived figure worse: averages
 * built from ten tiles swing on one outlier, and upload cadence read off ten
 * dates gave "0-761 days" for a channel that posts weekly. Reading a tile
 * costs nothing — the DOM is already there — so the only reason to stop is
 * payload size, which is what the cap is for now rather than a judgement about
 * how much data is useful. Scrolling the page loads more, and a re-capture
 * picks those up too.
 */
const RECENT_VIDEO_LIMIT = 120

/**
 * True for channel root pages and their subpages
 * (/@handle, /@handle/videos, /@handle/about, /channel/UC.../videos, ...).
 */
export function isYouTubeChannelPage(href: string) {
  return youTubeChannelBasePath(href) !== null
}

/**
 * Channel base path shared by all subpages of one channel
 * ("/@handle" for "/@handle/videos"), or null when not a channel page.
 * Useful as a React key so the card resets on channel-to-channel navigation.
 */
export function youTubeChannelBasePath(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.includes("youtube.com")) return null
    return url.pathname.match(CHANNEL_PATH_PATTERN)?.[0] ?? null
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

function findChannelId() {
  const candidates = [
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    metaContent('meta[property="og:url"]'),
    metaContent('meta[itemprop="identifier"]'),
    metaContent('meta[itemprop="channelId"]')
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (/^UC[0-9A-Za-z_-]{10,}$/.test(candidate)) return candidate
    const match = candidate.match(CHANNEL_ID_PATTERN)
    if (match?.[1]) return match[1]
  }

  return undefined
}

function findHandle(trustMeta: boolean) {
  const fromPath = window.location.pathname.match(/^\/(@[^/?#]+)/)?.[1]
  if (fromPath) return fromPath

  // A creator opened at youtube.com/channel/UC… has no handle in the URL, but
  // the header still shows it. Read it from there rather than reporting the
  // creator without one — the server takes the capture either way now, but a
  // handle is what makes a row recognisable to a human.
  const headerLink = document.querySelector<HTMLAnchorElement>(
    '#page-header a[href^="/@"], yt-page-header-renderer a[href^="/@"]'
  )
  const fromHeader = headerLink?.getAttribute('href')?.match(/^\/(@[^/?#]+)/)?.[1]
  if (fromHeader) return fromHeader

  if (!trustMeta) return undefined

  const ogUrl = metaContent('meta[property="og:url"]')
  return ogUrl?.match(/youtube\.com\/(@[^/?#]+)/)?.[1]
}

/** Channel name straight from the rendered header — never from <head>. */
function headerChannelName() {
  const selectors = [
    "#page-header h1",
    "yt-page-header-renderer h1",
    "ytd-c4-tabbed-header-renderer #channel-name #text",
    "ytd-channel-name #text"
  ]

  for (const selector of selectors) {
    const text = document
      .querySelector<HTMLElement>(selector)
      ?.textContent?.trim()
    if (text) return text
  }

  return undefined
}

function findChannelName(trustMeta: boolean) {
  return (
    headerChannelName() ??
    (trustMeta
      ? metaContent('meta[property="og:title"]')?.replace(/ - YouTube$/i, "")
      : undefined)
  )
}

/**
 * Does the document <head> describe the channel currently on screen?
 *
 * YouTube's SPA repaints the header the moment you navigate but leaves the
 * <head> block — canonical, og:url, og:title, og:description, itemprop ids —
 * describing the PREVIOUS channel for a while. Everything in there is a
 * different creator during that window, and none of it looks stale.
 *
 * This is not hypothetical: the public library held a capture of one real
 * channel (its own UC… id) stored under a different channel's UC… id,
 * with that other channel's join date and lifetime views, because the name
 * and follower count came from the fresh header while the identity came from
 * the stale <head>. The header name is the fresh source, so require the two
 * to agree before believing anything <head> says.
 */
function metaMatchesHeader(): boolean {
  const header = headerChannelName()
  const ogTitle = metaContent('meta[property="og:title"]')?.replace(
    / - YouTube$/i,
    ""
  )
  if (!header || !ogTitle) return false
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase()
  return normalize(header) === normalize(ogTitle)
}

function findAvatarUrl(trustMeta: boolean) {
  const img = document.querySelector<HTMLImageElement>(
    "#page-header yt-avatar-shape img, #page-header img, ytd-c4-tabbed-header-renderer #avatar img"
  )
  if (img?.src?.startsWith("http")) return img.src

  return trustMeta ? metaContent('meta[property="og:image"]') : undefined
}

/**
 * Channel banner (cover art). YouTube has shipped three different header
 * renderers, so try the current view-model first and fall back through the
 * older ones. `og:image` is deliberately NOT a fallback here — that is the
 * avatar, and using it as a banner would render a stretched square.
 */
function findBannerUrl() {
  const img = document.querySelector<HTMLImageElement>(
    "yt-image-banner-view-model img, #page-header-banner img, ytd-c4-tabbed-header-renderer #banner img, #banner img"
  )
  return img?.src?.startsWith("http") ? img.src : undefined
}

const SUBSCRIBER_PATTERNS = [
  /[\d,.]+\s*[KMB]?\s*(?:subscribers?|位订阅者|位訂閱者)/i,
  /[\d,.]+\s*[万亿億]?\s*(?:位)?订阅/
]

function findSubscriberText() {
  const header = document.querySelector<HTMLElement>(
    "#page-header, yt-page-header-renderer, ytd-c4-tabbed-header-renderer"
  )
  const sources = [header?.innerText, document.body?.innerText?.slice(0, 16000)]

  for (const source of sources) {
    if (!source) continue
    for (const pattern of SUBSCRIBER_PATTERNS) {
      const match = source.match(pattern)
      if (match?.[0]) return match[0].trim()
    }
  }

  return undefined
}

const VIDEO_COUNT_PATTERNS = [
  /([\d,.]+\s*[KMB万亿億]?)\s*(?:videos?|个视频|部影片|部片)/i
]

function findVideoCount(aboutRoot?: HTMLElement | null) {
  const sources = [
    aboutRoot?.innerText,
    document.querySelector<HTMLElement>(
      "#page-header, yt-page-header-renderer, ytd-c4-tabbed-header-renderer"
    )?.innerText
  ]

  for (const source of sources) {
    if (!source) continue
    for (const pattern of VIDEO_COUNT_PATTERNS) {
      const match = source.match(pattern)
      if (match?.[1]) return parseCompactNumber(match[1])
    }
  }

  return undefined
}

/** Every "youtube.com/@handle" or "youtube.com/channel/UC…" in a blob of text. */
const CHANNEL_SELF_URL = /youtube\.com\/(?:@[\w.-]+|channel\/UC[\w-]{10,})/gi

/**
 * The channel URLs an About dialog claims as its own. Taken from the "More
 * info" block when present so a creator who links *another* YouTube channel
 * in their Links section does not confuse the match.
 */
function aboutRootClaims(root: HTMLElement): string[] {
  const scope =
    root.querySelector<HTMLElement>("#additional-info-container") ?? root
  return (scope.innerText ?? "").match(CHANNEL_SELF_URL) ?? []
}

/** The identity of the channel on screen — what every field must belong to. */
type ChannelIdentity = {
  channelId?: string
  handle?: string
  name?: string
  /** Whether <head> currently describes this channel (see metaMatchesHeader). */
  trustMeta: boolean
}

function readChannelIdentity(): ChannelIdentity {
  const trustMeta = metaMatchesHeader()
  return {
    // The id only exists in <head>, so it is only usable when <head> is this
    // channel's. Untrusted, we fall back to the handle from the URL path,
    // which the router keeps correct at all times.
    channelId: trustMeta ? findChannelId() : undefined,
    handle: findHandle(trustMeta),
    name: findChannelName(trustMeta),
    trustMeta
  }
}

/**
 * True when this About dialog belongs to the channel we are standing on.
 *
 * YouTube's SPA leaves the previous channel's `ytd-about-channel-renderer`
 * mounted after you navigate away, and it is not visibly distinguishable from
 * a fresh one. Reading "the" About dialog therefore mixed a *different*
 * creator's join date, lifetime views, country and external links into this
 * creator's capture. (Seen live: a channel that joined 2023 with 355K views
 * and no external links was captured as joined Apr 2026, 123K views, with
 * Instagram and X links.)
 *
 * The dialog names its own channel in the More-info block, so require that to
 * match. When it cannot be matched we return nothing rather than guess: a
 * missing join date is a gap, a wrong one is a lie we cannot detect later.
 */
function aboutRootIsCurrent(
  root: HTMLElement,
  identity: ChannelIdentity
): boolean {
  const wanted = [identity.handle, identity.channelId]
    .filter(Boolean)
    .map((value) => `/${(value as string).toLowerCase()}`)
  if (wanted.length === 0) return false

  return aboutRootClaims(root).some((claim) => {
    const lowered = claim.toLowerCase()
    return wanted.some((suffix) => lowered.endsWith(suffix))
  })
}

/**
 * The channel About info renders inside `ytd-about-channel-renderer`
 * (modal on current YouTube) or `ytd-channel-about-metadata-renderer`
 * (legacy /about page). Only read it when it is already in the DOM —
 * we never trigger navigation or background fetches ourselves — and only
 * when it is this channel's, not the last one's.
 */
function findAboutRoot(identity: ChannelIdentity) {
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>(
      "ytd-about-channel-renderer, ytd-channel-about-metadata-renderer"
    )
  )
  return roots.find((root) => aboutRootIsCurrent(root, identity)) ?? null
}

/** Unwrap YouTube's /redirect?q=<target> wrapper used on About links. */
function unwrapRedirectUrl(href: string) {
  try {
    const url = new URL(href)
    if (url.pathname === "/redirect") {
      const target = url.searchParams.get("q")
      if (target) return decodeURIComponent(target)
    }
    return href
  } catch {
    return href
  }
}

function findAboutLinks(aboutRoot: HTMLElement | null): ProfileLink[] {
  if (!aboutRoot) return []

  const links: ProfileLink[] = []
  const seen = new Set<string>()

  // Current layout: one view-model per external link with a title element.
  const viewModels = Array.from(
    aboutRoot.querySelectorAll<HTMLElement>(
      "yt-channel-external-link-view-model"
    )
  )
  for (const model of viewModels) {
    const anchor = model.querySelector<HTMLAnchorElement>("a[href]")
    if (!anchor) continue
    const url = unwrapRedirectUrl(anchor.href)
    if (!url.startsWith("http") || seen.has(url)) continue
    seen.add(url)
    const title = model
      .querySelector<HTMLElement>(
        '[class*="external-link"] [class*="title"], span[class*="title"]'
      )
      ?.textContent?.trim()
    links.push({ title: title || undefined, url })
  }

  // Fallback (legacy layout): any outbound redirect-wrapped anchors.
  if (links.length === 0) {
    for (const anchor of Array.from(
      aboutRoot.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/redirect"], a[href^="http"]:not([href*="youtube.com"])'
      )
    )) {
      const url = unwrapRedirectUrl(anchor.href)
      if (!url.startsWith("http") || url.includes("youtube.com")) continue
      if (seen.has(url)) continue
      seen.add(url)
      links.push({ title: anchor.textContent?.trim() || undefined, url })
      if (links.length >= 10) break
    }
  }

  return links.slice(0, 10)
}

/** All About-dialog detail rows as trimmed text ("Joined Jul 8, 2006", ...). */
function aboutRows(aboutRoot: HTMLElement | null): string[] {
  if (!aboutRoot) return []
  return Array.from(
    aboutRoot.querySelectorAll<HTMLElement>(
      "#additional-info-container tr, #details-container tr, table tr"
    )
  )
    .map((row) => row.textContent?.replace(/\s+/g, " ").trim() || "")
    .filter(Boolean)
}

/**
 * Rich stats from the About dialog: join date, lifetime views, and the
 * accurate total video count (better than the header's rounded number).
 */
function findAboutStats(rows: string[]) {
  let joinedDate: string | undefined
  let totalViews: number | undefined
  let totalVideos: number | undefined

  for (const text of rows) {
    const joined =
      text.match(/Joined\s+(.+)/i)?.[1] ||
      text.match(/(\d{4}年\d{1,2}月\d{1,2}日)\s*加入/)?.[1] ||
      text.match(/加入日期[:：]?\s*(.+)/)?.[1]
    if (joined) joinedDate = joined.trim()

    const views = text.match(/([\d,]{4,})\s*(?:views|次观看|观看)/i)?.[1]
    if (views) totalViews = Number(views.replace(/,/g, ""))

    const videos = text.match(
      /([\d,.]+\s*[KMB万亿億]?)\s*(?:videos|个视频|部影片|部片)/i
    )?.[1]
    if (videos) totalVideos = parseCompactNumber(videos)
  }

  return { joinedDate, totalViews, totalVideos }
}

/**
 * Channel description.
 *
 * `og:description` is the primary source, not a fallback: it carries the full
 * text (verified against the dialog — 444 chars, ending mid-sentence in
 * neither) and is in the page from first paint. The About dialog only exists
 * once the user opens "More", and even then fills its description in
 * asynchronously — a scrape a moment too early found the container empty.
 * Between those two, the description was "sometimes" collected. Now it always
 * is, without the user opening anything — except while <head> still belongs to
 * the previous channel, where the About dialog is the only safe source.
 */
function findChannelDescription(
  aboutRoot: HTMLElement | null,
  trustMeta: boolean
) {
  const meta = trustMeta
    ? metaContent('meta[property="og:description"]')
    : undefined
  if (meta) return meta

  return (
    aboutRoot
      ?.querySelector<HTMLElement>(
        "#description-container, #description, yt-attributed-string#description"
      )
      ?.textContent?.trim() || undefined
  )
}

/**
 * Business email once the user has clicked "View email address" and passed
 * YouTube's human check (it renders as plain text in the About dialog). We
 * never trigger the reveal — only read what the user unlocked.
 */
function findBusinessEmail(aboutRoot: HTMLElement | null) {
  return extractEmail(aboutRoot?.innerText)
}

function findCountry(aboutRoot: HTMLElement | null) {
  if (!aboutRoot) return undefined

  // Current layout: details table rows, country row carries a globe icon.
  const rows = Array.from(
    aboutRoot.querySelectorAll<HTMLElement>(
      "#additional-info-container tr, #details-container tr, table tr"
    )
  )
  for (const row of rows) {
    const icon = row.querySelector("yt-icon")
    const iconName =
      icon?.getAttribute("icon") || icon?.getAttribute("class") || ""
    if (/privacy_public|globe/i.test(iconName)) {
      const text = row.textContent?.trim()
      if (text) return text
    }
  }

  // Legacy layout: explicit country container.
  const legacy = aboutRoot
    .querySelector<HTMLElement>(
      "#country-container, [id*='country']"
    )
    ?.textContent?.replace(/^(?:Location|Country|位置|国家\/地区)[:：]?\s*/i, "")
    .trim()
  return legacy || undefined
}

const VIDEO_ITEM_SELECTOR =
  "ytd-rich-item-renderer, ytd-grid-video-renderer, yt-lockup-view-model"

const VIDEO_TITLE_SELECTOR = [
  "#video-title",
  "a#video-title-link",
  '[class*="lockup-metadata-view-model"][class*="title"]',
  "h3 a"
].join(", ")

const VIDEO_METADATA_SELECTOR = [
  "#metadata-line span",
  ".inline-metadata-item",
  '[class*="content-metadata-view-model"] span',
  // Current lockup layout: camelCase class directly on the metadata span.
  '[class*="ContentMetadataViewModelMetadataText"]'
].join(", ")

function collectRecentVideos(limit = RECENT_VIDEO_LIMIT): RecentItem[] {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(VIDEO_ITEM_SELECTOR)
  )
  const seenTitles = new Set<string>()
  const videos: RecentItem[] = []

  for (const item of items) {
    // Skip Shorts shelves: no published dates and they skew regularity.
    if (item.closest("ytd-reel-shelf-renderer, ytd-rich-shelf-renderer")) {
      continue
    }

    const titleEl = item.querySelector<HTMLElement>(VIDEO_TITLE_SELECTOR)
    const title =
      titleEl?.getAttribute("title")?.trim() || titleEl?.textContent?.trim()
    if (!title || seenTitles.has(title)) continue

    const metadataTexts = Array.from(
      item.querySelectorAll<HTMLElement>(VIDEO_METADATA_SELECTOR)
    )
      .map((el) => el.textContent?.trim() || "")
      .filter(Boolean)

    // Current lockup layout drops the word "views": views render as a bare
    // compact number ("21K") next to an abbreviated date ("2d ago").
    const viewsText =
      metadataTexts.find((text) => /views?|次观看|观看/i.test(text)) ||
      metadataTexts.find((text) => /^[\d,.]+\s*[KMB万亿億]?$/i.test(text))
    const publishedText = metadataTexts.find(
      (text) => /\bago\b|前/.test(text) && !/views?|观看/i.test(text)
    )

    // Keep the granularity YouTube wrote the date in ("2d ago" is a day,
    // "3 months ago" is a bucket): the cadence maths refuses to measure gaps
    // between buckets, and cannot tell the two apart without this.
    const published = parseRelativePublished(publishedText)

    seenTitles.add(title)
    videos.push({
      title,
      viewsText,
      views: parseCompactNumber(viewsText),
      publishedText,
      publishedAt: published?.publishedAt,
      publishedPrecision: published?.precision,
      thumbnailUrl: tileThumbnailUrl(item)
    })

    if (videos.length >= limit) break
  }

  return videos
}

/**
 * Just the business email from the About dialog, if the user has revealed it.
 * Polled by the card so a reveal after the initial scrape still auto-fills the
 * contact — without re-running the whole scrape.
 */
export function readRevealedYouTubeEmail(): string | undefined {
  const identity = readChannelIdentity()
  const fromAbout = findBusinessEmail(findAboutRoot(identity))
  if (fromAbout) return fromAbout

  // Passing YouTube's human check does not write the address into the About
  // panel — it opens a separate dialog, outside `ytd-about-channel-renderer`,
  // which is why the reveal the user just completed never reached the card.
  //
  // Scanning every open dialog would risk lifting an address out of some
  // unrelated one, so only dialogs that announce themselves as the email
  // reveal are read.
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      'tp-yt-paper-dialog, ytd-popup-container tp-yt-paper-dialog, yt-dialog-view-model'
    )
  )
  for (const dialog of dialogs) {
    const text = dialog.innerText ?? ''
    if (!/email/i.test(text)) continue
    const found = extractEmail(text)
    if (found) return found
  }
  return undefined
}

/**
 * Read a one-click capture snapshot from the current YouTube channel page.
 * Only reads browser-visible public information; returns null when the
 * current page is not an identifiable channel page.
 */
export function readYouTubeChannelSnapshot(): CreatorSnapshot | null {
  if (!isYouTubeChannelPage(window.location.href)) return null

  const { channelId, handle, name, trustMeta } = readChannelIdentity()
  // Prefer the platform-native id, but only the verified one. A capture keyed
  // by handle is a weaker join key; a capture keyed by someone else's channel
  // id is another creator's record.
  const externalId = channelId || handle
  if (!externalId || !name) return null

  const subscriberText = findSubscriberText()
  const recentItems = collectRecentVideos()
  // On the videos tab an empty grid means the page is still loading — treat
  // as not hydrated so the card's retry loop waits for the tiles.
  if (
    recentItems.length === 0 &&
    /\/videos\/?$/.test(window.location.pathname)
  ) {
    return null
  }
  const aboutRoot = findAboutRoot({ channelId, handle, name, trustMeta })
  const rows = aboutRows(aboutRoot)
  const aboutStats = findAboutStats(rows)

  return {
    platform: "youtube",
    externalId,
    handle,
    name,
    avatarUrl: findAvatarUrl(trustMeta),
    bannerUrl: findBannerUrl(),
    followersText: subscriberText,
    followers: parseCompactNumber(subscriberText),
    // Prefer the About dialog's exact total over the header's rounded count.
    videoCount: aboutStats.totalVideos ?? findVideoCount(aboutRoot),
    avgViews: averageItemViews(recentItems),
    country: findCountry(aboutRoot),
    links: findAboutLinks(aboutRoot),
    recentItems,
    regularity: assessUploadRegularity(
      recentItems,
      platformStrings().youtube.regularityUnknown
    ),
    pageUrl: window.location.href,
    bio: findChannelDescription(aboutRoot, trustMeta),
    joinedDate: aboutStats.joinedDate,
    totalViews: aboutStats.totalViews,
    businessEmail: findBusinessEmail(aboutRoot)
  }
}
