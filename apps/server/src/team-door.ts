/**
 * WP427：「团队门」——同事从别的电脑连进来时**唯一**能走的那扇门。
 *
 * 桌面版的服务进程只听 127.0.0.1，而且本机档有几条「按邮箱直接给登录 token」的公开路由
 * （`/v1/auth/magic-link`、`/v1/auth/browser-link`、`/v1/auth/session` 换会话、`/app/bootstrap.json`
 * 里的主人邮箱）——那台电脑上能打开页面的只有主人自己，所以没问题。可一旦同事要连进来用，
 * 就不能把整个端口开出去：谁连上都能以主人身份进门。
 *
 * 所以开的不是那个端口，是这扇门（局域网那条路是另一个端口上的一个小反代，云那条路是长连接上下来的
 * 请求，两条路都过同一个 {@link createDoorHandler}）：
 *
 * 1. **没登录也能走的**只有这几条（{@link DOOR_PUBLIC}）：问「你是谁」、递申请、拿票问「批了没有」、
 *    同伴说「先批的那一边定了」、拿一次性 token 换会话、用工坊账号（邮箱验证码）进门、健康检查；
 *    外加工作台的页面与静态文件（页面本来就是公开的）。
 * 2. **其余一律要一张有效的会话 token**（`Authorization: Bearer` 或会话 cookie），门这里先验一遍——
 *    只认 `session` 那一种（插件钥匙、运行时令牌、内部令牌从外面来一律不认）。
 * 3. **本机档那几条「直接给 token」的公开路由，从门这里永远进不去**——带着会话也不行
 *    （一位同事拿着自己的会话去要主人邮箱的登录 token，正是要挡的那一下）。规则是「API 表里
 *    标了公开、又不在第 1 条清单里的，一律 403」，以后新加的公开路由默认也进不来。
 * 4. `/app/bootstrap.json` 由门自己回 `{ login: 'shared', team: true }`：页面拿不到主人邮箱，
 *    走登录页（工坊账号 / 申请时那张票换来的一次性 token）。
 *
 * 门转进去的请求带一个 `x-agentsws-door` 头（外面带进来的同名头先抹掉），日志与排查用；
 * 网关本身照旧按会话鉴权，门只是多挡一层。
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { collectRoutes } from '@agentsws/api'
import { TEAM_DOOR_HEADER } from '@agentsws/contracts'
import { getRequestListener } from '@hono/node-server'

/** 转进去时带的头（值是 `lan` / `cloud`）。 */
export const DOOR_HEADER = TEAM_DOOR_HEADER

export type DoorVia = 'lan' | 'cloud'

/** 没登录也能走的那几条（方法 + Hono 风格路径）。 */
export const DOOR_PUBLIC: readonly (readonly [string, string])[] = [
  ['GET', '/v1/health'],
  ['GET', '/v1/discovery/hello'],
  ['POST', '/v1/memberships/requests'],
  ['POST', '/v1/memberships/requests/:id/claim'],
  ['POST', '/v1/discovery/superseded'],
  ['POST', '/v1/auth/verify'],
  ['POST', '/v1/auth/account/code'],
  ['POST', '/v1/auth/account/verify'],
]

/** 门外来的这些路径不是工作台页面，一律不放（本机回调、聊天挂件脚本、接口说明）。 */
const NON_PAGE_PREFIXES = ['/oauth/', '/widget.js', '/openapi.json', '/v1']

/** 逐跳头与不该从外面带进来的头。 */
const DROP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  DOOR_HEADER,
])
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
])

export type DoorVerdict =
  /** 没登录也能走。 */
  | { kind: 'public' }
  /** 要一张会话 token。 */
  | { kind: 'member' }
  /** 门自己回 bootstrap。 */
  | { kind: 'bootstrap' }
  /** 永远进不去。 */
  | { kind: 'blocked' }

