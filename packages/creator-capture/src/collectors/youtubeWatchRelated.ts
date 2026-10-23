/** 移植自 agentsws-extension `src/contents/utils/youtubeWatchRelated.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/youtubeWatchRelated.ts` @ d25b877。 */
/**
 * Reading the SIMILAR COLUMN of a YouTube watch page (0.9.18, WP-D6).
 *
 * The rail beside a video is the platform's own answer to "who else makes this
 * kind of thing", which is exactly the question the war room's 相似达人 line
 * asks. It is also the single most polluted list YouTube renders: roughly four
 * entries in ten are personalised to the VIEWER rather than similar to the
 * VIDEO (owner's own measurement, 2026-08-12), which is why nothing here is
 * captured without a human ticking it — see `relevance.ts` for the pre-screen
 * that colours the doubtful ones.
 *
 * The same discipline as the search collector applies and is worth restating,
 * because a rail is even more tempting to crawl than a results page: we read
 * what the user's own scrolling has already painted, we never follow the
 * continuation token at the bottom of the list, and we never open a video to
 * find out more about it.
 *
 * ─── THE IDENTITY PROBLEM, AND WHY THE INLINE JSON IS READ ──────────────────
 *
 * Verified against the live page on 2026-08-13: a rail entry in YouTube's
 * current `yt-lockup-view-model` layout contains exactly TWO anchors, both
 * pointing at the video. The channel is a plain text run — no href, no id, no
 * handle, not even on the avatar. So the rendered rail alone cannot say WHO a
 * row belongs to, and a display name is not an identity: filing "3Blue1Brown"
 * as an `externalId` would mint a third key form in a shared library that
 * already suffers from handle-keyed and UC-keyed rows never merging.
 *
 * The identity is in the document all the same — YouTube ships the rail's data
 * as an inline `ytInitialData` script — so that is where it is read from (see
 * `youtubeInitialData.ts`), joined onto the rendered rows by video id. Rows the
 * join cannot resolve stay visible and are NOT capturable, which is the honest
 * outcome: we saw the video, we do not know whose it is.
 *
 * Every function takes an optional `root` so the selectors can be exercised
 * against fixture DOM, and `textContent` is used throughout — `innerText` needs
 * layout, which fixtures do not have.
 */
import type {
  SearchCreatorCandidate,
  SearchVideoEvidence
} from "../kol/utils/youtubeSearch.js"
import {
  channelRefFromHref,
  MAX_VIDEOS_PER_CREATOR
} from "../kol/utils/youtubeSearch.js"

/** `/watch?v=…` on this page, or null when this is not a watch page. */
export function youTubeWatchId(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.endsWith("youtube.com")) return null
    if (url.pathname !== "/watch") return null
    const id = url.searchParams.get("v")?.trim()
    return id ? id : null
  } catch {
    return null
  }
}

export function isYouTubeWatchPage(href: string): boolean {
  return youTubeWatchId(href) !== null
}

/**
 * The rail's container, tried ONE AT A TIME rather than as a selector list.
 *
 * A comma-separated selector returns whichever match comes first in DOCUMENT
 * order, not the one written first — the trap that made 0.9.16 read a channel
 * name as a doubled string. Here it matters because `#secondary` also holds the
 * description panel, the merch shelf and the donation card, and reading those
 * as rail entries would file the video's own channel as a candidate.
 */
const RAIL_ROOT_SELECTORS = [
  "ytd-watch-next-secondary-results-renderer",
  "#related",
  "#secondary"
] as const

/**
 * One entry in the rail. Both layouts YouTube currently serves are listed:
 * `yt-lockup-view-model` is what a 2026 desktop watch page renders,
 * `ytd-compact-video-renderer` is the older markup that still appears on some
 * accounts and in some experiments.
 */
const RAIL_ITEM_SELECTORS = [
  "yt-lockup-view-model",
  "ytd-compact-video-renderer"
] as const

