/**
 * WP240：网站读不到时**尽快照实说**是哪一种，并且进度跟着动。
 *
 * 起因（Fable 10-06 真机）：贴了一家开着访问密码的 Shopify 正式店，「正在读你的网站，已经读了 0 页」
 * 挂了 75 秒以上，没有错误、没有提示——用户只能干等。这里钉住：
 *
 * 1. 首页是 Shopify 密码页 → **当场停**（不再去抓那十来页，它们全会被跳到密码页），
 *    `failure_kind: 'password'`，密码页上的字不被当成政策 / 关于我们；
 * 2. 填了店铺密码 → 解开那一下只拿回 cookie，之后每一页都带着它；密码不进任何结果；
 * 3. 密码不对 → `password_wrong`；
 * 4. 429 / 403 → `blocked`；域名解析不了 → `dns`；
 * 5. 每抓完一页就回一次 `onPage`（界面「已经读了 N 页」跟着动）。
 *
 * 全程不联网：抓取口是内存夹具。
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeBrand,
  analyzeSite,
  failureKindOf,
  isShopifyPasswordPage,
  type PageFetch,
  type StorefrontPasswordPost,
  unlockShopifyStorefront,
} from '../src/index.js'
import { fixture, SHOP, SHOP_PAGES } from './fixtures.js'

/** 测试里唯一的一串店铺密码。断言就盯着它不出现在任何结果里。 */
const STORE_PASSWORD = 'fake-store-pass-wp240'
const DIGEST = 'storefront_digest=abc123'

/**
 * 一家开着访问密码的店：没带 cookie 的每一页都落到 `/password`（与真店一样 302 后 200）；
 * 带着解开后的 cookie 就是正常页面。
 */
function lockedShop(): { fetch: PageFetch; calls: { url: string; cookie?: string }[] } {
  const calls: { url: string; cookie?: string }[] = []
  const fetch: PageFetch = async (url, init) => {
    const cookie = init.headers.cookie
    calls.push({ url, ...(cookie === undefined ? {} : { cookie }) })
    if (url.endsWith('/robots.txt'))
      return { ok: true, status: 200, url, text: async () => fixture('robots.txt') }
    if (cookie?.includes(DIGEST) !== true)
      return {
        ok: true,
        status: 200,
        url: `${SHOP}/password`,
        text: async () => fixture('shop-password.html'),
      }
    const name = SHOP_PAGES[url]
    if (name === undefined) return { ok: false, status: 404, url, text: async () => '' }
    return { ok: true, status: 200, url, text: async () => fixture(name) }
  }
  return { fetch, calls }
}

/** 提交店铺密码那一下的替身：对的密码种 `storefront_digest`，错的什么都不种。 */
function passwordPost(): { post: StorefrontPasswordPost; bodies: string[] } {
  const bodies: string[] = []
  const post: StorefrontPasswordPost = async (_url, init) => {
    bodies.push(init.body)
    const ok = new URLSearchParams(init.body).get('password') === STORE_PASSWORD
    return {
      status: 302,
      headers: {
        get: () => null,
        getSetCookie: () =>
          ok
            ? [`${DIGEST}; path=/; HttpOnly`, '_shopify_y=xyz; path=/']
            : ['_shopify_y=xyz; path=/'],
      },
    }
  }
  return { post, bodies }
}

describe('WP240 · 认出 Shopify 密码页', () => {
  it('看落点或看页面内容都认得出；普通店铺首页不误判', () => {
    expect(isShopifyPasswordPage('<html></html>', `${SHOP}/password`)).toBe(true)
    expect(isShopifyPasswordPage(fixture('shop-password.html'))).toBe(true)
    expect(isShopifyPasswordPage(fixture('shop-home.html'), `${SHOP}/`)).toBe(false)
  })
})

