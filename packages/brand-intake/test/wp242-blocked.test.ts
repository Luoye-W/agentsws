/**
 * WP242：网站拦了自动读取时照实说是哪一种（Fable 10-06：Shopify 对脚本回 429，读到 0 页没说原因）。
 * 430（Shopify 机器人防护）、回 200 但其实是一张验证页，都算「被拦」；连不上时带上真原因的错误码。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeSite,
  causeCodeOf,
  fetchPage,
  isBotChallengePage,
  type PageFetch,
} from '../src/index.js'
import { SHOP } from './fixtures.js'

describe('WP242 · 被拦的几种样子', () => {
  it('首页 430（Shopify 机器人防护）：blocked，那一句带状态码', async () => {
    const fetch: PageFetch = async () => ({ ok: false, status: 430, text: async () => '' })
    const out = await analyzeSite(fetch, `${SHOP}/`)
    expect(out.failure_kind).toBe('blocked')
    expect(out.pages[0]?.reason).toContain('430')
  })

  it('回 200 但是验证页：当被拦，不把验证页当首页解析', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body>…</body></html>'
    const fetch: PageFetch = async (url) =>
      url.endsWith('/robots.txt')
        ? { ok: false, status: 404, text: async () => '' }
        : { ok: true, status: 200, text: async () => challenge }
    const out = await analyzeSite(fetch, `${SHOP}/`)
    expect(out.failure_kind).toBe('blocked')
    expect(out.pages.every((p) => !p.ok)).toBe(true)
    expect(isBotChallengePage(challenge)).toBe(true)
    // 普通页面挂着防护脚本不算
    expect(
      isBotChallengePage(
        '<title>Nordvik Supply</title><script src="/cdn-cgi/challenge-platform/x.js"></script>',
      ),
    ).toBe(false)
  })

  it('连不上：那一句带上 cause.code（ECONNRESET），不只是 fetch failed', async () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })
    expect(causeCodeOf(err)).toBe('ECONNRESET')
    const page = await fetchPage(async () => {
      throw err
    }, `${SHOP}/`)
    expect(page.failure_kind).toBe('unreachable')
    expect(page.reason).toContain('ECONNRESET')
  })
})
