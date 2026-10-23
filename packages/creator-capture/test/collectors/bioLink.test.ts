/** 移植自 agentsws-extension `test/contents/bioLink.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * Link-in-bio URL rules and the submission payload.
 *
 * The scrape itself needs a DOM and gets exercised on live pages; what is
 * testable here is the part that decides WHETHER a page is somebody's link
 * page at all — which is the difference between attaching linktr.ee/pricing to
 * a creator and attaching their actual page.
 */
import assert from "node:assert/strict"
import { test } from "vitest"

import {
  bioLinkPlatform,
  bioLinkSlug,
  isBioLinkPage,
  toBioLinkObservationPayload,
  type BioLinkSnapshot
} from "../../src/kol/utils/bioLink.js"
import { bioLinkCacheKey, expandBioLinks } from "../../src/kol/bioLinkCache.js"

test("both hosts are recognised, with or without www", () => {
  assert.equal(bioLinkPlatform("https://linktr.ee/someone"), "linktree")
  assert.equal(bioLinkPlatform("https://www.linktr.ee/someone"), "linktree")
  assert.equal(bioLinkPlatform("https://beacons.ai/someone"), "beacons")
  assert.equal(bioLinkPlatform("https://example.com/someone"), null)
})

test("a one-segment path is a slug", () => {
  assert.equal(bioLinkSlug("https://linktr.ee/kenyadriveit"), "kenyadriveit")
  assert.equal(
    bioLinkSlug("https://beacons.ai/kenyadriveit?src=ig"),
    "kenyadriveit"
  )
})

test("the marketing site is not somebody's link page", () => {
  // Attaching /pricing to a creator would be worse than capturing nothing.
  assert.equal(bioLinkSlug("https://linktr.ee/pricing"), null)
  assert.equal(bioLinkSlug("https://linktr.ee/"), null)
  assert.equal(bioLinkSlug("https://beacons.ai/discover"), null)
  assert.equal(isBioLinkPage("https://linktr.ee/s/onboarding"), false)
})

function snapshot(overrides: Partial<BioLinkSnapshot> = {}): BioLinkSnapshot {
  return {
    platform: "linktree",
    slug: "someone",
    sourceUrl: "https://linktr.ee/someone",
    links: [{ title: "Shop", url: "https://shop.example.com/" }],
    socialLinks: [],
    emails: [],
    ...overrides
  }
}

test("empty collections are omitted from the payload, not sent empty", () => {
  const payload = toBioLinkObservationPayload(snapshot())
  assert.equal("socialLinks" in payload, false)
  assert.equal("emails" in payload, false)
  assert.equal("bio" in payload, false)
  assert.equal(payload.links.length, 1)
  assert.equal(payload.platform, "linktree")
  assert.ok(payload.capturedAt)
})

test("what we found does travel", () => {
  const payload = toBioLinkObservationPayload(
    snapshot({
      emails: ["hi@example.com"],
      socialLinks: [
        { type: "INSTAGRAM", url: "https://instagram.com/someone" }
      ],
      bio: "Nairobi car reviews"
    })
  )
  assert.deepEqual(payload.emails, ["hi@example.com"])
  assert.equal(payload.socialLinks?.[0].type, "INSTAGRAM")
  assert.equal(payload.bio, "Nairobi car reviews")
})

test("the cache key survives www, trailing slashes and query strings", () => {
  const canonical = bioLinkCacheKey("https://linktr.ee/Someone")
  assert.equal(bioLinkCacheKey("https://www.linktr.ee/someone/"), canonical)
  assert.equal(
    bioLinkCacheKey("https://linktr.ee/someone?utm_source=ig"),
    canonical
  )
  assert.equal(bioLinkCacheKey("https://example.com/someone"), null)
})

test("expansion appends destinations and keeps the link the creator published", () => {
  const expanded = expandBioLinks(
    [{ title: "Links", url: "https://linktr.ee/someone" }],
    [
      {
        cachedAt: new Date().toISOString(),
        snapshot: snapshot({
          socialLinks: [
            { type: "INSTAGRAM", url: "https://instagram.com/someone" }
          ]
        })
      }
    ]
  )
  assert.deepEqual(
    expanded.map((link) => link.url),
    [
      "https://linktr.ee/someone",
      "https://shop.example.com/",
      "https://instagram.com/someone"
    ]
  )
})

test("expansion never duplicates a link the profile already showed", () => {
  const expanded = expandBioLinks(
    [
      { url: "https://linktr.ee/someone" },
      { url: "https://shop.example.com/" }
    ],
    [{ cachedAt: new Date().toISOString(), snapshot: snapshot() }]
  )
  assert.equal(expanded.length, 2)
})

test("no cached page leaves the links exactly as captured", () => {
  const links = [{ url: "https://linktr.ee/someone" }]
  assert.deepEqual(expandBioLinks(links, [undefined]), links)
})