/** Hono 风格路径 → 正则（`:id` 匹配一段）。 */
function patternOf(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${body}/?$`)
}

const DOOR_PUBLIC_PATTERNS = DOOR_PUBLIC.map(([m, p]) => ({ method: m, re: patternOf(p) }))

let apiPublicCache: { method: string; re: RegExp }[] | undefined
/** API 表里标了公开的路由（门据此挡「公开但不在清单里」的那些）。 */
function apiPublicPatterns(): { method: string; re: RegExp }[] {
  if (apiPublicCache === undefined) {
    apiPublicCache = collectRoutes()
      .filter((r) => r.spec.auth === 'public')
      .map((r) => ({ method: r.spec.method.toUpperCase(), re: patternOf(r.spec.path) }))
  }
  return apiPublicCache
}

/**
 * 这一条请求在门这里怎么走（纯函数；`isApiPublic` 测试可换）。
 *
 * 方法一律大写比较；`HEAD` 当 `GET` 看。
 */
export function classifyDoorRequest(
  method: string,
  path: string,
  isApiPublic: (method: string, path: string) => boolean = (m, p) =>
    apiPublicPatterns().some((x) => x.method === m && x.re.test(p)),
): DoorVerdict {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  // 路径里不许有 `..` / 反斜杠 / 编码过的斜杠：静态托管自己会挡，门这里先挡一道
  if (path.includes('..') || path.includes('\\') || /%2f|%5c/i.test(path))
    return { kind: 'blocked' }
  if (path === '/app/bootstrap.json')
    return m === 'GET' ? { kind: 'bootstrap' } : { kind: 'blocked' }
  if (path === '/v1' || path.startsWith('/v1/')) {
    if (DOOR_PUBLIC_PATTERNS.some((x) => x.method === m && x.re.test(path)))
      return { kind: 'public' }
    // 本机档那几条「公开」路由（按邮箱给 token、换会话 cookie、设置码……）：从门这里永远进不去
    if (isApiPublic(m, path)) return { kind: 'blocked' }
    return { kind: 'member' }
  }
  // 门外只给工作台的页面与静态文件（只读）
  if (m !== 'GET') return { kind: 'blocked' }
  if (NON_PAGE_PREFIXES.some((p) => path === p || path.startsWith(p))) return { kind: 'blocked' }
  return { kind: 'public' }
}

/** `Authorization` 头 / 会话 cookie → token 原文。 */
export function credentialOf(
  headers: { get(name: string): string | null },
  cookieName: string,
): string | undefined {
  const auth = headers.get('authorization')?.trim()
  if (auth !== undefined && auth !== '') {
    const value = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : auth
    return value === '' ? undefined : value
  }
  const cookie = headers.get('cookie')
  if (cookie === null) return undefined
  for (const part of cookie.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== cookieName) continue
    const value = decodeURIComponent(part.slice(at + 1).trim())
    return value === '' ? undefined : value
  }
  return undefined
}

/** WebSocket 握手里 `Sec-WebSocket-Protocol: agentsws.v1, agentsws.bearer.<token>` 那一把。 */
export function bearerFromSubprotocol(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(',')) {
    const p = part.trim()
    if (p.startsWith('agentsws.bearer.')) return p.slice('agentsws.bearer.'.length) || undefined
  }
  return undefined
}

export interface DoorOptions {
  /** 本机服务进程的地址（`http://127.0.0.1:<端口>`）；还没 listen 时 undefined。 */
  upstream(): string | undefined
  /** 验一张 token：回它是哪一种；无效回 undefined。 */
  authenticate(token: string): Promise<{ kind: string } | undefined>
  cookieName: string
  via: DoorVia
  /** 门自己回的 bootstrap（默认 `{ login: 'shared', team: true }`）。 */
  bootstrap?: () => Record<string, unknown>
  /** 测试注入。 */
  fetch?: typeof fetch
  isApiPublic?: (method: string, path: string) => boolean
}

const json = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

