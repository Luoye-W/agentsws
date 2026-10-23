/** 移植自 agentsws-extension `src/contents/utils/listCaptureTarget.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/listCaptureTarget.ts` @ d25b877（原移植基准 1f824f1；与 d25b877 相比只差 import 路径与下面写明的本仓改动）；WP130 再补搬同文件后来的改动（旧仓提交 6259a1c：TikTok 搜索 / tag、Instagram tag 三种列表页）。只改 import 路径。 */
/**
 * Which list this page is, and whether the FAB should open itself (0.9.18).
 *
 * Two decisions, both pure functions of the URL and a couple of numbers the
 * browser hands over, so they can be argued about in tests instead of being
 * discovered on a live YouTube page.
 */
import { youTubeSearchQuery } from "../kol/utils/youtubeSearch.js"
import { youTubeWatchId } from "./youtubeWatchRelated.js"

/**
 * `pageType` on the bulk payload, and the SaaS enum verbatim.
 *
 * The server defaults to `'search'` for every build that predates this one, so
 * the value only ever needs sending when it is the new one — but it is sent
 * either way, because a payload that says what it is costs nothing and a
 * payload that relies on a default is one refactor from lying.
 */
export type ListCapturePageType = "search" | "watch_related"
export type ListCapturePlatform = "youtube" | "tiktok" | "instagram"

export type ListCaptureTarget = {
  platform: ListCapturePlatform
  pageType: ListCapturePageType
  /**
   * What the batch was read off, as the discovery queue will record it: the
   * QUERY for a search page, the WATCH URL for a rail. A rail has no query —
   * that is precisely why the inbox needs `pageType` to explain the row at all.
   */
  sourceQuery: string
  /** The watch page's own video, when there is one. */
  videoId?: string
}

export function resolveListCaptureTarget(
  href: string
): ListCaptureTarget | null {
  const query = youTubeSearchQuery(href)
  if (query)
    return { platform: "youtube", pageType: "search", sourceQuery: query }

  const videoId = youTubeWatchId(href)
  if (videoId) {
    /*
      The URL, trimmed of everything that is not the video. A watch URL from a
      rail click carries `&list=`, `&index=`, `&pp=` (a base64 tracking blob)
      and often a `&t=` seek offset; storing those would make two captures of
      the same video look like two different sources, and the `pp` blob is
      per-session noise nobody can read back.
    */
    return {
      platform: "youtube",
      pageType: "watch_related",
      sourceQuery: `https://www.youtube.com/watch?v=${videoId}`,
      videoId
    }
  }
  try {
    const url = new URL(href)
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "")
    if (host === "tiktok.com") {
      const search =
        url.pathname === "/search" ? url.searchParams.get("q") : null
      const tag = url.pathname.match(/^\/tag\/([^/]+)\/?$/)?.[1]
      if (search || tag) {
        return {
          platform: "tiktok",
          pageType: "search",
          sourceQuery: search
            ? `https://www.tiktok.com/search?q=${encodeURIComponent(search)}`
            : `https://www.tiktok.com/tag/${tag}`
        }
      }
    }
    if (host === "instagram.com") {
      const tag = url.pathname.match(/^\/explore\/tags\/([^/]+)\/?$/)?.[1]
      if (tag) {
        return {
          platform: "instagram",
          pageType: "search",
          sourceQuery: `https://www.instagram.com/explore/tags/${tag}/`
        }
      }
    }
    // WP130 本仓补（旧插件没有，见文件尾 resolveSearchTabs）。
    const extra = resolveSearchTabs(url, host)
    if (extra) return extra
  } catch {
    return null
  }
  return null
}

/** True on the pages a war-room deep link can land on. */
export function isDeepLinkTargetPage(href: string): boolean {
  return resolveListCaptureTarget(href) !== null
}

