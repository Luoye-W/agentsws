/**
 * WP20：原生表单直填与断开（13 §4.3）。
 *
 * 磁带里没有 `PUT /api/connections/:service`（09-09 那次录制没打到管理面的写端点），
 * 所以这一档用可编程的假 runtime 打——重点不是线格式对不对，而是**凭据只经过一次**：
 * 请求体里有值，事件里只有字段名，返回值里两者都没有。
 */
import { describe, expect, it } from 'vitest'
import type { ConnectAdapterOptions, FetchLike } from '../src/index.js'
import { createConnectAdapter, MemoryEventSink } from '../src/index.js'
import { TestClock } from './helpers.js'

const SECRET = 'shpat_never_appears_anywhere_but_the_put_body'

interface Recorded {
  method: string
  path: string
  body: string | undefined
}

interface FakeRuntime {
  fetchImpl: FetchLike
  calls: Recorded[]
  connections: Record<string, unknown>[]
  /** DELETE 走哪条路径才成功；其余回 405（"路径在、方法不在"）。 */
  deletePath?: string
  putStatus: number
}

const CONN = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'conn-1',
  service: 'gotify',
  connectionName: 'default',
  authType: 'api_key',
  configured: true,
  default: true,
  profile: { accountId: 'acct-1', displayName: 'Gotify 主号' },
  ...over,
})

function fakeRuntime(): FakeRuntime {
  const state: FakeRuntime = {
    calls: [],
    connections: [],
    putStatus: 200,
    fetchImpl: async () => new Response('{}', { status: 404 }),
  }
  state.fetchImpl = async (url, init) => {
    const u = new URL(url)
    const path = u.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    state.calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (path === '/api/connections' && method === 'GET') return json(state.connections)
    if (path.startsWith('/api/connections/') && method === 'PUT') {
      if (state.putStatus !== 200) {
        return json(
          { error: { code: 'credential_verification_failed', message: '令牌不对' } },
          state.putStatus,
        )
      }
      state.connections = [CONN()]
      return json({ ok: true })
    }
    if (path.startsWith('/api/connections/') && method === 'DELETE') {
      if (state.deletePath !== undefined && path === state.deletePath) {
        state.connections = []
        return json({ ok: true })
      }
      return json({ error: { code: 'method_not_allowed', message: path } }, 405)
    }
    if (path === '/v1/providers') {
      return json({
        success: true,
        data: [
          { service: 'gotify', authTypes: ['api_key'] },
          { service: 'gmail', authTypes: ['oauth2'] },
        ],
        meta: {},
      })
    }
    if (path === '/api/providers/gotify') {
      return json({
        service: 'gotify',
        auth: [{ type: 'api_key', fields: [{ key: 'baseUrl', secret: false, required: true }] }],
      })
    }
    if (path === '/api/runtime-tokens' && method === 'POST') {
      return json({ token: 'oct_fake', record: { id: 'rt_1' } })
    }
    return json({ error: { code: 'not_found', message: path } }, 404)
  }
  return state
}

function adapter(
  rt: FakeRuntime,
  extra: Partial<ConnectAdapterOptions> = {},
): ReturnType<typeof createConnectAdapter> {
  return createConnectAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    adminTokenEnv: 'FAKE_ADMIN',
    clock: new TestClock(),
    fetchImpl: rt.fetchImpl,
    env: { FAKE_ADMIN: 'fake-admin-token' },
    workspaceId: 'ws_local',
    ...extra,
  })
}

const INPUT = {
  workspace_id: 'ws_local',
  ownership: 'workspace' as const,
  alias: 'default',
  fields: { apiKey: SECRET, baseUrl: 'https://gotify.example' },
}

