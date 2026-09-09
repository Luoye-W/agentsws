/**
 * 桌面壳调服务进程 `/v1` 的那几件事（13 §5 / 28 §1）。
 *
 * 断言的重点只有两件：**会话密钥不外泄**（只在请求体里出现一次），
 * 以及每条路都有一个「说清楚为什么」的失败分支——托盘上按一下不该炸掉整个壳。
 */
import { describe, expect, it } from 'vitest'
import { createApiClient, type DesktopSession, parseSetCookie } from '../src/api-client.js'
import type { ApiFetchLike, ApiResponseLike } from '../src/ports.js'

const BASE = 'http://127.0.0.1:4317'
const SESSION_KEY = 's'.repeat(64)
const COOKIE = 'agentsws_session=tok_abc123'

interface Recorded {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

function res(
  init: { ok?: boolean; status?: number; body?: unknown; setCookie?: string } = {},
): ApiResponseLike {
  const setCookie = init.setCookie
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => (typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {})),
    headers: {
      get: (name) => (name.toLowerCase() === 'set-cookie' ? (setCookie ?? null) : null),
      ...(setCookie === undefined ? {} : { getSetCookie: () => [setCookie] }),
    },
  }
}

function client(routes: Record<string, ApiResponseLike | (() => ApiResponseLike)>) {
  const calls: Recorded[] = []
  const fetchImpl: ApiFetchLike = async (url, init) => {
    calls.push({
      url,
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      ...(init?.body === undefined ? {} : { body: init.body }),
    })
    const path = url.slice(BASE.length)
    const hit = routes[path]
    if (hit === undefined) return res({ ok: false, status: 404, body: {} })
    return typeof hit === 'function' ? hit() : hit
  }
  return {
    calls,
    api: createApiClient({ baseUrl: `${BASE}/`, sessionKey: SESSION_KEY, fetchImpl }),
  }
}

const SESSION_OK = res({
  setCookie: `${COOKIE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600`,
  body: { data: { person: { id: 'per_1', email: 'a@b.com' }, workspace_id: 'ws_1' } },
})

const session: DesktopSession = {
  cookie: COOKIE,
  name: 'agentsws_session',
  value: 'tok_abc123',
  person: { id: 'per_1', email: 'a@b.com' },
}

describe('parseSetCookie', () => {
  it('只取 name=value 那一段，属性丢掉', () => {
    expect(parseSetCookie('a=b; Path=/; HttpOnly')).toEqual({ name: 'a', value: 'b' })
    expect(parseSetCookie('a=b=c')).toEqual({ name: 'a', value: 'b=c' })
  })

  it('拿不到 / 形状不对 → undefined，不猜', () => {
    expect(parseSetCookie(undefined)).toBeUndefined()
    expect(parseSetCookie('')).toBeUndefined()
    expect(parseSetCookie('=novalue')).toBeUndefined()
    expect(parseSetCookie('nokv')).toBeUndefined()
  })
})

describe('session：用会话密钥换 HttpOnly cookie', () => {
  it('POST /v1/auth/session，密钥只在请求体里出现一次，cookie 拿回来', async () => {
    const { api, calls } = client({ '/v1/auth/session': SESSION_OK })
    const out = await api.session()
    expect(out.ok && out.value.cookie).toBe(COOKIE)
    expect(out.ok && out.value.person.email).toBe('a@b.com')
    expect(out.ok && out.value.workspace_id).toBe('ws_1')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe(`${BASE}/v1/auth/session`)
    // 密钥不在 URL、不在头里——只在体里
    expect(calls[0]?.url).not.toContain(SESSION_KEY)
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(SESSION_KEY)
    expect(calls[0]?.body).toContain(SESSION_KEY)
  })

  it('没有 getSetCookie 的 fetch 实现也认（退回 get("set-cookie")）', async () => {
    const { api } = client({
      '/v1/auth/session': {
        ...SESSION_OK,
        headers: { get: (n) => (n.toLowerCase() === 'set-cookie' ? `${COOKIE}; HttpOnly` : null) },
      },
    })
    expect((await api.session()).ok).toBe(true)
  })

  it('服务端没回 Set-Cookie → 说清楚，不当成功', async () => {
    const { api } = client({ '/v1/auth/session': res({ body: { data: { person: {} } } }) })
    const out = await api.session()
    expect(out).toEqual({ ok: false, reason: '服务进程没有回 Set-Cookie' })
  })

  it('服务端 4xx → 把人话原样带出来', async () => {
    const { api } = client({
      '/v1/auth/session': res({
        ok: false,
        status: 401,
        body: { error: { code: 'unauthenticated', message: '会话密钥不对' } },
      }),
    })
    expect(await api.session()).toEqual({ ok: false, reason: '会话密钥不对' })
  })

  it('响应不是 JSON / 没有 data → 也是结构化失败', async () => {
    const notJson = client({ '/v1/auth/session': res({ ok: false, status: 500, body: '<html>' }) })
    expect(await notJson.api.session()).toEqual({ ok: false, reason: 'HTTP 500' })
    const noData = client({ '/v1/auth/session': res({ body: {} }) })
    expect(await noData.api.session()).toEqual({ ok: false, reason: '响应里没有 data' })
  })

  it('fetch 自己抛（服务没起来）→ 结构化失败，不往外抛', async () => {
    const api = createApiClient({
      baseUrl: BASE,
      sessionKey: SESSION_KEY,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    })
    const out = await api.session()
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.reason).toContain('ECONNREFUSED')
  })
})

