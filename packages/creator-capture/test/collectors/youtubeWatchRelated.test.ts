/** 移植自 agentsws-extension `test/contents/youtubeWatchRelated.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * What a watch page's similar column yields, and what it must refuse to yield.
 *
 * The fixtures are cut down from the live page (verified 2026-08-13): the class
 * names and the shape of the metadata rows are exactly as YouTube renders them,
 * the scaffolding around them thrown away. Two details in there are the whole
 * reason this file is long:
 *
 *   · the rail prints a view count with NO word attached — "9.4M", not "9.4M
 *     views" — so a pattern that looks for the word finds nothing;
 *   · the rail carries NO channel link, so identity has to be joined on from
 *     elsewhere and a row without one must not be capturable.
 */
import assert from "node:assert/strict"
import { test } from "vitest"
import { parseHTML } from "../helpers/dom"

import {
  collectWatchRelatedEntries,
  isYouTubeWatchPage,
  railChannelCount,
  railVideoRefFromHref,
  readWatchSeedIdentity,
  watchRelatedCandidates,
  youTubeWatchId,
  type WatchRelatedEntry
} from "../../src/collectors/youtubeWatchRelated.js"

function dom(html: string) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
}

/** One rail entry in the layout YouTube serves today. */
function lockup(input: {
  videoId: string
  title: string
  channel: string
  views?: string
  age?: string
  duration?: string
  list?: string
}) {
  const href = `/watch?v=${input.videoId}${
    input.list ? `&list=${input.list}` : ""
  }`
  return `
    <yt-lockup-view-model class="lockup ytLockupViewModelWrapper">
      <a class="ytLockupViewModelContentImage" href="${href}">
        <yt-thumbnail-view-model><img src="https://i.ytimg.com/x.jpg"></yt-thumbnail-view-model>
        <badge-shape><div class="badge-shape-wiz__text">${
          input.duration ?? "20:33"
        }</div></badge-shape>
      </a>
      <yt-lockup-metadata-view-model>
        <yt-decorated-avatar-view-model><yt-avatar-shape><img src=""></yt-avatar-shape></yt-decorated-avatar-view-model>
        <h3><a class="ytLockupMetadataViewModelTitle" href="${href}"
               aria-label="${input.title} 20 minutes"><span>${input.title}</span></a></h3>
        <yt-content-metadata-view-model>
          <div class="ytContentMetadataViewModelMetadataRow"><span>${
            input.channel
          }</span></div>
          <div class="ytContentMetadataViewModelMetadataRow">
            <span aria-label="views">${input.views ?? "9.4M"}</span>
            <span aria-label="ago">${input.age ?? "8y ago"}</span>
          </div>
        </yt-content-metadata-view-model>
      </yt-lockup-metadata-view-model>
    </yt-lockup-view-model>`
}

function rail(items: string) {
  return `<div id="secondary"><div id="related">
    <ytd-watch-next-secondary-results-renderer>${items}</ytd-watch-next-secondary-results-renderer>
  </div></div>`
}

/* ------------------------------------------------------------------ routing */

test("a watch page is a /watch URL with a v=, and nothing else is", () => {
  assert.equal(
    youTubeWatchId("https://www.youtube.com/watch?v=aircAruvnKk"),
    "aircAruvnKk"
  )
  // The extras a rail click adds ride along and change nothing.
  assert.equal(
    youTubeWatchId(
      "https://www.youtube.com/watch?v=IHZwWFHWa-w&list=PLZH&index=2&t=90s"
    ),
    "IHZwWFHWa-w"
  )
  assert.equal(youTubeWatchId("https://www.youtube.com/watch"), null)
  assert.equal(
    youTubeWatchId("https://www.youtube.com/results?search_query=x"),
    null
  )
  assert.equal(youTubeWatchId("https://vimeo.com/watch?v=abc"), null)
  assert.equal(isYouTubeWatchPage("https://www.youtube.com/@someone"), false)
})

test("a video id comes off a rail href, relative or absolute", () => {
  assert.deepEqual(railVideoRefFromHref("/watch?v=abc12345"), {
    videoId: "abc12345",
    url: "https://www.youtube.com/watch?v=abc12345"
  })
  assert.deepEqual(
    railVideoRefFromHref("https://www.youtube.com/watch?v=abc12345&t=12"),
    { videoId: "abc12345", url: "https://www.youtube.com/watch?v=abc12345" }
  )
  assert.equal(railVideoRefFromHref("/@someone"), null)
  assert.equal(railVideoRefFromHref(undefined), null)
})

