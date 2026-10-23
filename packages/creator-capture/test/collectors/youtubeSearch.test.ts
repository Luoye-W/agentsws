/** 移植自 agentsws-extension `test/contents/youtubeSearch.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * What a search-results page yields, and what it must refuse to yield.
 *
 * These run against fixture DOM parsed by linkedom, so what they pin is the
 * SHAPE of the markup the collector was written for — the two result families
 * (a channel's own card, a video's byline), and the several places YouTube
 * hides a subscriber count. The fixtures are cut down from the real thing:
 * the ids and class names the collector reads are left exactly as they appear,
 * the scaffolding around them thrown away.
 *
 * Three of these are guards rather than features, and they are the reason the
 * file exists:
 *
 *   · a video's THUMBNAIL must never be filed as the creator's avatar;
 *   · a description that mentions "200K subscribers" is not a subscriber count;
 *   · one creator on the page eight times is one creator, not eight rows of
 *     the day's capture allowance.
 */
import assert from "node:assert/strict"
import { test } from "vitest"
import { parseHTML } from "../helpers/dom"

import {
  channelRefFromHref,
  collectYouTubeSearchCreators,
  dedupeSearchCreators,
  isYouTubeSearchPage,
  MAX_VIDEOS_PER_CREATOR,
  videoRefFromHref,
  youTubeSearchQuery,
  type SearchCreatorCandidate
} from "../../src/kol/utils/youtubeSearch.js"

function dom(html: string) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
}

/* ------------------------------------------------------------------ routing */

test("the query comes off a results URL and nowhere else", () => {
  assert.equal(
    youTubeSearchQuery(
      "https://www.youtube.com/results?search_query=ai+dev+tools"
    ),
    "ai dev tools"
  )
  // Filters and sort params ride along on the same URL and change nothing.
  assert.equal(
    youTubeSearchQuery(
      "https://www.youtube.com/results?search_query=vlog&sp=EgIQAg%253D%253D"
    ),
    "vlog"
  )
  assert.equal(youTubeSearchQuery("https://www.youtube.com/@someone"), null)
  assert.equal(
    youTubeSearchQuery("https://www.youtube.com/watch?v=abc123"),
    null
  )
  assert.equal(youTubeSearchQuery("https://www.youtube.com/results"), null)
  assert.equal(
    youTubeSearchQuery("https://example.com/results?search_query=x"),
    null
  )
  assert.equal(youTubeSearchQuery("not a url"), null)
  assert.equal(
    isYouTubeSearchPage(
      "https://www.youtube.com/results?search_query=skincare"
    ),
    true
  )
})

test("a channel href yields an identity; anything else yields none", () => {
  assert.deepEqual(channelRefFromHref("/@fireship"), {
    externalId: "@fireship",
    handle: "@fireship",
    url: "https://www.youtube.com/@fireship"
  })
  assert.deepEqual(channelRefFromHref("/channel/UCsBjURrPoezykLs9EqgamOA"), {
    externalId: "UCsBjURrPoezykLs9EqgamOA",
    url: "https://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA"
  })
  // Absolute form, as a lockup sometimes renders it.
  assert.equal(
    channelRefFromHref("https://www.youtube.com/@fireship")?.externalId,
    "@fireship"
  )
  assert.equal(channelRefFromHref("/watch?v=abc"), null)
  assert.equal(channelRefFromHref("/playlist?list=PL1"), null)
  assert.equal(channelRefFromHref("https://example.com/@fireship"), null)
  assert.equal(channelRefFromHref(undefined), null)
})

/* ------------------------------------------------------------- channel card */

/**
 * A channel result, copied from the live search page (2026-08-06) with the
 * traps intact:
 *
 *   · `#subscribers` holds the HANDLE and `#video-count` holds the SUBSCRIBER
 *     line — verified on youtube.com/results?search_query=mkbhd, where they
 *     read "@mkbhd" and "21.1M subscribers" respectively. Reading by id would
 *     have swapped a handle into a follower count.
 *   · the name appears TWICE inside `#channel-title` (the visible string and
 *     the tooltip), so anything that reads the container instead of the inner
 *     element gets "Fireship Fireship".
 */