/** Rail entries live under one of these; ads and shelves are skipped below. */
const SKIP_ANCESTOR_SELECTOR = [
  "ytd-ad-slot-renderer",
  "ad-slot-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-reel-shelf-renderer"
].join(", ")

/** Where a rail entry's title lives, in preference order. Iterated, not listed. */
const TITLE_SELECTORS = [
  "a.ytLockupMetadataViewModelTitle",
  ".yt-lockup-metadata-view-model-wiz__title",
  "#video-title-link",
  "#video-title",
  "h3 a",
  "h3"
] as const

/**
 * A view count as the rail prints it — and the rail prints it WITHOUT the word
 * "views" (`9.4M`, `12万`), unlike a search page. Verified live on 2026-08-13.
 *
 * That is why the count is not matched by a "views" keyword here: it is matched
 * by SHAPE, and told apart from the upload age by the age's own pattern below.
 */
const COMPACT_COUNT_PATTERN =
  /^[\d][\d,.   ]*\s*[KMB万亿億만]?\s*(?:views?|次观看|次觀看|次播放|回視聴)?$/i

/**
 * "8y ago" / "3 days ago" / "8年前" / "2026年6月8日".
 *
 * The compact latin forms (`8y`, `11mo`, `3w`) are the rail's own abbreviation
 * and do not appear on a search page, so this pattern is deliberately wider
 * than the search collector's.
 */
const PUBLISHED_PATTERN =
  /^(?:\d+\s*(?:s|m|h|d|w|mo|y|second|minute|hour|day|week|month|year)s?\s+ago|\d+\s*(?:秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年)前|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}|\d{4}年\d{1,2}月\d{1,2}日)$/i

/** `12:34` / `1:02:03`. A LIVE badge deliberately does not match. */
const DURATION_PATTERN = /^\d{1,3}:\d{2}(?::\d{2})?$/

/** The badge word a Short carries, in the languages it is rendered in. */
const SHORTS_BADGE_PATTERN = /^(?:shorts|短视频|短影片|ショート)$/i

/** Long text is a description that happens to contain a number. */
const METADATA_TEXT_LIMIT = 48

function tidy(value?: string | null) {
  const text = value?.replace(/\s+/g, " ").trim()
  return text ? text : undefined
}

/**
 * One rail entry as the PAGE describes it — no identity, because the page does
 * not carry one (see the header). `channelName` is a display string and is
 * never used as a key on the wire.
 */
export type WatchRelatedEntry = {
  videoId: string
  url: string
  title?: string
  channelName?: string
  viewCountText?: string
  publishedText?: string
  durationText?: string
  isShort?: boolean
  /** Filled by the identity join, when the join can answer. */
  channelExternalId?: string
  channelHandle?: string
}

/** The first element matching any selector, tried in written order. */
function firstBySelectors(
  root: ParentNode,
  selectors: readonly string[]
): Element | null {
  for (const selector of selectors) {
    const found = root.querySelector(selector)
    if (found) return found
  }
  return null
}

/** The rail root, or the whole document when the page has not laid one out. */
export function watchRelatedRoot(root: ParentNode = document): ParentNode {
  return firstBySelectors(root, RAIL_ROOT_SELECTORS) ?? root
}

/**
 * The video this entry links to. A mix or radio playlist (`list=RD…`) is not
 * one creator's video and is refused here rather than filtered later.
 */
