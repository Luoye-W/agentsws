/**
 * WP502（决策 1764 B）：存入红人池时记下近期作品的原作品链接。
 * - 页面上读：采集器跑完之后按封面 / 标题在同一页找回链接（YouTube 标题链接、TikTok 封面链接、Instagram 短码）；
 * - 只认这个平台上的一条作品，规整掉分享 / 跟踪参数；
 * - 页面上没读到时从封面地址（YouTube）/ 短码（Instagram）推；TikTok 推不出来就不带。
 */
import { beforeAll, describe, expect, test } from 'vitest'
import type { PageCapture } from '../../src/page/capture.js'
import { creatorCapturePageExpression } from '../../src/page-script.js'
import { contentUrlOf, derivedContentUrlOf } from '../../src/wire/contentUrl.js'
import { creatorSaveBodyOf } from '../../src/wire/creatorSave.js'
import { ingestPlanOf } from '../../src/wire/plan.js'
import { FAKE_PAGES, fakePageHtml } from '../fixtures/pages/index.js'

declare const jsdom: { reconfigure(o: { url: string }): void }

const NOW = '2026-10-24T08:00:00.000Z'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent
    },
  })
})

function fakePage(name: string): PageCapture {
  const page = FAKE_PAGES.find((p) => p.name === name)
  if (page === undefined) throw new Error(name)
  jsdom.reconfigure({ url: page.url })
  document.open()
  document.write(fakePageHtml(page))
  document.close()
  // biome-ignore lint/security/noGlobalEval: ego 也是把这一段表达式交给浏览器求值
  return globalThis.eval(creatorCapturePageExpression({ lang: 'en' })) as PageCapture
}

describe('页面上读到的作品链接', () => {
  test('YouTube：按标题找回 /watch?v=', () => {
    const cap = fakePage('youtube-channel')
    expect(cap.creator_item_urls?.[0]).toBe('https://www.youtube.com/watch?v=dfVid000001')
    const body = ingestPlanOf(cap, { now: NOW }).creator_save
    expect(body?.recent_items?.[0]).toMatchObject({
      title: 'The ultimate desk setup guide',
      url: 'https://www.youtube.com/watch?v=dfVid000001',
    })
    expect(
      body?.recent_items?.every((r) => r.url?.startsWith('https://www.youtube.com/watch')),
    ).toBe(true)
  })

  test('TikTok：按封面找回视频 / 图文链接（推不出来的平台全靠这一步）', () => {
    const cap = fakePage('tiktok-profile')
    const items = ingestPlanOf(cap, { now: NOW }).creator_save?.recent_items ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.url).toBe('https://www.tiktok.com/@lunchfixture/video/7000000000000000201')
    expect(items.some((r) => r.url?.includes('/photo/'))).toBe(true)
  })

  test('Instagram：帖子 / Reel 链接规整成不带用户名的地址', () => {
    const cap = fakePage('instagram-profile')
    const items = ingestPlanOf(cap, { now: NOW }).creator_save?.recent_items ?? []
    expect(items[0]?.url).toBe('https://www.instagram.com/p/CFixtureP01/')
    expect(items.find((r) => r.title === 'CFixtureR03')?.url).toBe(
      'https://www.instagram.com/reel/CFixtureR03/',
    )
  })

  test('没读到链接时：YouTube 从封面推、Instagram 从短码推、TikTok 不带', () => {
    const yt = creatorSaveBodyOf(
      {
        platform: 'youtube',
        recentItems: [
          { title: 'A', thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' },
          { title: 'B' },
        ],
      } as never,
      NOW,
    )
    expect(yt.recent_items?.[0]?.url).toBe('https://www.youtube.com/watch?v=abcdefghijk')
    expect(yt.recent_items?.[1]?.url).toBeUndefined()
    const tt = creatorSaveBodyOf(
      {
        platform: 'tiktok',
        recentItems: [{ title: 'clip', thumbnailUrl: 'https://p16.example/t1.png' }],
      } as never,
      NOW,
    )
    expect(tt.recent_items?.[0]?.url).toBeUndefined()
  })
})

describe('contentUrlOf：只认一条作品', () => {
  test.each([
    [
      'https://www.youtube.com/watch?v=abcdefghijk&t=10s&si=x',
      'https://www.youtube.com/watch?v=abcdefghijk',
    ],
    ['https://youtu.be/abcdefghijk?si=share', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://m.youtube.com/shorts/abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk'],
    [
      'https://www.tiktok.com/@some.one/video/7000000000000000001?is_from_webapp=1',
      'https://www.tiktok.com/@some.one/video/7000000000000000001',
    ],
    ['https://www.instagram.com/someone/reels/Cabc123/', 'https://www.instagram.com/reel/Cabc123/'],
  ])('%s', (input, want) => {
    expect(contentUrlOf(input)).toBe(want)
  })

  test.each([
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/watch?v=short',
    'javascript:alert(1)',
    'https://evil.example/watch?v=abcdefghijk',
    'https://www.tiktok.com/@someone',
    'https://www.instagram.com/someone/',
  ])('不认 %s', (input) => {
    expect(contentUrlOf(input)).toBeUndefined()
  })

  test('平台对不上不认', () => {
    expect(contentUrlOf('https://www.youtube.com/watch?v=abcdefghijk', 'tiktok')).toBeUndefined()
  })

  test('derived：封面地址不是 ytimg 的不推', () => {
    expect(
      derivedContentUrlOf('youtube', {
        thumbnail_url: 'https://evil.example/vi/abcdefghijk/x.jpg',
      }),
    ).toBeUndefined()
  })
})
