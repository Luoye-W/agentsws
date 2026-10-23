/** 移植自 agentsws-extension `test/contents/creatorSnapshot.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Upload cadence, and the bug that made it necessary (0.9.19).
 *
 * Owner opened @zeeksteryt — fifty videos, plainly one a week — and the panel
 * said "更新不规律（间隔约 0-183 天）". Nothing was wrong with the statistics.
 * The dates were wrong: YouTube writes "4 days ago" for this week, "3 weeks
 * ago" for this month, and "N months ago" for everything older, so forty of
 * those fifty videos parsed to one of a handful of identical instants. Gaps
 * measured between them are 0 within a bucket and 30 across an edge — the
 * median came out at a quarter of a day, the variation exploded, and the range
 * quoted back at the user was the width of the bucket ladder.
 *
 * So these pin the shape of the data, not the arithmetic: a mixed-precision
 * page must read ~7 days, and a page that only says months must decline the
 * verdict instead of inventing one.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  assessUploadRegularity,
  parseRelativePublished,
  type RecentItem
} from "../../src/kol/utils/creatorSnapshot.js"
import { setActiveLang } from "../../src/kol/language.js"

setActiveLang("en")

const DAY_MS = 86_400_000

/** An item dated N days back, carrying the precision YouTube would have used. */
function item(
  daysAgo: number,
  precision: "day" | "week" | "month" | "year",
  title = `v${daysAgo}`
): RecentItem {
  return {
    title,
    publishedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    publishedPrecision: precision
  }
}

/**
 * What a weekly channel's page actually reads back as: the first few videos
 * dated to the day or the week, everything older collapsed onto the first of
 * each month bucket. Fifty videos, one every seven days.
 */
function weeklyChannelAsYouTubeDatesIt(): RecentItem[] {
  const items: RecentItem[] = []
  for (let index = 0; index < 50; index++) {
    const trueDaysAgo = 4 + index * 7
    if (trueDaysAgo <= 7) items.push(item(trueDaysAgo, "day"))
    else if (trueDaysAgo <= 30) {
      // "N weeks ago" — rounded down to the week, as YouTube renders it.
      items.push(item(Math.floor(trueDaysAgo / 7) * 7, "week", `v${index}`))
    } else {
      // "N months ago" — every video in the bucket lands on the same instant.
      items.push(
        item(Math.floor(trueDaysAgo / 30) * 30, "month", `v${index}`)
      )
    }
  }
  return items
}

test("relative dates carry the granularity they were written in", () => {
  assert.equal(parseRelativePublished("4 days ago")?.precision, "day")
  assert.equal(parseRelativePublished("3 weeks ago")?.precision, "week")
  assert.equal(parseRelativePublished("2 months ago")?.precision, "month")
  assert.equal(parseRelativePublished("1 year ago")?.precision, "year")
  // Compact lockup layout, and Chinese.
  assert.equal(parseRelativePublished("2d ago")?.precision, "day")
  assert.equal(parseRelativePublished("3mo ago")?.precision, "month")
  assert.equal(parseRelativePublished("3 周前")?.precision, "week")
  assert.equal(parseRelativePublished("5 个月前")?.precision, "month")
  assert.equal(parseRelativePublished("上周"), undefined)
})

test("an hour-old video is still day precision, not its own unit", () => {
  assert.equal(parseRelativePublished("6 hours ago")?.precision, "day")
})

test("a weekly channel reads as weekly, month buckets and all", () => {
  const result = assessUploadRegularity(weeklyChannelAsYouTubeDatesIt())

  // 50 videos across a year of seven-day gaps: the span says ~7 days even
  // though most of the individual gaps parse as 0 or 30.
  assert.ok(
    result.avgIntervalDays! >= 6 && result.avgIntervalDays! <= 8,
    `expected ~7 days, got ${result.avgIntervalDays}`
  )
  assert.notEqual(result.status, "irregular")
  assert.match(result.note, /about every 7 days/)
  // The bucket-width range that started this is gone.
  assert.doesNotMatch(result.note, /0-\d+ days/)
})

test("the owner's own sequence: 4d / 11d / 3w / 1mo / 1mo / 2mo", () => {
  const result = assessUploadRegularity([
    item(4, "day"),
    item(11, "day"),
    item(21, "week"),
    item(30, "month"),
    item(30, "month"),
    item(60, "month")
  ])

  // Span 56 days over six items → ~11 days. Day/week items: 4, 11, 21 → gaps
  // of 7 and 10, which is a cadence, not chaos.
  assert.equal(result.status, "regular")
  assert.ok(
    result.avgIntervalDays! >= 10 && result.avgIntervalDays! <= 12,
    `expected ~11 days, got ${result.avgIntervalDays}`
  )
})

