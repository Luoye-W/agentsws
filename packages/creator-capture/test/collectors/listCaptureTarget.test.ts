/** 移植自 agentsws-extension `test/contents/listCaptureTarget.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/__tests__/listCaptureTarget.test.ts` @ 1f824f1；WP130 再补搬同文件后来的改动（旧仓提交 6259a1c：TikTok 搜索 / tag、Instagram tag 三种列表页）。只改 import 路径。 */
/**
 * Which list a URL is, and when the panel is allowed to open itself.
 *
 * The second half is the one worth having tests for. "Open itself" is a
 * privilege the rest of this extension does not take — every other panel waits
 * for a click — so the rule that grants it has to be narrow enough to state in
 * one sentence and to fail closed on everything else.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  isDeepLinkTargetPage,
  resolveListCaptureTarget,
  shouldAutoExpand
} from "../../src/collectors/listCaptureTarget.js"

const SEARCH = "https://www.youtube.com/results?search_query=garage+floor+mat"
const WATCH = "https://www.youtube.com/watch?v=aircAruvnKk"

test("a results page is a search capture, keyed on the query", () => {
  assert.deepEqual(resolveListCaptureTarget(SEARCH), {
    platform: "youtube",
    pageType: "search",
    sourceQuery: "garage floor mat"
  })
})

test("a watch page is a rail capture, keyed on the video URL", () => {
  /*
    The URL is trimmed back to the video. A watch URL arrived at from a rail
    click carries `&list=`, `&index=`, a `&t=` seek offset and a `&pp=` tracking
    blob; keeping them would make two captures of the same video look like two
    different sources, and the blob is per-session noise nobody can read back.
  */
  assert.deepEqual(
    resolveListCaptureTarget(
      "https://www.youtube.com/watch?v=IHZwWFHWa-w&list=PL1&index=3&t=42s&pp=abcd"
    ),
    {
      platform: "youtube",
      pageType: "watch_related",
      sourceQuery: "https://www.youtube.com/watch?v=IHZwWFHWa-w",
      videoId: "IHZwWFHWa-w"
    }
  )
})

test("everything else is not a list page", () => {
  assert.equal(resolveListCaptureTarget("https://www.youtube.com/"), null)
  assert.equal(
    resolveListCaptureTarget("https://www.youtube.com/@3blue1brown"),
    null
  )
  assert.deepEqual(
    resolveListCaptureTarget("https://www.tiktok.com/search?q=garage&lang=en"),
    {
      platform: "tiktok",
      pageType: "search",
      sourceQuery: "https://www.tiktok.com/search?q=garage"
    }
  )
  assert.deepEqual(
    resolveListCaptureTarget("https://www.tiktok.com/tag/mealprep"),
    {
      platform: "tiktok",
      pageType: "search",
      sourceQuery: "https://www.tiktok.com/tag/mealprep"
    }
  )
  assert.deepEqual(
    resolveListCaptureTarget(
      "https://www.instagram.com/explore/tags/mealprep/"
    ),
    {
      platform: "instagram",
      pageType: "search",
      sourceQuery: "https://www.instagram.com/explore/tags/mealprep/"
    }
  )
  assert.equal(isDeepLinkTargetPage("https://www.youtube.com/feed/you"), false)
  assert.equal(isDeepLinkTargetPage(SEARCH), true)
  assert.equal(isDeepLinkTargetPage(WATCH), true)
})

/* -------------------------------------------------------- opening itself */

test("a tab opened AT a list page expands the panel", () => {
  // history.length === 1: nothing navigated here from inside this tab, so the
  // tab exists because something outside opened it — the war-room deep link.
  assert.equal(
    shouldAutoExpand({
      href: SEARCH,
      historyLength: 1,
      navigationType: "navigate"
    }),
    true
  )
  assert.equal(
    shouldAutoExpand({
      href: WATCH,
      historyLength: 1,
      navigationType: "navigate"
    }),
    true
  )
})

test("browsing YouTube does not expand anything", () => {
  // Every SPA hop pushes a history entry. A panel that popped open on each one
  // is an overlay nobody consented to.
  assert.equal(
    shouldAutoExpand({
      href: WATCH,
      historyLength: 4,
      navigationType: "navigate"
    }),
    false
  )
})

test("a reload is not an arrival", () => {
  /*
    A deep-linked tab keeps history.length === 1 forever. Without this, the
    panel would reopen on every F5 and there would be no way to dismiss it.
  */
  assert.equal(
    shouldAutoExpand({
      href: SEARCH,
      historyLength: 1,
      navigationType: "reload"
    }),
    false
  )
  assert.equal(
    shouldAutoExpand({
      href: SEARCH,
      historyLength: 1,
      navigationType: "back_forward"
    }),
    false
  )
})

test("a page with no list on it never expands, however it was reached", () => {
  assert.equal(
    shouldAutoExpand({
      href: "https://www.youtube.com/@3blue1brown",
      historyLength: 1,
      navigationType: "navigate"
    }),
    false
  )
})

test("a browser that reports no navigation type still answers", () => {
  // Old browsers and restricted contexts: the history length alone decides.
  assert.equal(shouldAutoExpand({ href: SEARCH, historyLength: 1 }), true)
  assert.equal(shouldAutoExpand({ href: SEARCH, historyLength: 9 }), false)
})
