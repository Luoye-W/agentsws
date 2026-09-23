/**
 * 访客那一面的 HTTP/SSE 路由（三种部署同一份）。
 *
 * 路径与 `apps/server` 托管档的公开访客面**完全同名**（挂件脚本不用改一个字）：
 * 挂件读自己 `<script src>` 定出 base，然后把 `/v1/chat/public/*` 打到 base 上。
 * 官方托管 base = `/relay/<ws>`，自建 = 转发器根或反代前缀——都一样。
 *
 * 四道门照搬（72 §2.2 第 4 条）：来源白名单（**服务端自己读 Origin，
 * 请求体里没有 origin 字段，连误读都不可能**）、限流、访客令牌、凭据不进 URL。
 * 差别只有一处：转发器不建对话、不落正文——`/messages` 只确认收到
 * （202 形状的 `{status:'forwarded'}`），回复从 SSE 那条流回来；
 * 对面不在线或免费额度到顶（拦新）时回 `{status:'offline'}`，挂件切留言表单。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { RelayCore } from './core.js'
import { CHAT_WIDGET_JS, WIDGET_PATH } from './widget-script.js'

/** 建会话的限流：按来源域名计（同 `apps/server` 的 SESSION_RATE）。 */
export const SESSION_RATE = { per_minute: 10, per_hour: 60 }

/** 留言的限流：比会话更宽一点（一个不开会话只留言的访客也要能留上）。 */
const OFFLINE_RATE = { per_minute: 5, per_hour: 30 }

/** 固定窗口限流（转发器里最小的那一版；细粒度归上游与管线）。 */
class FixedWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  take(key: string, per: { per_minute: number; per_hour: number }, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000)
    const minute = list.filter((t) => now - t < 60_000)
    if (minute.length >= per.per_minute || list.length >= per.per_hour) {
      this.hits.set(key, [...list, now])
      return false
    }
    this.hits.set(key, [...list, now])
    return true
  }
}

export interface RelayHttpOptions {
  core: RelayCore
  /** 工作区号（自建单工作区部署固定；托管部署每个 DO 一个）。 */
  workspace: string
  /** 访客令牌的 HMAC 密钥（转发器不落库，验就是重算一次）。 */
  visitorSecret(): Uint8Array
  /** 限流覆盖（测试钩子；缺省按 SESSION_RATE）。 */
  sessionRate?: { per_minute: number; per_hour: number }
  /** 页面上下文里允许带的字段已经在协议层收窄；这里只决定收不收 query（不收）。 */
}

