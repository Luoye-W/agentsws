/** 移植自 agentsws-extension `src/lib/kol/utils/youtubeSearch.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/youtubeSearch.ts` @ d25b877（原移植基准 f0de89a；与 d25b877 相比只差 import 路径与下面写明的本仓改动）；WP130 补搬旧仓提交 6259a1c：`SearchVideoEvidence.contentType`。 */
/**
 * Reading creators off a YouTube search-results page (P4).
 *
 * The whole point of this file is the discipline in what it will NOT do. A
 * search page is the one surface where a scraper is tempted to become a
 * crawler: the next page is one request away, the channel's subscriber count is
 * one API call away, and scrolling could be automated. None of that happens
 * here. We read the DOM the user has already caused to render, in the browser
 * they are already sitting in front of, and nothing else — no fetch, no
 * scrollTo, no continuation token. If a figure is not on screen it is absent
 * from the payload rather than looked up.
 *
 * Two shapes of result carry a creator, and they carry different amounts:
 *
 *   CHANNEL RESULT — the channel's own card. Name, link, avatar, and usually a
 *   subscriber line and a video count.
 *
 *   VIDEO ATTRIBUTION — the byline under a video. A name and a link, and that
 *   is genuinely all: the card is about the video, not about its author.
 *
 * Both are worth capturing (a creator who ranks for the query is a creator who
 * ranks for the query, whichever card they appear on) and they must not be
 * confused, which is why `source` rides along and why the avatar rule below is
 * as narrow as it is.
 *
 * Every function takes an optional `root` so the selectors can be exercised
 * against fixture DOM — see the tests. `textContent` throughout, never
 * `innerText`: the latter needs layout, which fixtures do not have.
 */