/**
 * Should the panel open itself, without being asked?
 *
 * The FAB normally waits to be pressed. The one exception is a page the user
 * reached FROM the war room: they clicked a word, a tab opened, and the whole
 * point of the trip is the capture — making them find a button in the corner
 * first is asking them to re-state an intention they already stated.
 *
 * The judgement is "this tab was opened AT this page", which is what
 * `history.length === 1` means: no back entry, so nothing navigated here from
 * somewhere else inside the tab. Two things it deliberately excludes:
 *
 *   · Clicking through YouTube's own SPA (every hop pushes a history entry) —
 *     that is browsing, and a panel that pops open on every video is an overlay
 *     nobody consented to.
 *   · A RELOAD of a deep-linked page. The user has already seen the panel once;
 *     reopening it on every F5 would make dismissing it impossible.
 *
 * Deliberately NOT done with a marker parameter: a `?kolagents=1` on the deep
 * link would be a tracking token on somebody else's URL, would survive being
 * copied and pasted into a message, and would break the moment YouTube
 * normalised the query string. Deliberately not done with `document.referrer`
 * either — the war room's links are `rel="noreferrer"`, so it is empty.
 */
export function shouldAutoExpand(input: {
  href: string
  historyLength: number
  navigationType?: string
}): boolean {
  if (!isDeepLinkTargetPage(input.href)) return false
  if (input.navigationType === "reload") return false
  if (input.navigationType === "back_forward") return false
  return input.historyLength <= 1
}

/**
 * What the browser knows about how this document was reached.
 *
 * Split out so the predicate above stays pure and this stays the only place
 * that touches globals — and so a fixture-driven test does not need a window.
 */
export function readArrivalSignals(): {
  historyLength: number
  navigationType?: string
} {
  let navigationType: string | undefined
  try {
    const entry = window.performance?.getEntriesByType?.("navigation")?.[0] as
      | PerformanceNavigationTiming
      | undefined
    navigationType = entry?.type
  } catch {
    // Old or restricted browsers: the history length alone still answers.
  }
  return { historyLength: window.history?.length ?? 1, navigationType }
}

/* ── WP130 本仓补的两样（不是移植；旧插件 6259a1c 只认 TikTok /search 与两种 tag 页）──

   1. TikTok 搜索页的「用户」「视频」两个分栏（`/search/user?q=`、`/search/video?q=`）：
      同一次搜索换了个分栏，卡片还是 socialList 认的那几种（`search-user-item` /
      `search-video-item`），不认它们等于用户点一下分栏 FAB 就消失。
   2. Instagram 关键词搜索结果页（`/explore/search/keyword/?q=`）：派工单点名要
      「Instagram 搜索列表」；这一页与 tag 页是同一种帖子网格。 */
function resolveSearchTabs(url: URL, host: string): ListCaptureTarget | null {
  if (host === "tiktok.com") {
    const tab = url.pathname.match(/^\/search\/(user|video)\/?$/)?.[1]
    const q = tab ? url.searchParams.get("q") : null
    if (tab && q) {
      return {
        platform: "tiktok",
        pageType: "search",
        sourceQuery: `https://www.tiktok.com/search/${tab}?q=${encodeURIComponent(q)}`
      }
    }
  }
  if (host === "instagram.com" && /^\/explore\/search\/keyword\/?$/.test(url.pathname)) {
    const q = url.searchParams.get("q")
    if (q) {
      return {
        platform: "instagram",
        pageType: "search",
        sourceQuery: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`
      }
    }
  }
  return null
}

/**
 * 面板上「搜索词：…」那一格给人看的写法（WP130 本仓补）：YouTube 搜索页本来就是
 * 搜索词；TikTok / Instagram 的 sourceQuery 是网址，折成搜索词或 `#话题`。
 */
export function listQueryLabel(sourceQuery: string): string {
  try {
    const url = new URL(sourceQuery)
    const tag =
      url.pathname.match(/^\/tag\/([^/]+)\/?$/)?.[1] ??
      url.pathname.match(/^\/explore\/tags\/([^/]+)\/?$/)?.[1]
    if (tag) return `#${decodeURIComponent(tag)}`
    return url.searchParams.get("q") ?? sourceQuery
  } catch {
    return sourceQuery
  }
}
