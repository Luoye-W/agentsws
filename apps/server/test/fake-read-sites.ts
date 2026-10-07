/**
 * WP246：本地假站点（**不访问真的 youtube.com / reddit.com / r.jina.ai**）——一个 HTTP 服务按路径摆出
 * 假 YouTube（视频页 + 字幕轨）、几个普通网页、假的第三方转文字服务。每个请求都记下来，
 * 测试据此断言「第三方没开时一个请求都没去」「内网地址没去」。
 *
 * 测试里的 fetch 把 `https://www.youtube.com/...` 这类真网址改写到这个本地服务上（路径不变），
 * 主机名解析给一个公网样子的地址——生产代码走的是真网址的形状，但一个字节都不出这台机器。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadFetch } from '../src/read-routes/fetch.js'

export interface SeenRead {
  host: string
  path: string
  method: string
}

const player = (o: Record<string, unknown>): string =>
  `<!doctype html><html><head><title>YouTube</title></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify(o)};var meta = {"x":"}"};</script></body></html>`

const details = (id: string, title: string) => ({
  videoId: id,
  title,
  author: 'INMO Official',
  lengthSeconds: '95',
  shortDescription: 'Unboxing the Air3. Links: https://example.com',
})

const tracks = (path: string, extra: Record<string, unknown>[] = []) => ({
  playerCaptionsTracklistRenderer: {
    captionTracks: [
      { baseUrl: `${path}&lang=en`, languageCode: 'en', name: { simpleText: 'English' } },
      {
        baseUrl: `${path}&lang=en&kind=asr`,
        languageCode: 'en',
        kind: 'asr',
        name: { runs: [{ text: 'English (auto)' }] },
      },
      ...extra,
    ],
  },
})

const XML_CAPTIONS =
  '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
  '<text start="0.5" dur="2">Hi everyone, it&amp;#39;s unboxing day</text>' +
  '<text start="3" dur="2">The Air3 display is &lt;sharp&gt;</text>' +
  '<text start="40.2" dur="3">Battery lasts four hours</text></transcript>'

const SRV3_CAPTIONS =
  '<timedtext format="3"><body><p t="1000" d="2000">字幕<s>第一句</s></p><p t="65000" d="1000">第二句</p></body></timedtext>'

const JSON3_CAPTIONS = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: 'json ' }, { utf8: 'captions' }] },
    { tStartMs: 1500, segs: [{ utf8: '\n' }] },
    { tStartMs: 2000, segs: [{ utf8: 'second line' }] },
  ],
})

const ARTICLE = `<!doctype html><html lang="en"><head><title>Air3 review</title></head><body>
<header><nav><a href="/">Home</a> <a href="/cart">Cart 0</a></nav></header>
<main><article><h1>Air3 review</h1>
<p>We wore the Air3 for two weeks. The display is sharp, the subtitles feature works in noisy cafes, and the frame is light enough for long sessions.</p>
<p>Battery life is the weak spot: about four hours of mixed use. Charging takes fifty minutes, which is fine for a desk setup but annoying on trips.</p>
</article></main><footer>© Example</footer></body></html>`

const SPA =
  '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'

function route(req: IncomingMessage, res: ServerResponse, host: string): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const send = (
    code: number,
    body: string,
    type = 'text/html; charset=utf-8',
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(code, { 'content-type': type, ...headers })
    res.end(body)
  }
  const p = url.pathname
  // ── 假 YouTube ──
  if (host.endsWith('youtube.com')) {
    if (p === '/robots.txt') return send(200, 'User-agent: *', 'text/plain')
    const v = url.searchParams.get('v') ?? ''
    if (p === '/watch') {
      if (v === 'okvideo0001')
        return send(
          200,
          player({
            playabilityStatus: { status: 'OK' },
            videoDetails: details(v, 'Air3 unboxing'),
            captions: tracks('/api/timedtext?v=okvideo0001'),
          }),
        )
      if (v === 'srv3video01')
        return send(
          200,
          player({
            playabilityStatus: { status: 'OK' },
            videoDetails: details(v, '中文视频'),
            captions: tracks('/api/timedtext?v=srv3video01&fmt=srv3'),
          }),
        )
      if (v === 'json3video1')
        return send(
          200,
          player({
            playabilityStatus: { status: 'OK' },
            videoDetails: details(v, 'json3'),
            captions: tracks('/api/timedtext?v=json3video1&fmt=json3'),
          }),
        )
      if (v === 'nocaptions1')
        return send(
          200,
          player({ playabilityStatus: { status: 'OK' }, videoDetails: details(v, 'No captions') }),
        )
      if (v === 'emptycaps01')
        return send(
          200,
          player({
            playabilityStatus: { status: 'OK' },
            videoDetails: details(v, 'PO token'),
            captions: tracks('/api/timedtext?v=emptycaps01'),
          }),
        )
      if (v === 'agegated001')
        return send(
          200,
          player({
            playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' },
            videoDetails: details(v, 'Age gated'),
          }),
        )
      if (v === 'removed0001')
        return send(
          200,
          player({ playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } }),
        )
      if (v === 'ratelimit01') return send(429, 'Too Many Requests')
      if (v === 'offhosttrk1')
        return send(
          200,
          player({
            playabilityStatus: { status: 'OK' },
            videoDetails: details(v, 'x'),
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [{ baseUrl: 'https://evil.example/cc', languageCode: 'en' }],
              },
            },
          }),
        )
      return send(200, '<html><body>changed layout</body></html>')
    }
    if (p === '/api/timedtext') {
      if (v === 'emptycaps01') return send(200, '', 'text/xml')
      if (url.searchParams.get('fmt') === 'srv3') return send(200, SRV3_CAPTIONS, 'text/xml')
      if (url.searchParams.get('fmt') === 'json3')
        return send(200, JSON3_CAPTIONS, 'application/json')
      return send(200, XML_CAPTIONS, 'text/xml')
    }
    return send(404, 'not found')
  }
  // ── 假第三方转文字（Jina Reader 的回包形状）──
  if (host === 'r.jina.ai') {
    if (p === '/') return send(200, 'ok', 'text/plain')
    const target = decodeURIComponent(p.slice(1))
    return send(
      200,
      `Title: Rendered by reader\nURL Source: ${target}\n\nMarkdown Content:\n# Rendered\n\nThis page was rendered by the third-party reader for testing purposes only.`,
      'text/plain',
    )
  }
  // ── 普通网页 ──
  if (p === '/article') return send(200, ARTICLE)
  if (p === '/spa') return send(200, SPA)
  if (p === '/notes.txt') return send(200, 'plain text notes', 'text/plain')
  if (p === '/file.pdf') return send(200, '%PDF-1.4', 'application/pdf')
  if (p === '/moved') return send(302, '', 'text/html', { location: '/article' })
  if (p === '/to-internal') return send(302, '', 'text/html', { location: 'http://10.0.0.5/admin' })
  return send(404, 'not found')
}

export async function startFakeReadSites(): Promise<{
  origin: string
  seen: SeenRead[]
  /** 把真网址改写到本地服务（路径不变，`x-fake-host` 带上原主机）。 */
  fetch: ReadFetch
  /** 所有主机都解析成一个公网样子的地址（`10.` 开头的照实是内网）。 */
  lookup: (host: string) => Promise<string[]>
  close(): Promise<void>
}> {
  const seen: SeenRead[] = []
  const server = createServer((req, res) => {
    const host = String(req.headers['x-fake-host'] ?? 'localhost')
    const u = new URL(req.url ?? '/', 'http://x')
    seen.push({ host, path: u.pathname, method: req.method ?? '' })
    route(req, res, host)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const fetch: ReadFetch = (url, init) => {
    const u = new URL(url)
    return globalThis.fetch(`${origin}${u.pathname}${u.search}`, {
      ...init,
      headers: { ...init.headers, 'x-fake-host': u.hostname },
    }) as unknown as ReturnType<ReadFetch>
  }
  return {
    origin,
    seen,
    fetch,
    lookup: async (host) => (host.startsWith('10.') ? [host] : ['93.184.216.34']),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
