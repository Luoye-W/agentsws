/** 移植自 agentsws-extension `src/contents/utils/youtubeInitialData.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/youtubeInitialData.ts` @ d25b877。 */
/**
 * WHO a rail entry belongs to, read out of the page's own inline data (0.9.18).
 *
 * ─── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * The rendered similar column carries no channel link (verified live,
 * 2026-08-13: two anchors per entry, both the video). The byline is a text run.
 * So the DOM can tell us that a video called X with 9.4M views is in the rail,
 * and it cannot tell us whose channel it is.
 *
 * YouTube ships that fact anyway, in an inline `<script>` the server rendered
 * with the page: `var ytInitialData = {…}`. Reading it is still reading THIS
 * document — no request is made, no page is opened, no continuation is
 * followed — and it is the only reading that produces a real identity. The
 * alternative was to send a display name where an `externalId` belongs, which
 * would mint a third key form into a shared library whose handle-keyed and
 * UC-keyed rows already never merge. A wrong identity is worse than none.
 *
 * ─── WHY IT IS ALSO NOT ALWAYS AVAILABLE ────────────────────────────────────
 *
 * The inline script is written ONCE, at document load, and YouTube does not
 * rewrite it on SPA navigation — verified by clicking a rail entry and watching
 * `currentVideoEndpoint.watchEndpoint.videoId` stay on the previous video. So
 * this data is trusted only while it describes the video in the address bar,
 * exactly the freshness rule `readYouTubeWatchSnapshot` already applies to the
 * `<meta itemprop>` block. Stale means unavailable, and the panel says so and
 * offers a reload rather than guessing.
 *
 * Everything here is pure: the caller hands over the script text, which keeps
 * the parsing testable without a browser and keeps the (large) DOM read and the
 * (large) JSON parse in one place the caller can cache.
 */

/** What one rail video's identity looks like once found. */
export type RailChannelIdentity = {
  /** UC id when the payload named one, otherwise the @handle. */
  externalId: string
  handle?: string
}

export type WatchInitialData = {
  /** True only when the payload describes the video currently in the URL. */
  fresh: boolean
  /** videoId → channel identity, for every entry the payload described. */
  byVideoId: Map<string, RailChannelIdentity>
}

export const EMPTY_WATCH_INITIAL_DATA: WatchInitialData = {
  fresh: false,
  byVideoId: new Map()
}

/**
 * The inline script's text, straight off the document.
 *
 * Matched on the assignment rather than on a script id, because the id and the
 * position in `<head>` have both moved more than once and the assignment has
 * not. A 700KB string is returned rather than parsed here so the caller decides
 * when to pay for the parse (once per video, on a deliberate click — never on
 * the 1.5s rescan poll).
 */
export function readInitialDataScript(
  root: ParentNode = document
): string | null {
  for (const script of Array.from(
    root.querySelectorAll<HTMLScriptElement>("script")
  )) {
    const text = script.textContent
    if (!text || !text.includes("ytInitialData")) continue
    if (text.length < 100) continue
    return text
  }
  return null
}

/**
 * `var ytInitialData = {…};` → the object, or null.
 *
 * Brace-counted rather than regex-trimmed, and string-aware, because the JSON
 * is full of braces inside titles and descriptions (`{` in a video title is not
 * rare) and a lastIndexOf-based cut breaks on the first script that has a
 * trailing statement after the assignment.
 */
