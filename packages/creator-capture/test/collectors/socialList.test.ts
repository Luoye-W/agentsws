/** 移植自 agentsws-extension `test/contents/socialList.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/__tests__/socialList.test.ts` @ 6259a1c（WP130 时是基于 1f824f1 的工作区未提交改动，旧仓 09-23 以 6259a1c 正式提交，内容逐字相同）。只改：node:test → vitest、linkedom → test/helpers/dom（同形）、import 路径。用例一个字没动。 */
import assert from "node:assert/strict"
import { test } from "vitest"
import { parseHTML } from "../helpers/dom"

import { collectSocialListCreators } from "../../src/collectors/socialList.js"

function dom(html: string) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
}

test("TikTok collects visible creators once and keeps content evidence", () => {
  const root = dom(`
    <div>
      <div data-e2e="search_top-item">
        <a href="/@foodmaker/video/7411111111111111111"><img src="thumb.jpg"></a>
        <strong data-e2e="video-views">36.1K</strong>
      </div>
      <div data-e2e="search-card-desc">
        <span data-e2e="new-desc-span">Meal prep for a week</span>
        <a href="/@foodmaker"><img src="avatar.jpg"><span data-e2e="search-card-user-unique-id">Food Maker</span></a>
      </div>
    </div>
    <article data-e2e="search-video-item">
      <a href="/@foodmaker/video/7422222222222222222">Another video</a>
    </article>
  `)
  const creators = collectSocialListCreators("tiktok", root)
  assert.equal(creators.length, 1)
  assert.equal(creators[0].handle, "foodmaker")
  assert.equal(creators[0].videos?.length, 2)
  assert.equal(creators[0].videos?.[0].title, "Meal prep for a week")
  assert.equal(creators[0].videos?.[0].viewsText, "36.1K")
  assert.equal(creators[0].displayName, "Food Maker")
  assert.equal(creators[0].avatarUrl, "avatar.jpg")
})

test("TikTok photo search results retain their content evidence", () => {
  const root = dom(
    `<div data-e2e="search_top-item"><a href="/@foodmaker/photo/7411111111111111111">photo</a></div>`
  )
  const creators = collectSocialListCreators("tiktok", root)
  assert.equal(creators[0]?.videos?.[0].contentId, "7411111111111111111")
  assert.equal(creators[0]?.videos?.[0].contentType, "post")
})

test("Instagram collects a tile only when its visible DOM identifies the author", () => {
  const root = dom(`
    <article><a href="/p/Cabc123/">Unknown author</a></article>
    <article>
      <a href="/reel/Cdef456/"><img alt="Photo by @kitchenjane"></a>
      <a href="/kitchenjane/">Jane</a>
    </article>
  `)
  const creators = collectSocialListCreators("instagram", root)
  assert.equal(creators.length, 1)
  assert.equal(creators[0].handle, "kitchenjane")
  assert.equal(creators[0].videos?.[0].contentId, "Cdef456")
  assert.equal(creators[0].videos?.[0].contentType, "reel")
})

test("off-platform links and unlabeled Instagram tiles are ignored", () => {
  const root = dom(
    `<a href="https://other.example/@somebody/video/123">no</a><a href="/p/Anon/">no author</a>`
  )
  assert.deepEqual(collectSocialListCreators("tiktok", root), [])
  assert.deepEqual(collectSocialListCreators("instagram", root), [])
})

test("navigation profiles and shared Instagram grid wrappers are not results", () => {
  const tiktok = dom('<nav><a href="/@myself">Me</a></nav>')
  assert.deepEqual(collectSocialListCreators("tiktok", tiktok), [])

  const instagram = dom(`
    <nav><a href="/myself/">Me</a></nav>
    <article>
      <a href="/p/One/">first</a>
      <a href="/p/Two/">second</a>
      <a href="/firstauthor/">First author</a>
    </article>
  `)
  assert.deepEqual(collectSocialListCreators("instagram", instagram), [])
})

test("Instagram can attribute separate tiles inside one grid article", () => {
  const root = dom(`
    <article>
      <div><a href="/p/One/"><img alt="Photo by @firstauthor"></a></div>
      <div><a href="/reel/Two/"><img alt="Video by @secondauthor"></a></div>
    </article>
  `)
  const creators = collectSocialListCreators("instagram", root)
  assert.deepEqual(
    creators.map((creator) => creator.handle),
    ["firstauthor", "secondauthor"]
  )
})
