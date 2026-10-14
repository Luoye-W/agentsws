/**
 * WP328：Reddit 每日巡查在网关这一层的形状。
 * 1. 插件那两条与 `/v1/extension/*` 同一道闸，令牌上要有 `reddit.read`；交回的东西逐格验；
 * 2. 工作台那几条按品牌（principal 的 workspace）走端口。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionPort, RedditWatchPort } from '../src/index.js'
import { createGateway, createMemoryExtensionStore } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

async function wired() {
  const h = await harness()
  const store = createMemoryExtensionStore({ clock: makeClock(), random: seeded(5) })
  const calls: string[] = []
  const port: RedditWatchPort = {
    next: (s, input) => {
      calls.push(`next:${s.workspace_id}:${input.connected}`)
      return { retry_after_ms: 60_000 }
    },
    result: (_s, id, input) => {
      calls.push(`result:${id}:${input.outcome}:${input.parts[0]?.items.length ?? 0}`)
      return id === 'rj_1' ? { accepted: true } : undefined
    },
    view: (ws) => {
      calls.push(`view:${ws}`)
      return { settings: {} as never, configured: false, extension: {}, pending: [] }
    },
    updateSettings: (_ws, patch) => {
      calls.push(`settings:${JSON.stringify(patch)}`)
      return patch as never
    },
    runNow: async () => ({ id: 'rwr_1' }) as never,
    items: (_ws, q) => {
      calls.push(`items:${JSON.stringify(q)}`)
      return []
    },
    setStatus: (_ws, id, status) => (id === 'rw_1' ? ({ id, status } as never) : undefined),
    digest: (_ws, w) => {
      calls.push(`digest:${w?.since ?? '-'}`)
      return {} as never
    },
  }
  // 社媒 Reddit 那条职责读写得到社群线程（community_thread）；测试的通用岗位没有，这里补上
  const roles = {
    ...h.deps.roles,
    can: (id: string, domain: string, op: string, r: never) =>
      domain === 'community_thread'
        ? id === h.assignment.id
        : h.deps.roles.can(id, domain as never, op as never, r),
  }
  const gateway = createGateway({
    ...h.deps,
    roles: roles as never,
    extension: { store } as unknown as ExtensionPort,
    redditWatch: port,
  })
  const req = (method: string, path: string, headers: Headers, body?: unknown) => {
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const owner = (method: string, path: string, body?: unknown) =>
    req(
      method,
      path,
      new Headers({ Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }),
      body,
    )
  const plugin = (method: string, path: string, token?: string, body?: unknown) => {
    const headers = new Headers({ Origin: EXT_ORIGIN })
    if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
    return req(method, path, headers, body)
  }
  const made = await owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await plugin('POST', '/v1/extension/pair', undefined, { code })
  const issued = ((await res.json()) as { data: { token: string; scopes: string[] } }).data
  return { h, calls, owner, plugin, token: issued.token, scopes: issued.scopes }
}

const item = {
  name: 't1_c1',
  kind: 'comment',
  text: 'hi',
  created_utc: 1_760_400_000,
  inbox_type: 'comment_reply',
}

describe('插件这一侧', () => {
  it('新配的令牌带 reddit.read；领活按令牌上的品牌、带 connected', async () => {
    const w = await wired()
    expect(w.scopes).toContain('reddit.read')
    const res = await w.plugin('GET', '/v1/extension/reddit/next?connected=1', w.token)
    expect(res.status).toBe(200)
    expect(w.calls).toEqual([`next:${w.h.assignment.workspace_id}:true`])
  })
  it('没令牌 / 交回的格子不对：拒', async () => {
    const w = await wired()
    expect((await w.plugin('GET', '/v1/extension/reddit/next')).status).toBe(401)
    const bad = await w.plugin('POST', '/v1/extension/reddit/rj_1/result', w.token, {
      outcome: 'done',
      message: 'ok',
      parts: [
        {
          key: 'inbox',
          ok: true,
          items: [{ ...item, name: 'not-a-fullname' }],
          pages: 1,
          reached_stop: true,
        },
      ],
    })
    expect(bad.status).toBe(400)
  })
  it('交回：认得的那一件收下；不认得的 404', async () => {
    const w = await wired()
    const body = {
      outcome: 'done',
      message: 'ok',
      user: 'inmo_official',
      parts: [{ key: 'inbox', ok: true, items: [item], pages: 1, reached_stop: true }],
    }
    expect((await w.plugin('POST', '/v1/extension/reddit/rj_1/result', w.token, body)).status).toBe(
      200,
    )
    expect((await w.plugin('POST', '/v1/extension/reddit/rj_9/result', w.token, body)).status).toBe(
      404,
    )
    expect(w.calls).toContain('result:rj_1:done:1')
  })
})

describe('工作台这一侧', () => {
  it('看、改设置、筛条目、标状态、周汇总', async () => {
    const w = await wired()
    expect((await w.owner('GET', '/v1/reddit-watch')).status).toBe(200)
    expect(
      (
        await w.owner('PUT', '/v1/reddit-watch/settings', {
          own_subreddits: ['inmoxr'],
          every_hours: 12,
        })
      ).status,
    ).toBe(200)
    expect((await w.owner('PUT', '/v1/reddit-watch/settings', { every_hours: 0 })).status).toBe(400)
    expect((await w.owner('GET', '/v1/reddit-watch/items?source=inbox&reply=1')).status).toBe(200)
    expect((await w.owner('GET', '/v1/reddit-watch/items?source=bogus')).status).toBe(400)
    expect(
      (await w.owner('POST', '/v1/reddit-watch/items/rw_1/status', { status: 'dismissed' })).status,
    ).toBe(200)
    expect(
      (await w.owner('POST', '/v1/reddit-watch/items/rw_9/status', { status: 'dismissed' })).status,
    ).toBe(404)
    expect(
      (await w.owner('GET', '/v1/reddit-watch/digest?since=2026-10-11T00:00:00Z')).status,
    ).toBe(400)
    expect(
      (
        await w.owner(
          'GET',
          '/v1/reddit-watch/digest?since=2026-10-11T00:00:00Z&until=2026-10-17T00:00:00Z',
        )
      ).status,
    ).toBe(200)
    expect(w.calls).toContain('items:{"source":"inbox","reply":true}')
    expect(w.calls).toContain('digest:2026-10-11T00:00:00.000Z')
    expect(w.calls).toContain('settings:{"own_subreddits":["inmoxr"],"every_hours":12}')
  })
})
