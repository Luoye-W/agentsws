/** 移植自 agentsws-extension `test/contents/youtubeInitialData.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Reading identities out of the page's own inline data.
 *
 * Three things are pinned here, and every one of them is a way this could
 * quietly produce wrong rows rather than no rows:
 *
 *   · the payload is cut out of the script by COUNTING BRACES, because a video
 *     title containing `{` is not rare and a lastIndexOf-based cut breaks on
 *     the first one;
 *   · a payload that describes a DIFFERENT video is refused outright — after an
 *     in-page navigation YouTube leaves the old one in the DOM, and trusting it
 *     would attach the previous rail's channels to this rail's videos;
 *   · the channel is found by SHAPE (a browseEndpoint with a UC id), not by the
 *     six-segment path it happens to sit at today.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  parseInitialDataObject,
  readWatchInitialData
} from "../../src/collectors/youtubeInitialData.js"

/** The real nesting, trimmed: avatar → onTap → innertubeCommand → browse. */
function lockup(videoId: string, browseId: string, handle?: string) {
  return {
    lockupViewModel: {
      contentId: videoId,
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      metadata: {
        lockupMetadataViewModel: {
          title: { content: `Video ${videoId}` },
          image: {
            decoratedAvatarViewModel: {
              rendererContext: {
                commandContext: {
                  onTap: {
                    innertubeCommand: {
                      browseEndpoint: {
                        browseId,
                        canonicalBaseUrl: handle
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function payload(videoId: string, items: unknown[]) {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    contents: {
      twoColumnWatchNextResults: {
        secondaryResults: {
          secondaryResults: {
            results: [{ itemSectionRenderer: { contents: items } }]
          }
        }
      }
    }
  }
}

function script(object: unknown, trailer = "") {
  return `var ytInitialData = ${JSON.stringify(object)};${trailer}`
}

test("the object is cut out by counting braces, not by guessing", () => {
  const parsed = parseInitialDataObject(
    script(
      { title: 'a } brace } in a { title "', nested: { deep: true } },
      'window.ytcfg.set({"x":1});'
    )
  )
  assert.equal((parsed as any)?.nested?.deep, true)
  assert.equal((parsed as any)?.title, 'a } brace } in a { title "')
})

test("a script with no assignment yields nothing rather than throwing", () => {
  assert.equal(parseInitialDataObject("window.foo = 1;"), null)
  assert.equal(parseInitialDataObject("var ytInitialData = not json"), null)
})

test("videos map to the channel that published them", () => {
  const data = readWatchInitialData(
    script(
      payload("seed0000", [
        lockup("v1", "UCYO_jab_esuFRV4b17AJtAw", "/@3blue1brown"),
        lockup("v2", "UCbuildbay00000000000", "/@buildbay"),
        { continuationItemRenderer: {} }
      ])
    ),
    "seed0000"
  )

  assert.equal(data.fresh, true)
  assert.deepEqual(data.byVideoId.get("v1"), {
    externalId: "UCYO_jab_esuFRV4b17AJtAw",
    handle: "@3blue1brown"
  })
  // No canonical URL is not a missing identity — the UC id is the identity.
  assert.deepEqual(
    readWatchInitialData(
      script(payload("seed0000", [lockup("v3", "UCnohandle0000000000")])),
      "seed0000"
    ).byVideoId.get("v3"),
    { externalId: "UCnohandle0000000000" }
  )
})

test("the old compactVideoRenderer resolves the same way", () => {
  const data = readWatchInitialData(
    script(
      payload("seed0000", [
        {
          compactVideoRenderer: {
            videoId: "old1",
            longBylineText: {
              runs: [
                {
                  navigationEndpoint: {
                    browseEndpoint: {
                      browseId: "UClegacy000000000000",
                      canonicalBaseUrl: "/@legacy"
                    }
                  }
                }
              ]
            }
          }
        }
      ])
    ),
    "seed0000"
  )
  assert.deepEqual(data.byVideoId.get("old1"), {
    externalId: "UClegacy000000000000",
    handle: "@legacy"
  })
})

test("a payload about another video is refused, not used stale", () => {
  /*
    This is the SPA case, verified live: click a rail entry and the inline
    script still describes the video the tab was opened on. Using it would put
    the previous rail's channels on this rail's videos — rows that are wrong
    rather than missing, which is the worse of the two failures.
  */
  const data = readWatchInitialData(
    script(payload("firstVideo", [lockup("v1", "UCYO_jab_esuFRV4b17AJtAw")])),
    "secondVideo"
  )
  assert.equal(data.fresh, false)
  assert.equal(data.byVideoId.size, 0)
})

test("no script and no video id are answers, not errors", () => {
  assert.equal(readWatchInitialData(null, "seed0000").fresh, false)
  assert.equal(
    readWatchInitialData(script(payload("x", [])), null).fresh,
    false
  )
})

test("a browseId that is not a channel is not an identity", () => {
  // Playlists, hashtags and shelves all carry browseEndpoints too (VL…, FE…).
  const data = readWatchInitialData(
    script(payload("seed0000", [lockup("v1", "VLPL1234567890")])),
    "seed0000"
  )
  assert.equal(data.byVideoId.size, 0)
})
