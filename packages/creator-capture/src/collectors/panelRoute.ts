/** 移植自 agentsws-extension `src/contents/utils/panelRoute.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/panelRoute.ts` @ d25b877。 */
/**
 * Which card the current URL deserves.
 *
 * Pulled out of the content script so the decision is a pure function of the
 * href: the panel has to re-take it on every SPA navigation (see
 * useUrlChangeListener), and a routing rule that can only be exercised by
 * mounting React into a real YouTube page is a rule nobody ever checks.
 *
 * Content permalinks win over profiles, so one toolbar click captures whatever
 * the user is looking at. That order is load-bearing on TikTok: a video opened
 * from a profile keeps the profile's own path prefix (/@handle/video/123), so
 * asking "is this a profile?" first would answer yes for a page showing a
 * video.
 */
import type { CapturePlatform } from "../kol/utils/creatorSnapshot.js"
import { instagramPostShortcode } from "./instagramPost.js"
import { instagramProfileBasePath } from "./instagramProfile.js"
import { tiktokProfileBasePath } from "./tiktokProfile.js"
import { tiktokVideoId } from "./tiktokVideo.js"
import { youTubeChannelBasePath } from "./youtubeChannel.js"
import { youTubeWatchVideoId } from "./youtubeWatch.js"

export type PanelRoute = {
  kind: "content" | "creator"
  platform: CapturePlatform
  /**
   * What the card is about: a content id for content, the profile base path
   * for a creator. Part of the React key, so the card resets between subjects
   * but survives tab switches within one (/videos, /reels…).
   */
  subject: string
}

export function resolvePanelRoute(href: string): PanelRoute | null {
  const watchId = youTubeWatchVideoId(href)
  if (watchId) {
    return { kind: "content", platform: "youtube", subject: watchId }
  }

  const tiktokContentId = tiktokVideoId(href)
  if (tiktokContentId) {
    return { kind: "content", platform: "tiktok", subject: tiktokContentId }
  }

  const instagramShortcode = instagramPostShortcode(href)
  if (instagramShortcode) {
    return {
      kind: "content",
      platform: "instagram",
      subject: instagramShortcode
    }
  }

  const channelBasePath = youTubeChannelBasePath(href)
  if (channelBasePath) {
    return { kind: "creator", platform: "youtube", subject: channelBasePath }
  }

  const instagramBasePath = instagramProfileBasePath(href)
  if (instagramBasePath) {
    return {
      kind: "creator",
      platform: "instagram",
      subject: instagramBasePath
    }
  }

  const tiktokBasePath = tiktokProfileBasePath(href)
  if (tiktokBasePath) {
    return { kind: "creator", platform: "tiktok", subject: tiktokBasePath }
  }

  return null
}

/** React key for a route — see PanelRoute.subject. */
export function panelRouteKey(route: PanelRoute): string {
  return `${route.platform}-${route.kind}:${route.subject}`
}

/** True for the pages a card can actually capture something from. */
export function isCapturablePage(href: string): boolean {
  return resolvePanelRoute(href) !== null
}
