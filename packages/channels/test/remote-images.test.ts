/**
 * WP204：「显示图片」的本机代取。全程不联网：fetch 与 DNS 都是替身。
 *
 * 钉住的是：只取公网 http(s)、内网 / 回环一律拒（SSRF）、跳转每一跳重判、只收图片、
 * 限大小，以及取不到的图**照旧挡着**。
 */
import { describe, expect, it } from 'vitest'
import {
  createRemoteImageLoader,
  type ImageFetch,
  inlineRemoteImages,
  isPrivateAddress,
  sanitizeMessageHtml,
} from '../src/index.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function fakeFetch(
  routes: Record<string, { status?: number; type?: string; body?: Uint8Array; location?: string }>,
): { fetch: ImageFetch; hits: string[] } {
  const hits: string[] = []
  const fetch: ImageFetch = async (url) => {
    hits.push(url)
    const r = routes[url] ?? { status: 404 }
    const headers = new Map<string, string>()
    if (r.type !== undefined) headers.set('content-type', r.type)
    if (r.location !== undefined) headers.set('location', r.location)
    return {
      status: r.status ?? 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      arrayBuffer: async () => (r.body ?? PNG).slice().buffer,
    }
  }
  return { fetch, hits }
}

const publicDns = async (): Promise<string[]> => ['93.184.216.34']

describe('远程图片代取（WP204）', () => {
  it('内网 / 回环 / 链路本地 / 组播都算不能碰的地址', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254'])
      expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ['::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1'])
      expect(isPrivateAddress(ip)).toBe(true)
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })

  it('公网上的图取回来内联成 data:；非图片、SVG、太大、非 http 都不收', async () => {
    const { fetch } = fakeFetch({
      'https://cdn.example/a.png': { type: 'image/png' },
      'https://cdn.example/page': { type: 'text/html' },
      'https://cdn.example/x.svg': { type: 'image/svg+xml' },
      'https://cdn.example/big.jpg': { type: 'image/jpeg', body: new Uint8Array(20) },
      'https://cdn.example/evil': { type: 'image/png" onerror="x' },
    })
    const load = createRemoteImageLoader({ fetch, lookup: publicDns, maxBytes: 10 })
    const ok = await load('https://cdn.example/a.png')
    expect(ok).toEqual({ ok: true, data_uri: 'data:image/png;base64,iVBORw==' })
    expect(await load('https://cdn.example/page')).toEqual({ ok: false, reason: 'not_image' })
    expect(await load('https://cdn.example/x.svg')).toEqual({ ok: false, reason: 'not_image' })
    expect(await load('https://cdn.example/big.jpg')).toEqual({ ok: false, reason: 'too_large' })
    expect(await load('https://cdn.example/evil')).toEqual({ ok: false, reason: 'not_image' })
    expect(await load('ftp://cdn.example/a.png')).toEqual({ ok: false, reason: 'bad_url' })
  })

  it('SSRF：指向本机 / 内网的地址（含解析到内网的域名、跳到内网的跳转）一律不去碰', async () => {
    const { fetch, hits } = fakeFetch({
      'https://cdn.example/r': { status: 302, location: 'http://127.0.0.1:4317/v1/me' },
    })
    const lookup = async (host: string): Promise<string[]> =>
      host === 'intranet.example' ? ['10.0.0.8'] : ['93.184.216.34']
    const load = createRemoteImageLoader({ fetch, lookup })
    expect((await load('http://127.0.0.1/p.gif')).ok).toBe(false)
    expect((await load('http://localhost/p.gif')).ok).toBe(false)
    expect((await load('http://[::1]/p.gif')).ok).toBe(false)
    expect((await load('https://intranet.example/p.gif')).ok).toBe(false)
    expect((await load('https://cdn.example:8443/p.gif')).ok).toBe(false)
    expect(await load('https://cdn.example/r')).toEqual({ ok: false, reason: 'blocked_host' })
    // 只真去碰过那一个公网地址；跳转目标没被请求
    expect(hits).toEqual(['https://cdn.example/r'])
  })

  it('正文内联：取到的换成 src="data:"，取不到的原样挡着；同一个地址只取一次', async () => {
    const { html } = sanitizeMessageHtml(
      '<p>hi</p><img src="https://cdn.example/a.png?x=1&amp;y=2"><img src="https://cdn.example/a.png?x=1&amp;y=2"><img src="https://gone.example/p.gif">',
    )
    const { fetch, hits } = fakeFetch({
      'https://cdn.example/a.png?x=1&y=2': { type: 'image/png' },
    })
    const load = createRemoteImageLoader({ fetch, lookup: publicDns })
    const out = await inlineRemoteImages(html, load)
    expect(out.shown).toBe(1)
    expect(out.failed).toBe(1)
    expect(out.html.match(/src="data:image\/png;base64,/g)?.length).toBe(2)
    expect(out.html).toContain('data-ws-remote-src="https://gone.example/p.gif"')
    expect(hits.filter((h) => h.startsWith('https://cdn.example')).length).toBe(1)
  })
})