const CHANNEL_RESULT = `
<ytd-channel-renderer>
  <a id="main-link" href="/@fireship">
    <div id="avatar-section">
      <yt-img-shadow id="avatar"><img src="https://yt3.ggpht.com/avatar-fireship=s88"></yt-img-shadow>
    </div>
    <div id="info-section">
      <ytd-channel-name id="channel-title">
        <div id="container">
          <div id="text-container"><yt-formatted-string id="text" title="Fireship">Fireship</yt-formatted-string></div>
        </div>
        <tp-yt-paper-tooltip>Fireship</tp-yt-paper-tooltip>
      </ytd-channel-name>
      <div id="metadata">
        <span id="subscribers">@fireship</span>
        <span id="video-count">3.5M subscribers</span>
        <span id="extra">683 videos</span>
      </div>
      <yt-formatted-string id="description">High-intensity code tutorials for developers who want to build a startup with 200K subscribers worth of ambition.</yt-formatted-string>
    </div>
  </a>
</ytd-channel-renderer>`

test("a channel card gives the name, the handle, the counts and the avatar", () => {
  const [creator] = collectYouTubeSearchCreators(dom(CHANNEL_RESULT))
  assert.equal(creator.externalId, "@fireship")
  assert.equal(creator.handle, "@fireship")
  assert.equal(creator.displayName, "Fireship")
  assert.equal(creator.url, "https://www.youtube.com/@fireship")
  assert.equal(creator.avatarUrl, "https://yt3.ggpht.com/avatar-fireship=s88")
  assert.equal(creator.source, "channel_result")
})

test("the name is read once, not once per copy of it in the markup", () => {
  /*
    Caught on the live page before this shipped: `#channel-title` contains the
    visible name AND the tooltip, so a comma-separated selector list — which
    returns the first match in DOCUMENT order, i.e. the container — produced
    "Marques Brownlee Marques Brownlee". The selectors are tried one at a time
    now, and this fixture keeps the duplicate that proved it.
  */
  const [creator] = collectYouTubeSearchCreators(dom(CHANNEL_RESULT))
  assert.equal(creator.displayName, "Fireship")
})

test("the counts are matched by what they SAY, not by the id they sit under", () => {
  const [creator] = collectYouTubeSearchCreators(dom(CHANNEL_RESULT))
  // #subscribers holds "@fireship" on the live page; trusting it would have
  // filed a handle as a follower count.
  assert.equal(creator.subscriberCountText, "3.5M subscribers")
  assert.equal(creator.videoCountText, "683 videos")
})

test("a description mentioning subscribers is not a subscriber count", () => {
  const [creator] = collectYouTubeSearchCreators(dom(CHANNEL_RESULT))
  assert.ok(!creator.subscriberCountText?.includes("ambition"))
  assert.ok(!creator.displayName?.includes("High-intensity"))
})

test("a channel linked by UC id keeps the id as its identity", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <ytd-channel-renderer>
        <a id="main-link" href="/channel/UCsBjURrPoezykLs9EqgamOA">
          <ytd-channel-name id="channel-title"><yt-formatted-string id="text">Fireship</yt-formatted-string></ytd-channel-name>
          <span id="video-count">3.5M subscribers</span>
        </a>
      </ytd-channel-renderer>`)
  )
  assert.equal(creator.externalId, "UCsBjURrPoezykLs9EqgamOA")
  assert.equal(creator.handle, undefined)
  assert.equal(creator.key, "UCsBjURrPoezykLs9EqgamOA")
})

/* ----------------------------------------------------------- video bylines */

const VIDEO_RESULT = `
<ytd-video-renderer>
  <a id="thumbnail" href="/watch?v=abc123">
    <img src="https://i.ytimg.com/vi/abc123/hqdefault.jpg">
  </a>
  <div id="dismissible">
    <h3><a id="video-title" href="/watch?v=abc123">Next.js in 100 Seconds</a></h3>
    <div id="channel-info">
      <a class="yt-simple-endpoint" href="/@fireship"></a>
      <ytd-channel-name id="channel-name">
        <div id="text-container"><yt-formatted-string id="text"><a href="/@fireship">Fireship</a></yt-formatted-string></div>
      </ytd-channel-name>
    </div>
    <div id="metadata-line"><span>1.2M views</span><span>3 years ago</span></div>
  </div>
</ytd-video-renderer>`

test("a video result yields its author, tagged as a byline", () => {
  const [creator] = collectYouTubeSearchCreators(dom(VIDEO_RESULT))
  assert.equal(creator.externalId, "@fireship")
  assert.equal(creator.displayName, "Fireship")
  assert.equal(creator.source, "video_attribution")
})

test("a video's thumbnail is never filed as the creator's avatar", () => {
  /*
    The guard this whole file is worth writing for. The first, biggest and most
    obvious <img> in a video result is a still frame from the video; it would
    look entirely plausible in an avatar slot, and nobody would ever report it.
  */
  const [creator] = collectYouTubeSearchCreators(dom(VIDEO_RESULT))
  assert.equal(creator.avatarUrl, undefined)
})

test("the channel's own thumbnail on a video result IS taken", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <ytd-video-renderer>
        <a id="thumbnail" href="/watch?v=abc123"><img src="https://i.ytimg.com/vi/abc123/hqdefault.jpg"></a>
        <div id="channel-info">
          <yt-img-shadow id="channel-thumbnail"><img src="https://yt3.ggpht.com/avatar-fireship=s68"></yt-img-shadow>
          <ytd-channel-name id="channel-name"><yt-formatted-string id="text"><a href="/@fireship">Fireship</a></yt-formatted-string></ytd-channel-name>
        </div>
      </ytd-video-renderer>`)
  )
  assert.equal(creator.avatarUrl, "https://yt3.ggpht.com/avatar-fireship=s68")
})

