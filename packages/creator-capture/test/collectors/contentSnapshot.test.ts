/** 移植自 agentsws-extension `test/contents/contentSnapshot.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * What leaves the extension for the two content endpoints.
 *
 * `orientation` / `durationSeconds` are ADDITIVE fields: today's server strips
 * unknown keys (both routes parse with a plain `z.object`, which strips rather
 * than rejects), so sending them costs nothing — but sending a null we never
 * measured would teach a future server that we looked and found nothing, which
 * is a different and false claim.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  isoDurationSeconds,
  toContentCapturePayload,
  toContentObservationPayload,
  type ContentSnapshot
} from "../../src/kol/utils/contentSnapshot.js"

function snapshot(overrides: Partial<ContentSnapshot> = {}): ContentSnapshot {
  return {
    platform: "tiktok",
    contentId: "7401234567890123456",
    contentType: "video",
    title: "A clip",
    url: "https://www.tiktok.com/@someone/video/7401234567890123456",
    orientation: null,
    durationSeconds: null,
    author: { externalId: "123456", handle: "someone" },
    pageUrl: "https://www.tiktok.com/@someone/video/7401234567890123456",
    ...overrides
  }
}

test("a measured shape and length ride along on the observation", () => {
  const payload = toContentObservationPayload(
    snapshot({ orientation: "portrait", durationSeconds: 41 })
  )
  assert.equal(payload?.orientation, "portrait")
  assert.equal(payload?.durationSeconds, 41)
})

test("an unmeasured shape is absent, not null", () => {
  const payload = toContentObservationPayload(snapshot())
  assert.ok(payload)
  assert.equal("orientation" in payload, false)
  assert.equal("durationSeconds" in payload, false)
})

test("the tenant capture keeps the measurement even on an older server", () => {
  // Top level is what a future server reads; rawSignals is persisted verbatim
  // today, so the measurement survives the strip either way.
  const payload = toContentCapturePayload(
    snapshot({ orientation: "landscape", durationSeconds: 1051 })
  )
  assert.equal(payload?.orientation, "landscape")
  assert.equal(payload?.durationSeconds, 1051)
  assert.deepEqual(
    (payload?.rawSignals as Record<string, unknown>).orientation,
    "landscape"
  )
  assert.equal(
    (payload?.rawSignals as Record<string, unknown>).durationSeconds,
    1051
  )
})

test("the public observation carries no comment text, whatever else it grows", () => {
  /*
    The red line, written as a test rather than as a comment nobody re-reads.

    The public library takes metrics about a piece of content and never the
    words strangers wrote under it (policy §12.4): those belong to one tenant,
    under one tenant's consent, and the shared pool has no consent
    conversation to attach them to. The observation builder takes no comments
    argument at all, so the only way this regresses is somebody adding one —
    and this is where that stops.
  */
  const payload = toContentObservationPayload(
    snapshot({ orientation: "portrait", durationSeconds: 41 })
  )
  assert.ok(payload)
  assert.equal(JSON.stringify(payload).includes("capturedComments"), false)
  // Nor under another name. `stats.comments` is a COUNT and is allowed; any
  // other key that talks about comments on this body is not.
  for (const key of Object.keys(payload)) {
    assert.equal(/comment/i.test(key), false, `unexpected key: ${key}`)
  }
})

test("an unidentifiable author still blocks both payloads", () => {
  const orphan = snapshot({ author: {} })
  assert.equal(toContentObservationPayload(orphan), null)
  // Comments cannot smuggle an orphan through either: no author, no save.
  assert.equal(toContentCapturePayload(orphan), null)
  assert.equal(toContentCapturePayload(orphan, [{ text: "hello" }]), null)
})

test("ISO durations convert to seconds, and non-durations to null", () => {
  assert.equal(isoDurationSeconds("PT17M31S"), 1051)
  assert.equal(isoDurationSeconds("PT1H2M5S"), 3725)
  assert.equal(isoDurationSeconds("PT45S"), 45)
  assert.equal(isoDurationSeconds("PT0S"), null)
  assert.equal(isoDurationSeconds(undefined), null)
  assert.equal(isoDurationSeconds("17:31"), null)
})