describe('submitForm：凭据只经过一次', () => {
  it('值只出现在 PUT 的请求体里；事件里只有字段名，返回值里什么都没有', async () => {
    const rt = fakeRuntime()
    const sink = new MemoryEventSink()
    const connect = adapter(rt, { eventSink: sink })
    const conn = await connect.submitForm('gotify', INPUT)

    expect(conn.id).toBe('conn-1')
    expect(conn.service).toBe('gotify')
    expect(conn.workspace_id).toBe('ws_local')
    expect(conn.identity?.display_name).toBe('Gotify 主号')
    // 返回值里没有凭据
    expect(JSON.stringify(conn)).not.toContain(SECRET)

    // 请求体：只有那一条 PUT 带了值
    const withSecret = rt.calls.filter((c) => c.body?.includes(SECRET) === true)
    expect(withSecret).toHaveLength(1)
    expect(withSecret[0]?.method).toBe('PUT')
    expect(withSecret[0]?.path).toBe('/api/connections/gotify')
    expect(JSON.parse(withSecret[0]?.body ?? '{}')).toEqual({
      authType: 'api_key',
      connectionName: 'default',
      values: { apiKey: SECRET, baseUrl: 'https://gotify.example' },
    })

    // 事件：只有字段名
    expect(JSON.stringify(sink.events)).not.toContain(SECRET)
    const submitted = sink.ofType('connect.form_submitted')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.payload.field_names).toEqual(['apiKey', 'baseUrl'])
    expect(submitted[0]?.payload.connection_id).toBe('conn-1')
    expect(sink.ofType('connect.connection_established')).toHaveLength(1)
  })

  it('走 beginConnect 拿到的 request_id 在 submit 之后就结掉了', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    const started = await connect.beginConnect('gotify', {
      workspace_id: 'ws_local',
      ownership: 'workspace',
      alias: 'default',
      mode: 'own_app',
    })
    expect(started.secure_form).toBeDefined()
    await connect.submitForm('gotify', { ...INPUT, request_id: started.request_id })
    // 结掉之后再 poll 就是 expired（而不是永远 initiated）
    expect(await connect.pollConnect(started.request_id)).toBe('expired')
  })

  it('OAuth 类 provider 拒绝表单直填；空表单也拒', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await expect(connect.submitForm('gmail', INPUT)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(connect.submitForm('gotify', { ...INPUT, fields: {} })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('上游拒绝凭据时抛出来的错误里不含凭据', async () => {
    const rt = fakeRuntime()
    rt.putStatus = 400
    const connect = adapter(rt)
    try {
      await connect.submitForm('gotify', INPUT)
      expect.unreachable('上游拒绝时不该成功')
    } catch (e) {
      expect(JSON.stringify({ message: (e as Error).message, details: e })).not.toContain(SECRET)
    }
  })

  it('runtime 收了凭据却没冒出连接：明确报错，不假装成功', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await expect(connect.submitForm('gotify', { ...INPUT, alias: 'other' })).rejects.toMatchObject({
      code: 'provider_error',
    })
  })
})

describe('removeConnection：断开', () => {
  it('service/connectionName 那条路能删就用它', async () => {
    const rt = fakeRuntime()
    rt.deletePath = '/api/connections/gotify/default'
    const sink = new MemoryEventSink()
    const connect = adapter(rt, { eventSink: sink })
    await connect.submitForm('gotify', INPUT)
    await connect.removeConnection('conn-1')
    expect(await connect.connections('ws_local')).toEqual([])
    expect(sink.ofType('connect.connection_removed')[0]?.payload.connection_id).toBe('conn-1')
  })

  it('退回按 id 删', async () => {
    const rt = fakeRuntime()
    rt.deletePath = '/api/connections/conn-1'
    const connect = adapter(rt)
    await connect.submitForm('gotify', INPUT)
    await connect.removeConnection('conn-1')
    expect(await connect.connections('ws_local')).toEqual([])
  })

  it('两条路都不通就抛 not_implemented，而不是静默当成删掉了', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await connect.submitForm('gotify', INPUT)
    await expect(connect.removeConnection('conn-1')).rejects.toMatchObject({
      code: 'not_implemented',
    })
    // 连接还在——界面不该显示已断开
    expect(await connect.connections('ws_local')).toHaveLength(1)
  })

  it('删一条不存在的连接是 not_found', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await expect(connect.removeConnection('conn-nope')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
