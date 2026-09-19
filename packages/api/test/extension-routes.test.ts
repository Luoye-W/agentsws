/**
 * WP119（68）：`/v1/extension/*` 在**网关这一层**的形状。
 *
 * 这一组守的是那条最容易说成"以后再说"的：
 * **插件的三条路不走网关鉴权，判权在处理器里做，而且 Origin 与令牌要同时对。**
 *
 * 换句话说：一个网页拿到了插件令牌也没用——它的 `Origin` 不是扩展的。
 * 这就是"本机服务不开通配 CORS"这句话在代码里的落点，
 * 所以它必须有一条测试，而不是只有一段注释。
 */
import { describe, expect, it } from 'vitest'
import type { ExtensionPort, ExtensionSession } from '../src/index.js'
import { createGateway, createMemoryExtensionStore } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'
const PAGE_ORIGIN = 'https://www.youtube.com'

async function wired() {
  const h = await harness()
  const clock = makeClock()
  const store = createMemoryExtensionStore({ clock, random: seeded(9) })
  const seen: { session: ExtensionSession; count: number }[] = []
  const port: ExtensionPort = {
    store,
    hello: (session) => {
      seen.push({ session, count: 0 })
      return {
        workspace_id: session.workspace_id,
        workspace_name: '我的品牌',
        cloud_linked: false,
        shares_to_public_library: false,
        scopes: session.scopes,
        server_version: '0.1.0',
      }
    },
    ingest: (session, input) => {
      seen.push({ session, count: input.observations.length })
      return {
        rows: input.observations.map((o) => ({ handle: o.handle, status: 'ok' as const })),
        forwarded_to_public_library: 0,
      }
    },
  }
  const gateway = createGateway({ ...h.deps, extension: port })

  /** 工作台那一侧（Bearer + X-Assignment）。 */
  const owner = (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    )
  }

  /** 插件那一侧（插件令牌 + Origin，**没有** X-Assignment）。 */
  const plugin = (
    method: string,
    path: string,
    init: { token?: string; origin?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const headers = new Headers()
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
    if (init.origin !== undefined) headers.set('Origin', init.origin)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return Promise.resolve(
      gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      ),
    )
  }

  return { h, gateway, store, seen, owner, plugin }
}

const observation = {
  channel: 'youtube',
  handle: '@fixture',
  observed_at: '2026-09-07T09:00:00.000Z',
  source: 'channel_page',
}

async function paired(w: Awaited<ReturnType<typeof wired>>): Promise<string> {
  const made = await w.owner('POST', '/v1/extension/pairings', {})
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const res = await w.plugin('POST', '/v1/extension/pair', { origin: EXT_ORIGIN, body: { code } })
  return ((await res.json()) as { data: { token: string } }).data.token
}

describe('没装配时', () => {
  it('回 not_implemented，工作台其余一切照常', async () => {
    const h = await harness()
    const gateway = createGateway(h.deps)
    const res = await gateway.fetch(
      new Request('http://127.0.0.1/v1/extension/tokens', {
        headers: { Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id },
      }),
    )
    expect(res.status).toBe(501)
  })
})

describe('工作台这一侧', () => {
  it('发码 → 清单 → 撤销', async () => {
    const w = await wired()
    const token = await paired(w)
    expect(token).toMatch(/^ext_/)

    const listed = await w.owner('GET', '/v1/extension/tokens')
    const rows = ((await listed.json()) as { data: { tokens: { id: string }[] } }).data.tokens
    expect(rows).toHaveLength(1)

    const revoked = await w.owner(
      'POST',
      `/v1/extension/tokens/${rows[0]?.id ?? ''}/revoke`,
      undefined,
    )
    expect(revoked.status).toBe(200)

    // 撤掉之后插件那一侧当场不认
    const after = await w.plugin('GET', '/v1/extension/hello', { token, origin: EXT_ORIGIN })
    expect(after.status).toBe(401)
  })

  it('撤一把不存在的回 404', async () => {
    const w = await wired()
    expect((await w.owner('POST', '/v1/extension/tokens/ext_nope/revoke')).status).toBe(404)
  })
})

describe('插件这一侧：Origin 与令牌要同时对', () => {
  it('对的令牌 + 对的 Origin = 通', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [observation] },
    })
    expect(res.status).toBe(200)
    expect(w.seen.at(-1)?.count).toBe(1)
  })

  it('**对的令牌 + 网页的 Origin = 不通**（这就是"不开通配 CORS"的落点）', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: PAGE_ORIGIN,
      body: { observations: [observation] },
    })
    expect(res.status).toBe(401)
  })

  it('没有 Origin 也不通（curl 直接打本机服务这一条路堵死）', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('GET', '/v1/extension/hello', { token })
    expect(res.status).toBe(401)
  })

  it('没有令牌不通', async () => {
    const w = await wired()
    await paired(w)
    expect((await w.plugin('GET', '/v1/extension/hello', { origin: EXT_ORIGIN })).status).toBe(401)
  })

  it('换码那一条：Origin 不是扩展的 → 403 且话说得不一样', async () => {
    const w = await wired()
    const made = await w.owner('POST', '/v1/extension/pairings', {})
    const code = ((await made.json()) as { data: { code: string } }).data.code
    const res = await w.plugin('POST', '/v1/extension/pair', {
      origin: PAGE_ORIGIN,
      body: { code },
    })
    expect(res.status).toBe(403)
    // 「你不是扩展」与「码不对」是两句话——混成一句用户不知道该改哪一边
    expect(((await res.json()) as { message: string }).message).toContain('chrome-extension')
  })

  it('码不对 → 401，而且不说到底哪儿不对（区分等于给人一台探测机）', async () => {
    const w = await wired()
    const res = await w.plugin('POST', '/v1/extension/pair', {
      origin: EXT_ORIGIN,
      body: { code: '000000' },
    })
    expect(res.status).toBe(401)
  })
})

describe('观测的白名单', () => {
  it('多一个键**整批拒**——悄悄丢掉等于把"有人塞了正文"这个信号也丢了', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: [{ ...observation, transcript: '整段视频文案' }] },
    })
    expect(res.status).toBe(400)
    // 一条都没进去
    expect(w.seen.filter((s) => s.count > 0)).toHaveLength(0)
  })

  it('一批最多 100 条', async () => {
    const w = await wired()
    const token = await paired(w)
    const res = await w.plugin('POST', '/v1/extension/observations', {
      token,
      origin: EXT_ORIGIN,
      body: { observations: Array.from({ length: 101 }, () => observation) },
    })
    expect(res.status).toBe(400)
  })
})
