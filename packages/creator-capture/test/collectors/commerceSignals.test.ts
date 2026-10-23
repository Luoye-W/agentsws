/** 移植自 agentsws-extension `test/contents/commerceSignals.test.ts` @ 57fca9c（决策 1739 A：采集器测试随采集器一起搬；只改 import 路径）。 */
/**
 * WP130：视频 / 帖子页上的「含付费推广」与带货入口（本仓新写）。
 * 夹具是自造的最小片段，元素名照各平台公开页面的写法。
 */
import { expect, test } from 'vitest'

import { readCommerceSignals, withCommerceSignals } from '../../src/collectors/commerceSignals.js'
import { parseHTML } from '../helpers/dom'

const dom = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document

test('YouTube：付费推广浮层 + 商品货架 → 两个都是 true', () => {
  const root = dom(`
    <div id="movie_player"><div class="ytp-paid-content-overlay"><div class="ytp-paid-content-overlay-text">Includes paid promotion</div></div></div>
    <ytd-merch-shelf-renderer><div>Desk Craft store</div></ytd-merch-shelf-renderer>`)
  expect(readCommerceSignals('youtube', root)).toEqual({ paidPromotion: true, shoppable: true })
})

test('YouTube：中文界面只剩那一句字也认；贴片广告的「广告」角标不算', () => {
  expect(readCommerceSignals('youtube', dom('<span>包含付费推广内容</span>'))).toEqual({
    paidPromotion: true,
  })
  expect(readCommerceSignals('youtube', dom('<span class="ad-badge">广告</span><span>Ad</span>'))).toEqual({})
})

test('正文里提一句不算：只认短小的整段标签', () => {
  const root = dom('<div id="description"><span>This video is not a paid partnership, I bought everything myself.</span></div>')
  expect(readCommerceSignals('youtube', root)).toEqual({})
})

test('TikTok：Paid partnership 标签 + 商品锚点', () => {
  const root = dom(`
    <div data-e2e="browse-video-desc"><span>5 lunches for $20</span></div>
    <div><span>Paid partnership</span></div>
    <a data-e2e="product-anchor" href="https://shop.tiktok.com/view/product/1729"><span>Bento box set</span></a>`)
  expect(readCommerceSignals('tiktok', root)).toEqual({ paidPromotion: true, shoppable: true })
})

test('Instagram：「Paid partnership with 品牌」+ 商品标签', () => {
  const root = dom(`
    <header><div><a href="/kitchenjane/">kitchenjane</a></div><div><span>Paid partnership with brandco</span></div></header>
    <a href="/shopping/product/123456/">Lunch box</a>`)
  expect(readCommerceSignals('instagram', root)).toEqual({ paidPromotion: true, shoppable: true })
})

test('什么都没看到：一格都不报（不写 false）；快照读不到原样回 null', () => {
  const root = dom('<h1>Just a video</h1>')
  expect(readCommerceSignals('tiktok', root)).toEqual({})
  const snap = withCommerceSignals({ contentId: 'v1' }, 'tiktok', root)
  expect(snap).toEqual({ contentId: 'v1' })
  expect(snap).not.toHaveProperty('paidPromotion')
  expect(withCommerceSignals(null, 'tiktok', root)).toBeNull()
})
