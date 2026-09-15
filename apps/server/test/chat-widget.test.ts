/**
 * 网站聊天窗的公开访客面（WP60；48 §4 L3 #11 的云端一半）。
 *
 * 跑的是真服务进程 + 真网关：起一个 `createServer()`、监听一个随机端口、
 * 用真 `fetch` 打进去。钉四件事：
 *
 * 1. **白名单外 403**，而且默认（一条都没配）就是全拒；
 * 2. **限流 429**（`ChatRateLimiter`，与 WP57 同一个模块）；
 * 3. **SSE 收得到回复**，而且访客那条流里**没有内部帧**；
 * 4. 访客令牌走 `Authorization` 头，**不进 URL**；对不上就 401。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const SHOP = 'https://shop.example.com'
const OTHER = 'https://evil.example.net'

function makeClock(start = '2026-09-15T09:00:00.000Z') {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

interface Ctx {
  server: Server
  url: string
  clock: ReturnType<typeof makeClock>
  owner: Assignment
}

let ctx: Ctx

/**
 * 商家那一面（登录态 + Assignment）。
 *
 * 用 owner 的那条：widget 设置的元组是 `store_config.read@workspace` /
 * `policy.stage@workspace`——"允许哪些网站嵌我们的聊天窗"是工作区级的配置，
 * 不是某一条会话上的权限。
 */
const owner = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', ctx.owner.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

/** 访客那一面（无凭据，只有 Origin；带令牌时走 Authorization 头）。 */
const visitor = async (
  path: string,
  init: RequestInit & { origin?: string; token?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (init.origin !== undefined) headers.set('Origin', init.origin)
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const allow = async (origins: string[]): Promise<Response> =>
  owner('/v1/chat/widget/settings', {
    method: 'PUT',
    body: JSON.stringify({ allowed_origins: origins, accent: '#ff5500', greeting: '在的，你说' }),
  })

async function openSession(): Promise<{ session_id: string; visitor_token: string }> {
  const res = await visitor('/v1/chat/public/sessions', { method: 'POST', origin: SHOP })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { session_id: string; visitor_token: string } }).data
}

beforeEach(async () => {
  const clock = makeClock()
  const server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  })
  const { url } = await server.listen(0)
  ctx = { server, url, clock, owner: server.bootstrap.ownerAssignment }
})

afterEach(async () => {
  await ctx.server.close()
})

describe('来源域名白名单', () => {
  it('默认一条都没配 = 全拒（不是全放）', async () => {
    const settings = await owner('/v1/chat/widget/settings')
    expect(settings.status).toBe(200)
    expect(((await settings.json()) as { data: { allowed_origins: string[] } }).data).toMatchObject(
      { allowed_origins: [] },
    )

    const res = await visitor('/v1/chat/public/sessions', { method: 'POST', origin: SHOP })
    expect(res.status).toBe(403)
  })

  it('白名单外的来源：403 + 一句人话；白名单内的：201', async () => {
    expect((await allow([SHOP])).status).toBe(200)

    const blocked = await visitor('/v1/chat/public/sessions', { method: 'POST', origin: OTHER })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { message: string }).message).toContain('允许的网站')

    const opened = await visitor('/v1/chat/public/sessions', { method: 'POST', origin: SHOP })
    expect(opened.status).toBe(201)
    expect(opened.headers.get('access-control-allow-origin')).toBe(SHOP)
    expect(opened.headers.get('vary')).toBe('Origin')
  })

  it('没有 Origin 头（curl 直连）也拒：白名单判的是浏览器报的来源', async () => {
    await allow([SHOP])
    expect((await visitor('/v1/chat/public/sessions', { method: 'POST' })).status).toBe(403)
  })

  it('widget-config 对白名单外只说 enabled: false，不说还允许了谁', async () => {
    await allow([SHOP])
    const res = await visitor('/v1/chat/widget-config', { origin: OTHER })
    const body = ((await res.json()) as { data: Record<string, unknown> }).data
    expect(body.enabled).toBe(false)
    expect(body).not.toHaveProperty('allowed_origins')

    const ok = await visitor('/v1/chat/widget-config', { origin: SHOP })
    expect(((await ok.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      enabled: true,
      accent: '#ff5500',
      greeting: '在的，你说',
    })
  })

  it('预检（OPTIONS）也按同一张白名单判', async () => {
    await allow([SHOP])
    const ok = await visitor('/v1/chat/public/sessions', { method: 'OPTIONS', origin: SHOP })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization')
    const bad = await visitor('/v1/chat/public/sessions', { method: 'OPTIONS', origin: OTHER })
    expect(bad.status).toBe(403)
  })
})