/** Channel ids and handles as they appear in an href. */
const CHANNEL_ID_PATTERN = /^\/channel\/(UC[0-9A-Za-z_-]{10,})/
const HANDLE_PATTERN = /^\/(@[^/?#]+)/

/** A Short's id lives in the path; a long video's lives in `v=`. */
const SHORTS_ID_PATTERN = /^\/shorts\/([0-9A-Za-z_-]{5,})/

/**
 * Subscriber and video-count lines, matched by CONTENT rather than by id.
 *
 * YouTube's own markup cannot be trusted to label these: on the current search
 * page `#subscribers` holds the @handle and `#video-count` holds the
 * subscriber line. Matching the text is the only reading that survives that.
 */
const SUBSCRIBER_PATTERN =
  /[\d,.]+\s*[KMB]?\s*(?:subscribers?)|[\d,.]+\s*[万亿億]?\s*位?(?:订阅者|訂閱者|订阅)/i
const VIDEO_COUNT_PATTERN =
  /[\d,.]+\s*[KMB万亿億]?\s*(?:videos?|个视频|部影片|部片)/i

/**
 * A view count as the page prints it. Deliberately close to, and deliberately
 * NOT the same as, VIDEO_COUNT_PATTERN: "683 videos" is how many a channel has
 * ever posted, "1.2M views" is how one of them did, and a filter that mixes
 * them up hides creators for the wrong reason.
 */
const VIEWS_PATTERN =
  /[\d,.]+\s*[KMB万亿億]?\s*(?:views?|次观看|次觀看|次播放|回視聴)/i

/** `12:34` / `1:02:03`. A livestream's "LIVE" badge deliberately does not match. */
const DURATION_PATTERN = /^\d{1,3}:\d{2}(?::\d{2})?$/

/** The word a Shorts badge uses, in the languages the badge is rendered in. */
const SHORTS_BADGE_PATTERN = /^(?:shorts|短视频|短影片|ショート)$/i

/** Long text is a description that happens to contain the word "subscribers". */
const METADATA_TEXT_LIMIT = 48

export type SearchCreatorSource = "channel_result" | "video_attribution"

/**
 * One video seen on the page, filed under the creator whose byline it carries.
 *
 * A search page is mostly VIDEO results, and several of them routinely belong
 * to one creator — which is exactly the fact 0.9.16 threw away when it merged
 * those rows into a single candidate. The merge was right; discarding the
 * evidence was not. Five videos with their view counts is the difference
 * between "this channel ranks for the query" and "this channel ranks for the
 * query with 1.2M, 890K and 400K views on the three videos that did it".
 *
 * Every field but the id is optional because every field but the id is
 * optional ON THE PAGE, and all of them are stored AS RENDERED — the same rule
 * `subscriberCountText` follows, for the same reason: the user's YouTube is in
 * whichever locale they set, and a number this file parses wrong is a number
 * the shared library then repeats to everybody.
 */
export type SearchVideoEvidence = {
  /** `v=` on a watch URL, the path segment on `/shorts/<id>`. */
  contentId: string
  url?: string
  title?: string
  viewsText?: string
  durationText?: string
  isShort?: boolean
  /** Social list cards can be a TikTok photo or an Instagram post/reel. */
  contentType?: "post" | "reel"
  /**
   * "8y ago" / 「3个月前」, as a watch page's similar column renders it
   * (0.9.18). PANEL-ONLY: the wire has no field for it, and inventing one to
   * carry a string nobody parses would be padding every row of every batch.
   * It is here because a rail entry's age is half of how a human judges
   * whether a channel is still active before ticking it.
   */
  publishedText?: string
}

/**
 * Videos attached to one creator, at most.
 *
 * Evidence, not a catalogue. Five is enough to show what a channel ranks with
 * and to average a view count off; past that it is a page dump riding on every
 * row of a hundred-creator capture.
 */
export const MAX_VIDEOS_PER_CREATOR = 5

export type SearchCreatorCandidate = {
  /**
   * Dedupe key within one page: the UC id when the page gave one, else the
   * lowercased handle. NOT sent to the server — `externalId` is.
   */
  key: string
  externalId: string
  handle?: string
  displayName?: string
  url?: string
  avatarUrl?: string
  /** As rendered ("3.5M subscribers"). Parsing is the server's business. */
  subscriberCountText?: string
  videoCountText?: string
  source: SearchCreatorSource
  /** Up to five of this creator's videos, as seen on this page. */
  videos?: SearchVideoEvidence[]
  /**
   * 0–100 from the watch-page pre-screen (0.9.18), or absent.
   *
   * Absent is the normal state: a search page has nothing to score against.
   * It lives on the shared candidate type rather than on a rail-specific one
   * because the panel, the filters and the upload all treat a rail row and a
   * search row as the same kind of thing — a creator we saw on a list page.
   */
  relevanceScore?: number
}

/**
 * The query this page is showing, or null when it is not a search page.
 *
 * `search_query` rather than `q`: YouTube accepts both on the way in and
 * normalises to `search_query`, and taking whichever is present would mean the
 * discovery queue records two different source strings for one search.
 */
export function youTubeSearchQuery(href: string): string | null {
  try {
    const url = new URL(href)
    if (!url.hostname.endsWith("youtube.com")) return null
    if (url.pathname !== "/results") return null
    const query = url.searchParams.get("search_query")?.trim()
    return query ? query : null
  } catch {
    return null
  }
}

export function isYouTubeSearchPage(href: string): boolean {
  return youTubeSearchQuery(href) !== null
}

type ChannelRef = { externalId: string; handle?: string; url: string }

/**
 * A channel identity out of one href, or null for the many hrefs on a search
 * page that point at something else (a video, a playlist, a filter chip).
 *
 * Relative and absolute forms both occur — the DOM has `/@handle`, a fixture
 * or a lockup may carry the full URL — and `getAttribute("href")` is what the
 * caller reads, so this cannot rely on the browser having resolved anything.
 */
export function channelRefFromHref(raw?: string | null): ChannelRef | null {
  if (!raw) return null

  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (!url.hostname.endsWith("youtube.com")) return null
      path = url.pathname
    } catch {
      return null
    }
  }
  if (!path.startsWith("/")) return null

  const channelId = path.match(CHANNEL_ID_PATTERN)?.[1]
  if (channelId) {
    return {
      externalId: channelId,
      url: `https://www.youtube.com/channel/${channelId}`
    }
  }

  const handle = path.match(HANDLE_PATTERN)?.[1]
  if (handle) {
    return {
      externalId: handle,
      handle,
      url: `https://www.youtube.com/${handle}`
    }
  }

  return null
}