describe('WP240 · 店铺开着访问密码', () => {
  it('没填密码：读到首页就停，照实说「店铺有访问密码」，不往下抓', async () => {
    const shop = lockedShop()
    const seen: string[] = []
    const out = await analyzeSite(shop.fetch, `${SHOP}/`, {
      onPage: (p) => {
        seen.push(p.url)
      },
    })
    expect(out.failure_kind).toBe('password')
    expect(out.password_protected).toBe(true)
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0]?.ok).toBe(false)
    expect(out.pages[0]?.reason).toContain('访问密码')
    // 只敲了 robots 与首页两下——不会再去敲那十来页（每一页都会被跳到密码页）
    expect(shop.calls.map((c) => c.url)).toEqual([`${SHOP}/robots.txt`, `${SHOP}/`])
    // 密码页上的字不被当成任何东西
    expect(out.profile).toEqual({})
    expect(seen).toEqual([`${SHOP}/`])
  })

  it('填了对的密码：解开一次，之后每一页都带着 cookie；密码不出现在任何结果里', async () => {
    const shop = lockedShop()
    const { post, bodies } = passwordPost()
    const out = await analyzeBrand(shop.fetch, [`${SHOP}/`], {
      storefrontPassword: STORE_PASSWORD,
      unlock: (origin, password) => unlockShopifyStorefront(post, origin, password),
      keepHtml: true,
    })
    expect(out.failure_kind).toBeUndefined()
    expect(out.password_protected).toBe(true)
    expect(out.profile.brand_name?.value).toBe('Nordvik Supply')
    expect(out.pages.filter((p) => p.ok).length).toBeGreaterThan(5)
    // 解开之后的每一次 GET 都带着 cookie（robots 那一下在解开之前）
    const after = shop.calls.slice(2)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((c) => c.cookie?.includes(DIGEST) === true)).toBe(true)
    // 密码只进了那一个 POST 体
    expect(bodies).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain(STORE_PASSWORD)
    expect(JSON.stringify(shop.calls)).not.toContain(STORE_PASSWORD)
  })

  it('密码不对：password_wrong，同样当场停', async () => {
    const shop = lockedShop()
    const { post } = passwordPost()
    const out = await analyzeSite(shop.fetch, `${SHOP}/`, {
      storefrontPassword: 'not-it',
      unlock: (origin, password) => unlockShopifyStorefront(post, origin, password),
    })
    expect(out.failure_kind).toBe('password_wrong')
    expect(out.pages).toHaveLength(1)
    expect(JSON.stringify(out)).not.toContain('not-it')
  })
})

describe('WP240 · 被拦与域名问题', () => {
  it('首页 429：blocked，只敲两下就停', async () => {
    const calls: string[] = []
    const fetch: PageFetch = async (url) => {
      calls.push(url)
      return { ok: false, status: 429, text: async () => '' }
    }
    const out = await analyzeSite(fetch, `${SHOP}/`)
    expect(out.failure_kind).toBe('blocked')
    expect(calls).toHaveLength(2)
  })

  it('域名解析不了：dns（Node 的 fetch 把真原因放在 cause.code 上）', async () => {
    const fetch: PageFetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND shop.invalid'), {
          code: 'ENOTFOUND',
        }),
      })
    }
    const out = await analyzeSite(fetch, 'https://shop.invalid/')
    expect(out.failure_kind).toBe('dns')
    expect(out.pages[0]?.reason).toContain('域名')
  })

  it('failureKindOf：超时 / 别的连不上', () => {
    expect(failureKindOf(new DOMException('The operation was aborted', 'TimeoutError'))).toBe(
      'timeout',
    )
    expect(failureKindOf(new Error('socket hang up'))).toBe('unreachable')
  })
})

describe('WP240 · 进度跟着动', () => {
  it('每抓完一页回一次 onPage，次数与最后的 pages 一样多', async () => {
    const shop = lockedShop()
    const { post } = passwordPost()
    let count = 0
    const out = await analyzeBrand(shop.fetch, [`${SHOP}/`], {
      onPage: () => {
        count += 1
      },
      storefrontPassword: STORE_PASSWORD,
      unlock: (origin, password) => unlockShopifyStorefront(post, origin, password),
    })
    expect(count).toBe(out.pages.length)
    expect(count).toBeGreaterThan(5)
  })
})