export function railVideoRefFromHref(
  raw?: string | null
): { videoId: string; url: string } | null {
  if (!raw) return null

  let path = raw
  let search = ""
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (!url.hostname.endsWith("youtube.com")) return null
      path = url.pathname
      search = url.search
    } catch {
      return null
    }
  } else {
    if (!path.startsWith("/")) return null
    const mark = path.indexOf("?")
    if (mark >= 0) {
      search = path.slice(mark)
      path = path.slice(0, mark)
    }
  }

  if (path !== "/watch") return null
  const params = new URLSearchParams(search)
  const list = params.get("list")
  // RD… is a generated mix; the rail shows them and they belong to nobody.
  if (list && /^RD/i.test(list)) return null
  const id = params.get("v")?.trim()
  if (!id) return null
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` }
}

function shortTexts(element: Element): string[] {
  const nodes = Array.from(
    element.querySelectorAll<HTMLElement>(
      "span, yt-formatted-string, .badge-shape-wiz__text, badge-shape, #metadata-line"
    )
  )
  const texts: string[] = []
  for (const node of nodes) {
    const text = tidy(node.textContent)
    if (!text || text.length > METADATA_TEXT_LIMIT) continue
    texts.push(text)
  }
  return texts
}

function readTitle(element: Element): string | undefined {
  for (const selector of TITLE_SELECTORS) {
    const node = element.querySelector<HTMLElement>(selector)
    if (!node) continue
    /*
      textContent, and NOT aria-label. The rail's title anchor carries
      `aria-label="… 20 minutes"` — the duration glued onto the end — and a
      title with a duration in it is a title that scores against the seed's
      topic words with a stray number in the bag.
    */
    const title = tidy(node.textContent) ?? tidy(node.getAttribute("title"))
    if (title) return title
  }
  return undefined
}

/**
 * The channel's display name: the FIRST metadata row of the lockup, or the
 * old renderer's channel-name element.
 *
 * Iterated per selector, and the shortest text wins within a row, for the two
 * reasons this repo keeps relearning: a comma selector answers in document
 * order, and a container's textContent is every child's text run together.
 */
function readChannelName(element: Element): string | undefined {
  const rows = Array.from(
    element.querySelectorAll<HTMLElement>(
      ".ytContentMetadataViewModelMetadataRow"
    )
  )
  for (const row of rows) {
    const text = tidy(row.textContent)
    if (!text || text.length > METADATA_TEXT_LIMIT) continue
    // The rail's first row is the byline; the second is "count · age", which
    // this refuses so an entry whose byline did not render is left unnamed
    // rather than named after its view count.
    if (COMPACT_COUNT_PATTERN.test(text) || PUBLISHED_PATTERN.test(text)) {
      continue
    }
    if (looksLikeCountAndAge(row)) continue
    return text
  }

  for (const selector of [
    "ytd-channel-name #text",
    "#channel-name #text",
    "#channel-name yt-formatted-string",
    "ytd-channel-name"
  ]) {
    const text = tidy(element.querySelector<HTMLElement>(selector)?.textContent)
    if (text && text.length <= METADATA_TEXT_LIMIT) return text
  }
  return undefined
}

/** "9.4M 8y ago" — the second metadata row, which is not a byline. */
function looksLikeCountAndAge(row: Element): boolean {
  const spans = Array.from(row.querySelectorAll<HTMLElement>("span"))
    .map((span) => tidy(span.textContent))
    .filter((text): text is string => Boolean(text))
  return spans.some((text) => PUBLISHED_PATTERN.test(text))
}

/**
 * Views and upload age off one entry, told apart BY CONTENT.
 *
 * Never by position and never by element id — this is the `#subscribers`
 * lesson from the search page, where the id said one thing and the content
 * said another. The age is unmistakable (it ends in "ago" / 前 / is a date), so
 * it is matched first and the remaining count-shaped string is the views.
 */
function readCounts(texts: string[]): {
  viewCountText?: string
  publishedText?: string
} {
  let publishedText: string | undefined
  let viewCountText: string | undefined

  for (const text of texts) {
    if (!publishedText && PUBLISHED_PATTERN.test(text)) {
      publishedText = text
      continue
    }
    if (!viewCountText && /\d/.test(text) && COMPACT_COUNT_PATTERN.test(text)) {
      viewCountText = text
    }
  }
  return { viewCountText, publishedText }
}

