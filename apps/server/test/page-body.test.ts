/**
 * WP166：模型写初稿前读页面正文——店铺只读口优先，读不到再抓公开网址（只抓自家域名、遵 robots）。
 * 全程替身：店铺连接是假的，抓取是只认夹具的 fetch。
 */
import type { PageFetch } from '@agentsws/brand-intake'
import { describe, expect, it } from 'vitest'
import { allowedHost, createPageBodyReader, mainHtml, storePageOf } from '../src/page-body.js'

describe('WP166 · 读页面正文', () => {
  it('网址认得出店里哪一类、handle 是什么（多语言子目录先去掉）', () => {
    expect(storePageOf('https://shop.co/pages/about-us')).toEqual({
      kind: 'page',
      handle: 'about-us',
    })
    expect(storePageOf('https://shop.co/en-gb/products/tote?variant=1')).toEqual({
      kind: 'product',
      handle: 'tote',
    })
    expect(storePageOf('https://shop.co/blogs/guide/best-mount')).toEqual({
      kind: 'article',
      handle: 'best-mount',
    })
    expect(storePageOf('https://shop.co/collections/chargers')).toEqual({
      kind: 'collection',
      handle: 'chargers',
    })
    expect(storePageOf('https://shop.co/')).toBeUndefined()
  })

  it('只抓自家域名；IP、localhost、内网名、保留域名一律不抓', () => {
    const ours = ['nordvolt.com']
    expect(allowedHost('nordvolt.com', ours)).toBe(true)
    expect(allowedHost('www.nordvolt.com', ours)).toBe(true)
    expect(allowedHost('shop.nordvolt.com', ours)).toBe(true)
    expect(allowedHost('evil.com', ours)).toBe(false)
    expect(allowedHost('nordvolt.com.evil.com', ours)).toBe(false)
    expect(allowedHost('127.0.0.1', ['127.0.0.1'])).toBe(false)
    expect(allowedHost('localhost', ['localhost'])).toBe(false)
    expect(allowedHost('shop.example', ['shop.example'])).toBe(false)
  })

  it('有 <main> 只要 <main>（导航与页脚不占长度）', () => {
    expect(mainHtml('<body><nav>menu</nav><main><p>Body</p></main><footer>f</footer></body>')).toBe(
      '<p>Body</p>',
    )
  })

  it('店里读得到：用店铺连接的只读 Action 按 handle 查正文', async () => {
    const calls: { id: string; input: unknown }[] = []
    const read = createPageBodyReader({
      connect: {
        actions: async () => [{ id: 'shopify_admin.list_pages' }],
        issueToken: async () => ({ token: 't' }),
        execute: async <T>(id: string, input: unknown): Promise<T> => {
          calls.push({ id, input })
          return { pages: [{ handle: 'about-us', body_html: '<p>We make chargers.</p>' }] } as T
        },
      },
      connection: () => ({ id: 'c1', service: 'shopify_admin' }),
    })
    const got = await read({
      url: 'https://nordvolt.com/pages/about-us',
      domains: ['nordvolt.com'],
    })
    expect(got).toEqual({ text: '<p>We make chargers.</p>', from: 'store' })
    expect(calls).toEqual([{ id: 'shopify_admin.list_pages', input: { query: 'handle:about-us' } }])
  })

  it('没连店：抓公开网址（带我们的 UA、遵 robots）；外站与 robots 不让的不抓', async () => {
    const fetched: string[] = []
    const fetch: PageFetch = async (url) => {
      fetched.push(url)
      if (url.endsWith('/robots.txt'))
        return { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /private' }
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body><main><h1>Guide</h1><p>Pick 65W.</p></main></body></html>',
      }
    }
    const read = createPageBodyReader({ connection: () => undefined, fetch })
    const ours = ['nordvolt.com']
    expect(await read({ url: 'https://nordvolt.com/blogs/g/x', domains: ours })).toEqual({
      text: '<h1>Guide</h1><p>Pick 65W.</p>',
      from: 'web',
    })
    expect(await read({ url: 'https://nordvolt.com/private/x', domains: ours })).toBeUndefined()
    const before = fetched.length
    expect(await read({ url: 'https://evil.com/x', domains: ours })).toBeUndefined()
    expect(fetched.length).toBe(before)
  })
})
