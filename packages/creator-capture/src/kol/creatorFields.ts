/** 移植自 agentsws-extension `src/lib/kol/creatorFields.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/creatorFields.ts` @ d25b877（原移植基准 1a9c84e；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Per-platform field sets for creator captures. Platforms expose different
 * data, so the summary rows shown in the card and the export columns differ
 * by platform rather than being forced into one shared schema.
 */
import type {
  CapturePlatform,
  CreatorSnapshot
} from "./utils/creatorSnapshot.js"
import { countryFlag } from "./countryFlag.js"
import { formatNumber } from "./format.js"
import { pick } from "./language.js"
import { computeLocalHealth, formatRatioPercent } from "./localHealth.js"

const PLATFORM_NAMES: Record<CapturePlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok"
}

export type SummaryRow = { label: string; value: string }

const fmt = (n?: number) => (n != null ? formatNumber(n) : "")

const SOCIAL_HOSTS: { platform: string; re: RegExp; self?: string }[] = [
  { platform: "YouTube", re: /youtube\.com\//i, self: "youtube" },
  { platform: "Instagram", re: /instagram\.com\//i, self: "instagram" },
  { platform: "TikTok", re: /tiktok\.com\/@/i, self: "tiktok" },
  { platform: "X", re: /(?:twitter|x)\.com\//i },
  { platform: "Twitch", re: /twitch\.tv\//i },
  { platform: "Facebook", re: /facebook\.com\//i },
  { platform: "LinkedIn", re: /linkedin\.com\/(in|company)\//i }
]

/**
 * The creator's profiles on OTHER platforms, pulled from the bio / About
 * links. Feeds the SaaS cross-platform identity merge and lets the card show
 * "also on X / TikTok" without the plugin itself scraping those platforms.
 */
export function crossPlatformLinks(
  s: CreatorSnapshot
): { platform: string; url: string }[] {
  const out: { platform: string; url: string }[] = []
  const seen = new Set<string>()
  for (const link of s.links) {
    const match = SOCIAL_HOSTS.find((h) => h.re.test(link.url))
    if (!match || match.self === s.platform) continue
    if (seen.has(match.platform)) continue
    seen.add(match.platform)
    out.push({ platform: match.platform, url: link.url })
  }
  return out
}

export type ProfileLinkRow = {
  /** Known social platform (renders its glyph), or null for a generic link. */
  platform: string | null
  /** The creator's own label for the link — shown on hover. */
  label: string
  url: string
}

/** Strip scheme and `www.` so a bare host reads as a label. */
function hostLabel(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
}

/**
 * Every link on the profile, annotated with the platform we recognise it as.
 *
 * `crossPlatformLinks` only ever returned links that matched a known social
 * host, so a creator's Skool community, shop or newsletter — often the most
 * commercially interesting thing on the page — was counted ("外链: 6") and
 * then thrown away. Generic links keep their own row and render with a chain
 * glyph; known platforms still collapse to one icon each.
 */
export function profileLinkRows(s: CreatorSnapshot): ProfileLinkRow[] {
  const out: ProfileLinkRow[] = []
  const seenPlatform = new Set<string>()
  const seenUrl = new Set<string>()

  for (const link of s.links) {
    const url = link.url?.trim()
    if (!url || seenUrl.has(url)) continue
    seenUrl.add(url)

    const match = SOCIAL_HOSTS.find((h) => h.re.test(url))
    // A link back to the platform we are standing on is not "another link".
    if (match?.self === s.platform) continue
    if (match) {
      if (seenPlatform.has(match.platform)) continue
      seenPlatform.add(match.platform)
    }

    out.push({
      platform: match?.platform ?? null,
      label: link.title?.trim() || hostLabel(url),
      url
    })
  }
  return out
}

function crossPlatformCell(s: CreatorSnapshot): string {
  return crossPlatformLinks(s)
    .map((l) => `${l.platform}: ${l.url}`)
    .join(" | ")
}

/** Drop the trailing unit word so "1.87M subscribers" reads as "1.87M". */
function compactFollowers(s: CreatorSnapshot): string {
  const text = s.followersText
    ?.replace(/\s*(subscribers?|followers?|位?订阅者?|粉丝).*$/i, "")
    .trim()
  return text || fmt(s.followers)
}

/** Compact stat rows for the card, tailored to what each platform exposes. */
export function creatorSummaryRows(s: CreatorSnapshot): SummaryRow[] {
  const rows: SummaryRow[] = []
  const push = (label: string, value?: string) => {
    if (value) rows.push({ label, value })
  }
  const followers = compactFollowers(s)
  const region = (c?: string) => (c ? `${countryFlag(c)} ${c}`.trim() : "")

  const count = (n: number, zhUnit: string) =>
    n ? pick(`${n} ${zhUnit}`, String(n)) : ""

  if (s.platform === "youtube") {
    push(pick("订阅", "Subscribers"), followers)
    push(pick("视频总数", "Videos"), fmt(s.videoCount))
    push(pick("总播放", "Total views"), fmt(s.totalViews))
    push(pick("平均播放", "Avg. views"), fmt(s.avgViews))
    push(pick("近期视频", "Recent videos"), count(s.recentItems.length, "条"))
    push(pick("地区", "Region"), region(s.country))
    push(pick("注册", "Joined"), s.joinedDate)
  } else if (s.platform === "instagram") {
    push(pick("粉丝", "Followers"), followers)
    push(pick("帖子总数", "Posts"), fmt(s.videoCount))
    push(pick("近期帖子", "Recent posts"), count(s.recentItems.length, "篇"))
    push(pick("平均播放", "Avg. views"), fmt(s.avgViews))
  } else {
    push(pick("粉丝", "Followers"), followers)
    push(pick("视频总数", "Videos"), fmt(s.videoCount))
    push(pick("近期视频", "Recent videos"), count(s.recentItems.length, "条"))
    push(pick("平均播放", "Avg. views"), fmt(s.avgViews))
    push(pick("地区", "Region"), region(s.country))
  }
  return rows
}

export type ExportTable = { columns: readonly string[]; values: string[] }

const raw = (n?: number) => (n != null ? String(Math.round(n)) : "")

/**
 * One export row per platform. `email` (user-entered) wins over the
 * page-scraped business email. Keep column order stable so the Feishu/Notion
 * templates (M3/M4) can map each platform's table — which is why 估值区间 is
 * appended at the END rather than slotted in next to the other money columns.
 *
 * `valuationRange` is TEXT ("$120-$280"), never a number. A spreadsheet column
 * holding a single number is exactly how a band quietly becomes a quote, and
 * the whole point of the report-v2 valuation is that a channel is worth a band.
 */
export function creatorExportTable(
  s: CreatorSnapshot,
  email = "",
  valuationRange = ""
): ExportTable {
  const health = computeLocalHealth(s)
  const name = PLATFORM_NAMES[s.platform]
  const contact = email || s.businessEmail || ""
  const capturedAt = new Date().toISOString()
  const valueColumn = pick("估值区间", "Value range")

  if (s.platform === "youtube") {
    return {
      columns: pick(
        [
          "平台", "名称", "Handle", "频道ID", "主页链接", "订阅数",
          "视频总数", "总播放量", "平均播放", "播放/订阅比", "疑似刷粉",
          "更新规律", "地区", "注册时间", "商务邮箱", "简介", "外链数", "其他平台主页", "采集时间",
          valueColumn
        ],
        [
          "Platform", "Name", "Handle", "Channel ID", "Profile URL", "Subscribers",
          "Videos", "Total views", "Avg. views", "Views/subs", "Bought audience?",
          "Upload cadence", "Region", "Joined", "Business email", "Bio", "Links", "Other profiles", "Captured at",
          valueColumn
        ]
      ),
      values: [
        name, s.name, s.handle ?? "", s.externalId, s.pageUrl, raw(s.followers),
        raw(s.videoCount), raw(s.totalViews), raw(s.avgViews),
        formatRatioPercent(health.viewsToSubsRatio),
        health.boughtAudienceSuspected ? pick("是", "Yes") : pick("否", "No"), s.regularity.note,
        s.country ?? "", s.joinedDate ?? "", contact, s.bio ?? "",
        String(s.links.length), crossPlatformCell(s), capturedAt,
        valuationRange
      ]
    }
  }

  if (s.platform === "instagram") {
    return {
      columns: pick(
        [
          "平台", "名称", "Handle", "账号ID", "主页链接", "粉丝数", "帖子总数",
          "近期帖子数", "平均播放", "更新规律", "商务邮箱", "简介", "外链数", "其他平台主页", "采集时间",
          valueColumn
        ],
        [
          "Platform", "Name", "Handle", "Account ID", "Profile URL", "Followers", "Posts",
          "Recent posts", "Avg. views", "Upload cadence", "Business email", "Bio", "Links", "Other profiles", "Captured at",
          valueColumn
        ]
      ),
      values: [
        name, s.name, s.handle ?? "", s.externalId, s.pageUrl, raw(s.followers),
        raw(s.videoCount), String(s.recentItems.length), raw(s.avgViews),
        s.regularity.note, contact, s.bio ?? "", String(s.links.length),
        crossPlatformCell(s), capturedAt, valuationRange
      ]
    }
  }

  return {
    columns: pick(
      [
        "平台", "名称", "Handle", "账号ID", "主页链接", "粉丝数", "视频总数",
        "近期视频数", "平均播放", "播放/粉丝比", "疑似刷粉", "地区", "商务邮箱",
        "简介", "外链数", "其他平台主页", "采集时间", valueColumn
      ],
      [
        "Platform", "Name", "Handle", "Account ID", "Profile URL", "Followers", "Videos",
        "Recent videos", "Avg. views", "Views/followers", "Bought audience?", "Region", "Business email",
        "Bio", "Links", "Other profiles", "Captured at", valueColumn
      ]
    ),
    values: [
      name, s.name, s.handle ?? "", s.externalId, s.pageUrl, raw(s.followers),
      raw(s.videoCount), String(s.recentItems.length), raw(s.avgViews),
      formatRatioPercent(health.viewsToSubsRatio),
      health.boughtAudienceSuspected ? pick("是", "Yes") : pick("否", "No"), s.country ?? "", contact,
      s.bio ?? "", String(s.links.length), crossPlatformCell(s), capturedAt,
      valuationRange
    ]
  }
}
