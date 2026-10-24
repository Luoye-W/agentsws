/**
 * WP505（决策 1770 B）：红人图片的下载器——**认系统代理**（`net-proxy.ts`），其余闸照 WP502 不变。
 *
 * 以前用的是 Node 内置的 `fetch`：它不看操作系统的代理设置，开着代理软件的用户这里一张图都取不到。
 * 这里自己拨号：候选代理（环境变量 → 系统设置）一个个试，`CONNECT` 打隧道，隧道里再做 TLS；
 * 前一个代理连不上就试下一个，最后直连。拨号只在「连上对方」那一步换路，连上之后不再换。
 *
 * 和 `kol-media.ts` 的分工：那边管「认不认这张图」（域名白名单、文件头、单张上限、超时、只取一次），
 * 这里只管「这一跳怎么出门」，形状照旧是 {@link KolMediaFetch}。多出来的一道闸：**跳转一跳一跳地跟、每一跳先核域名**
 * ——不在白名单里的地址连都不连（原来是跟完了才核最后那个地址）。
 *
 * 测试注入 `ca`（本地自签证书）和 `dial`（直连那一步改连本地），配本地假代理 + 假图片站，不出网。
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import type { KolMediaFetch } from './kol-media.js'
import { isKolMediaUrl } from './kol-media.js'
import {
  createSystemProxyReader,
  type ProxyChoice,
  proxyCandidates,
  proxyLabel,
  type SystemProxySetting,
} from './net-proxy.js'

/** 跳转最多跟几次。 */
const MAX_REDIRECTS = 3
/** 「连上代理 / 对方」那一步最多等多久（之后的读图受调用方的总超时管）。 */
const CONNECT_TIMEOUT_MS = 5_000

export interface KolMediaNetOptions {
  /** 环境变量（`HTTPS_PROXY` / `NO_PROXY` 这类）。默认 `process.env`。 */
  env?: Readonly<Record<string, string | undefined>>
  /** 读操作系统设置里的代理。默认现查（`createSystemProxyReader`）；`false` = 不看系统设置。 */
  systemProxy?: (() => Promise<SystemProxySetting | undefined>) | false
  /** 额外信任的根证书（**只给测试**：本地假图片站的自签证书）。 */
  ca?: string | Buffer
  /** 直连那一步怎么拨（**只给测试**：改连本地）。默认 `net.connect(port, host)`。 */
  dial?: (host: string, port: number) => Socket
  log?: (line: string) => void
}

class DialError extends Error {}

/** 等一个套接字连上（或出错 / 超时 / 被叫停）。 */
function connected(sock: Socket, event: 'connect' | 'secureConnect', signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      done(new DialError('连接超时'))
    }, CONNECT_TIMEOUT_MS)
    const onAbort = (): void => {
      done(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const done = (err?: Error): void => {
      clearTimeout(timer)
      sock.off(event, ok)
      sock.off('error', bad)
      signal.removeEventListener('abort', onAbort)
      if (err === undefined) resolve()
      else {
        sock.destroy()
        reject(err)
      }
    }
    const ok = (): void => {
      done()
    }
    const bad = (e: Error): void => {
      done(new DialError(e.message))
    }
    sock.once(event, ok)
    sock.once('error', bad)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 在已连上的代理套接字上打 `CONNECT host:port` 隧道；代理回 200 才算通。 */
function tunnel(
  sock: Socket,
  proxy: URL,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0)
    const timer = setTimeout(() => {
      done(new DialError('代理没回话'))
    }, CONNECT_TIMEOUT_MS)
    const onAbort = (): void => {
      done(new Error('aborted'))
    }
    const done = (err?: Error, rest?: Buffer): void => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onError)
      sock.off('end', onEnd)
      signal.removeEventListener('abort', onAbort)
      if (err !== undefined) {
        sock.destroy()
        reject(err)
        return
      }
      if (rest !== undefined && rest.length > 0) sock.unshift(rest)
      resolve()
    }
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 16 * 1024) done(new DialError('代理回的头太长'))
        return
      }
      const status = Number(head.subarray(0, end).toString('latin1').split(' ')[1])
      if (status !== 200) done(new DialError(`代理不让过（${String(status)}）`))
      else done(undefined, head.subarray(end + 4))
    }
    const onError = (e: Error): void => {
      done(new DialError(e.message))
    }
    const onEnd = (): void => {
      done(new DialError('代理断开了'))
    }
    sock.on('data', onData)
    sock.once('error', onError)
    sock.once('end', onEnd)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const auth =
      proxy.username === ''
        ? ''
        : `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString('base64')}\r\n`
    sock.write(
      `CONNECT ${host}:${String(port)} HTTP/1.1\r\nHost: ${host}:${String(port)}\r\n${auth}\r\n`,
    )
  })
}