test("month-level data alone reports the average and refuses the verdict", () => {
  const result = assessUploadRegularity([
    item(30, "month"),
    item(60, "month"),
    item(90, "month"),
    item(120, "month"),
    item(150, "month")
  ])

  assert.equal(result.status, "unknown")
  assert.equal(result.avgIntervalDays, 30)
  assert.match(result.note, /about every 30 days/)
  assert.match(result.note, /month-level/)
})

test("two videos in one week do not make a twice-weekly channel irregular", () => {
  // Both stamped "1 week ago": the measured gap is 0, which is a lower bound
  // and not a fact. Forgiving it up to the label's own resolution is the
  // difference between "regular" and condemning a channel for YouTube's UI.
  const result = assessUploadRegularity([
    item(3, "day"),
    item(7, "week"),
    item(7, "week"),
    item(14, "week"),
    item(21, "week"),
    item(28, "week")
  ])

  assert.equal(result.status, "regular")
})

test("a genuinely erratic channel is still called erratic", () => {
  const result = assessUploadRegularity([
    item(1, "day"),
    item(2, "day"),
    item(3, "day"),
    item(50, "day"),
    item(52, "day")
  ])

  assert.equal(result.status, "irregular")
  assert.match(result.note, /recent gaps of/)
})

test("a dormant channel is slow and irregular, with the average said out loud", () => {
  const result = assessUploadRegularity([
    item(2, "day"),
    item(9, "day"),
    item(16, "day"),
    item(400, "day"),
    item(800, "day")
  ])

  assert.equal(result.status, "irregular")
  assert.match(result.note, /Slow and irregular/)
  assert.match(result.note, /about every 200 days/)
})

test("fewer than three dated items stays unknown, with the caller's note", () => {
  const result = assessUploadRegularity(
    [item(1, "day"), item(8, "day"), { title: "no date" }],
    "no dates here"
  )
  assert.deepEqual(result, { status: "unknown", note: "no dates here" })
})

test("undated items (TikTok) never reach the maths", () => {
  const result = assessUploadRegularity(
    [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }],
    "no dates here"
  )
  assert.deepEqual(result, { status: "unknown", note: "no dates here" })
})

test("everything published the same day divides by nothing and claims nothing", () => {
  const sameInstant = new Date().toISOString()
  const result = assessUploadRegularity([
    { title: "a", publishedAt: sameInstant, publishedPrecision: "day" },
    { title: "b", publishedAt: sameInstant, publishedPrecision: "day" },
    { title: "c", publishedAt: sameInstant, publishedPrecision: "day" },
    { title: "d", publishedAt: sameInstant, publishedPrecision: "day" }
  ])

  assert.equal(result.status, "unknown")
  assert.equal(result.avgIntervalDays, undefined)
  assert.match(result.note, /too close together/)
})

test("a month bucket that swallowed every visible video says so", () => {
  // Three videos, all "5 months ago". Span 0 — but zero here means the page
  // cannot tell them apart, not that they went up together.
  const result = assessUploadRegularity([
    item(150, "month"),
    item(150, "month"),
    item(150, "month")
  ])

  assert.equal(result.status, "unknown")
  assert.match(result.note, /too close together/)
})

test("a real burst is reported as a burst, not as one-a-day", () => {
  const result = assessUploadRegularity([
    item(0, "day"),
    item(0.2, "day"),
    item(1, "day"),
    item(1.5, "day"),
    item(2, "day"),
    item(3, "day"),
    item(4, "day")
  ])

  assert.match(result.note, /multiple posts a day/)
})

test("precision falls back to the text when the scraper did not record it", () => {
  // Instagram writes an absolute date, which matches no relative pattern and
  // is exact: it must not be treated as the coarsest possible reading.
  const dated = (daysAgo: number, text: string): RecentItem => ({
    title: text,
    publishedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    publishedText: text
  })
  const result = assessUploadRegularity([
    dated(2, "July 11, 2026"),
    dated(9, "July 4, 2026"),
    dated(16, "June 27, 2026"),
    dated(23, "June 20, 2026")
  ])

  assert.equal(result.status, "regular")
  assert.equal(result.avgIntervalDays, 7)
})

test("month-level text is read off publishedText too", () => {
  const buckets: RecentItem[] = [30, 60, 90, 120].map((daysAgo) => ({
    title: `v${daysAgo}`,
    publishedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    publishedText: `${Math.round(daysAgo / 30)} months ago`
  }))

  assert.equal(assessUploadRegularity(buckets).status, "unknown")
})

test("Chinese notes carry the same numbers", () => {
  setActiveLang("zh")
  try {
    const result = assessUploadRegularity(weeklyChannelAsYouTubeDatesIt())
    assert.match(result.note, /约每 7 天一更/)
  } finally {
    setActiveLang("en")
  }
})
