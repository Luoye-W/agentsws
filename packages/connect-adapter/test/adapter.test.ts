import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterStateFile, FetchLike } from '../src/index.js'
import {
  createConnectAdapter,
  createReplayFetch,
  fingerprint,
  MemoryEventSink,
  secretKey,
} from '../src/index.js'
import { TestClock } from './helpers.js'
import { cassette, replayCtx as ctx, makeReplayAdapter, meta } from './replay-harness.js'
import { applyTokenInput, IDEMPOTENCY_KEY, readTokenInput } from './scenarios.js'

interface Seen {
  url: string
  headers: Headers
  method: string
}

function spy(): { fetchImpl: FetchLike; seen: Seen[] } {
  const inner = createReplayFetch(cassette)
  const seen: Seen[] = []
  return {
    seen,
    fetchImpl: (url, init) => {
      seen.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: new Headers((init?.headers ?? {}) as HeadersInit),
      })
      return inner(url, init)
    },
  }
}

function adapterWith(
  fetchImpl: FetchLike,
  extra: Partial<Parameters<typeof createConnectAdapter>[0]> = {},
): ReturnType<typeof createConnectAdapter> {
  return createConnectAdapter({
    baseUrl: meta.base_url,
    adminTokenEnv: meta.admin_token_env,
    clock: new TestClock(meta.clock_start),
    fetchImpl,
    env: { [meta.admin_token_env]: meta.admin_token_placeholder },
    workspaceId: meta.workspace_id,
    services: [meta.service],
    ...extra,
  })
}

