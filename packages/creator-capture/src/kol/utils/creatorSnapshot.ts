/** 移植自 agentsws-extension `src/lib/kol/utils/creatorSnapshot.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/creatorSnapshot.ts` @ d25b877（原移植基准 f9aee68；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/**
 * Platform-generic capture snapshot shared by the YouTube / Instagram /
 * TikTok profile scrapers and the single creator card UI. Every
 * scraper reads only browser-visible public page data and maps into this
 * shape; the health check, row export, and observation sync all consume it
 * without knowing which platform produced it.
 */
import { pick } from "../language.js"

export type CapturePlatform = "youtube" | "instagram" | "tiktok"

export type RecentItem = {
  title: string
  views?: number
  viewsText?: string
  likes?: number
  comments?: number
  publishedAt?: string
  publishedText?: string
  /**
   * Granularity of `publishedAt`, when the scraper knows it. Absent means the
   * cadence maths reads it back off `publishedText`, and an absolute date
   * ("July 11, 2026") that matches no relative pattern is exact — day.
   */
  publishedPrecision?: PublishedPrecision
  /** Grid tile cover (whatever size the grid renders — never hi-res). */
  thumbnailUrl?: string
}

/**
 * How precisely a page dated something.
 *
 * YouTube spends a day-level label on this week ("4 days ago"), a week-level
 * one on this month ("3 weeks ago"), and from there on it is months and years.
 * Those coarse labels are BUCKETS: every video published inside the same month
 * reads back as the same instant, so the gap between two of them measures 0 and
 * the gap across a bucket edge measures a whole month. Anything that reads
 * those gaps one at a time ends up describing YouTube's label granularity
 * rather than the channel — which is exactly how a weekly channel came out as
 * "irregular, gaps of 0-183 days". Carrying the precision alongside the
 * timestamp is what lets the cadence maths know which numbers it may believe.
 */
export type PublishedPrecision = "day" | "week" | "month" | "year"

export type UploadRegularity = {
  /** Whether the cadence is CONSISTENT. "unknown" also covers "not judged". */
  status: "regular" | "irregular" | "unknown"
  /**
   * Mean days between uploads: (newest − oldest) ÷ (items − 1).
   *
   * Deliberately a span divided by a count rather than an average of measured
   * gaps: bucket collapse cancels out of a span (a telescoping sum), so 50
   * videos across a year read 7.3 days whether YouTube dated them to the day
   * or to the month. It is the headline number for that reason.
   */
  avgIntervalDays?: number
  note: string
}

export type ProfileLink = {
  title?: string
  url: string
}

export type CreatorSnapshot = {
  platform: CapturePlatform
  /**
   * Stable account key for the SaaS. Mirrors apify-import keying: the
   * platform's numeric/opaque account id when the page exposes one,
   * otherwise the handle without a leading "@" (YouTube keeps "@handle" —
   * that is its canonical public id form).
   */
  externalId: string
  name: string
  handle?: string
  avatarUrl?: string
  followersText?: string
  followers?: number
  /** Total published items when the page exposes it (videos/posts). */
  videoCount?: number
  /** Mean views/plays across the visible recent items. */
  avgViews?: number
  country?: string
  links: ProfileLink[]
  recentItems: RecentItem[]
  regularity: UploadRegularity
  pageUrl: string
  // --- Platform-specific extras (only some platforms expose each) ---------
  /** Profile bio / channel description. */
  bio?: string
  /**
   * Channel banner / cover art (YouTube only — IG/TikTok have no equivalent).
   * The SaaS stores it on the platform account and renders it behind the
   * creator drawer's header.
   */
  bannerUrl?: string
  /** Channel/account creation date, YouTube only ("Jul 8, 2006"). */
  joinedDate?: string
  /** Lifetime view count, YouTube About page only. */
  totalViews?: number
  /**
   * Business email read directly off the page (YouTube About "View email
   * address" once revealed, or an email found in the bio). Lets the user
   * skip hand-filling it.
   */
  businessEmail?: string
}