type VideoRef = { contentId: string; url: string; isShort: boolean }

/**
 * A video identity out of one href, or null for every other link on the page.
 *
 * The id is read from the URL and never from an element id, a thumbnail
 * filename or a data attribute: `v=` and `/shorts/<id>` are the two forms
 * YouTube itself navigates by, so they are the two that stay true when the
 * markup around them is rewritten (which it is, constantly).
 *
 * `/shorts/` is the strongest signal there is that a video is a Short —
 * stronger than any badge, because the badge is a rendering choice and the URL
 * is the route. The badge is checked too, for the layouts that put a Short
 * behind an ordinary watch link.
 */
export function videoRefFromHref(raw?: string | null): VideoRef | null {
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

  const shortId = path.match(SHORTS_ID_PATTERN)?.[1]
  if (shortId) {
    return {
      contentId: shortId,
      url: `https://www.youtube.com/shorts/${shortId}`,
      isShort: true
    }
  }

  if (path === "/watch") {
    const id = new URLSearchParams(search).get("v")?.trim()
    if (id) {
      return {
        contentId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        isShort: false
      }
    }
  }

  return null
}

function tidy(value?: string | null) {
  const text = value?.replace(/\s+/g, " ").trim()
  return text ? text : undefined
}

/** Every result container a search page can put a creator inside. */
const RESULT_SELECTOR = [
  "ytd-channel-renderer",
  "ytd-grid-channel-renderer",
  "ytd-video-renderer",
  "ytd-rich-item-renderer",
  "yt-lockup-view-model"
].join(", ")

const CHANNEL_ANCHOR_SELECTOR = [
  'a[href^="/@"]',
  'a[href^="/channel/"]',
  'a[href*="youtube.com/@"]',
  'a[href*="youtube.com/channel/"]'
].join(", ")

/**
 * Where a creator's NAME lives, in order of preference — and tried ONE AT A
 * TIME rather than as one comma-separated selector.
 *
 * That distinction is not stylistic. A selector list returns whichever match
 * comes first in DOCUMENT ORDER, not the one written first, so the container
 * (`#channel-title`) beat the element inside it (`#channel-title #text`) and
 * the name came back as "Marques Brownlee Marques Brownlee" — the visible copy
 * plus the tooltip copy, concatenated by textContent. Verified against the live
 * search page on 2026-08-06; the same trap as `headerChannelName()` in
 * youtubeChannel.ts, which is why that one iterates too.
 */
const CHANNEL_TITLE_SELECTORS = [
  "#channel-title #text",
  "ytd-channel-name #text",
  "#channel-name #text",
  "#text-container yt-formatted-string",
  "#channel-title"
] as const

/**
 * Is this card ABOUT a channel, or about a video that happens to have one?
 *
 * A channel card has no /watch link in it; a video result's whole reason for
 * existing is that link. Tag names answer first because they are unambiguous
 * where they exist, and the link test covers the lockup layout, where every
 * result is the same element with a different attribute.
 */
function isChannelResult(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === "ytd-channel-renderer" || tag === "ytd-grid-channel-renderer") {
    return true
  }
  return !element.querySelector('a[href*="/watch"], a[href*="/shorts/"]')
}

