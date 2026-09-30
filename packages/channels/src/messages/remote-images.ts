/**
 * WP204（63 §G）：「显示图片」的**本机代取**。
 *
 * 净化那一层把远程图片的 `src` 搬去了 `data-ws-remote-src`（在人按下之前一个请求都不发）。
 * 人按了「显示图片」之后，**不是**把 `src` 搬回去让浏览器直连对方服务器，而是由本机服务
 * 代取、内联成 `data:` 再交给界面。理由三条：
 *
 * 1. 桌面壳的 CSP 是 `img-src 'self' blob: data:`（WP99，Luoye 定：不加任何外域），
 *    直连的图在壳里**永远显示不出来**——那正是「点了没反应」的一半；
 * 2. 浏览器直连会把 Cookie、Referer、浏览器指纹一起递给追踪方；代取只剩"有人打开了"这一件事；
 * 3. 取回来的字节先验明是图片、限大小，才进页面。
 *
 * 代取是一条 SSRF 口子（信里的地址是陌生人写的），所以只放行公网上的 http(s)：
 * 地址先解析，**任何一个**解析结果落在回环 / 内网 / 链路本地 / 组播就拒；跳转手动跟、
 * 每一跳重新判；只收 `image/*`（SVG 不收）；单张 2 MB、单封 40 张封顶。
 * 残余风险：判完地址到真正连接之间 DNS 可能换了答案（rebinding）——响应必须是图片
 * 才会被用，拿不到别的东西；写在这里，不假装没有。
 */

import { isIP } from 'node:net'

/** 一张图代取的结果。 */
export type RemoteImageLoad =
  | { ok: true; data_uri: string }
  | {
      ok: false
      reason: 'bad_url' | 'blocked_host' | 'http_error' | 'not_image' | 'too_large' | 'error'
    }

export type RemoteImageLoader = (url: string) => Promise<RemoteImageLoad>

/** 最小的 fetch 形状（测试注入替身，不联网）。 */
export type ImageFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface RemoteImageLoaderOptions {
  fetch?: ImageFetch
  /** 主机名 → 全部 IP。缺省 `dns.promises.lookup(host, { all: true })`。 */
  lookup?: (host: string) => Promise<string[]>
  /** 单张上限（字节），缺省 2 MB。 */
  maxBytes?: number
  timeoutMs?: number
}

export const REMOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** 一封信最多代取几张（超过的照旧挡着）。 */
export const REMOTE_IMAGE_MAX_COUNT = 40

/** 这个 IP 是不是不该从本机去碰的地方（回环 / 内网 / 链路本地 / 组播 / 保留）。 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (v === 6) {
    const low = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low)
    if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1])
    return (
      low === '::' ||
      low === '::1' ||
      /^f[cd]/.test(low) ||
      /^fe[89ab]/.test(low) ||
      low.startsWith('ff') ||
      low.startsWith('::ffff:')
    )
  }
  return true
}

const defaultLookup = async (host: string): Promise<string[]> => {
  const { lookup } = await import('node:dns/promises')
  const rows = await lookup(host, { all: true, verbatim: true })
  return rows.map((r) => r.address)
}

/** 公网上的 http(s) 才放行；其余一律 `bad_url` / `blocked_host`。 */
async function checkUrl(
  raw: string,
  lookup: (host: string) => Promise<string[]>,
): Promise<URL | 'bad_url' | 'blocked_host'> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'bad_url'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'bad_url'
  if (url.username !== '' || url.password !== '') return 'bad_url'
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return 'blocked_host'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '' || host.toLowerCase() === 'localhost' || host.endsWith('.localhost'))
    return 'blocked_host'
  let addresses: string[]
  try {
    addresses = isIP(host) === 0 ? await lookup(host) : [host]
  } catch {
    return 'blocked_host'
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return 'blocked_host'
  return url
}

/** 真代取：公网 http(s)、手动跟跳转（最多三跳，每跳重判）、只收 `image/*`、限大小。 */
export function createRemoteImageLoader(options: RemoteImageLoaderOptions = {}): RemoteImageLoader {
  const doFetch: ImageFetch =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init) as ReturnType<ImageFetch>)
  const lookup = options.lookup ?? defaultLookup
  const maxBytes = options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? 8000
  return async (start) => {
    let next = start
    for (let hop = 0; hop < 4; hop += 1) {
      const checked = await checkUrl(next, lookup)
      if (typeof checked === 'string') return { ok: false, reason: checked }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await doFetch(checked.href, {
          redirect: 'manual',
          signal: controller.signal,
          // 不带 Cookie、不带 Referer；只说要图
          headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9' },
        })
        const location = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && location !== null) {
          next = new URL(location, checked).href
          continue
        }
        if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'http_error' }
        const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
        // SVG 是一份文档（能带脚本与外链），不当图片收；类型串要干净（它会被拼进属性里）
        if (mime === undefined || !/^image\/[a-z0-9.+-]+$/.test(mime) || mime.includes('svg'))
          return { ok: false, reason: 'not_image' }
        const declared = Number(res.headers.get('content-length') ?? '0')
        if (Number.isFinite(declared) && declared > maxBytes)
          return { ok: false, reason: 'too_large' }
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.length > maxBytes) return { ok: false, reason: 'too_large' }
        return { ok: true, data_uri: `data:${mime};base64,${bytes.toString('base64')}` }
      } catch {
        return { ok: false, reason: 'error' }
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: false, reason: 'http_error' }
  }
}

const unescapeAttr = (v: string): string =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/**
 * 属性里的地址 → 浏览器会去请求的那个地址。净化那一层对原值又转义了一次
 * （原信里的 `&amp;` 变成了 `&amp;amp;`），所以解两层：一层是净化加的，一层是 HTML 本来的。
 */
const urlOf = (raw: string): string => unescapeAttr(unescapeAttr(raw))

/**
 * 把一封信正文里挡着的远程图片代取、内联。取到的换成 `src="data:…"`，取不到的
 * **原样挡着**（`data-ws-remote-src` 不动）。同一个地址只取一次（追踪像素常重复放）。
 */
export async function inlineRemoteImages(
  html: string,
  load: RemoteImageLoader,
  options: { maxCount?: number; concurrency?: number } = {},
): Promise<{ html: string; shown: number; failed: number }> {
  const re = /data-ws-remote-src="([^"]*)"/g
  const urls = [...new Set([...html.matchAll(re)].map((m) => urlOf(m[1] ?? '')))]
  const wanted = urls.slice(0, options.maxCount ?? REMOTE_IMAGE_MAX_COUNT)
  const got = new Map<string, string>()
  const queue = [...wanted]
  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const out = await load(url).catch((): RemoteImageLoad => ({ ok: false, reason: 'error' }))
      if (out.ok) got.set(url, out.data_uri)
    }
  }
  await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker))
  const next = html.replace(re, (whole, raw: string) => {
    const data = got.get(urlOf(raw))
    return data === undefined ? whole : `src="${data}"`
  })
  return { html: next, shown: got.size, failed: urls.length - got.size }
}