/** Body of POST /api/plugin/public/observations (see SaaS API contract). */
export type ObservationPayload = {
  platform: CapturePlatform
  externalId: string
  handle?: string
  name: string
  avatarUrl?: string
  stats: {
    followers: number
    avgViews?: number
    videoCount?: number
  }
  /**
   * Recent per-item detail (titles, views, publish dates) so channel-page
   * captures land richer than the aggregate stats. Additive — the SaaS
   * ignores it until content-level storage ships (strategy doc §十二).
   */
  recentItems?: Array<{
    title: string
    views?: number
    likes?: number
    comments?: number
    publishedAt?: string
    thumbnailUrl?: string
  }>
  /** Platform-specific extras; the SaaS ignores what it does not yet store. */
  bio?: string
  joinedDate?: string
  totalViews?: number
  businessEmail?: string
  capturedAt: string
  sourceUrl: string
}

/** Map a scraped snapshot to the exact POST /api/plugin/public/observations body. */
export function toObservationPayload(
  snapshot: CreatorSnapshot
): ObservationPayload {
  return {
    platform: snapshot.platform,
    externalId: snapshot.externalId,
    handle: snapshot.handle,
    name: snapshot.name,
    avatarUrl: snapshot.avatarUrl,
    stats: {
      followers: snapshot.followers ?? 0,
      avgViews: snapshot.avgViews,
      videoCount: snapshot.videoCount
    },
    recentItems: snapshot.recentItems.slice(0, 120).map((item) => ({
      title: item.title,
      views: item.views,
      likes: item.likes,
      comments: item.comments,
      publishedAt: item.publishedAt,
      thumbnailUrl: item.thumbnailUrl
    })),
    bio: snapshot.bio,
    joinedDate: snapshot.joinedDate,
    totalViews: snapshot.totalViews,
    businessEmail: snapshot.businessEmail,
    capturedAt: new Date().toISOString(),
    sourceUrl: snapshot.pageUrl
  }
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

/** First email address found in free text (bio, About page), or undefined. */
export function extractEmail(text?: string): string | undefined {
  return text?.match(EMAIL_IN_TEXT)?.[0]?.toLowerCase()
}

type RelativeUnit = { ms: number; precision: PublishedPrecision }

const DAY_MS = 86_400_000
const WEEK_MS = 604_800_000
const MONTH_MS = 2_629_800_000
const YEAR_MS = 31_557_600_000

/*
  Precision is the unit the page CHOSE, not the unit we convert into. "3 weeks
  ago" pins a video to a seven-day window; "2 months ago" pins it to a
  thirty-day one; both land on a millisecond after arithmetic, and only this
  column remembers which of them is worth measuring gaps with.
*/
const RELATIVE_UNITS: Record<string, RelativeUnit> = {
  second: { ms: 1_000, precision: "day" },
  minute: { ms: 60_000, precision: "day" },
  hour: { ms: 3_600_000, precision: "day" },
  day: { ms: DAY_MS, precision: "day" },
  week: { ms: WEEK_MS, precision: "week" },
  month: { ms: MONTH_MS, precision: "month" },
  year: { ms: YEAR_MS, precision: "year" },
  秒: { ms: 1_000, precision: "day" },
  分钟: { ms: 60_000, precision: "day" },
  分鐘: { ms: 60_000, precision: "day" },
  小时: { ms: 3_600_000, precision: "day" },
  小時: { ms: 3_600_000, precision: "day" },
  天: { ms: DAY_MS, precision: "day" },
  日: { ms: DAY_MS, precision: "day" },
  周: { ms: WEEK_MS, precision: "week" },
  週: { ms: WEEK_MS, precision: "week" },
  星期: { ms: WEEK_MS, precision: "week" },
  个月: { ms: MONTH_MS, precision: "month" },
  個月: { ms: MONTH_MS, precision: "month" },
  月: { ms: MONTH_MS, precision: "month" },
  年: { ms: YEAR_MS, precision: "year" }
}

// Abbreviated units from YouTube's compact lockup layout ("2d ago", "3mo ago").
const ABBREVIATED_UNITS: Record<string, RelativeUnit> = {
  s: { ms: 1_000, precision: "day" },
  m: { ms: 60_000, precision: "day" },
  h: { ms: 3_600_000, precision: "day" },
  d: { ms: DAY_MS, precision: "day" },
  w: { ms: WEEK_MS, precision: "week" },
  mo: { ms: MONTH_MS, precision: "month" },
  y: { ms: YEAR_MS, precision: "year" }
}

export type ParsedPublished = {
  publishedAt: string
  precision: PublishedPrecision
}

/** A relative date string as both an instant and the granularity it was written in. */
export function parseRelativePublished(
  text?: string
): ParsedPublished | undefined {
  if (!text) return undefined
  const cleaned = text.replace(/^(?:Streamed|Premiered|首播于?|直播过)\s*/i, "")

  const english = cleaned.match(
    /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i
  )
  const chinese = cleaned.match(
    /(\d+)\s*(秒|分钟|分鐘|小时|小時|天|日|周|週|星期|个月|個月|月|年)前/
  )
  const spelled = english || chinese
  const abbreviated = spelled
    ? null
    : cleaned.match(/(\d+)\s*(mo|[smhdwy])\s*ago/i)
  const match = spelled ?? abbreviated
  if (!match) return undefined

  const unit = (spelled ? RELATIVE_UNITS : ABBREVIATED_UNITS)[
    match[2].toLowerCase()
  ]
  if (!unit) return undefined

  return {
    publishedAt: new Date(
      Date.now() - Number(match[1]) * unit.ms
    ).toISOString(),
    precision: unit.precision
  }
}

export function parseRelativePublishedDate(text?: string) {
  return parseRelativePublished(text)?.publishedAt
}

const DEFAULT_UNKNOWN_REGULARITY_NOTE = () =>
  pick(
    "近期作品缺少发布时间，无法判断更新规律",
    "Recent posts carry no dates, so cadence is unknown"
  )

/** Days a label of this precision can be wrong by. */
const PRECISION_DAYS: Record<PublishedPrecision, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365
}