/** `https://shop.example.com/a/b` → `https://shop.example.com`。 */
export function originOf(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (text === undefined || text === '' || text === 'null') return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function createRelayHttp(options: RelayHttpOptions): Hono {
  const { core, workspace } = options
  const app = new Hono()
  const sessionLimiter = new FixedWindowLimiter()
  const offlineLimiter = new FixedWindowLimiter()
  const sessionRate = options.sessionRate ?? SESSION_RATE
  const visitors = new Map<string, string>() // session_id → visitor_id（只这两样，没有正文）

  const visitorToken = (session_id: string): string =>
    createHmac('sha256', options.visitorSecret())
      .update(`${workspace}:${session_id}`)
      .digest('base64url')

  const verify = (session_id: string, raw: string | undefined): boolean => {
    if (raw === undefined || raw === '') return false
    const given = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
    const expected = Buffer.from(visitorToken(session_id))
    const actual = Buffer.from(given)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  const allowedOrigin = (origin: string | undefined): string | undefined => {
    const normalized = originOf(origin)
    if (normalized === undefined) return undefined
    const list = core.publicConfig(workspace).allowed_origins ?? []
    return list.some((a) => originOf(a) === normalized) ? normalized : undefined
  }

  const cors = (origin: string): Record<string, string> => ({
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  })

  app.on('OPTIONS', ['/v1/chat/public/*', '/v1/chat/widget-config'], (c) => {
    const origin = allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return c.body(null, 403)
    return c.body(null, 204, cors(origin))
  })

  // 嵌入脚本本身谁都能拉（公开资源）；能不能建会话由白名单说了算
  app.get(WIDGET_PATH, (c) =>
    c.text(CHAT_WIDGET_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    }),
  )

  app.get('/v1/chat/widget-config', (c) => {
    const origin = allowedOrigin(c.req.header('Origin'))
    if (origin === undefined)
      return c.json({ data: { enabled: false, accent: '#2563eb', greeting: '' } })
    const cfg = core.publicConfig(workspace)
    return c.json(
      {
        data: {
          enabled: cfg.enabled,
          accent: cfg.accent,
          greeting: cfg.greeting,
          ...(cfg.position === undefined ? {} : { position: cfg.position }),
          ...(cfg.language === undefined ? {} : { language: cfg.language }),
        },
      },
      200,
      cors(origin),
    )
  })

  app.post('/v1/chat/public/sessions', (c) => {
    const origin = allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return c.json({ error: { code: 'origin_not_allowed' } }, 403)
    if (!sessionLimiter.take(origin, sessionRate, Date.now()))
      return c.json({ error: { code: 'rate_limited' } }, 429)
    // 访客 id 随机生成，不从 IP / UA / cookie 推（21 §4 随主体删除的主体键不该能反推人）
    const visitor = `v_${crypto.randomUUID()}`
    const session = `s_${crypto.randomUUID()}`
    visitors.set(session, visitor)
    core.attachVisitor(workspace, session, visitor, {
      // SSE 写入端在宿主层接（见各宿主）；这里先给个空实现，宿主会覆盖 attachVisitor
      send: () => {},
      close: () => {},
    })
    return c.json(
      { data: { session_id: session, visitor_token: visitorToken(session) } },
      200,
      cors(origin),
    )
  })

  app.post('/v1/chat/public/sessions/:id/typing', async (c) => {
    const id = c.req.param('id')
    if (!verify(id, c.req.header('Authorization')))
      return c.json({ error: { code: 'unauthorized' } }, 401)
    let body: { active?: unknown } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'invalid_input' } }, 400)
    }
    // 服务端再拒一次带自由文本的打字事件（解析层已拒，这里防 HTTP 口）
    if (typeof body.active !== 'boolean') return c.json({ error: { code: 'invalid_input' } }, 400)
    core.visitorTyping(id, body.active)
    return c.json({ data: { ok: true } })
  })

  app.post('/v1/chat/public/sessions/:id/messages', async (c) => {
    const id = c.req.param('id')
    const origin = allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return c.json({ error: { code: 'origin_not_allowed' } }, 403)
    if (!verify(id, c.req.header('Authorization')))
      return c.json({ error: { code: 'unauthorized' } }, 401)
    let body: { text?: unknown; trial?: unknown } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'invalid_input' } }, 400)
    }
    if (typeof body.text !== 'string' || body.text.trim() === '')
      return c.json({ error: { code: 'invalid_input' } }, 400)
    // 一次一个来源的限流（发消息按访客计）
    const visitor = visitors.get(id) ?? 'unknown'
    if (!sessionLimiter.take(id, OFFLINE_RATE, Date.now()))
      return c.json({ error: { code: 'rate_limited' } }, 429)
    const result = core.visitorMessage({
      workspace,
      session: id,
      visitor,
      text: body.text.slice(0, 2000),
      // 页面上下文：只留 host + path；query 一概不收（心跳与页面上下文两条路都一样）
      ...(origin === undefined ? {} : { page: { host: new URL(origin).host, path: '/' } }),
      ...(body.trial === true ? { trial: true } : {}),
    })
    if (result.status === 'offline')
      return c.json({ data: { status: 'offline', reason: result.reason } }, 200, cors(origin))
    return c.json({ data: { status: 'forwarded' } }, 202, cors(origin))
  })

  app.post('/v1/chat/public/offline-messages', async (c) => {
    const origin = allowedOrigin(c.req.header('Origin'))
    if (origin === undefined) return c.json({ error: { code: 'origin_not_allowed' } }, 403)
    if (!offlineLimiter.take(origin, OFFLINE_RATE, Date.now()))
      return c.json({ error: { code: 'rate_limited' } }, 429)
    let body: { email?: unknown; text?: unknown; order_ref?: unknown; page?: unknown } = {}
    try {
      body = (await c.req.json()) as typeof body
    } catch {
      return c.json({ error: { code: 'invalid_input' } }, 400)
    }
    if (typeof body.email !== 'string' || !body.email.includes('@'))
      return c.json({ error: { code: 'invalid_input' } }, 400)
    if (typeof body.text !== 'string' || body.text.trim() === '')
      return c.json({ error: { code: 'invalid_input' } }, 400)
    const sealed = JSON.stringify({
      email: body.email.slice(0, 200),
      text: body.text.slice(0, 2000),
      ...(typeof body.order_ref === 'string' && body.order_ref !== ''
        ? { order_ref: body.order_ref.slice(0, 100) }
        : {}),
      ...(typeof body.page === 'string' ? { page: body.page.slice(0, 300) } : {}),
    })
    core.leaveOfflineMessage(workspace, sealed)
    return c.json({ data: { ok: true } }, 200, cors(origin))
  })

  /** SSE：回复与打字从这条流回来。宿主层把 sink 接到 core.attachVisitor 上。 */
  app.get('/v1/chat/public/sessions/:id/stream', (c) => {
    const id = c.req.param('id')
    if (!verify(id, c.req.header('Authorization')))
      return c.json({ error: { code: 'unauthorized' } }, 401)
    const encoder = new TextEncoder()
    let closed = false
    const stream = new ReadableStream({
      start(controller) {
        const push = (frame: unknown): void => {
          if (closed) return
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        }
        core.attachVisitor(workspace, id, visitors.get(id) ?? 'unknown', {
          send: (frame) => push(frame),
          close: () => {
            if (!closed) {
              closed = true
              try {
                controller.close()
              } catch {
                /* 已经关了 */
              }
            }
          },
        })
        push({ type: 'open' })
      },
      cancel() {
        closed = true
        core.detachVisitor(id)
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...cors(allowedOrigin(c.req.header('Origin')) ?? '*'),
      },
    })
  })

  return app
}
