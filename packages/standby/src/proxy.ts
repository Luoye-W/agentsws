/**
 * 公网入口：`/w/:workspace_id/*` → 那个租户的子进程（49 §6 WP60）。
 *
 * 这一层**什么都不懂**，这正是它的价值：
 *
 * - 不认识会话。末端用户（老板、同事、访客）走的是**子进程自己的** magic link
 *   与 cookie，云进程只是把 `Set-Cookie` 原样带回去。云侧不发、不存、不看任何
 *   租户会话——它没有能力冒充任何一个租户的用户。
 * - **不读正文**。请求体与响应体都是流，原样穿过去（`res.body` 直接交出去，
 *   不 `await text()`）。这一条同时保证了两件事：SSE 与长轮询是真的流式，
 *   以及 49 M6「入口不存正文」在值守这条路上也成立。
 * - 不改路径语义。`/w/ws_1/v1/chat/...` → 子进程的 `/v1/chat/...`，
 *   查询串照抄。子进程眼里的自己长什么样由 `X-Forwarded-*` 说。
 *
 * 逐跳头（hop-by-hop）要摘掉：`connection` / `keep-alive` / `transfer-encoding` 这几个
 * 描述的是"这一段连接"，把它们转给下一段是 RFC 9110 明说不行的，实际后果是
 * 一个 `transfer-encoding: chunked` 被转两次之后流就断了。
 */
import type { Context } from 'hono'
import { StandbyError } from './types.js'

/** 逐跳头：描述"这一段连接"的，不转给下一段。 */
export const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
] as const

/** 公网入口的前缀。 */
export const PUBLIC_PREFIX = '/w'

/** `/w/ws_1/v1/chat/x` → `/v1/chat/x`；`/w/ws_1` → `/`。 */
export function childPath(pathname: string, workspace_id: string): string {
  const prefix = `${PUBLIC_PREFIX}/${workspace_id}`
  if (!pathname.startsWith(prefix)) throw new StandbyError('not_found', '不是这个工作区的入口')
  const rest = pathname.slice(prefix.length)
  return rest === '' ? '/' : rest
}

export interface ProxyDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  /** 这个工作区的回环端口；没在跑就抛（503 + 一句人话）。 */
  portOf: (workspace_id: string) => number
}

/**
 * 转发一次。
 *
 * 失败的那几种分得清清楚楚：没开通 = 404、正在起 = 503、子进程连不上 = 502。
 * 三种合成一个 500 的话，用户看到的永远是"服务器错误"，而真正该做的事
 * （去开通 / 等几秒 / 报给我们）三种各不相同。
 */
export async function proxyToChild(deps: ProxyDeps, c: Context): Promise<Response> {
  const workspace_id = c.req.param('workspace_id') ?? ''
  const port = deps.portOf(workspace_id)
  const url = new URL(c.req.url)
  const target = `http://127.0.0.1:${String(port)}${childPath(url.pathname, workspace_id)}${url.search}`

  const headers = new Headers(c.req.raw.headers)
  for (const h of HOP_BY_HOP) headers.delete(h)
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''))
  headers.set('X-Forwarded-Prefix', `${PUBLIC_PREFIX}/${workspace_id}`)

  const method = c.req.method.toUpperCase()
  const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: 'manual' }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = c.req.raw.body
    // Node 的 fetch 要求流式请求体显式声明半双工；不声明会在运行时抛
    init.duplex = 'half'
  }

  let upstream: Response
  try {
    upstream = await deps.fetch(target, init)
  } catch {
    // 端口在库里但连不上：进程刚崩、还没被这一拍的 tick 发现
    throw new StandbyError('unavailable', '这个工作区的服务暂时连不上，过几秒再试。')
  }

  const out = new Headers(upstream.headers)
  for (const h of HOP_BY_HOP) out.delete(h)
  // 流原样交出去：不 await 正文 = 不缓冲 = SSE 是真的流式，也没人读到过正文
  return new Response(upstream.body, { status: upstream.status, headers: out })
}