export function parseInitialDataObject(
  scriptText: string
): Record<string, unknown> | null {
  const marker = scriptText.indexOf("ytInitialData")
  if (marker < 0) return null
  const start = scriptText.indexOf("{", marker)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < scriptText.length; index += 1) {
    const char = scriptText[index]

    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(scriptText.slice(start, index + 1)) as Record<
            string,
            unknown
          >
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** The video the payload is ABOUT — the freshness check's other half. */
function payloadVideoId(payload: Record<string, unknown>): string | undefined {
  const endpoint = (payload as any)?.currentVideoEndpoint?.watchEndpoint
    ?.videoId
  return typeof endpoint === "string" ? endpoint : undefined
}

/** How deep the walk is allowed to go before it gives up on a branch. */
const MAX_WALK_DEPTH = 18

/**
 * The first channel endpoint under a node.
 *
 * A generic walk rather than the exact path
 * (`metadata.lockupMetadataViewModel.image.decoratedAvatarViewModel
 * .rendererContext.commandContext.onTap.innertubeCommand.browseEndpoint`)
 * on purpose: that path is six renames from being wrong, and every one of those
 * renames would silently turn every row unidentified. What is stable is the
 * SHAPE — a `browseEndpoint` carrying a `UC…` browseId — so that is what is
 * looked for.
 */
function findChannelIdentity(
  node: unknown,
  depth = 0
): RailChannelIdentity | null {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== "object") {
    return null
  }

  const record = node as Record<string, unknown>
  const endpoint = record.browseEndpoint as
    | { browseId?: unknown; canonicalBaseUrl?: unknown }
    | undefined
  if (endpoint && typeof endpoint.browseId === "string") {
    const browseId = endpoint.browseId
    if (/^UC[0-9A-Za-z_-]{10,}$/.test(browseId)) {
      const base =
        typeof endpoint.canonicalBaseUrl === "string"
          ? endpoint.canonicalBaseUrl
          : undefined
      const handle = base?.startsWith("/@") ? base.slice(1) : undefined
      return handle
        ? { externalId: browseId, handle }
        : { externalId: browseId }
    }
  }

  for (const value of Object.values(record)) {
    if (value === null || typeof value !== "object") continue
    const found = findChannelIdentity(value, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Every `{contentId → channel}` pair the payload describes.
 *
 * Both renderer families are matched by the field that identifies them — a
 * `lockupViewModel` with a `contentId`, or a `compactVideoRenderer` with a
 * `videoId` — so a page served either layout resolves the same way.
 */
function collectIdentities(
  node: unknown,
  into: Map<string, RailChannelIdentity>,
  depth = 0
) {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== "object")
    return

  if (Array.isArray(node)) {
    for (const item of node) collectIdentities(item, into, depth + 1)
    return
  }

  const record = node as Record<string, unknown>

  for (const key of ["lockupViewModel", "compactVideoRenderer"]) {
    const renderer = record[key] as Record<string, unknown> | undefined
    if (!renderer) continue
    const videoId =
      (typeof renderer.contentId === "string" && renderer.contentId) ||
      (typeof renderer.videoId === "string" && renderer.videoId) ||
      null
    if (!videoId || into.has(videoId)) continue
    const identity = findChannelIdentity(renderer)
    if (identity) into.set(videoId, identity)
  }

  for (const value of Object.values(record)) {
    if (value === null || typeof value !== "object") continue
    collectIdentities(value, into, depth + 1)
  }
}

/**
 * Script text + the video in the address bar → the identity map.
 *
 * `fresh: false` is not an error state, it is the ordinary consequence of the
 * user having clicked through to a second video without the page reloading. The
 * map is returned empty in that case rather than stale, because a stale map
 * would attach the PREVIOUS rail's channels to this rail's videos — rows that
 * are wrong rather than missing.
 */
export function readWatchInitialData(
  scriptText: string | null,
  currentVideoId: string | null
): WatchInitialData {
  if (!scriptText || !currentVideoId) return EMPTY_WATCH_INITIAL_DATA
  const payload = parseInitialDataObject(scriptText)
  if (!payload) return EMPTY_WATCH_INITIAL_DATA
  if (payloadVideoId(payload) !== currentVideoId)
    return EMPTY_WATCH_INITIAL_DATA

  const byVideoId = new Map<string, RailChannelIdentity>()
  /*
    The rail's own subtree first, the whole payload only if that yields
    nothing. Not just for speed on a 700KB object: scoping means a lockup from
    some other shelf on the page cannot contribute an identity for a video the
    rail never showed, and the fallback means a layout change that moves the
    rail does not take the whole feature down with it.
  */
  const secondary = (payload as any)?.contents?.twoColumnWatchNextResults
    ?.secondaryResults
  if (secondary) collectIdentities(secondary, byVideoId)
  if (byVideoId.size === 0) collectIdentities(payload, byVideoId)
  return { fresh: true, byVideoId }
}