describe('访客令牌', () => {
  it('凭据走 Authorization 头；没有它或者对不上就 401', async () => {
    await allow([SHOP])
    const session = await openSession()

    const anonymous = await visitor(`/v1/chat/public/sessions/${session.session_id}/messages`, {
      method: 'POST',
      origin: SHOP,
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(anonymous.status).toBe(401)

    const wrong = await visitor(`/v1/chat/public/sessions/${session.session_id}/messages`, {
      method: 'POST',
      origin: SHOP,
      token: 'not-the-token',
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(wrong.status).toBe(401)

    const right = await visitor(`/v1/chat/public/sessions/${session.session_id}/messages`, {
      method: 'POST',
      origin: SHOP,
      token: session.visitor_token,
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(right.status).toBe(201)
  })

  it('别人的会话 id + 自己的令牌：401（令牌绑的是这一条会话）', async () => {
    await allow([SHOP])
    const a = await openSession()
    const b = await openSession()
    const res = await visitor(`/v1/chat/public/sessions/${b.session_id}/messages`, {
      method: 'POST',
      origin: SHOP,
      token: a.visitor_token,
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('限流', () => {
  it('同一个来源狂开会话：到点 429 + Retry-After', async () => {
    await allow([SHOP])
    let last: Response | undefined
    for (let i = 0; i < 12; i += 1) {
      last = await visitor('/v1/chat/public/sessions', { method: 'POST', origin: SHOP })
      if (last.status === 429) break
      await last.text()
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('retry-after')).toBeTruthy()
  })
})

describe('SSE', () => {
  it('访客挂上就收到 ready；AI 的回复推过来，内部帧不推', async () => {
    await allow([SHOP])
    const session = await openSession()

    const stream = await visitor(`/v1/chat/public/sessions/${session.session_id}/stream`, {
      origin: SHOP,
      token: session.visitor_token,
    })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    expect(stream.headers.get('access-control-allow-origin')).toBe(SHOP)

    const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('ready')

    // 商家那边把接管开关翻一下：这是一帧 `session`，**不该**推到访客那条流上。
    // 直接打车道（不经网关）：这条断言要的是"帧过不过得去"，不是那条路由的鉴权
    const lane = ctx.server.chat
    if (lane === undefined) throw new Error('这个服务进程没装在线客服')
    await lane.setTakeover(session.session_id, true)
    await lane.setTakeover(session.session_id, false)

    // 访客说一句 → AI 走一轮 → `message` 帧推过来
    await visitor(`/v1/chat/public/sessions/${session.session_id}/messages`, {
      method: 'POST',
      origin: SHOP,
      token: session.visitor_token,
      body: JSON.stringify({ text: '你们发不发中国？' }),
    })
    ctx.clock.advance(3_000)
    await lane.advanceTurn(session.session_id, { force: true })

    let seen = ''
    for (let i = 0; i < 6 && !seen.includes('"type":"message"'); i += 1) {
      const chunk = await reader.read()
      if (chunk.done) break
      seen += decoder.decode(chunk.value)
    }
    expect(seen).toContain('"type":"message"')
    // 接管开关那两帧一条都没漏过去
    expect(seen).not.toContain('"type":"session"')
    await reader.cancel()
  }, 30_000)
})

describe('嵌入脚本', () => {
  it('两条路径都给同一段脚本；≤ 20 KB；不依赖任何框架', async () => {
    const short = await fetch(`${ctx.url}/widget.js`)
    const api = await fetch(`${ctx.url}/v1/chat/widget.js`)
    expect(short.status).toBe(200)
    expect(api.status).toBe(200)
    expect(short.headers.get('content-type')).toContain('text/javascript')
    const js = await short.text()
    expect(await api.text()).toBe(js)
    expect(Buffer.byteLength(js, 'utf8')).toBeLessThanOrEqual(20 * 1024)
    // 凭据不进 URL：脚本里没有 EventSource（它塞不进 Authorization 头）
    expect(js).not.toContain('EventSource')
    expect(js).toContain('authorization')
  })
})
