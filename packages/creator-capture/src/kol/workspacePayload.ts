/** 移植自 agentsws-extension `src/lib/kol/workspacePayload.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/workspacePayload.ts` @ d25b877（原移植基准 c53ee4a；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * CreatorSnapshot → the SaaS tenant-workspace payload (§八 login tier).
 *
 * The extension has always had far more about a creator than it forwarded: the
 * public-library path (`/api/plugin/public/*`) takes a different, narrower
 * shape, and the tenant path (`/api/influencer/extension/*`) had no bridge at
 * all — its client functions existed but nothing called them, so nothing a user
 * captured ever reached their own 红人池.
 *
 * This maps the snapshot onto `creatorCaptureSchema` (SaaS
 * `src/influencer/schemas.ts`), including the avatar, channel banner and the
 * creator's own description, which the SaaS now stores on `im_platform_account`
 * and renders in the creator drawer.
 */

import type { CreatorSnapshot } from "./utils/creatorSnapshot.js"
import type { PageObservation } from "./utils/pageObservation.js"

/**
 * Canonical profile URL per platform. The SaaS falls back to building one from
 * the handle, but sending the real one keeps the "open profile" link exact.
 */
function profileUrl(snap: CreatorSnapshot): string {
  if (snap.pageUrl) return snap.pageUrl
  const handle = snap.handle?.replace(/^@/, "")
  if (!handle) return ""
  if (snap.platform === "youtube") return `https://www.youtube.com/@${handle}`
  if (snap.platform === "tiktok") return `https://www.tiktok.com/@${handle}`
  return `https://www.instagram.com/${handle}`
}

/**
 * Mean views across the visible recent items, which the SaaS stores as
 * `avgViews90d`. Only sent when the scraper actually computed it — a zero here
 * would look like a measured zero and poison the pool's ranking and pricing.
 */
function avgViews(snap: CreatorSnapshot): number | undefined {
  return typeof snap.avgViews === "number" && snap.avgViews > 0
    ? Math.round(snap.avgViews)
    : undefined
}

export function toWorkspacePayload(snap: CreatorSnapshot): PageObservation {
  const followers =
    typeof snap.followers === "number" && snap.followers >= 0
      ? snap.followers
      : undefined

  return {
    platform: snap.platform,
    pageType: "profile",
    pageUrl: snap.pageUrl || profileUrl(snap),
    canonicalUrl: profileUrl(snap),
    detectedPlatformAccountId: snap.externalId,
    detectedHandle: snap.handle,
    detectedDisplayName: snap.name,
    avatarUrl: snap.avatarUrl,
    bannerUrl: snap.bannerUrl,
    // The creator's own words about their channel. The SaaS shows this in the
    // drawer and feeds it to the scorer.
    description: snap.bio,
    rawSignals: {
      source: "extension_manual_capture",
      country: snap.country,
      joinedDate: snap.joinedDate,
      links: snap.links,
      businessEmail: snap.businessEmail,
      uploadRegularity: snap.regularity,
      recentItems: snap.recentItems?.slice(0, 12)
    },
    normalizedMetrics: {
      // YouTube reports subscribers, IG/TikTok followers — the SaaS reads
      // whichever is present, so send the one that matches the platform.
      ...(snap.platform === "youtube"
        ? { subscriberCount: followers }
        : { followerCount: followers }),
      ...(avgViews(snap) === undefined ? {} : { avgViews90d: avgViews(snap) }),
      ...(typeof snap.videoCount === "number"
        ? { videoCount: snap.videoCount }
        : {}),
      ...(typeof snap.totalViews === "number"
        ? { totalViewCount: snap.totalViews }
        : {})
    }
  }
}