test("a generated mix belongs to nobody and is refused", () => {
  // RD… is YouTube's own auto-playlist. It has a thumbnail and a title like
  // any other row, and filing it as a creator's video would attribute a
  // machine's playlist to a person.
  assert.equal(railVideoRefFromHref("/watch?v=abc12345&list=RDabc12345"), null)
  // A real playlist is still a real video by a real creator.
  assert.deepEqual(railVideoRefFromHref("/watch?v=abc12345&list=PL123"), {
    videoId: "abc12345",
    url: "https://www.youtube.com/watch?v=abc12345"
  })
})

/* ------------------------------------------------------------------ parsing */

test("one rail entry yields the six things the page prints", () => {
  const document = dom(
    rail(
      lockup({
        videoId: "IHZwWFHWa-w",
        title: "Gradient descent, how neural networks learn",
        channel: "3Blue1Brown",
        views: "9.4M",
        age: "8y ago",
        duration: "20:33"
      })
    )
  )
  const [entry] = collectWatchRelatedEntries(document)

  assert.equal(entry.videoId, "IHZwWFHWa-w")
  assert.equal(entry.url, "https://www.youtube.com/watch?v=IHZwWFHWa-w")
  assert.equal(entry.title, "Gradient descent, how neural networks learn")
  assert.equal(entry.channelName, "3Blue1Brown")
  assert.equal(entry.viewCountText, "9.4M")
  assert.equal(entry.publishedText, "8y ago")
  assert.equal(entry.durationText, "20:33")
  // Nobody said whose channel this is. The page did not print it.
  assert.equal(entry.channelExternalId, undefined)
})

test("the count has no word attached, and is still not the upload age", () => {
  /*
    The trap this pins: BOTH strings in the second metadata row start with a
    digit, neither says "views", and a positional read gets it right until the
    day YouTube swaps the order. They are told apart by the age's own shape.
  */
  const document = dom(
    rail(
      lockup({
        videoId: "a1b2c3d4",
        title: "Epoxy vs containment mats",
        channel: "CoatingsLab",
        views: "12万",
        age: "3个月前"
      })
    )
  )
  const [entry] = collectWatchRelatedEntries(document)
  assert.equal(entry.viewCountText, "12万")
  assert.equal(entry.publishedText, "3个月前")
})

test("the title is read as text, not off the aria-label", () => {
  // YouTube glues the duration onto the accessible name ("… 20 minutes"). A
  // title with a stray number in it scores against the seed's words with a
  // stray number in the bag.
  const document = dom(
    rail(
      lockup({
        videoId: "a1b2c3d4",
        title: "Modern garage overhaul ep.2",
        channel: "BuildBayNorth"
      })
    )
  )
  const [entry] = collectWatchRelatedEntries(document)
  assert.equal(entry.title, "Modern garage overhaul ep.2")
})

test("the old compact renderer still parses", () => {
  const document = dom(
    rail(`
      <ytd-compact-video-renderer>
        <a id="thumbnail" href="/watch?v=old12345"></a>
        <span id="video-title" title="An older layout">An older layout</span>
        <ytd-channel-name id="channel-name"><div id="text">LegacyChannel</div></ytd-channel-name>
        <div id="metadata-line"><span>1.2M views</span><span>2 years ago</span></div>
      </ytd-compact-video-renderer>`)
  )
  const [entry] = collectWatchRelatedEntries(document)
  assert.equal(entry.videoId, "old12345")
  assert.equal(entry.channelName, "LegacyChannel")
  assert.equal(entry.viewCountText, "1.2M views")
  assert.equal(entry.publishedText, "2 years ago")
})

test("an ad slot in the rail is not a rail entry", () => {
  const document = dom(
    rail(
      `<ytd-ad-slot-renderer>${lockup({
        videoId: "spon1234",
        title: "Sponsored thing",
        channel: "Brand"
      })}</ytd-ad-slot-renderer>` +
        lockup({
          videoId: "real1234",
          title: "A real video",
          channel: "RealChannel"
        })
    )
  )
  const entries = collectWatchRelatedEntries(document)
  assert.deepEqual(
    entries.map((entry) => entry.videoId),
    ["real1234"]
  )
})

test("the description panel is not the rail", () => {
  // #secondary holds the description, the merch shelf and the donation card as
  // well as the rail, and every one of them has anchors in it.
  const document = dom(`
    <div id="secondary">
      <ytd-watch-next-secondary-results-renderer>
        ${lockup({ videoId: "rail1234", title: "In the rail", channel: "A" })}
      </ytd-watch-next-secondary-results-renderer>
      <ytd-structured-description-content-renderer>
        ${lockup({
          videoId: "desc1234",
          title: "In the description",
          channel: "B"
        })}
      </ytd-structured-description-content-renderer>
    </div>`)
  const entries = collectWatchRelatedEntries(document)
  assert.deepEqual(
    entries.map((entry) => entry.videoId),
    ["rail1234"]
  )
})