/** Precisions whose gaps are worth measuring one at a time. */
const MEASURABLE: PublishedPrecision[] = ["day", "week"]

/** Below this many day/week-dated items we state the average and stop. */
const MIN_MEASURABLE_ITEMS = 3

/** A cadence this slow is not a cadence. */
const REGULAR_MAX_DAYS = 45
const SLOW_MIN_DAYS = 60

/** Spread beyond what the labels can explain, as a fraction of the mean. */
const REGULAR_MAX_SPREAD = 0.8

type DatedItem = { time: number; precision: PublishedPrecision }

function itemPrecision(item: RecentItem): PublishedPrecision {
  if (item.publishedPrecision) return item.publishedPrecision
  // Instagram dates a tile absolutely ("July 11, 2026"): no relative pattern
  // matches, and the date is exact — so the fallback is day, not year.
  return parseRelativePublished(item.publishedText)?.precision ?? "day"
}

/** Newest minus oldest, in days. Zero when everything landed on one instant. */
function spanDays(sortedNewestFirst: DatedItem[]): number {
  const newest = sortedNewestFirst[0]
  const oldest = sortedNewestFirst[sortedNewestFirst.length - 1]
  return (newest.time - oldest.time) / DAY_MS
}

/**
 * How far the measured gaps stray from their own mean, beyond the slack the
 * date labels already carry, as a fraction of that mean.
 *
 * Two videos both stamped "1 week ago" measure a gap of zero days, which is a
 * lower bound and not a fact — a raw coefficient of variation reads that as
 * wild inconsistency and condemns a twice-weekly channel. So each gap is
 * forgiven up to the resolution of its coarser end before it counts against
 * consistency. Returns 0 when there is nothing left to explain.
 */
function spreadBeyondPrecision(entries: DatedItem[]): number {
  const gaps = entries.slice(1).map((entry, index) => ({
    days: (entries[index].time - entry.time) / DAY_MS,
    slack: Math.max(
      PRECISION_DAYS[entries[index].precision],
      PRECISION_DAYS[entry.precision]
    )
  }))
  const mean = gaps.reduce((sum, gap) => sum + gap.days, 0) / gaps.length
  if (mean <= 0) return 0
  const excess = gaps.map((gap) =>
    Math.max(Math.abs(gap.days - mean) - gap.slack, 0)
  )
  const variance =
    excess.reduce((sum, value) => sum + value ** 2, 0) / excess.length
  return Math.sqrt(variance) / mean
}

/**
 * Upload cadence, and only the part of it the page's dates can support.
 *
 * Two separate questions, deliberately answered by different data:
 *
 *   HOW OFTEN — (newest − oldest) ÷ (items − 1), over every dated item. Bucket
 *   collapse telescopes out of a span, so this survives a page where forty of
 *   the fifty videos say "N months ago" and it is the headline for that reason.
 *
 *   HOW CONSISTENTLY — measured only across items dated to the day or the
 *   week, because a gap between two month-level labels is 0 or 30 and never
 *   anything a channel actually did. Under three such items we report the
 *   average and decline the verdict: 0.9.18 called a plainly weekly channel
 *   "irregular, gaps of 0-183 days" off month buckets, and no verdict at all
 *   beats a confident wrong one.
 */