/** 拨到 `host:443` 的 TLS：经代理（隧道）或直连。连不上抛 {@link DialError}。 */
async function dialTls(
  host: string,
  via: ProxyChoice | undefined,
  options: KolMediaNetOptions,
  signal: AbortSignal,
): Promise<TLSSocket> {
  let raw: Socket
  if (via === undefined) {
    raw = options.dial?.(host, 443) ?? netConnect(443, host)
    if (raw.connecting) await connected(raw, 'connect', signal)
  } else {
    const proxy = new URL(via.url)
    const port = Number(proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : proxy.port)
    if (proxy.protocol === 'https:') {
      const s = tlsConnect({
        host: proxy.hostname,
        port,
        servername: proxy.hostname,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      })
      await connected(s, 'secureConnect', signal)
      raw = s
    } else {
      raw = netConnect(port, proxy.hostname)
      await connected(raw, 'connect', signal)
    }
    await tunnel(raw, proxy, host, 443, signal)
  }
  // 连上之后底下那根的错误由上面的 TLS / 请求报出来；这里只是别让它变成进程级的未处理错误
  raw.on('error', () => undefined)
  const tls = tlsConnect({
    socket: raw,
    servername: host,
    ALPNProtocols: ['http/1.1'],
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  })
  // TLS 这一步不算「连不上」：证书不对就是不对，不换路再试
  await connected(tls, 'secureConnect', signal).catch((e: unknown) => {
    throw e instanceof DialError ? new Error(`TLS：${e.message}`) : e
  })
  tls.on('error', () => undefined)
  return tls
}

/** 在 TLS 套接字上发一个 GET。 */
function get(
  tls: TLSSocket,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      method: 'GET',
      host: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host, connection: 'close', 'user-agent': 'Mozilla/5.0' },
      createConnection: () => tls,
      signal,
    })
    req.once('response', resolve)
    req.once('error', reject)
    req.end()
  })
}

/**
 * 认系统代理的红人图片下载器（{@link KolMediaFetch} 的形状）。
 * 生产入口用它替掉 `globalThis.fetch`；`kol-media.ts` 的几道闸照旧在那边。
 */
export function createKolMediaFetch(options: KolMediaNetOptions = {}): KolMediaFetch {
  const env = options.env ?? process.env
  const system =
    options.systemProxy === false ? undefined : (options.systemProxy ?? createSystemProxyReader())
  let lastRoute: string | undefined
  let socksNoted = false
  const note = (route: string): void => {
    if (route === lastRoute) return
    lastRoute = route
    options.log?.(`红人图片：${route}`)
  }

  return async (url, init) => {
    let current = new URL(url)
    for (let hop = 0; ; hop++) {
      // 每一跳先核域名：白名单以外的地址连都不连
      if (!isKolMediaUrl(current.href))
        return { ok: false, status: 0, url: current.href, headers: new Headers(), body: null }
      const host = current.hostname
      const candidates: (ProxyChoice | undefined)[] = [
        ...(await proxyCandidates(host, { env, system })),
        undefined,
      ]
      if (
        !socksNoted &&
        /^socks/iu.test(env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? '')
      ) {
        socksNoted = true
        options.log?.('红人图片：环境变量里的是 SOCKS 代理，这里认不了，改试系统设置 / 直连')
      }
      let tls: TLSSocket | undefined
      let lastErr: unknown
      for (const via of candidates) {
        try {
          tls = await dialTls(host, via, options, init.signal)
          note(
            via === undefined
              ? '直连'
              : `经代理 ${proxyLabel(via.url)}（${via.from === 'env' ? '环境变量' : '系统设置'}）`,
          )
          break
        } catch (e) {
          lastErr = e
          if (!(e instanceof DialError)) throw e
        }
      }
      if (tls === undefined) throw lastErr instanceof Error ? lastErr : new Error('连不上')
      const res = await get(tls, current, init.headers, init.signal)
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location !== undefined && init.redirect === 'follow') {
        res.resume()
        tls.destroy()
        if (hop >= MAX_REDIRECTS)
          return { ok: false, status, url: current.href, headers: new Headers(), body: null }
        current = new URL(location, current)
        continue
      }
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string') headers.set(k, v)
        else if (Array.isArray(v)) headers.set(k, v.join(', '))
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        url: current.href,
        headers,
        body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
      }
    }
  }
}
