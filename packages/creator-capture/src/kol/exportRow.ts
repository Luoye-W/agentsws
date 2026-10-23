/** 移植自 agentsws-extension `src/lib/kol/exportRow.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/exportRow.ts` @ d25b877（原移植基准 25bbeae；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Row export for the no-login local tier (免登录本地档).
 *
 * Without an account the captured data lives nowhere — these helpers give it
 * a manual exit: one TAB-separated row that pastes into a Feishu/Excel sheet
 * as a single record, or a one-row CSV download. Column order is stable and
 * shared between both formats; keep it in sync with the Feishu Bitable
 * template (M3) so migrating from manual paste to auto-sync is seamless.
 */
import type { ContentSnapshot } from "./utils/contentSnapshot.js"
import type {
  CapturePlatform,
  CreatorSnapshot
} from "./utils/creatorSnapshot.js"
import { creatorExportTable } from "./creatorFields.js"
import { formatDurationClock } from "./format.js"
import { pick } from "./language.js"
import { computeContentHealth, formatRatioPercent } from "./localHealth.js"

const PLATFORM_NAMES: Record<CapturePlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok"
}

/** One tab-separated row — pastes into Feishu/Excel as a single record. */
function toTsv(values: string[]): string {
  // Tabs/newlines inside values would split the pasted row.
  return values.map((value) => value.replace(/[\t\n\r]+/g, " ")).join("\t")
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Header + one data row, BOM-prefixed so Excel opens UTF-8 correctly. */
function toCsv(columns: readonly string[], values: string[]): string {
  const header = columns.map(csvEscape).join(",")
  const row = values.map(csvEscape).join(",")
  return `﻿${header}\n${row}\n`
}

/** Trigger a client-side CSV download from the content script. */
function triggerCsvDownload(csv: string, basename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  // 移植时改的唯一一处**用户看得见**的字：旧仓前缀是 `kolagents-`，
  // 这里跟外壳（`src/lib/export-row.ts` 的 `exportFileName`）用同一个产品名
  // 「红人助手」。文件名不进任何算法，导出内容逐字未动。
  anchor.download = `红人助手-${basename}-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * `valuationRange` is the 频道价值 range as plain text ("$120-$280"), passed
 * in rather than computed: on the login tier it is the SERVER's answer, and
 * the export must print the same string the panel showed, not a second
 * opinion. Empty when there is no honest range to print.
 */
export function buildTsvRow(
  snapshot: CreatorSnapshot,
  email = "",
  valuationRange = ""
): string {
  return toTsv(creatorExportTable(snapshot, email, valuationRange).values)
}

export function downloadCsv(
  snapshot: CreatorSnapshot,
  email = "",
  valuationRange = ""
): void {
  const table = creatorExportTable(snapshot, email, valuationRange)
  triggerCsvDownload(
    toCsv(table.columns, table.values),
    snapshot.handle || snapshot.externalId
  )
}

/**
 * Content rows (§十) are the second record type: one row per captured
 * video/post, linked to the creator table by 作者Handle/作者ID. Keep the
 * column order in sync with the two-table Feishu/Notion templates (M3/M4).
 */
/**
 * New columns go on the END, never in the middle. Someone whose Bitable
 * automation already maps this row by position keeps working; inserting 时长
 * next to 发布时间, where it reads better, would silently shift every cell
 * after it in every sheet already in use.
 */
export const contentExportColumns = (): readonly string[] =>
  pick(
    [
      "平台",
      "内容标题",
      "内容链接",
      "封面链接",
      "作者",
      "作者Handle",
      "作者ID",
      "播放",
      "点赞",
      "评论",
      "转发",
      "发布时间",
      "赞/播比",
      "播放/粉丝比",
      "作者邮箱",
      "采集时间",
      "时长",
      "画幅"
    ],
    [
      "Platform",
      "Title",
      "URL",
      "Thumbnail",
      "Creator",
      "Creator handle",
      "Creator ID",
      "Views",
      "Likes",
      "Comments",
      "Shares",
      "Published",
      "Likes/views",
      "Views/followers",
      "Creator email",
      "Captured at",
      "Duration",
      "Orientation"
    ]
  )

/** "" when unmeasured — an empty cell, not a guess. */
export function orientationLabel(
  orientation: ContentSnapshot["orientation"]
): string {
  if (orientation === "portrait") return pick("竖屏", "Portrait")
  if (orientation === "landscape") return pick("横屏", "Landscape")
  return ""
}

export function buildContentExportValues(
  snapshot: ContentSnapshot,
  email = ""
): string[] {
  const health = computeContentHealth(snapshot)
  return [
    PLATFORM_NAMES[snapshot.platform],
    snapshot.title,
    snapshot.url,
    snapshot.thumbnailUrl ?? "",
    snapshot.author.name ?? "",
    snapshot.author.handle ?? "",
    snapshot.author.externalId ?? "",
    snapshot.views != null ? String(snapshot.views) : "",
    snapshot.likes != null ? String(snapshot.likes) : "",
    snapshot.comments != null ? String(snapshot.comments) : "",
    snapshot.shares != null ? String(snapshot.shares) : "",
    snapshot.publishedAt ?? snapshot.publishedText ?? "",
    formatRatioPercent(health.engagementRate),
    formatRatioPercent(health.viewsToFollowersRatio),
    email,
    new Date().toISOString(),
    formatDurationClock(snapshot.durationSeconds) ?? "",
    orientationLabel(snapshot.orientation)
  ]
}

export function buildContentTsvRow(
  snapshot: ContentSnapshot,
  email = ""
): string {
  return toTsv(buildContentExportValues(snapshot, email))
}

export function downloadContentCsv(
  snapshot: ContentSnapshot,
  email = ""
): void {
  triggerCsvDownload(
    toCsv(contentExportColumns(), buildContentExportValues(snapshot, email)),
    `content-${snapshot.contentId}`
  )
}
