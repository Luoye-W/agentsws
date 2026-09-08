import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConnectAdapterOptions, FetchLike } from '../src/index.js'
import { createConnectAdapter, MemoryEventSink } from '../src/index.js'
import { TestClock } from './helpers.js'

/**
 * 边角路径：上游报错、幂等窗口过期、撤销时上游已无记录、签发后策略收紧、
 * 未知 provider、连接缓存失效……这些在录制磁带里凑不齐，用一个可编程的假 runtime 打。
 */
interface FakeRuntime {
  fetchImpl: FetchLike
  /** 下一次 `POST /v1/actions/:id` 的响应。 */
  actionResponse: { status: number; body: unknown } | 'throw'
  deleteStatus: number
  connections: Record<string, unknown>[]
  calls: string[]
}

const CONN = {
  id: 'conn-1',
  service: 'gotify',
  connectionName: 'default',
  authType: 'api_key',
  configured: true,
  virtual: false,
  default: true,
  profile: { accountId: 'gotify:acct', displayName: 'Gotify', grantedScopes: [] },
}

const ACTIONS = [
  {
    id: 'gotify.get_version',
    service: 'gotify',
    name: 'get_version',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    requiredScopes: [],
    execution: {
      locallyExecutable: true,
      catalogOnly: false,
      needsCredential: true,
      requiredAuthTypes: ['api_key'],
    },
  },
]