test("the newer lockup layout is read the same way", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <yt-lockup-view-model class="lockup">
        <a class="yt-lockup-view-model-wiz__content-image" href="/watch?v=zzz"><img src="https://i.ytimg.com/vi/zzz/hq.jpg"></a>
        <div class="yt-lockup-metadata-view-model-wiz__text-container">
          <h3><a class="yt-lockup-metadata-view-model-wiz__title" href="/watch?v=zzz"><span>A very long video title that is not a channel name at all</span></a></h3>
          <div class="yt-content-metadata-view-model-wiz__metadata-row">
            <span><a href="/@mkbhd">Marques Brownlee</a></span>
          </div>
        </div>
      </yt-lockup-view-model>`)
  )
  assert.equal(creator.externalId, "@mkbhd")
  assert.equal(creator.displayName, "Marques Brownlee")
  assert.equal(creator.source, "video_attribution")
  assert.equal(creator.avatarUrl, undefined)
})

test("a result that names no channel is skipped, not guessed at", () => {
  const found = collectYouTubeSearchCreators(
    dom(`
      <ytd-video-renderer>
        <a id="thumbnail" href="/watch?v=nochannel"><img src="https://i.ytimg.com/vi/nochannel/hq.jpg"></a>
        <h3><a id="video-title" href="/watch?v=nochannel">An orphaned clip</a></h3>
      </ytd-video-renderer>
      <ytd-playlist-renderer><a href="/playlist?list=PL1">A mix</a></ytd-playlist-renderer>`)
  )
  assert.equal(found.length, 0)
})

/* -------------------------------------------------------------- the count */

test("one creator on the page many times is ONE row", () => {
  /*
    This is the number the FAB prints and the number of rows the upload spends
    from the day's allowance. A channel that ranks well appears once as a card
    and again under every one of its videos; counting the results instead of
    the creators would burn eight of fifty on one channel.
  */
  const page = dom(`
    ${VIDEO_RESULT}
    ${CHANNEL_RESULT}
    ${VIDEO_RESULT}
    <ytd-video-renderer>
      <a id="thumbnail" href="/watch?v=other"><img src="https://i.ytimg.com/vi/other/hq.jpg"></a>
      <ytd-channel-name id="channel-name"><yt-formatted-string id="text"><a href="/@theprimeagen">ThePrimeagen</a></yt-formatted-string></ytd-channel-name>
    </ytd-video-renderer>`)

  const found = collectYouTubeSearchCreators(page)
  assert.equal(found.length, 2)
  assert.deepEqual(
    found.map((creator) => creator.externalId).sort(),
    ["@fireship", "@theprimeagen"]
  )
})

test("merging keeps the richest facts and the stronger provenance", () => {
  // The byline is FIRST in DOM order and carries almost nothing; the card
  // comes later with the avatar and the counts. First-wins would have thrown
  // the card's data away and left the row tagged as a byline.
  const found = collectYouTubeSearchCreators(
    dom(`${VIDEO_RESULT}${CHANNEL_RESULT}`)
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].source, "channel_result")
  assert.equal(found[0].avatarUrl, "https://yt3.ggpht.com/avatar-fireship=s88")
  assert.equal(found[0].subscriberCountText, "3.5M subscribers")
  assert.equal(found[0].displayName, "Fireship")
})

test("the same creator under a UC id and a handle stays two rows", () => {
  // Two identities as far as this page is concerned. Linking them is the
  // server's job; doing it here would be a guess with no way to check itself.
  const candidates: SearchCreatorCandidate[] = [
    {
      key: "@fireship",
      externalId: "@fireship",
      handle: "@fireship",
      source: "video_attribution"
    },
    {
      key: "UCsBjURrPoezykLs9EqgamOA",
      externalId: "UCsBjURrPoezykLs9EqgamOA",
      source: "channel_result"
    }
  ]
  assert.equal(dedupeSearchCreators(candidates).length, 2)
})

/* ---------------------------------------------------------- video evidence */

test("a video id comes off the URL, and a Short is known by its route", () => {
  assert.deepEqual(videoRefFromHref("/watch?v=abc123"), {
    contentId: "abc123",
    url: "https://www.youtube.com/watch?v=abc123",
    isShort: false
  })
  // Search results carry a pile of tracking params around the id.
  assert.equal(
    videoRefFromHref("/watch?v=abc123&pp=ygUEbWtiaGQ%3D&t=42")?.contentId,
    "abc123"
  )
  assert.deepEqual(videoRefFromHref("/shorts/Xy_9-Zq"), {
    contentId: "Xy_9-Zq",
    url: "https://www.youtube.com/shorts/Xy_9-Zq",
    isShort: true
  })
  assert.equal(
    videoRefFromHref("https://www.youtube.com/watch?v=abc123")?.contentId,
    "abc123"
  )
  // Everything that is not a video, and nothing guessed from a path shape.
  assert.equal(videoRefFromHref("/watch"), null)
  assert.equal(videoRefFromHref("/watch?list=PL1"), null)
  assert.equal(videoRefFromHref("/@fireship"), null)
  assert.equal(videoRefFromHref("/playlist?list=PL1"), null)
  assert.equal(videoRefFromHref("https://evil.example/watch?v=abc123"), null)
  assert.equal(videoRefFromHref(undefined), null)
})

test("a video result carries its video as evidence for the creator", () => {
  const [creator] = collectYouTubeSearchCreators(dom(VIDEO_RESULT))
  assert.deepEqual(creator.videos, [
    {
      contentId: "abc123",
      url: "https://www.youtube.com/watch?v=abc123",
      title: "Next.js in 100 Seconds",
      viewsText: "1.2M views"
    }
  ])
})

test("a view count is never filed as a subscriber count", () => {
  // The two live one span apart on a video result, and one of them is a claim
  // about the channel while the other is a claim about one video.
  const [creator] = collectYouTubeSearchCreators(dom(VIDEO_RESULT))
  assert.equal(creator.subscriberCountText, undefined)
  assert.equal(creator.videos?.[0].viewsText, "1.2M views")
})

test("the duration badge is read, including the div-shaped new one", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <yt-lockup-view-model>
        <a class="yt-lockup-view-model-wiz__content-image" href="/watch?v=zzz">
          <img src="https://i.ytimg.com/vi/zzz/hq.jpg">
          <div class="badge-shape-wiz__text">12:34</div>
        </a>
        <h3><a class="yt-lockup-metadata-view-model-wiz__title" href="/watch?v=zzz"><span>Reviewing the thing</span></a></h3>
        <div class="yt-content-metadata-view-model-wiz__metadata-row">
          <span><a href="/@mkbhd">Marques Brownlee</a></span><span>1.2万次观看</span>
        </div>
      </yt-lockup-view-model>`)
  )
  assert.equal(creator.videos?.[0].durationText, "12:34")
  // As rendered, in whatever locale this user's YouTube is in.
  assert.equal(creator.videos?.[0].viewsText, "1.2万次观看")
  assert.equal(creator.videos?.[0].isShort, undefined)
})