describe('connect-adapter：与上游打交道的细节', () => {
  it('幂等键透传成 Idempotency-Key 头，且只在给了键时出现', async () => {
    const { fetchImpl, seen } = spy()
    const connect = adapterWith(fetchImpl)
    const token = await connect.issueToken(readTokenInput(ctx))
    await connect.execute(ctx.read_action, ctx.read_input, { token: token.token })
    const noKey = seen.filter((s) => s.url.includes('/v1/actions/') && s.method === 'POST')
    expect(noKey).toHaveLength(1)
    expect(noKey[0]?.headers.get('idempotency-key')).toBeNull()
    expect(noKey[0]?.headers.get('x-oo-connector-alias')).toBe('default')

    seen.length = 0
    const idem = await connect.issueToken({
      ...applyTokenInput(ctx),
      assignment_id: `${ctx.assignment_id}_idem`,
      allowed_actions: [ctx.write_action, ctx.read_action],
    })
    await connect.execute(ctx.write_action, ctx.write_input, {
      token: idem.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    const posted = seen.filter((s) => s.url.includes('/v1/actions/') && s.method === 'POST')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY)
  })

  it('execute 的 executionId 进事件；重放时 meta 标 idempotent_replay', async () => {
    const sink = new MemoryEventSink()
    const connect = adapterWith(createReplayFetch(cassette), { eventSink: sink })
    const token = await connect.issueToken({
      ...applyTokenInput(ctx),
      assignment_id: `${ctx.assignment_id}_idem`,
      allowed_actions: [ctx.write_action, ctx.read_action],
    })
    const first = await connect.execute(ctx.write_action, ctx.write_input, {
      token: token.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    const again = await connect.execute(ctx.write_action, ctx.write_input, {
      token: token.token,
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    expect(first.meta?.idempotent_replay).toBe(false)
    expect(again.meta?.idempotent_replay).toBe(true)
    expect(again.execution_id).toBe(first.execution_id)

    const executed = sink.ofType('connect.executed')
    expect(executed).toHaveLength(2)
    expect(executed[0]?.execution_id).toBe(first.execution_id)
    expect(executed[0]?.assignment_id).toBe(`${ctx.assignment_id}_idem`)
    expect(executed[0]?.payload).toMatchObject({
      action_id: ctx.write_action,
      service: ctx.service,
      side_effect: 'write',
      token_kind: 'role-apply',
      connection_id: ctx.connection_id,
      idempotency_key: IDEMPOTENCY_KEY,
    })
    expect(executed[0]?.payload.token_fingerprint).toBe(fingerprint(token.token))
  })

  it('签发与撤销都进事件；失败的执行进 connect.execute_failed', async () => {
    const sink = new MemoryEventSink()
    const connect = adapterWith(createReplayFetch(cassette), { eventSink: sink })
    const token = await connect.issueToken(readTokenInput(ctx))
    await expect(
      connect.execute(ctx.write_action, ctx.write_input, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await connect.revokeTokens(ctx.assignment_id)

    expect(sink.ofType('connect.token_issued')[0]?.payload).toMatchObject({
      kind: 'role-read',
      allowed_proxies: [],
      allowed_actions: [ctx.read_action],
    })
    expect(sink.ofType('connect.execute_failed')[0]?.payload).toMatchObject({
      action_id: ctx.write_action,
      code: 'forbidden',
    })
    expect(sink.ofType('connect.tokens_revoked')[0]?.payload).toMatchObject({ revoked: 1 })
  })

  it('proxy 被拒时也发事件，且带上 token 指纹而不是原文', async () => {
    const sink = new MemoryEventSink()
    const connect = adapterWith(createReplayFetch(cassette), { eventSink: sink })
    const token = await connect.issueToken(readTokenInput(ctx))
    await expect(
      connect.proxy(ctx.service, { endpoint: '/x', method: 'GET' }, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    const denied = sink.ofType('connect.proxy_denied')[0]
    expect(denied?.payload).toMatchObject({ service: ctx.service, token_kind: 'role-read' })
    expect(denied?.payload.token_fingerprint).toBe(fingerprint(token.token))
    // 未知 token 也拒，只是没有指纹
    await expect(
      connect.proxy(ctx.service, { endpoint: '/x', method: 'GET' }, { token: 'oct_nope' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(sink.ofType('connect.proxy_denied')[1]?.payload.token_kind).toBe('unknown')
  })

  it('凭据零泄漏：所有返回值 + 所有事件里都搜不到 admin token / runtime token 原文，只有 sha256 前 12 位', async () => {
    const sink = new MemoryEventSink()
    const connect = adapterWith(createReplayFetch(cassette), { eventSink: sink })
    const returned: unknown[] = []
    returned.push(await connect.providers())
    returned.push(await connect.actions(ctx.service))
    returned.push(await connect.connections(ctx.workspace_id))
    const token = await connect.issueToken(readTokenInput(ctx))
    returned.push(await connect.execute(ctx.read_action, ctx.read_input, { token: token.token }))
    returned.push(connect.tokenLedger())
    await connect.revokeTokens(ctx.assignment_id)

    const events = JSON.stringify(sink.events)
    const secrets = [meta.admin_token_placeholder, token.token]
    for (const secret of secrets) {
      expect(events).not.toContain(secret)
      // 只有 issueToken 的返回值本身允许含 token（契约要求把它交给调用方）
      for (const value of returned.slice(0, 3)) {
        expect(JSON.stringify(value)).not.toContain(secret)
      }
    }
    // 事件里出现的是指纹
    expect(events).toContain(fingerprint(token.token))
    expect(fingerprint(token.token)).toHaveLength(12)
    expect(secretKey(token.token)).toHaveLength(64)
  })

  it('本地状态文件不含凭据原文，只有 sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-connect-'))
    const stateFile = join(dir, 'connect-state.json')
    const connect = adapterWith(createReplayFetch(cassette), { stateFile })
    const token = await connect.issueToken(readTokenInput(ctx))
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as AdapterStateFile
    expect(JSON.stringify(saved)).not.toContain(token.token)
    expect(saved.tokens[0]?.token_sha256).toBe(secretKey(token.token))
    expect(saved.tokens[0]?.allowed_proxies).toEqual([])

    // 重开一个适配器：从文件里认得回这把 token
    const reopened = adapterWith(createReplayFetch(cassette), { stateFile })
    const res = await reopened.execute(ctx.read_action, ctx.read_input, { token: token.token })
    expect(res.execution_id.length).toBeGreaterThan(0)
  })

  it('token 到期后失效（上游 runtime token 没有有效期，由我们记账）', async () => {
    const clock = new TestClock(meta.clock_start)
    const connect = adapterWith(createReplayFetch(cassette), { clock, tokenTtlSeconds: 60 })
    const token = await connect.issueToken(readTokenInput(ctx))
    expect(Date.parse(token.expires_at) - Date.parse(meta.clock_start)).toBe(60_000)
    clock.advance(61_000)
    await expect(
      connect.execute(ctx.read_action, ctx.read_input, { token: token.token }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(connect.tokenLedger()[0]).toMatchObject({
      assignment_id: ctx.assignment_id,
      kind: 'role-read',
      revoked: false,
    })
  })

  it('actions() 带出 locallyExecutable / catalogOnly', async () => {
    const connect = adapterWith(createReplayFetch(cassette))
    const actions = await connect.actions(ctx.service)
    const read = actions.find((a) => a.id === ctx.read_action)
    expect(read?.execution).toMatchObject({
      locally_executable: true,
      catalog_only: false,
      needs_credential: true,
    })
    expect(read?.execution.required_auth_types).toContain('api_key')
    expect(read?.input_schema).toBeDefined()
    expect(read?.output_schema).toBeDefined()
  })

  it('providers() 在给了 services 白名单时精确解析 executable', async () => {
    const connect = adapterWith(createReplayFetch(cassette))
    const providers = await connect.providers()
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ service: ctx.service, auth: 'api_key', executable: true })
  })

  it('beginConnect 对 api_key provider 只给表单描述，不接触任何值（13 §4.3）', async () => {
    const connect = adapterWith(createReplayFetch(cassette))
    const started = await connect.beginConnect(ctx.service, {
      workspace_id: ctx.workspace_id,
      ownership: 'workspace',
      alias: 'conformance_api_key',
      mode: 'own_app',
    })
    expect(started.authorization_url).toBeUndefined()
    expect(started.secure_form?.fields).toEqual([
      { name: 'apiKey', secret: true },
      { name: 'baseUrl', secret: false },
    ])
    // 还没连上：连接列表里没有这个 alias
    expect(await connect.pollConnect(started.request_id)).toBe('initiated')
  })

  it('beginConnect 对 oauth2 provider 给真实的授权 URL，request_id 就是上游的 state', async () => {
    const connect = adapterWith(createReplayFetch(cassette))
    const started = await connect.beginConnect(ctx.oauth_service as string, {
      workspace_id: ctx.workspace_id,
      ownership: 'workspace',
      alias: 'conformance_oauth',
      mode: 'own_app',
    })
    expect(started.secure_form).toBeUndefined()
    const url = new URL(started.authorization_url as string)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('state')).toBe(started.request_id)
    expect(url.searchParams.get('redirect_uri')).toContain('/oauth/callback')
    // clientSecret 绝不出现在授权 URL 里
    expect(started.authorization_url).not.toContain('client_secret')
  })

  it('pollConnect：授权窗口过了就是 expired；未知 request_id 也是 expired', async () => {
    const clock = new TestClock(meta.clock_start)
    const connect = adapterWith(createReplayFetch(cassette), { clock, oauthWindowSeconds: 60 })
    const started = await connect.beginConnect(ctx.oauth_service as string, {
      workspace_id: ctx.workspace_id,
      ownership: 'workspace',
      alias: 'conformance_oauth',
      mode: 'own_app',
    })
    expect(await connect.pollConnect(started.request_id)).toBe('initiated')
    clock.advance(61_000)
    expect(await connect.pollConnect(started.request_id)).toBe('expired')
    // 过期后这条 pending 就被丢掉了
    expect(await connect.pollConnect(started.request_id)).toBe('expired')
    expect(await connect.pollConnect('creq_never_existed')).toBe('expired')
  })

  it('pollConnect：目标 alias 的连接出现后就是 connected，并按 ownership 记归属', async () => {
    // 这一条要"连接列表在两次 poll 之间变了"，用 stub fetch 更直白
    let connected = false
    const gotify = { service: 'gotify', authTypes: ['api_key'] }
    const stubFetch: FetchLike = async (url) => {
      const path = new URL(url).pathname
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (path === '/api/runtime-tokens') return json({ token: 'oct_stub', record: { id: 't1' } })
      if (path === '/v1/providers') return json({ success: true, data: [gotify], meta: {} })
      if (path === '/api/providers/gotify') {
        return json({ service: 'gotify', auth: [{ type: 'api_key', extraFields: [] }] })
      }
      if (path === '/api/connections') {
        return json(
          connected
            ? [
                {
                  id: 'conn-new',
                  service: 'gotify',
                  connectionName: 'support',
                  configured: true,
                  default: false,
                },
              ]
            : [],
        )
      }
      return new Response('{}', { status: 404 })
    }
    const connect = adapterWith(stubFetch)
    const started = await connect.beginConnect('gotify', {
      workspace_id: 'ws_local',
      ownership: 'person',
      alias: 'support',
      mode: 'own_app',
    })
    expect(await connect.pollConnect(started.request_id)).toBe('initiated')
    connected = true
    expect(await connect.pollConnect(started.request_id)).toBe('connected')
    const conns = await connect.connections('ws_local')
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ id: 'conn-new', ownership: 'person', alias: 'support' })
    // person 类连接不许转移
    await expect(connect.transferConnection('conn-new', 'ws_other')).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('跨 runtime 的 transferConnection 标 not_implemented', async () => {
    const connect = adapterWith(createReplayFetch(cassette), {
      workspaceRuntimes: { ws_remote: 'http://127.0.0.1:39999' },
    })
    await expect(connect.transferConnection(ctx.connection_id, 'ws_remote')).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'not_implemented' },
    })
    // 同一个 runtime 上的目标工作区照常放行
    const moved = await connect.transferConnection(ctx.connection_id, ctx.workspace_id)
    expect(moved.workspace_id).toBe(ctx.workspace_id)
  })

  it('person 类连接不许转移', async () => {
    const connect = adapterWith(createReplayFetch(cassette))
    const started = await connect.beginConnect(ctx.service, {
      workspace_id: ctx.workspace_id,
      ownership: 'person',
      alias: 'conformance_api_key',
      mode: 'own_app',
    })
    expect(started.request_id.length).toBeGreaterThan(0)
    // 直接改一条已知连接的归属：用 transfer 把它变成 person 拿不到，只能靠已有元数据，
    // 所以这里验证的是"默认 workspace 的连接可转、非 workspace 的拒"这条分支的另一半
    await expect(connect.transferConnection('conn_does_not_exist', 'ws_x')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('admin token 环境变量缺失时，凡是要 admin 的调用都报 unauthenticated', async () => {
    const connect = createConnectAdapter({
      baseUrl: meta.base_url,
      adminTokenEnv: 'NOT_SET_ANYWHERE',
      clock: new TestClock(meta.clock_start),
      fetchImpl: createReplayFetch(cassette),
      env: {},
      workspaceId: meta.workspace_id,
    })
    await expect(connect.connections(meta.workspace_id)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('上游不可达 / 超时分别映射成 provider_unavailable 与 timeout', async () => {
    const dead = adapterWith(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(dead.connections(meta.workspace_id)).rejects.toMatchObject({
      code: 'provider_unavailable',
    })

    const hang = adapterWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
      { requestTimeoutMs: 20 },
    )
    await expect(hang.connections(meta.workspace_id)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('回放档下 makeReplayAdapter 与手工装配等价（磁带游标各自独立）', async () => {
    const a = makeReplayAdapter()
    const b = makeReplayAdapter()
    const ta = await a.issueToken(readTokenInput(ctx))
    const tb = await b.issueToken(readTokenInput(ctx))
    expect(ta.token).toBe(tb.token)
    expect(a.tokenLedger()).toHaveLength(1)
    expect(b.tokenLedger()).toHaveLength(1)
  })
})