export function assessUploadRegularity(
  items: RecentItem[],
  unknownNote = DEFAULT_UNKNOWN_REGULARITY_NOTE()
): UploadRegularity {
  const dated = items
    .map((item) => ({
      time: item.publishedAt ? Date.parse(item.publishedAt) : NaN,
      precision: itemPrecision(item)
    }))
    .filter((entry): entry is DatedItem => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)

  if (dated.length < MIN_MEASURABLE_ITEMS) {
    return { status: "unknown", note: unknownNote }
  }

  /*
    A span no wider than the slack in its own two endpoints is not a span. Three
    videos all stamped "5 months ago" span zero days, and dividing that by two
    would announce several uploads a day; the honest reading is that this page
    does not say. (Never a division by zero — the item count is at least three
    above, so the divisor is at least two.)
  */
  const span = spanDays(dated)
  const endpointSlack =
    PRECISION_DAYS[dated[0].precision] +
    PRECISION_DAYS[dated[dated.length - 1].precision]
  if (span < endpointSlack) {
    return {
      status: "unknown",
      note: pick(
        "近期作品的发布时间过于接近，无法判断更新频率",
        "Recent posts are dated too close together to read a cadence"
      )
    }
  }

  const avgIntervalDays = span / (dated.length - 1)
  const rounded = Math.max(Math.round(avgIntervalDays), 1)
  const cadence =
    avgIntervalDays < 1
      ? pick("平均每天多条", "multiple posts a day")
      : pick(`约每 ${rounded} 天一更`, `about every ${rounded} days`)
  const avg = Math.round(avgIntervalDays * 10) / 10

  const measurable = dated.filter((entry) =>
    MEASURABLE.includes(entry.precision)
  )
  if (measurable.length < MIN_MEASURABLE_ITEMS) {
    return {
      status: "unknown",
      avgIntervalDays: avg,
      note: pick(
        `${cadence}；较早的日期只精确到月，是否规律暂不判断`,
        `Older dates are month-level only, so consistency is not judged — ${cadence}`
      )
    }
  }

  if (
    avgIntervalDays <= REGULAR_MAX_DAYS &&
    spreadBeyondPrecision(measurable) <= REGULAR_MAX_SPREAD
  ) {
    return {
      status: "regular",
      avgIntervalDays: avg,
      note: pick(`更新较规律 · ${cadence}`, `Fairly regular · ${cadence}`)
    }
  }

  if (avgIntervalDays > SLOW_MIN_DAYS) {
    return {
      status: "irregular",
      avgIntervalDays: avg,
      note: pick(
        `更新缓慢且不规律 · ${cadence}`,
        `Slow and irregular · ${cadence}`
      )
    }
  }

  // The gap range only ever quotes measurable items — quoting it off month
  // buckets is what produced "0-183 天" for a channel that posts every week.
  const gaps = measurable
    .slice(1)
    .map((entry, index) => (measurable[index].time - entry.time) / DAY_MS)
    .sort((a, b) => a - b)
  const shortest = Math.round(gaps[0])
  const longest = Math.round(gaps[gaps.length - 1])

  return {
    status: "irregular",
    avgIntervalDays: avg,
    note: pick(
      `更新不规律 · ${cadence}（近期间隔 ${shortest}-${longest} 天）`,
      `Irregular · ${cadence} (recent gaps of ${shortest}-${longest} days)`
    )
  }
}

/** Tile <img> src when it's a real network image (skips lazy data: placeholders). */
export function tileThumbnailUrl(
  container: HTMLElement | null
): string | undefined {
  const src = container?.querySelector("img")?.src
  return src?.startsWith("http") ? src : undefined
}

/** Mean of the finite view counts across recent items, or undefined. */
export function averageItemViews(items: RecentItem[]): number | undefined {
  const counts = items
    .map((item) => item.views)
    .filter((views): views is number => Number.isFinite(views))
  if (counts.length === 0) return undefined
  return Math.round(counts.reduce((sum, views) => sum + views, 0) / counts.length)
}
