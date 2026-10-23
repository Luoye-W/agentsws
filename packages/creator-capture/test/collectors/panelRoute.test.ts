/** 移植自 agentsws-extension `test/contents/panelRoute.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Which card a URL gets.
 *
 * The bug this pins: a TikTok video opened FROM a profile keeps the profile's
 * own path prefix (/@handle/video/123), so a router that asks "is this a
 * profile?" before "is this a video?" answers "profile" for a page showing a
 * video — and the creator scraper then fails on the overlay DOM and tells the
 * user the page is not a profile. The order below is the fix, and it is worth
 * a test precisely because both answers look plausible in isolation.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  isCapturablePage,
  panelRouteKey,
  resolvePanelRoute
} from "../../src/collectors/panelRoute.js"

test("a TikTok video permalink is content, not the profile it hangs off", () => {
  const route = resolvePanelRoute(
    "https://www.tiktok.com/@kenyadriveit/video/7401234567890123456"
  )
  assert.deepEqual(route, {
    kind: "content",
    platform: "tiktok",
    subject: "7401234567890123456"
  })
})

test("TikTok photo posts route to the content card too", () => {
  assert.equal(
    resolvePanelRoute(
      "https://www.tiktok.com/@someone/photo/7400000000000000000"
    )?.kind,
    "content"
  )
})

test("a bare TikTok profile is still the creator card", () => {
  assert.deepEqual(resolvePanelRoute("https://www.tiktok.com/@kenyadriveit"), {
    kind: "creator",
    platform: "tiktok",
    subject: "/@kenyadriveit"
  })
})

test("YouTube watch and channel URLs land on their own cards", () => {
  assert.deepEqual(
    resolvePanelRoute("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    { kind: "content", platform: "youtube", subject: "dQw4w9WgXcQ" }
  )
  assert.deepEqual(resolvePanelRoute("https://www.youtube.com/@mkbhd/videos"), {
    kind: "creator",
    platform: "youtube",
    subject: "/@mkbhd"
  })
})

test("Instagram permalinks beat the username segment in front of them", () => {
  assert.equal(
    resolvePanelRoute("https://www.instagram.com/p/C1abcdEFghi/")?.kind,
    "content"
  )
  assert.equal(
    resolvePanelRoute("https://www.instagram.com/reel/C1abcdEFghi/")?.kind,
    "content"
  )
  assert.deepEqual(resolvePanelRoute("https://www.instagram.com/nasa/"), {
    kind: "creator",
    platform: "instagram",
    subject: "/nasa"
  })
})

test("pages we cannot capture from route nowhere", () => {
  assert.equal(resolvePanelRoute("https://www.youtube.com/"), null)
  assert.equal(resolvePanelRoute("https://www.tiktok.com/foryou"), null)
  assert.equal(resolvePanelRoute("not a url"), null)
  assert.equal(isCapturablePage("https://example.com/"), false)
})

test("a profile and one of its videos never share a React key", () => {
  const profile = resolvePanelRoute("https://www.tiktok.com/@kenyadriveit")
  const video = resolvePanelRoute(
    "https://www.tiktok.com/@kenyadriveit/video/7401234567890123456"
  )
  assert.ok(profile && video)
  assert.notEqual(panelRouteKey(profile), panelRouteKey(video))
})

test("profile tabs keep one key, so the card survives the switch", () => {
  const home = resolvePanelRoute("https://www.youtube.com/@mkbhd")
  const videos = resolvePanelRoute("https://www.youtube.com/@mkbhd/videos")
  assert.ok(home && videos)
  assert.equal(panelRouteKey(home), panelRouteKey(videos))
})
