/**
 * WP353：应用内搜索浏览器的规则与本机通道（不起 Electron）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanUserAgent,
  newChannelToken,
  type SearchBrowserDriver,
  searchPartitionOf,
  startSearchBrowserChannel,
  validateOpen,
  validateReveal,
} from '../src/search-browser.js'

describe('规则', () => {
  it('每个品牌一份持久 partition，名字是哈希', () => {
    const a = searchPartitionOf('ws_brand_a')
    expect(a).toMatch(/^persist:agentsws-search-[0-9a-f]{24}$/)
    expect(a).not.toContain('brand_a')
    expect(searchPartitionOf('ws_brand_a')).toBe(a)
    expect(searchPartitionOf('ws_brand_b')).not.toBe(a)
  })

  it('UA 去掉 Electron 与应用名，Chromium 那几段原样', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @agentsws/desktop/0.3.1 Chrome/146.0.7680.80 Electron/44.3.0 Safari/537.36'
    expect(cleanUserAgent(ua)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36',
    )
  })

  it('open 请求只认这几种形状', () => {
    expect(validateOpen({ workspace_id: 'ws_1', url: 'file:///etc/passwd', kind: 'page' })).toBe(
      '只开 http / https 网址',
    )
    expect(validateOpen({ workspace_id: '../x', url: 'https://a.com', kind: 'page' })).toBe(
      'workspace_id 不对',
    )
    expect(validateOpen({ workspace_id: 'ws_1', url: 'https://u:p@a.com', kind: 'page' })).toBe(
      '只开 http / https 网址',
    )
    expect(validateOpen({ workspace_id: 'ws_1', url: 'https://a.com', kind: 'click' })).toBe(
      'kind 只认 google / bing / page / data / html',
    )
    expect(validateOpen(null)).toBe('workspace_id 不对')
    expect(
      validateOpen({ workspace_id: 'ws_1', url: 'https://a.com', kind: 'google', timeout_ms: 1 }),
    ).toEqual({
      workspace_id: 'ws_1',
      url: 'https://a.com',
      kind: 'google',
      timeout_ms: 1_000,
      settle_ms: 1_200,
      max_chars: 60_000,
    })
  })

  it('WP393：data（读数据地址原文）允许大一些的字数上限，别的种类仍是 20 万', () => {
    const d = validateOpen({
      workspace_id: 'ws_1',
      url: 'https://shop.example/products.json',
      kind: 'data',
    })
    expect(d).toMatchObject({ kind: 'data', max_chars: 8_000_000 })
    const p = validateOpen({
      workspace_id: 'ws_1',
      url: 'https://a.com',
      kind: 'page',
      max_chars: 9e9,
    })
    expect(p).toMatchObject({ max_chars: 200_000 })
  })

  it('reveal 请求只认这几种形状', () => {
    expect(validateReveal({ workspace_id: 'ws_1', url: 'https://a.com', reason: 'x' })).toBe(
      'reason 只认 captcha / login',
    )
    expect(validateReveal({ workspace_id: 'ws_1', url: 'ftp://a', reason: 'captcha' })).toBe(
      '只开 http / https 网址',
    )
    expect(validateReveal({ workspace_id: '', url: 'https://a.com', reason: 'captcha' })).toBe(
      'workspace_id 不对',
    )
    expect(
      validateReveal({ workspace_id: 'ws_1', url: 'https://a.com', reason: 'login', message: 7 }),
    ).toEqual({ workspace_id: 'ws_1', url: 'https://a.com', reason: 'login', message: '' })
    expect(newChannelToken()).toMatch(/^[0-9a-f]{48}$/)
  })
})

describe('本机通道', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const s of stops.splice(0)) await s()
  })
  const driver: SearchBrowserDriver = {
    open: async (req) => ({ ok: true, status: 200, final_url: req.url }),
    reveal: async () => ({ shown: true }),
    status: (ws) => ({ revealed: ws === 'ws_1' }),
  }
  async function start(d: SearchBrowserDriver = driver) {
    const ch = await startSearchBrowserChannel({ driver: d, token: 'tok' })
    stops.push(ch.close)
    return ch
  }
  const call = (url: string, init: RequestInit = {}, token = 'tok') =>
    fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })

  it('只听 127.0.0.1；口令不对 401；带 Origin（网页来的）403', async () => {
    const ch = await start()
    expect(ch.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await call(`${ch.url}/status?workspace_id=ws_1`, {}, 'bad')).status).toBe(401)
    expect(
      (await call(`${ch.url}/status?workspace_id=ws_1`, { headers: { origin: 'https://evil' } }))
        .status,
    ).toBe(403)
  })

  it('open / reveal / status 走得通；坏请求 400；没有的路径 404；出错 500', async () => {
    const ch = await start()
    const opened = await call(`${ch.url}/open`, {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: 'ws_1',
        url: 'https://www.google.com/search?q=a',
        kind: 'google',
      }),
    })
    expect(await opened.json()).toEqual({
      ok: true,
      status: 200,
      final_url: 'https://www.google.com/search?q=a',
    })
    const bad = await call(`${ch.url}/open`, { method: 'POST', body: '{"kind":"x"}' })
    expect(bad.status).toBe(400)
    const notJson = await call(`${ch.url}/open`, { method: 'POST', body: '{' })
    expect(notJson.status).toBe(500)
    const shown = await call(`${ch.url}/reveal`, {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: 'ws_1',
        url: 'https://www.google.com/',
        reason: 'captcha',
        message: '点一下验证',
      }),
    })
    expect(await shown.json()).toEqual({ shown: true })
    expect((await call(`${ch.url}/reveal`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect(await (await call(`${ch.url}/status?workspace_id=ws_1`)).json()).toEqual({
      revealed: true,
    })
    expect((await call(`${ch.url}/status`)).status).toBe(400)
    expect((await call(`${ch.url}/nope`)).status).toBe(404)
    const big = await call(`${ch.url}/open`, { method: 'POST', body: 'x'.repeat(70_000) }).catch(
      () => undefined,
    )
    expect(big === undefined || big.status === 500).toBe(true)
  })
})
