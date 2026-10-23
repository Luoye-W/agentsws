/** 移植自 agentsws-extension `test/kol/exportRow.test.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：算法对拍用例逐字照搬，只改 import 路径（`src/lib/kol/` → `src/kol/`）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/__tests__/exportRow.test.ts` @ 3ec7a07。 用例数值与旧仓逐字一致；只把 runner 从 node:test 换成 vitest（assert 仍是 node:assert/strict）。 */
/**
 * Export-row invariants. The 估值区间 column was appended to three per-platform
 * tables at once; a header/value count that drifts by one shifts every cell
 * after it and the user finds out by pasting a wrecked row into their sheet.
 *
 * The row-sink assertions that used to sit here went with `rowSink.ts` in
 * 0.9.16: the plugin no longer posts rows to anybody's spreadsheet (the SaaS
 * owns the destination and pushes on ingest — P2b), so the only row this build
 * builds is the one the user copies or downloads, and that is what is pinned.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import type { ContentSnapshot } from "../../src/kol/utils/contentSnapshot.js"
import type { CreatorSnapshot } from "../../src/kol/utils/creatorSnapshot.js"
import { creatorExportTable } from "../../src/kol/creatorFields.js"
import {
  buildContentExportValues,
  buildTsvRow,
  contentExportColumns
} from "../../src/kol/exportRow.js"

function snapshot(platform: CreatorSnapshot["platform"]): CreatorSnapshot {
  return {
    platform,
    externalId: "@test",
    name: "Test Creator",
    handle: "@test",
    followers: 100_000,
    avgViews: 20_000,
    links: [],
    recentItems: [],
    regularity: { status: "unknown", note: "n/a" },
    pageUrl: "https://example.com/@test"
  }
}

const PLATFORMS: CreatorSnapshot["platform"][] = [
  "youtube",
  "instagram",
  "tiktok"
]

test("every platform's export table has as many values as columns", () => {
  for (const platform of PLATFORMS) {
    const table = creatorExportTable(snapshot(platform), "", "$120-$280")
    assert.equal(
      table.values.length,
      table.columns.length,
      `${platform}: ${table.columns.length} columns vs ${table.values.length} values`
    )
  }
})

test("the valuation range is the last column, as text", () => {
  for (const platform of PLATFORMS) {
    const table = creatorExportTable(snapshot(platform), "", "$120-$280")
    assert.equal(table.values[table.values.length - 1], "$120-$280")
  }
})

test("no valuation → an empty trailing cell, never a stray number", () => {
  const table = creatorExportTable(snapshot("youtube"))
  assert.equal(table.values[table.values.length - 1], "")
})

test("the TSV row carries the range and stays single-line", () => {
  const row = buildTsvRow(snapshot("tiktok"), "a@b.com", "$120-$280")
  assert.ok(row.includes("$120-$280"))
  assert.ok(!row.includes("\n"))
})

function content(overrides: Partial<ContentSnapshot> = {}): ContentSnapshot {
  return {
    platform: "tiktok",
    contentId: "740123",
    contentType: "video",
    title: "A clip",
    url: "https://www.tiktok.com/@someone/video/740123",
    orientation: null,
    durationSeconds: null,
    author: { externalId: "1", handle: "someone" },
    pageUrl: "https://www.tiktok.com/@someone/video/740123",
    ...overrides
  }
}

test("the content row has as many values as columns", () => {
  // 时长/画幅 were appended to a table three formats already share; a drift of
  // one shifts every cell after it and the user finds out by pasting.
  assert.equal(
    buildContentExportValues(content()).length,
    contentExportColumns().length
  )
})

test("duration exports as the clock the panel showed, orientation as words", () => {
  const values = buildContentExportValues(
    content({ durationSeconds: 95, orientation: "portrait" })
  )
  assert.equal(values[values.length - 2], "1:35")
  assert.ok(["竖屏", "Portrait"].includes(values[values.length - 1]))
})

test("an unmeasured clip leaves both cells empty rather than guessing", () => {
  const values = buildContentExportValues(content())
  assert.equal(values[values.length - 2], "")
  assert.equal(values[values.length - 1], "")
})