describe('assignment / setHalt / rotateSecretsKey', () => {
  it('assignment 取第一条没被撤销的', async () => {
    const { api, calls } = client({
      '/v1/me': res({
        body: {
          data: {
            assignments: [
              { id: 'asg_gone', revoked_at: '2026-01-01T00:00:00.000Z' },
              { id: 'asg_ok' },
            ],
          },
        },
      }),
    })
    expect(await api.assignment(session)).toEqual({ ok: true, value: 'asg_ok' })
    expect(calls[0]?.headers?.cookie).toBe(COOKIE)
  })

  it('一条可用的都没有 → 说清楚', async () => {
    const { api } = client({ '/v1/me': res({ body: { data: { assignments: [] } } }) })
    expect(await api.assignment(session)).toEqual({
      ok: false,
      reason: '这个人名下没有可用的岗位分配',
    })
  })

  it('setHalt：PUT /v1/halt，带 cookie 与 X-Assignment，回 changed', async () => {
    const { api, calls } = client({ '/v1/halt': res({ body: { data: { changed: true } } }) })
    const out = await api.setHalt(session, 'asg_ok', 'all', true, '桌面壳托盘')
    expect(out).toEqual({ ok: true, value: { changed: true } })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.headers?.['X-Assignment']).toBe('asg_ok')
    expect(calls[0]?.headers?.cookie).toBe(COOKIE)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      scope: 'all',
      on: true,
      reason: '桌面壳托盘',
    })
  })

  it('setHalt 不给 reason 时不塞空字段', async () => {
    const { api, calls } = client({ '/v1/halt': res({ body: { data: { changed: false } } }) })
    await api.setHalt(session, 'asg_ok', 'model', false)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ scope: 'model', on: false })
  })

  it('setHalt 被拒（非 owner）→ 结构化失败', async () => {
    const { api } = client({
      '/v1/halt': res({ ok: false, status: 403, body: { error: { message: '没有权限' } } }),
    })
    expect(await api.setHalt(session, 'asg_ok', 'all', true)).toEqual({
      ok: false,
      reason: '没有权限',
    })
  })

  it('rotateSecretsKey：新密钥只在请求体里，回换了几条', async () => {
    const { api, calls } = client({
      '/v1/secrets/rotate': res({ body: { data: { rotated: 3, at: '2026-09-10T00:00:00.000Z' } } }),
    })
    const newKey = 'n'.repeat(64)
    expect(await api.rotateSecretsKey(session, 'asg_ok', newKey)).toEqual({
      ok: true,
      value: { rotated: 3 },
    })
    expect(calls[0]?.url).not.toContain(newKey)
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(newKey)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ new_key: newKey })
  })

  it('rotateSecretsKey 失败 → 结构化失败（本机密钥不该动）', async () => {
    const { api } = client({
      '/v1/secrets/rotate': res({
        ok: false,
        status: 400,
        body: { error: { message: '新密钥和现在这把一样' } },
      }),
    })
    expect(await api.rotateSecretsKey(session, 'asg_ok', 'x'.repeat(64))).toEqual({
      ok: false,
      reason: '新密钥和现在这把一样',
    })
  })
})

describe('baseUrl 是取值函数（端口是 sidecar 起来后才知道的）', () => {
  it('每次调用都重新取一遍，换了端口就打到新端口', async () => {
    let port = 0
    const seen: string[] = []
    const api = createApiClient({
      baseUrl: () => `http://127.0.0.1:${port}/`,
      sessionKey: SESSION_KEY,
      fetchImpl: async (url) => {
        seen.push(url)
        return SESSION_OK
      },
    })
    await api.session()
    port = 51234
    await api.session()
    expect(seen).toEqual([
      'http://127.0.0.1:0/v1/auth/session',
      'http://127.0.0.1:51234/v1/auth/session',
    ])
  })
})