/**
 * Short metadata strings inside one result, for the count patterns to sift.
 *
 * Only elements small enough to BE a metadata line: a channel description
 * mentioning "500K subscribers" is prose about somebody else's channel, and
 * filing it as this creator's follower count would be a fabricated metric.
 */
function metadataTexts(element: Element): string[] {
  const nodes = Array.from(
    element.querySelectorAll<HTMLElement>(
      // `.badge-shape-wiz__text` is the newer layout's duration/Shorts badge,
      // and it is a div — every other line here happens to be a span, which is
      // why a span-only scan silently had no durations in it.
      "span, yt-formatted-string, #subscribers, #video-count, #metadata-line, .badge-shape-wiz__text"
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

/**
 * The SHORTEST metadata line that matches, not the first.
 *
 * The same trap as the duplicated channel name, one level along: a container
 * matches a selector as well as its children do, and `textContent` on the
 * container is every child's text run together. `#metadata-line` is exactly
 * that — it yields "1.2M views3 years ago", which is document-order FIRST, so
 * `find()` filed a view count with an upload age glued to the end of it.
 *
 * Shortest rather than leaves-only on purpose: a layout that splits a count
 * across nested spans ("<span>3.5M</span> subscribers") still has to match on
 * the parent, and discarding parents that contain matching children would
 * throw that whole family of markup away to fix this one.
 */
function shortestMatch(texts: string[], pattern: RegExp): string | undefined {
  let best: string | undefined
  for (const text of texts) {
    if (!pattern.test(text)) continue
    if (!best || text.length < best.length) best = text
  }
  return best
}

/**
 * The creator's avatar, and only when we can prove it is theirs.
 *
 * On a video result the biggest, first and most obvious `img` is the VIDEO
 * THUMBNAIL. Filing that as the creator's avatar would put a still frame in
 * every avatar slot in the pool, and it would look plausible enough that
 * nobody would report it. So the image has to be inside the channel's own
 * anchor or in a container that names itself as a channel avatar — anything
 * else yields nothing, which the server treats as "not observed".
 */
function readAvatar(
  element: Element,
  anchor: Element | null,
  channelResult: boolean
): string | undefined {
  const scopes: (Element | null)[] = [
    anchor,
    element.querySelector("#channel-thumbnail"),
    element.querySelector("yt-decorated-avatar-view-model"),
    element.querySelector("#avatar"),
    channelResult ? element.querySelector("yt-img-shadow") : null,
    // A channel card is entirely about one creator, so its first image is
    // theirs by construction. A video card's is not, which is the whole point.
    channelResult ? element : null
  ]

  for (const scope of scopes) {
    if (!scope) continue
    const src = scope
      .querySelector<HTMLImageElement>("img")
      ?.getAttribute("src")
    if (src?.startsWith("http")) return src
  }
  return undefined
}

function readDisplayName(
  element: Element,
  anchor: Element | null,
  channelResult: boolean
): string | undefined {
  for (const selector of CHANNEL_TITLE_SELECTORS) {
    const titled = tidy(
      element.querySelector<HTMLElement>(selector)?.textContent
    )
    if (titled) return titled
  }

  /*
    The anchor's own text is the name on a video byline ("Fireship") and the
    ENTIRE CARD on a channel result, whose main link wraps the avatar, the
    handle, the subscriber line and the description. Taking it there would file
    a paragraph as somebody's name.
  */
  if (!channelResult) {
    const anchorText = tidy(anchor?.textContent)
    if (anchorText && anchorText.length <= METADATA_TEXT_LIMIT)
      return anchorText
  }

  return (
    tidy(anchor?.getAttribute("title")) ??
    tidy(element.querySelector("img")?.getAttribute("alt"))
  )
}

/**
 * Where a video's TITLE lives, tried one at a time for the same reason the
 * channel-title list is (a selector list returns document order, not written
 * order, and the container usually comes first).
 */
const VIDEO_TITLE_SELECTORS = [
  "#video-title",
  "#video-title-link",
  "a.yt-lockup-metadata-view-model-wiz__title",
  ".yt-lockup-metadata-view-model-wiz__title",
  "h3 a",
  "h3"
] as const

function readVideoTitle(element: Element): string | undefined {
  for (const selector of VIDEO_TITLE_SELECTORS) {
    const node = element.querySelector<HTMLElement>(selector)
    if (!node) continue
    // The attribute is the untruncated string where both exist; YouTube
    // ellipsises the visible copy of a long title and not the tooltip.
    const title = tidy(node.getAttribute("title")) ?? tidy(node.textContent)
    if (title) return title
  }
  return undefined
}

/** Tags whose whole existence is a Short, whatever their link happens to be. */
const SHORTS_CONTAINER_SELECTOR = [
  "ytm-shorts-lockup-view-model",
  "ytd-reel-item-renderer"
].join(", ")

function looksLikeShort(element: Element, texts: string[]): boolean {
  const tag = element.tagName.toLowerCase()
  if (
    tag === "ytm-shorts-lockup-view-model" ||
    tag === "ytd-reel-item-renderer"
  ) {
    return true
  }
  if (element.querySelector(SHORTS_CONTAINER_SELECTOR)) return true
  return texts.some((text) => SHORTS_BADGE_PATTERN.test(text))
}

/**
 * The video this result is about, if it is about one.
 *
 * One result element carries at most one video — a search page renders one per
 * row — so the "several videos, one creator" case is handled by the merge in
 * `dedupeSearchCreators`, not here.
 *
 * `texts` is passed in rather than re-scanned: the same short-strings sweep
 * that finds a subscriber line finds the view count and the duration badge,
 * and walking the subtree twice for one row of a fifty-row page is waste the
 * poll pays every 1.5 seconds.
 */
function readVideoEvidence(
  element: Element,
  texts: string[]
): SearchVideoEvidence | undefined {
  let ref: VideoRef | null = null
  for (const anchor of Array.from(
    element.querySelectorAll<HTMLAnchorElement>("a[href]")
  )) {
    ref = videoRefFromHref(anchor.getAttribute("href"))
    if (ref) break
  }
  if (!ref) return undefined

  const evidence: SearchVideoEvidence = { contentId: ref.contentId }
  evidence.url = ref.url
  const title = readVideoTitle(element)
  if (title) evidence.title = title
  const views = shortestMatch(texts, VIEWS_PATTERN)
  if (views) evidence.viewsText = views
  const duration = shortestMatch(texts, DURATION_PATTERN)
  if (duration) evidence.durationText = duration
  if (ref.isShort || looksLikeShort(element, texts)) evidence.isShort = true
  return evidence
}

/** One result element → the creator it names, or null when it names none. */
export function readSearchResultCreator(
  element: Element
): SearchCreatorCandidate | null {
  const anchors = Array.from(
    element.querySelectorAll<HTMLAnchorElement>(CHANNEL_ANCHOR_SELECTOR)
  )

  let anchor: HTMLAnchorElement | null = null
  let ref: ChannelRef | null = null
  for (const candidate of anchors) {
    const parsed = channelRefFromHref(candidate.getAttribute("href"))
    if (parsed) {
      anchor = candidate
      ref = parsed
      break
    }
  }
  if (!ref) return null

  const channelResult = isChannelResult(element)
  const texts = metadataTexts(element)
  const video = channelResult ? undefined : readVideoEvidence(element, texts)

  return {
    key: ref.handle ? ref.handle.toLowerCase() : ref.externalId,
    externalId: ref.externalId,
    handle: ref.handle,
    displayName: readDisplayName(element, anchor, channelResult),
    url: ref.url,
    avatarUrl: readAvatar(element, anchor, channelResult),
    subscriberCountText: shortestMatch(texts, SUBSCRIBER_PATTERN),
    videoCountText: shortestMatch(texts, VIDEO_COUNT_PATTERN),
    source: channelResult ? "channel_result" : "video_attribution",
    videos: video ? [video] : undefined
  }
}

/**
 * Two lists of videos for one creator → one, oldest-first, capped.
 *
 * Deduped by `contentId` because the same video can be on the page twice (a
 * result and a "people also watched" rail), and because a repeated id would
 * make one video look like two pieces of evidence. First five in DOM order:
 * those are the ones that ranked, and rank is the whole reason this page is
 * interesting.
 */
function mergeVideoEvidence(
  first?: SearchVideoEvidence[],
  second?: SearchVideoEvidence[]
): SearchVideoEvidence[] | undefined {
  if (!first?.length) return second?.length ? second : undefined
  if (!second?.length) return first

  const byId = new Map<string, SearchVideoEvidence>()
  for (const video of [...first, ...second]) {
    const existing = byId.get(video.contentId)
    byId.set(video.contentId, existing ? { ...existing, ...video } : video)
  }
  return [...byId.values()].slice(0, MAX_VIDEOS_PER_CREATOR)
}

/**
 * Collapse the same creator appearing many times on one page.
 *
 * A channel that ranks well is on the page once as a card and five more times
 * as the byline of its own videos. Uploading six rows for it would spend six
 * of the day's allowance on one creator and teach the discovery queue that it
 * was found six times.
 *
 * Merging rather than first-wins: the byline may come first in DOM order while
 * the card is the one carrying the avatar and the subscriber line, so each
 * field is filled by whoever has it. A channel card wins the `source` tag,
 * because that is a claim about what we saw and the card is the stronger one.
 *
 * Not merged: the same creator seen once as `UC…` and once as `@handle`. They
 * are two identities as far as this page is concerned, and inventing the link
 * between them without asking the server would be guessing.
 */
export function dedupeSearchCreators(
  candidates: readonly SearchCreatorCandidate[]
): SearchCreatorCandidate[] {
  const byKey = new Map<string, SearchCreatorCandidate>()

  for (const candidate of candidates) {
    const existing = byKey.get(candidate.key)
    if (!existing) {
      byKey.set(candidate.key, { ...candidate })
      continue
    }
    byKey.set(candidate.key, {
      ...existing,
      displayName: existing.displayName ?? candidate.displayName,
      url: existing.url ?? candidate.url,
      avatarUrl: existing.avatarUrl ?? candidate.avatarUrl,
      subscriberCountText:
        existing.subscriberCountText ?? candidate.subscriberCountText,
      videoCountText: existing.videoCountText ?? candidate.videoCountText,
      // The one field that ACCUMULATES rather than being filled once: six
      // results for one creator are six pieces of evidence about them, and
      // first-wins here would keep one video and throw the other five away.
      videos: mergeVideoEvidence(existing.videos, candidate.videos),
      source:
        existing.source === "channel_result" ||
        candidate.source === "channel_result"
          ? "channel_result"
          : existing.source
    })
  }

  return [...byKey.values()]
}

/**
 * Every creator currently rendered on a search-results page, deduped.
 *
 * "Currently rendered" is load-bearing: the count changes as the user scrolls
 * and more results paint, and that is the only way it ever changes. We do not
 * scroll for them.
 */
export function collectYouTubeSearchCreators(
  root: ParentNode = document
): SearchCreatorCandidate[] {
  const found: SearchCreatorCandidate[] = []
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>(RESULT_SELECTOR)
  )) {
    /*
      A lockup can be nested inside a rich item; reading both would count the
      creator twice. Dedupe would collapse it anyway, but skipping the outer
      wrapper keeps the `source` decision on the element that actually knows.
    */
    if (element.querySelector(RESULT_SELECTOR)) continue
    const candidate = readSearchResultCreator(element)
    if (candidate) found.push(candidate)
  }
  return dedupeSearchCreators(found)
}