/** One rail element → what the page says about it, or null. */
export function readWatchRelatedEntry(
  element: Element
): WatchRelatedEntry | null {
  if (SKIP_ANCESTOR_SELECTOR && element.closest?.(SKIP_ANCESTOR_SELECTOR)) {
    return null
  }

  let ref: { videoId: string; url: string } | null = null
  for (const anchor of Array.from(
    element.querySelectorAll<HTMLAnchorElement>("a[href]")
  )) {
    ref = railVideoRefFromHref(anchor.getAttribute("href"))
    if (ref) break
  }
  if (!ref) return null

  const texts = shortTexts(element)
  const { viewCountText, publishedText } = readCounts(texts)
  const duration = texts.find((text) => DURATION_PATTERN.test(text))
  const isShort =
    texts.some((text) => SHORTS_BADGE_PATTERN.test(text)) ||
    Boolean(element.querySelector("ytm-shorts-lockup-view-model"))

  const entry: WatchRelatedEntry = { videoId: ref.videoId, url: ref.url }
  const title = readTitle(element)
  if (title) entry.title = title
  const channelName = readChannelName(element)
  if (channelName) entry.channelName = channelName
  if (viewCountText) entry.viewCountText = viewCountText
  if (publishedText) entry.publishedText = publishedText
  if (duration) entry.durationText = duration
  if (isShort) entry.isShort = true
  return entry
}

/**
 * Every rail entry currently RENDERED, in page order.
 *
 * "Currently rendered" is the whole compliance story: YouTube paints four or
 * five entries and lazily adds more as the user scrolls the column. We follow
 * their scrolling; we do not do it for them, and we never request the
 * continuation that would fetch the next twenty.
 */
export function collectWatchRelatedEntries(
  root: ParentNode = document
): WatchRelatedEntry[] {
  const rail = watchRelatedRoot(root)
  const seen = new Set<string>()
  const entries: WatchRelatedEntry[] = []

  for (const selector of RAIL_ITEM_SELECTORS) {
    for (const element of Array.from(
      rail.querySelectorAll<HTMLElement>(selector)
    )) {
      // A lockup nested inside another container is read once, on the innermost
      // element that knows what it is.
      if (element.querySelector(RAIL_ITEM_SELECTORS.join(", "))) continue
      const entry = readWatchRelatedEntry(element)
      if (!entry) continue
      if (seen.has(entry.videoId)) continue
      seen.add(entry.videoId)
      entries.push(entry)
    }
  }
  return entries
}

/**
 * The channel whose video the user is WATCHING — the seed the rail hangs off.
 *
 * Wanted for two jobs: it is the `externalId` the seed-signature lookup asks
 * about, and it is the one channel that must never appear as a candidate (the
 * rail lists the seed's own other videos, and re-capturing the seed teaches the
 * discovery queue nothing).
 */
export function readWatchSeedIdentity(root: ParentNode = document): {
  externalId: string
  handle?: string
  name?: string
} | null {
  const owner = root.querySelector("ytd-video-owner-renderer")
  const scopes: ParentNode[] = owner ? [owner, root] : [root]

  for (const scope of scopes) {
    for (const anchor of Array.from(
      scope.querySelectorAll<HTMLAnchorElement>("a[href]")
    )) {
      const ref = channelRefFromHref(anchor.getAttribute("href"))
      if (!ref) continue
      const name =
        tidy(
          firstBySelectors(root, [
            "ytd-video-owner-renderer #channel-name #text",
            "ytd-video-owner-renderer ytd-channel-name #text",
            "ytd-video-owner-renderer #channel-name"
          ])?.textContent
        ) ??
        tidy(
          root.querySelector('link[itemprop="name"]')?.getAttribute("content")
        )
      return {
        externalId: ref.externalId,
        handle: ref.handle,
        name
      }
    }
  }

  /*
    Microformat fallback. `<span itemprop="author"><link itemprop="url" …>` is
    the one place the owner's URL survives a layout the rest of this function
    does not recognise, and it is present on every watch page.
  */
  const microUrl = root
    .querySelector('span[itemprop="author"] link[itemprop="url"]')
    ?.getAttribute("href")
  const ref = channelRefFromHref(microUrl)
  if (!ref) return null
  return {
    externalId: ref.externalId,
    handle: ref.handle,
    name: tidy(
      root
        .querySelector('span[itemprop="author"] link[itemprop="name"]')
        ?.getAttribute("content")
    )
  }
}