test("a /shorts/ result is marked as one, badge or no badge", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <ytd-video-renderer>
        <a id="thumbnail" href="/shorts/aB3_x-9"><img src="https://i.ytimg.com/vi/aB3_x-9/hq.jpg"></a>
        <h3><a id="video-title" href="/shorts/aB3_x-9">60 second build</a></h3>
        <ytd-channel-name id="channel-name"><yt-formatted-string id="text"><a href="/@fireship">Fireship</a></yt-formatted-string></ytd-channel-name>
        <div id="metadata-line"><span>890K views</span></div>
      </ytd-video-renderer>`)
  )
  assert.equal(creator.videos?.[0].contentId, "aB3_x-9")
  assert.equal(creator.videos?.[0].isShort, true)
  assert.equal(
    creator.videos?.[0].url,
    "https://www.youtube.com/shorts/aB3_x-9"
  )
})

test("a Shorts badge marks a Short that is linked as an ordinary watch URL", () => {
  const [creator] = collectYouTubeSearchCreators(
    dom(`
      <ytd-video-renderer>
        <a id="thumbnail" href="/watch?v=badged"><img src="https://i.ytimg.com/vi/badged/hq.jpg"></a>
        <div class="badge-shape-wiz__text">Shorts</div>
        <ytd-channel-name id="channel-name"><yt-formatted-string id="text"><a href="/@fireship">Fireship</a></yt-formatted-string></ytd-channel-name>
      </ytd-video-renderer>`)
  )
  assert.equal(creator.videos?.[0].isShort, true)
})

test("a channel card is not evidence about any particular video", () => {
  const [creator] = collectYouTubeSearchCreators(dom(CHANNEL_RESULT))
  assert.equal(creator.videos, undefined)
})

function videoRow(id: string, views: string) {
  return `
    <ytd-video-renderer>
      <a id="thumbnail" href="/watch?v=${id}"><img src="https://i.ytimg.com/vi/${id}/hq.jpg"></a>
      <h3><a id="video-title" href="/watch?v=${id}">Video ${id}</a></h3>
      <ytd-channel-name id="channel-name"><yt-formatted-string id="text"><a href="/@fireship">Fireship</a></yt-formatted-string></ytd-channel-name>
      <div id="metadata-line"><span>${views}</span></div>
    </ytd-video-renderer>`
}

test("several videos by one creator become one row holding all of them", () => {
  const found = collectYouTubeSearchCreators(
    dom(`${videoRow("one", "10K views")}${videoRow("two", "2.5M views")}${CHANNEL_RESULT}`)
  )
  assert.equal(found.length, 1)
  assert.deepEqual(
    found[0].videos?.map((video) => video.contentId),
    ["one", "two"]
  )
  // The channel card still wins the identity fields it alone carries.
  assert.equal(found[0].subscriberCountText, "3.5M subscribers")
})

test("evidence stops at five videos, keeping the ones that ranked highest", () => {
  /*
    Five is a cap on the PAYLOAD, and the payload rides every row of a capture
    that can be a hundred creators wide. The first five in DOM order are the
    five YouTube ranked highest for this query, which is the part worth having.
  */
  const ids = ["a", "b", "c", "d", "e", "f", "g"]
  const found = collectYouTubeSearchCreators(
    dom(ids.map((id) => videoRow(id, "1K views")).join(""))
  )
  assert.equal(found.length, 1)
  assert.equal(found[0].videos?.length, MAX_VIDEOS_PER_CREATOR)
  assert.deepEqual(
    found[0].videos?.map((video) => video.contentId),
    ["a", "b", "c", "d", "e"]
  )
})

test("the same video seen twice on one page is one piece of evidence", () => {
  const found = collectYouTubeSearchCreators(
    dom(`${videoRow("twice", "1K views")}${videoRow("twice", "1K views")}`)
  )
  assert.equal(found[0].videos?.length, 1)
})

test("handles differing only in case are one creator", () => {
  const candidates: SearchCreatorCandidate[] = [
    {
      key: "@fireship",
      externalId: "@Fireship",
      handle: "@Fireship",
      source: "video_attribution"
    },
    {
      key: "@fireship",
      externalId: "@fireship",
      handle: "@fireship",
      displayName: "Fireship",
      source: "channel_result"
    }
  ]
  const merged = dedupeSearchCreators(candidates)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].displayName, "Fireship")
})