/* --------------------------------------------------------------- the seed */

test("the seed is the channel whose video is playing", () => {
  const document = dom(`
    <ytd-video-owner-renderer>
      <a class="yt-simple-endpoint" href="/@3blue1brown"><img></a>
      <div id="channel-name"><div id="text">3Blue1Brown</div></div>
      <div id="owner-sub-count">8.54M subscribers</div>
    </ytd-video-owner-renderer>`)
  assert.deepEqual(readWatchSeedIdentity(document), {
    externalId: "@3blue1brown",
    handle: "@3blue1brown",
    name: "3Blue1Brown"
  })
})

test("the microformat answers when the owner block does not", () => {
  const document = dom(`
    <span itemprop="author">
      <link itemprop="url" href="http://www.youtube.com/@detaildavetv">
      <link itemprop="name" content="DetailDaveTV">
    </span>`)
  assert.deepEqual(readWatchSeedIdentity(document), {
    externalId: "@detaildavetv",
    handle: "@detaildavetv",
    name: "DetailDaveTV"
  })
})

/* --------------------------------------------------------- channel dedupe */

function entry(
  videoId: string,
  channel: string,
  identity?: { externalId: string; handle?: string }
): WatchRelatedEntry {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `${channel} video ${videoId}`,
    channelName: channel,
    channelExternalId: identity?.externalId,
    channelHandle: identity?.handle
  }
}

test("three videos by one channel are one candidate with three videos", () => {
  const { candidates } = watchRelatedCandidates([
    entry("v1", "BuildBay", {
      externalId: "UCbuildbay0000",
      handle: "@buildbay"
    }),
    entry("v2", "BuildBay", {
      externalId: "UCbuildbay0000",
      handle: "@buildbay"
    }),
    entry("v3", "BuildBay", {
      externalId: "UCbuildbay0000",
      handle: "@buildbay"
    })
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].externalId, "UCbuildbay0000")
  assert.equal(candidates[0].videos?.length, 3)
  // A rail row is a byline, exactly like a search page's video result.
  assert.equal(candidates[0].source, "video_attribution")
})

test("a row with no identity is counted, not invented", () => {
  /*
    The one rule worth breaking the feature over: a display name is not an
    identity, and sending one where an externalId belongs would mint a third
    key form into a library whose handle-keyed and UC-keyed rows already never
    merge. Unnamed rows are dropped and COUNTED, so the panel can say where
    they went.
  */
  const { candidates, unidentified } = watchRelatedCandidates([
    entry("v1", "Named", { externalId: "UCnamed0000000" }),
    entry("v2", "Anonymous"),
    entry("v3", "Anonymous")
  ])
  assert.deepEqual(
    candidates.map((candidate) => candidate.externalId),
    ["UCnamed0000000"]
  )
  assert.equal(unidentified, 2)
})

test("the seed's own back catalogue is not a similar creator", () => {
  const { candidates } = watchRelatedCandidates(
    [
      entry("v1", "3Blue1Brown", {
        externalId: "UCYO_jab_esuFRV4b17AJtAw",
        handle: "@3blue1brown"
      }),
      entry("v2", "BuildBay", {
        externalId: "UCbuildbay0000",
        handle: "@buildbay"
      })
    ],
    { seedExternalId: "@3blue1brown", seedHandle: "@3blue1brown" }
  )
  assert.deepEqual(
    candidates.map((candidate) => candidate.handle),
    ["@buildbay"]
  )
})

test("the button's count is names, minus the seed's own back catalogue", () => {
  /*
    The FAB counts by display NAME because resolving identities costs a 700KB
    parse a page nobody has clicked on has not earned. What it must not do is
    promise rows the panel then drops — so the seed is excluded here too, by
    the only thing the button has to match on.
  */
  const entries = [
    entry("v1", "3Blue1Brown"),
    entry("v2", "3Blue1Brown"),
    entry("v3", "Tyriel Wood - VR Tech"),
    { ...entry("v4", ""), channelName: undefined }
  ]
  assert.equal(railChannelCount(entries), 3)
  assert.equal(railChannelCount(entries, "3Blue1Brown"), 2)
  // Case and stray whitespace are the page's, not the user's.
  assert.equal(railChannelCount(entries, "  3blue1brown "), 2)
})

test("no more than five videos ride on one candidate", () => {
  const identity = { externalId: "UCbuildbay0000", handle: "@buildbay" }
  const { candidates } = watchRelatedCandidates(
    ["v1", "v2", "v3", "v4", "v5", "v6", "v7"].map((id) =>
      entry(id, "BuildBay", identity)
    )
  )
  assert.equal(candidates[0].videos?.length, 5)
})
