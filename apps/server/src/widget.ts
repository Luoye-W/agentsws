/**
 * 网站聊天窗的嵌入脚本（WP124 起搬到 `@agentsws/chat-relay`：一份脚本，三种部署）。
 *
 * 出处与四条硬约束见 `packages/chat-relay/src/widget-script.ts` 的头注释。
 * 这里只 re-export——`apps/server`（本地档公开访客面）与三种转发器部署
 * 用的是**同一个字符串**，改一处三处生效。
 */

import { CHAT_WIDGET_JS, WIDGET_PATH } from '@agentsws/chat-relay'
import type { Env, Hono } from 'hono'

export { CHAT_WIDGET_JS, WIDGET_API_PATH, WIDGET_PATH } from '@agentsws/chat-relay'

/**
 * 把 `/widget.js` 挂到服务进程的 Hono 应用上（网关路由之后、静态托管之前）。
 *
 * 为什么不走 `RouteSpec`：它不是一条 API，是一个**资源**——`/v1` 之下那套
 * 信封、鉴权、幂等对一段 JavaScript 没有意义。顺手把这几条公开路由的
 * CORS 预检（`OPTIONS`）也挂在这里：`RouteSpec` 的方法表里没有 `options`，
 * 为了一次预检去改契约的方法联合，代价比在这里多两行大。
 */
export function mountChatWidget<E extends Env>(
  app: Hono<E>,
  deps: { allowedOrigin: (origin: string | undefined) => string | undefined },
): void {
  const serve = (): Response =>
    new Response(CHAT_WIDGET_JS, {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // 商家网站上的每个访客都会拉它一次；改了主色要等最多 5 分钟生效
        'cache-control': 'public, max-age=300',
        // 脚本本身谁都能拉（它是公开资源）；能不能建会话由 Origin 白名单说了算
        'access-control-allow-origin': '*',
      },
    })

  app.get(WIDGET_PATH, () => serve())

  app.on('OPTIONS', ['/v1/chat/public/*', '/v1/chat/widget-config'], (c) => {
    const origin = deps.allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return new Response(null, { status: 403 })
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '600',
        vary: 'Origin',
      },
    })
  })
}
