/** 移植自 agentsws-extension `test/contents/tiktokVideo.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Which cover a TikTok capture keeps.
 *
 * The DOM half of the scraper needs a real page and gets exercised there; what
 * is decidable here — and what actually broke — is the ORDER: a 0.9.12 capture
 * reached the SaaS with an empty thumbnail because the only two rungs that
 * existed (the rehydrated struct, then `poster`) can both miss on the same
 * page. These tests pin every rung, and pin the one refusal that matters: the
 * profile's og:image must never be filed as a video's cover.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  resolveTikTokCover,
  tiktokVideoId,
  type TikTokCoverSources
} from "../../src/collectors/tiktokVideo.js"

const ID = "7401234567890123456"
const VIDEO_URL = `https://www.tiktok.com/@someone/video/${ID}`
const PROFILE_URL = "https://www.tiktok.com/@someone"

/** Shapes copied from a live page: signed CDN URLs, expiry params and all. */
const COVER =
  "https://p16-sign-sg.tiktokcdn.com/obj/tos-alisg-p-0037/aaa~tplv-photomode-video-cover:720:720.jpeg?x-expires=1754582400&x-signature=one%3D"
const ORIGIN_COVER =
  "https://p16-sign-sg.tiktokcdn.com/obj/tos-alisg-p-0037/bbb~tplv-photomode-video-cover:720:720.jpeg?x-expires=1754582400&x-signature=two%3D"
const DYNAMIC_COVER =
  "https://p16-sign-sg.tiktokcdn.com/obj/tos-alisg-p-0037/ccc~tplv-photomode-video-cover.webp?x-expires=1754582400&x-signature=three%3D"
const POSTER =
  "https://p19-sign.tiktokcdn-us.com/obj/tos-useast5-p-0068-tx/ddd?x-expires=1754582400&x-signature=four%3D"
const TILE_COVER =
  "https://p16-sign-sg.tiktokcdn.com/obj/tos-alisg-p-0037/eee~tplv-tiktokx-360p.jpeg?x-expires=1754582400&x-signature=five%3D"
const OG_IMAGE =
  "https://p16-sign.tiktokcdn-us.com/obj/tos-useast5-p-0068-tx/fff~tplv-tiktokx-cropcenter:300:400.jpeg?x-expires=1754582400&x-signature=six%3D"
const AVATAR =
  "https://p16-sign-sg.tiktokcdn.com/aweme/1080x1080/ggg.jpeg?x-expires=1754582400&x-signature=seven%3D"

function sources(overrides: TikTokCoverSources = {}): TikTokCoverSources {
  return { ...overrides }
}

test("the rehydrated cover wins over everything else on offer", () => {
  // The standalone permalink, fully server-rendered: every rung has an answer
  // and the item struct's own still is the one that is certainly this video.
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({
        cover: COVER,
        originCover: ORIGIN_COVER,
        dynamicCover: DYNAMIC_COVER,
        poster: POSTER,
        tileCover: TILE_COVER,
        ogImage: OG_IMAGE,
        ogUrl: VIDEO_URL
      })
    ),
    COVER
  )
})

test("originCover covers for a struct that carries no cover", () => {
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({ cover: "", originCover: ORIGIN_COVER, poster: POSTER })
    ),
    ORIGIN_COVER
  )
})

test("the player's poster answers when the struct is absent", () => {
  // Reaching a video FROM a profile leaves no video-detail scope at all.
  assert.equal(
    resolveTikTokCover(ID, sources({ poster: POSTER, ogUrl: PROFILE_URL })),
    POSTER
  )
})

test("the grid tile answers when the struct is absent and poster unset", () => {
  // The overlay route with a player that never got a poster attribute: the
  // profile behind it is still mounted and its tile is holding the cover.
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({
        poster: "",
        tileCover: TILE_COVER,
        ogImage: AVATAR,
        ogUrl: PROFILE_URL
      })
    ),
    TILE_COVER
  )
})

test("the profile's og:image is refused, however empty the alternative", () => {
  /*
    The regression this guard exists for. On the overlay route the head still
    describes the profile, so og:image is the creator's AVATAR — a picture that
    would look plausible in the content pool and be wrong in every row.
  */
  assert.equal(
    resolveTikTokCover(ID, sources({ ogImage: AVATAR, ogUrl: PROFILE_URL })),
    undefined
  )
  // A head that names a DIFFERENT video is refused for the same reason.
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({
        ogImage: OG_IMAGE,
        ogUrl: "https://www.tiktok.com/@someone/video/7409999999999999999"
      })
    ),
    undefined
  )
  // And so is one with no subject at all: unverifiable is not permission.
  assert.equal(
    resolveTikTokCover(ID, sources({ ogImage: OG_IMAGE })),
    undefined
  )
})

test("og:image is taken once the head is about this exact video", () => {
  assert.equal(
    resolveTikTokCover(ID, sources({ ogImage: OG_IMAGE, ogUrl: VIDEO_URL })),
    OG_IMAGE
  )
  // A canonical link is the same claim by another name; a photo post counts.
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({
        ogImage: OG_IMAGE,
        ogUrl: `https://www.tiktok.com/@someone/photo/${ID}`
      })
    ),
    OG_IMAGE
  )
})

test("the animated cover is a last resort, never a first choice", () => {
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({ dynamicCover: DYNAMIC_COVER, poster: POSTER })
    ),
    POSTER
  )
  assert.equal(
    resolveTikTokCover(ID, sources({ dynamicCover: DYNAMIC_COVER })),
    DYNAMIC_COVER
  )
})

test("nothing usable yields no cover rather than an invented one", () => {
  assert.equal(resolveTikTokCover(ID, sources()), undefined)
  // The shapes an empty rung actually arrives as: `poster` reads "" when the
  // attribute is absent, and a lazy tile can still be holding its placeholder.
  assert.equal(
    resolveTikTokCover(
      ID,
      sources({
        cover: "",
        poster: "",
        tileCover:
          "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=",
        ogImage: "/static/placeholder.jpg",
        ogUrl: VIDEO_URL
      })
    ),
    undefined
  )
})

test("the id parser backs the og guard, on both permalink shapes", () => {
  assert.equal(tiktokVideoId(VIDEO_URL), ID)
  assert.equal(tiktokVideoId(`https://www.tiktok.com/@someone/photo/${ID}`), ID)
  assert.equal(tiktokVideoId(PROFILE_URL), null)
  assert.equal(tiktokVideoId(`https://example.com/@someone/video/${ID}`), null)
  assert.equal(tiktokVideoId("not a url"), null)
})