function fakeRuntime(): FakeRuntime {
  const state: FakeRuntime = {
    actionResponse: {
      status: 200,
      body: { success: true, data: { v: 1 }, meta: { executionId: 'exec-1' } },
    },
    deleteStatus: 200,
    connections: [CONN],
    calls: [],
    fetchImpl: async () => new Response('{}', { status: 404 }),
  }
  let tokenSeq = 0
  state.fetchImpl = async (url, init) => {
    const u = new URL(url)
    const path = u.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    state.calls.push(`${method} ${path}`)
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (path === '/api/runtime-tokens' && method === 'POST') {
      tokenSeq += 1
      return json({ token: `oct_fake_${tokenSeq}`, record: { id: `rt_${tokenSeq}` } })
    }
    if (path.startsWith('/api/runtime-tokens/') && method === 'DELETE') {
      return state.deleteStatus === 200
        ? json({ id: 'rt', revoked: true })
        : json({}, state.deleteStatus)
    }
    if (path === '/api/connections') return json(state.connections)
    if (path === '/v1/providers') {
      const wanted = u.searchParams.getAll('service')
      const all = [
        { service: 'gotify', authTypes: ['api_key'] },
        { service: 'weird', authTypes: [] },
      ]
      return json({
        success: true,
        data: wanted.length === 0 ? all : all.filter((p) => wanted.includes(p.service)),
        meta: {},
      })
    }
    if (path === '/v1/actions') return json({ success: true, data: ACTIONS, meta: {} })
    if (path === '/api/providers/weird') return json({ service: 'weird', auth: [] })
    if (path.startsWith('/v1/actions/') && method === 'POST') {
      if (state.actionResponse === 'throw') throw new Error('socket hang up')
      return json(state.actionResponse.body, state.actionResponse.status)
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

const READ = {
  assignment_id: 'asg_edge',
  kind: 'role-read' as const,
  allowed_actions: ['gotify.get_version'],
  allowed_connections: ['conn-1'],
}

describe('connect-adapter：边角路径', () => {
  it('上游执行失败：errorCode 优先于 HTTP 状态，失败也发事件', async () => {
    const rt = fakeRuntime()
    const sink = new MemoryEventSink()
    const connect = adapter(rt, { eventSink: sink })
    const token = await connect.issueToken(READ)

    rt.actionResponse = {
      status: 403,
      body: { success: false, errorCode: 'authorization_failed', message: '上游 401' },
    }
    await expect(
      connect.execute('gotify.get_version', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'provider_error' })

    rt.actionResponse = {
      status: 429,
      body: { success: false, errorCode: 'rate_limited', message: '慢点' },
    }
    await expect(
      connect.execute('gotify.get_version', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'rate_limited' })

    rt.actionResponse = 'throw'
    await expect(
      connect.execute('gotify.get_version', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })

    const failures = sink.ofType('connect.execute_failed')
    expect(failures.map((f) => f.payload.code)).toEqual([
      'provider_error',
      'rate_limited',
      'provider_unavailable',
    ])
    expect(failures[0]?.payload.runtime_error_code).toBe('authorization_failed')
  })

  it('执行超时映射成 timeout', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt, { requestTimeoutMs: 20 })
    const token = await connect.issueToken(READ)
    const hang: FetchLike = (url, init) => {
      if (new URL(url).pathname.startsWith('/v1/actions/') && init?.method === 'POST') {
        return new Promise((_r, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
      }
      return rt.fetchImpl(url, init)
    }
    const slow = adapter({ ...rt, fetchImpl: hang }, { requestTimeoutMs: 20 })
    const t2 = await slow.issueToken(READ)
    expect(t2.token).toBeDefined()
    await expect(slow.execute('gotify.get_version', {}, { token: t2.token })).rejects.toMatchObject(
      { code: 'timeout' },
    )
    expect(token.allowed_proxies).toEqual([])
  })

  it('签发后策略收紧：同一把 token 在新的覆盖表下调写 Action 被拒（纵深防御）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-connect-edge-'))
    const stateFile = join(dir, 'state.json')
    const lenient = join(dir, 'lenient.yml')
    const strict = join(dir, 'strict.yml')
    writeFileSync(lenient, 'version: 1\ndefault: write\nactions:\n  gotify.get_version: read\n')
    writeFileSync(strict, 'version: 1\ndefault: write\nactions:\n  gotify.get_version: write\n')

    const rt = fakeRuntime()
    const before = adapter(rt, { stateFile, sideEffectsFile: lenient })
    const token = await before.issueToken(READ)
    // 收紧后：这条 role-read token 还在，但它现在指着一个写 Action
    const after = adapter(rt, { stateFile, sideEffectsFile: strict })
    await expect(
      after.execute('gotify.get_version', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // 新的签发直接拒
    await expect(after.issueToken(READ)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('幂等键过了 24h 窗口就可以重用', async () => {
    const rt = fakeRuntime()
    const clock = new TestClock()
    const connect = adapter(rt, { clock, tokenTtlSeconds: 72 * 3600 })
    const token = await connect.issueToken({ ...READ, kind: 'role-apply' })
    const first = await connect.execute(
      'gotify.get_version',
      {},
      { token: token.token, idempotencyKey: 'k1' },
    )
    expect(first.meta?.idempotent_replay).toBe(false)
    const replayed = await connect.execute(
      'gotify.get_version',
      {},
      { token: token.token, idempotencyKey: 'k1' },
    )
    expect(replayed.meta?.idempotent_replay).toBe(true)
    clock.advance(24 * 3600 * 1000 + 1)
    const fresh = await connect.execute(
      'gotify.get_version',
      {},
      { token: token.token, idempotencyKey: 'k1' },
    )
    expect(fresh.meta?.idempotent_replay).toBe(false)
  })

  it('撤销时上游已经没有这条 token：当作已吊销，不报错', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    const token = await connect.issueToken(READ)
    rt.deleteStatus = 404
    await connect.revokeTokens(READ.assignment_id)
    expect(connect.tokenLedger()[0]?.revoked).toBe(true)
    await expect(
      connect.execute('gotify.get_version', {}, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('撤销时上游报别的错：照抛', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await connect.issueToken(READ)
    rt.deleteStatus = 500
    await expect(connect.revokeTokens(READ.assignment_id)).rejects.toMatchObject({
      code: 'provider_error',
    })
  })

  it('beginConnect 未知 provider → not_found；authTypes 为空按 no_auth 走空表单', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    await expect(
      connect.beginConnect('no_such_service', {
        workspace_id: 'ws_local',
        ownership: 'workspace',
        alias: 'x',
        mode: 'own_app',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    const weird = await connect.beginConnect('weird', {
      workspace_id: 'ws_local',
      ownership: 'workspace',
      alias: 'x',
      mode: 'agentsws_connect',
    })
    expect(weird.secure_form?.fields).toEqual([])
    expect(weird.request_id.startsWith('creq_')).toBe(true)
  })

  it('providers()：没给 services 白名单时不逐个探 executable', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    const providers = await connect.providers()
    expect(providers.map((p) => p.service)).toEqual(['gotify', 'weird'])
    expect(providers.map((p) => p.auth)).toEqual(['api_key', 'no_auth'])
    expect(providers.every((p) => p.executable)).toBe(true)
    expect(rt.calls.filter((c) => c === 'GET /v1/actions')).toHaveLength(0)
  })

  it('连接列表是缓存的，命中不了才刷新；始终找不到就是 not_found', async () => {
    const rt = fakeRuntime()
    const connect = adapter(rt)
    const token = await connect.issueToken(READ)
    await connect.execute('gotify.get_version', {}, { token: token.token })
    const before = rt.calls.filter((c) => c === 'GET /api/connections').length
    await expect(
      connect.execute('gotify.get_version', {}, { token: token.token, connection: 'conn-ghost' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // 缓存没命中会去刷新一次
    expect(rt.calls.filter((c) => c === 'GET /api/connections').length).toBe(before + 1)
  })

  it('catalogTokenEnv 给了就用现成的目录 token，不再自己签', async () => {
    const rt = fakeRuntime()
    const connect = createConnectAdapter({
      baseUrl: 'http://127.0.0.1:3000',
      adminTokenEnv: 'FAKE_ADMIN',
      catalogTokenEnv: 'FAKE_CATALOG',
      clock: new TestClock(),
      fetchImpl: rt.fetchImpl,
      env: { FAKE_ADMIN: 'fake-admin-token', FAKE_CATALOG: 'oct_provided_catalog' },
    })
    await connect.actions('gotify')
    expect(rt.calls.filter((c) => c === 'POST /api/runtime-tokens')).toHaveLength(0)
  })

  it('transferConnection 保住 owner_person_id', async () => {
    const rt = fakeRuntime()
    const stateFile = join(mkdtempSync(join(tmpdir(), 'agentsws-connect-own-')), 'state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        tokens: [],
        connections: [
          {
            connection_id: 'conn-1',
            workspace_id: 'ws_local',
            ownership: 'workspace',
            owner_person_id: 'per_1',
          },
        ],
      }),
    )
    const connect = adapter(rt, { stateFile })
    const moved = await connect.transferConnection('conn-1', 'ws_other')
    expect(moved.owner_person_id).toBe('per_1')
    expect((await connect.connections('ws_other'))[0]?.owner_person_id).toBe('per_1')
  })

  it('连接没配好时 status 是 reauth_required', async () => {
    const rt = fakeRuntime()
    rt.connections = [{ ...CONN, configured: false, profile: undefined }]
    const connect = adapter(rt)
    const conns = await connect.connections('ws_local')
    expect(conns[0]).toMatchObject({ status: 'reauth_required' })
    expect(conns[0]?.identity).toBeUndefined()
  })
})