/** 门那一下：分类 → 该验的验 → 转给本机服务进程（流式，原样回）。 */
export function createDoorHandler(options: DoorOptions): (req: Request) => Promise<Response> {
  const doFetch = options.fetch ?? fetch
  return async (req) => {
    const url = new URL(req.url)
    const verdict = classifyDoorRequest(
      req.method,
      url.pathname,
      ...(options.isApiPublic === undefined ? [] : [options.isApiPublic]),
    )
    if (verdict.kind === 'blocked')
      return json(403, 'forbidden', '这一条只能在发起人自己的电脑上用。')
    if (verdict.kind === 'bootstrap')
      return new Response(
        JSON.stringify(options.bootstrap?.() ?? { login: 'shared', team: true }),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
      )
    if (verdict.kind === 'member') {
      const token = credentialOf(req.headers, options.cookieName)
      const who = token === undefined ? undefined : await options.authenticate(token)
      if (who === undefined || who.kind !== 'session')
        return json(401, 'unauthenticated', '先登录：用工坊账号，或者等对方同意你的申请。')
    }
    const base = options.upstream()
    if (base === undefined) return json(503, 'unavailable', '对方的工坊还没起来，等一会儿再试。')
    const headers = new Headers()
    req.headers.forEach((value, name) => {
      if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value)
    })
    headers.set(DOOR_HEADER, options.via)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    let res: Response
    try {
      res = await doFetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: req.body, duplex: 'half' } : {}),
        redirect: 'manual',
        signal: req.signal,
      } as RequestInit)
    } catch {
      return json(502, 'unavailable', '对方的工坊这会儿没回应，等一会儿再试。')
    }
    const out = new Headers()
    res.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value)
    })
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  }
}

// ── 局域网那条路：另一个端口上的小反代 ─────────────────────────────────────

export interface LanDoorOptions extends Omit<DoorOptions, 'via'> {
  /** 听哪（默认所有网卡 `0.0.0.0`；测试用 127.0.0.1）。 */
  host?: string
  /** 听哪个端口（默认 0 = 系统给一个）。 */
  port?: number
  /** 本机服务进程的端口（WebSocket 直接拼字节流过去）。 */
  upstreamPort(): number | undefined
}

export interface LanDoor {
  port: number
  close(): Promise<void>
}

/** 起局域网那扇门。起不来（端口被占、没权限）就抛——调用方降级成「局域网这条路没开」。 */
export async function startLanDoor(options: LanDoorOptions): Promise<LanDoor> {
  const handler = createDoorHandler({ ...options, via: 'lan' })
  const listener = getRequestListener(handler)
  const server: Server = createHttpServer((req, res) => {
    void listener(req, res)
  })
  const sockets = new Set<Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void upgrade(req, socket, head)
  })

  /** 工作台的实时推送（`/v1/ws`）：验过会话再把两边的字节流接起来。 */
  async function upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const deny = (status: string): void => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    try {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      if (path !== '/v1/ws') return deny('404 Not Found')
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
      const token =
        bearerFromSubprotocol(req.headers['sec-websocket-protocol']) ??
        credentialOf(headers, options.cookieName)
      const who = token === undefined ? undefined : await options.authenticate(token)
      if (who === undefined || who.kind !== 'session') return deny('401 Unauthorized')
      const port = options.upstreamPort()
      if (port === undefined) return deny('503 Service Unavailable')
      const upstream = connect(port, '127.0.0.1')
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      upstream.on('connect', () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i] ?? ''
          const lower = name.toLowerCase()
          if (lower === 'host' || lower.startsWith('x-forwarded') || lower === DOOR_HEADER) continue
          lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ''}`)
        }
        lines.push(`Host: 127.0.0.1:${String(port)}`, `${DOOR_HEADER}: lan`, '', '')
        upstream.write(lines.join('\r\n'))
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
    } catch {
      deny('500 Internal Server Error')
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
