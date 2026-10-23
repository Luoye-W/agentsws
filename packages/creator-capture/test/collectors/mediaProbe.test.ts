/** 移植自 agentsws-extension `test/contents/mediaProbe.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Orientation and duration are the two capture fields with no honest default:
 * every platform has a shape it "usually" is, and a guess is indistinguishable
 * from a measurement once it is stored. These tests pin the refusals as
 * tightly as the answers.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import { measureMedia } from "../../src/collectors/mediaProbe.js"

test("a taller frame is portrait, a wider one is landscape", () => {
  assert.equal(
    measureMedia({ width: 1080, height: 1920 }).orientation,
    "portrait"
  )
  assert.equal(
    measureMedia({ width: 1920, height: 1080 }).orientation,
    "landscape"
  )
})

test("a square claims neither orientation", () => {
  assert.equal(measureMedia({ width: 1080, height: 1080 }).orientation, null)
})

test("an unloaded player reports no orientation rather than a default", () => {
  // videoWidth/videoHeight are 0 until the element has metadata.
  assert.equal(measureMedia({ width: 0, height: 0 }).orientation, null)
  assert.equal(measureMedia({}).orientation, null)
  assert.equal(
    measureMedia({ width: Number.NaN, height: Number.NaN }).orientation,
    null
  )
})

test("duration rounds to whole seconds", () => {
  assert.equal(measureMedia({ duration: 17.4 }).durationSeconds, 17)
  assert.equal(measureMedia({ duration: 1051.6 }).durationSeconds, 1052)
})

test("the three non-durations are all rejected", () => {
  // 0:00 is the pre-playback placeholder, NaN precedes metadata, and a live
  // stream reports Infinity. None of them is a length.
  assert.equal(measureMedia({ duration: 0 }).durationSeconds, null)
  assert.equal(measureMedia({ duration: Number.NaN }).durationSeconds, null)
  assert.equal(
    measureMedia({ duration: Number.POSITIVE_INFINITY }).durationSeconds,
    null
  )
  assert.equal(measureMedia({ duration: -5 }).durationSeconds, null)
  assert.equal(measureMedia({}).durationSeconds, null)
})

test("a sub-second clip rounds away rather than being reported as zero", () => {
  assert.equal(measureMedia({ duration: 0.4 }).durationSeconds, null)
  assert.equal(measureMedia({ duration: 0.6 }).durationSeconds, 1)
})

test("shape and length are measured independently", () => {
  // A photo post has an orientation and no duration; an audio-only or
  // not-yet-sized player can have the reverse.
  assert.deepEqual(measureMedia({ width: 1080, height: 1350 }), {
    orientation: "portrait",
    durationSeconds: null
  })
  assert.deepEqual(measureMedia({ duration: 32 }), {
    orientation: null,
    durationSeconds: 32
  })
})