/**
 * How many creators the rail is offering, WITHOUT resolving anybody's
 * identity.
 *
 * Only ever a label on a button. Names collapse to a count here because the
 * count is the fact that makes the button worth pressing, and resolving
 * identities costs a 700KB JSON parse that a page nobody has clicked on has
 * not earned. A display name never becomes a key on the wire — that is
 * `watchRelatedCandidates`, and it refuses.
 *
 * The seed is excluded by NAME for the same reason the panel excludes it by
 * id: half a rail is the seed's own back catalogue, and a button that counts
 * those promises rows the panel then does not show.
 */
export function railChannelCount(
  entries: readonly WatchRelatedEntry[],
  seedName?: string
): number {
  const seed = seedName?.trim().toLowerCase()
  const names = new Set<string>()
  let unnamed = 0
  for (const entry of entries) {
    if (!entry.channelName) {
      unnamed += 1
      continue
    }
    const name = entry.channelName.toLowerCase()
    if (seed && name === seed) continue
    names.add(name)
  }
  return names.size + unnamed
}

/**
 * Rail entries → capture candidates, ONE PER CHANNEL.
 *
 * A channel with three videos in the rail is one creator who keeps coming up,
 * not three rows of the day's allowance — the same merge the search collector
 * does, for the same reason. The videos accumulate onto the candidate as
 * evidence, capped by the shared five.
 *
 * Two rules that are decisions rather than details:
 *
 *   · An entry the identity join could not resolve is DROPPED, because there is
 *     no honest `externalId` to send for it. The panel counts them so the user
 *     is not left wondering where a row went.
 *   · The seed's own channel is dropped. The rail is full of the seed's back
 *     catalogue and the war room already has them.
 */
export function watchRelatedCandidates(
  entries: readonly WatchRelatedEntry[],
  options: { seedExternalId?: string; seedHandle?: string } = {}
): { candidates: SearchCreatorCandidate[]; unidentified: number } {
  const seedKeys = new Set(
    [options.seedExternalId, options.seedHandle]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase())
  )

  const byKey = new Map<string, SearchCreatorCandidate>()
  let unidentified = 0

  for (const entry of entries) {
    const externalId = entry.channelExternalId
    if (!externalId) {
      unidentified += 1
      continue
    }
    const key = (entry.channelHandle ?? externalId).toLowerCase()
    if (seedKeys.has(key) || seedKeys.has(externalId.toLowerCase())) continue

    const video: SearchVideoEvidence = { contentId: entry.videoId }
    video.url = entry.url
    if (entry.title) video.title = entry.title
    if (entry.viewCountText) video.viewsText = entry.viewCountText
    if (entry.durationText) video.durationText = entry.durationText
    if (entry.publishedText) video.publishedText = entry.publishedText
    if (entry.isShort) video.isShort = true

    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, {
        key,
        externalId,
        handle: entry.channelHandle,
        displayName: entry.channelName,
        url: entry.channelHandle
          ? `https://www.youtube.com/${entry.channelHandle}`
          : `https://www.youtube.com/channel/${externalId}`,
        // A rail row is a video's byline, exactly like a search page's video
        // result — the card is about the video, not about its author.
        source: "video_attribution",
        videos: [video]
      })
      continue
    }

    const videos = [...(existing.videos ?? [])]
    if (!videos.some((seen) => seen.contentId === video.contentId)) {
      videos.push(video)
    }
    byKey.set(key, {
      ...existing,
      displayName: existing.displayName ?? entry.channelName,
      // Same cap as the search collector's, and the same reason: five videos
      // are evidence that a channel keeps coming up, twenty are a page dump.
      videos: videos.slice(0, MAX_VIDEOS_PER_CREATOR)
    })
  }

  return { candidates: [...byKey.values()], unidentified }
}
