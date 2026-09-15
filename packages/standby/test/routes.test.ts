/**
 * 值守的路由与公网反向代理（49 §6 WP60）。
 *
 * 钉的是：`standby` 动作集缺了就 403；令牌只能管自己那个工作区；
 * 代理透传 SSE（不缓冲）；没在跑的时候 503 而不是 500。
 */
import type { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createStandbyApp, type StandbyEnv, type StandbyVerifier } from '../src/index.js'
import { harness } from './helpers.js'

const MERCHANT = 'wst_merchant'
const NO_STANDBY = 'wst_no_standby'

const verifier: StandbyVerifier = (token) => {
  if (token === MERCHANT)
    return Promise.resolve({
      account_id: 'acc_1',
      org_id: 'org_1',
      workspace_id: 'ws_1',
      scopes: ['ai', 'wallet:read', 'standby'],
    })
  if (token === NO_STANDBY)
    return Promise.resolve({
      account_id: 'acc_1',
      org_id: 'org_1',
      workspace_id: 'ws_1',
      scopes: ['ai', 'wallet:read'],
    })
  return Promise.resolve(undefined)
}

function app(h: ReturnType<typeof harness>): Hono<StandbyEnv> {
  return createStandbyApp({ service: h.service, verifier })
}

const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

describe('控制面的鉴权', () => {
  it('没有 standby 动作集：403 + 一句人话（不是 401，也不是 404）', async () => {
    const h = harness({ credits: 1000 })
    const res = await app(h).request('/v1/standby/workspaces', { headers: auth(NO_STANDBY) })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('forbidden')
    expect(body.message).toContain('值守')
  })

  it('形状不对与验不过回同一句话同一个码（不给探测口）', async () => {
    const h = harness({ credits: 1000 })
    const a = await app(h).request('/v1/standby/workspaces', { headers: auth('nope') })
    const b = await app(h).request('/v1/standby/workspaces', { headers: auth('wst_unknown') })
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(await a.text()).toBe(await b.text())
  })

  it('令牌只能管它自己那个工作区', async () => {
    const h = harness({ credits: 1000 })
    const res = await app(h).request('/v1/standby/workspaces/ws_2', { headers: auth(MERCHANT) })
    expect(res.status).toBe(403)
  })
})

describe('控制面的动作', () => {
  it('开通 → 列表 → 停', async () => {
    const h = harness({ credits: 1000 })
    const a = app(h)

    const opened = await a.request('/v1/standby/workspaces', {
      method: 'POST',
      headers: { ...auth(MERCHANT), 'content-type': 'application/json' },
      body: JSON.stringify({ seats: 3 }),
    })
    expect(opened.status).toBe(201)
    expect(await opened.json()).toMatchObject({
      workspace_id: 'ws_1',
      seats: 3,
      status: 'starting',
    })

    const listed = await a.request('/v1/standby/workspaces', { headers: auth(MERCHANT) })
    const body = (await listed.json()) as { workspaces: unknown[]; seat_price: number }
    expect(body.workspaces).toHaveLength(1)
    expect(body.seat_price).toBe(h.service.seatPrice())

    const stopped = await a.request('/v1/standby/workspaces/ws_1/stop', {
      method: 'POST',
      headers: auth(MERCHANT),
    })
    expect(await stopped.json()).toMatchObject({ status: 'stopped' })
  })

  it('余额不足开不了：402 + 一句人话', async () => {
    const h = harness({ credits: 5 })
    const res = await app(h).request('/v1/standby/workspaces', {
      method: 'POST',
      headers: { ...auth(MERCHANT), 'content-type': 'application/json' },
      body: JSON.stringify({ seats: 1 }),
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('insufficient_credits')
    expect(body.message).toMatch(/充值/)
  })

  it('上传的包校验不过：422，不解包', async () => {
    const h = harness({ credits: 1000, packageOk: false })
    const res = await app(h).request('/v1/standby/workspaces/ws_1/import?seats=1', {
      method: 'POST',
      headers: { ...auth(MERCHANT), 'content-type': 'application/zip' },
      body: new Uint8Array([80, 75, 3, 4]),
    })
    expect(res.status).toBe(422)
    expect(h.packager.imported).toHaveLength(0)
  })

  it('空请求体不当成一个包', async () => {
    const h = harness({ credits: 1000 })
    const res = await app(h).request('/v1/standby/workspaces/ws_1/import', {
      method: 'POST',
      headers: auth(MERCHANT),
      body: new Uint8Array(),
    })
    expect(res.status).toBe(400)
  })

  it('导出回一个 zip（到期停了也能导）', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    h.fs.dirs.set('/data/standby/ws_1', 5)
    const res = await app(h).request('/v1/standby/workspaces/ws_1/export', {
      headers: auth(MERCHANT),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('ws_1-')
  })
})

describe('公网入口（反向代理）', () => {
  it('路径与查询串原样转给子进程，不带 /w/<ws> 前缀', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    await h.service.tick()

    const res = await app(h).request('/w/ws_1/v1/chat/public/sessions?a=1')
    expect(res.status).toBe(200)
    expect(h.proxied.at(-1)?.url).toBe('http://127.0.0.1:41000/v1/chat/public/sessions?a=1')
  })

  it('SSE 一帧一帧过来，不等整条流读完（不缓冲）', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    await h.service.tick()

    let push: ((chunk: string) => void) | undefined
    let done: (() => void) | undefined
    h.upstream.respond = () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => {
            controller.enqueue(encoder.encode(chunk))
          }
          done = () => {
            controller.close()
          }
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    const res = await app(h).request('/w/ws_1/v1/chat/public/sessions/s1/stream')
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    push?.('data: {"type":"ready"}\n\n')
    const first = await reader.read()
    // 上游还没关，第一帧就已经到手了 —— 这就是"没缓冲"
    expect(new TextDecoder().decode(first.value)).toContain('ready')
    push?.('data: {"type":"reply"}\n\n')
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain('reply')
    done?.()
  })

  it('逐跳头不往下转（转了流就断）', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    await h.service.tick()
    await app(h).request('/w/ws_1/v1/me', {
      headers: { connection: 'keep-alive', 'x-real': 'yes' },
    })
    const headers = h.proxied.at(-1)?.init?.headers as Headers
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('x-real')).toBe('yes')
    expect(headers.get('x-forwarded-prefix')).toBe('/w/ws_1')
  })

  it('没开通 = 404；正在起 = 503（不是一个笼统的 500）', async () => {
    const h = harness({ credits: 1000 })
    expect((await app(h).request('/w/ws_x/v1/health')).status).toBe(404)
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    expect((await app(h).request('/w/ws_1/v1/health')).status).toBe(503)
  })

  it('到期停了：503 + 一句说得清楚的人话（数据都在，导出照常）', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    h.service.stop('ws_1')
    const record = h.store.get('ws_1')
    if (record !== undefined) h.store.put({ ...record, status: 'expired' })
    const res = await app(h).request('/w/ws_1/v1/health')
    expect(res.status).toBe(503)
    expect((await res.json()) as { message: string }).toMatchObject({
      message: expect.stringContaining('导出照常'),
    })
  })

  it('公网入口不要求任何云侧凭据——末端用户走的是子进程自己的会话', async () => {
    const h = harness({ credits: 1000 })
    await h.service.open({ org_id: 'org_1', account_id: 'acc_1', workspace_id: 'ws_1', seats: 1 })
    await h.service.tick()
    const res = await app(h).request('/w/ws_1/v1/chat/public/sessions', { method: 'POST' })
    expect(res.status).toBe(200)
  })
})
