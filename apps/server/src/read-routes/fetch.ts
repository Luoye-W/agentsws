/**
 * WP246：零配置那几级（YouTube 字幕、网页转文字）共用的**只取公开页面**的 GET。
 *
 * 与 `brand-intake` 的抓取、`remote-images` 的代取同一套纪律：
 *
 * 1. 不带凭据、不带 Cookie / Referer，UA 照实说是我们（不伪装）；
 * 2. 只放行公网 http(s)：地址先解析，任何一个结果落在回环 / 内网 / 链路本地就拒；
 *    跳转手动跟（最多 4 跳），每一跳重判——网址是模型给的，别让它打内网；
 * 3. 抓不到就照实说是哪一种（被拦 / 连不上 / 超时 / 太大），**永不抛**；
 * 4. 读多少有上限（页面再大也只读前几 MB）。
 */
import { isIP } from 'node:net'
import { isPrivateAddress } from '@agentsws/channels'

export const READER_USER_AGENT = 'agentsws-reader/1.0 (+https://github.com/Luoye-W/agentsws)'

/** 最小的 fetch 形状（测试注入替身或指向本地假站点）。 */
export type ReadFetch = (
  url: string,
  init: {
    method: 'GET'
    redirect: 'manual'
    headers: Record<string, string>
    signal: AbortSignal
  },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export type PublicGetFailure =
  | 'bad_url'
  | 'blocked_host'
  | 'blocked'
  | 'http'
  | 'unreachable'
  | 'timeout'

export type PublicGet =
  | { ok: true; status: number; url: string; body: string; contentType: string }
  | { ok: false; kind: PublicGetFailure; status?: number; url: string; message: string }

export interface PublicGetOptions {
  fetch: ReadFetch
  /** 主机名 → 全部 IP（缺省系统解析）。 */
  lookup?: (host: string) => Promise<string[]>
  timeoutMs?: number
  maxChars?: number
  /** 测试用：本地假站点在 127.0.0.1 上，放行这几个主机。生产不给。 */
  allowHosts?: readonly string[]
}

const defaultLookup = async (host: string): Promise<string[]> => {
  const { lookup } = await import('node:dns/promises')
  const rows = await lookup(host, { all: true, verbatim: true })
  return rows.map((r) => r.address)
}

async function check(
  raw: string,
  options: PublicGetOptions,
): Promise<URL | { kind: 'bad_url' | 'blocked_host' | 'unreachable'; message: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'bad_url', message: `这不是一个网址：${raw}` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { kind: 'bad_url', message: '只读 http / https 的网页。' }
  if (url.username !== '' || url.password !== '')
    return { kind: 'bad_url', message: '网址里带了账号密码，不读。' }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (options.allowHosts?.includes(host) === true) return url
  if (host === '' || host === 'localhost' || host.endsWith('.localhost'))
    return { kind: 'blocked_host', message: '本机 / 内网地址不读。' }
  let addresses: string[]
  try {
    addresses = isIP(host) === 0 ? await (options.lookup ?? defaultLookup)(host) : [host]
  } catch {
    return { kind: 'unreachable', message: `找不到这个域名：${host}` }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress))
    return { kind: 'blocked_host', message: '本机 / 内网地址不读。' }
  return url
}

const sayStatus = (status: number): string =>
  status === 404
    ? '这个页面不存在（404）'
    : status === 429
      ? '对方在限流（429）'
      : status === 401 || status === 403
        ? `对方拒绝了（${status}）`
        : status >= 500
          ? `对方服务器出错（${status}）`
          : `没取到（${status}）`

/** 取一页公开网页。永不抛。 */
export async function getPublicPage(
  start: string,
  options: PublicGetOptions,
  accept = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
): Promise<PublicGet> {
  const timeoutMs = options.timeoutMs ?? 12_000
  const maxChars = options.maxChars ?? 3_000_000
  let next = start
  for (let hop = 0; hop < 5; hop += 1) {
    const checked = await check(next, options)
    if (!(checked instanceof URL)) return { ok: false, url: next, ...checked }
    let res: Awaited<ReturnType<ReadFetch>>
    try {
      res = await options.fetch(checked.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': READER_USER_AGENT,
          accept,
          'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.6',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const name = (err as { name?: string }).name
      const code = (err as { cause?: { code?: string } }).cause?.code
      return name === 'TimeoutError' || name === 'AbortError'
        ? { ok: false, kind: 'timeout', url: checked.href, message: '等太久了，先不读了。' }
        : {
            ok: false,
            kind: 'unreachable',
            url: checked.href,
            message: `连不上（${code ?? (err instanceof Error ? err.message : String(err))}）`,
          }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc === null)
        return {
          ok: false,
          kind: 'http',
          status: res.status,
          url: checked.href,
          message: '跳转没给去处。',
        }
      next = new URL(loc, checked).href
      continue
    }
    if (res.status < 200 || res.status >= 300)
      return {
        ok: false,
        kind: res.status === 429 || res.status === 403 ? 'blocked' : 'http',
        status: res.status,
        url: checked.href,
        message: sayStatus(res.status),
      }
    const body = (await res.text().catch(() => '')).slice(0, maxChars)
    return {
      ok: true,
      status: res.status,
      url: checked.href,
      body,
      contentType: res.headers.get('content-type') ?? '',
    }
  }
  return { ok: false, kind: 'http', url: next, message: '跳转太多次，停下了。' }
}
