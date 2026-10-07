/**
 * WP252（决策 125）：一台机一个 OpenConnector、多个品牌共用时，连接按品牌隔开。
 *
 * 假 runtime 按真上游的脾气写：`PUT /api/connections/:service` 按 (service, connectionName) **就地覆盖**
 * （同名再 PUT 一次，凭据就被顶掉——这正是老问题的根），每个 provider 第一条连接是 `default: true`，
 * runtime token 记下 `allowedConnections`。不联网。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConnectAdapterOptions, FetchLike } from '../src/index.js'
import {
  brandConnectionName,
  ConnectionOwners,
  createConnectAdapter,
  migrateConnectionOwners,
  parseBrandConnectionName,
} from '../src/index.js'
import { TestClock } from './helpers.js'

const A = 'ws_0llwvcm2' // 启动品牌（INMO 那种）
const B = 'ws_19cxxs7l' // 后加的品牌（Rollout 那种）

interface WireConn {
  id: string
  service: string
  connectionName: string
  authType: string
  configured: boolean
  default: boolean
  /** 只在假 runtime 里：现在存着的凭据（断言「没被顶掉」用）。 */
  secret: string
  profile: { accountId: string; displayName: string }
}

interface FakeRuntime {
  fetchImpl: FetchLike
  conns: WireConn[]
  puts: { service: string; connectionName: string }[]
  tokens: { allowedConnections: string[] }[]
  executed: { action: string; connectionName: string | undefined }[]
}

function fakeRuntime(seed: Partial<WireConn>[] = []): FakeRuntime {
  let seq = 0
  const rt: FakeRuntime = {
    conns: seed.map((c, i) => ({
      id: `legacy-${i + 1}`,
      service: 'gotify',
      connectionName: 'default',
      authType: 'api_key',
      configured: true,
      default: true,
      secret: 'old',
      profile: { accountId: `acct-legacy-${i + 1}`, displayName: '老连接' },
      ...c,
    })),
    puts: [],
    tokens: [],
    executed: [],
    fetchImpl: async () => new Response('{}', { status: 404 }),
  }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  rt.fetchImpl = async (url, init) => {
    const u = new URL(url)
    const path = u.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (path === '/api/connections' && method === 'GET') {
      return json(rt.conns.map(({ secret: _s, ...c }) => c))
    }
    if (path.startsWith('/api/connections/') && method === 'PUT') {
      const service = decodeURIComponent(path.slice('/api/connections/'.length))
      const { connectionName, values } = body as {
        connectionName: string
        values: Record<string, string>
      }
      rt.puts.push({ service, connectionName })
      const hit = rt.conns.find((c) => c.service === service && c.connectionName === connectionName)
      if (hit !== undefined) {
        hit.secret = values.apiKey ?? ''
      } else {
        seq += 1
        rt.conns.push({
          id: `conn-${seq}`,
          service,
          connectionName,
          authType: 'api_key',
          configured: true,
          default: !rt.conns.some((c) => c.service === service),
          secret: values.apiKey ?? '',
          profile: { accountId: `acct-${seq}`, displayName: values.baseUrl ?? '' },
        })
      }
      return json({ ok: true })
    }
    if (path.startsWith('/api/connections/') && method === 'DELETE') {
      const service = decodeURIComponent(path.slice('/api/connections/'.length))
      const name = u.searchParams.get('connectionName')
      rt.conns = rt.conns.filter((c) => !(c.service === service && c.connectionName === name))
      return json({ service, connectionName: name, configured: false })
    }
    if (path === '/v1/providers') {
      return json({ success: true, data: [{ service: 'gotify', authTypes: ['api_key'] }] })
    }
    if (path === '/api/providers/gotify') {
      return json({ service: 'gotify', auth: [{ type: 'api_key', fields: [] }] })
    }
    if (path === '/api/runtime-tokens' && method === 'POST') {
      rt.tokens.push({ allowedConnections: body.allowedConnections })
      return json({ token: `oct_${rt.tokens.length}`, record: { id: `rt_${rt.tokens.length}` } })
    }
    if (path === '/v1/actions') {
      return json({
        success: true,
        data: [
          {
            id: 'gotify.get_version',
            service: 'gotify',
            inputSchema: {},
            execution: { locallyExecutable: true, catalogOnly: false },
          },
        ],
      })
    }
    if (path.startsWith('/v1/actions/') && method === 'POST') {
      rt.executed.push({
        action: decodeURIComponent(path.split('/')[3] ?? ''),
        // SDK 把连接名放在这个头里（`@oomol-lab/connector` 1.2.0）
        connectionName:
          new Headers((init?.headers ?? {}) as HeadersInit).get('x-oo-connector-alias') ??
          undefined,
      })
      return json({ success: true, data: { v: 1 }, meta: { executionId: 'exec-1' } })
    }
    return json({ error: { code: 'not_found', message: path } }, 404)
  }
  return rt
}

function brand(
  rt: FakeRuntime,
  workspaceId: string,
  owners: ConnectionOwners,
  extra: Partial<ConnectAdapterOptions> = {},
): ReturnType<typeof createConnectAdapter> {
  return createConnectAdapter({
    baseUrl: 'http://127.0.0.1:43170',
    adminTokenEnv: 'FAKE_ADMIN',
    clock: new TestClock(),
    fetchImpl: rt.fetchImpl,
    env: { FAKE_ADMIN: 'fake-admin-token' },
    workspaceId,
    owners,
    claimsLegacy: workspaceId === A,
    ...extra,
  })
}

const submit = (
  connect: ReturnType<typeof createConnectAdapter>,
  workspace_id: string,
  secret: string,
  alias = 'default',
) =>
  connect.submitForm('gotify', {
    workspace_id,
    ownership: 'workspace',
    alias,
    auth_type: 'api_key',
    fields: { apiKey: secret, baseUrl: `${workspace_id}.example.test` },
  })

describe('WP252 连接名带品牌', () => {
  it('brandConnectionName：`<别名>--<品牌段>`，再套一次不变；parse 拆得回来，老名字拆不出', () => {
    expect(brandConnectionName(B, 'default')).toBe('default--ws_19cxxs7l')
    expect(brandConnectionName(B, 'default--ws_19cxxs7l')).toBe('default--ws_19cxxs7l')
    expect(brandConnectionName('WS-Odd.Id', 'eu')).toBe('eu--wsoddid')
    expect(parseBrandConnectionName('default--ws_19cxxs7l')).toEqual({
      alias: 'default',
      segment: 'ws_19cxxs7l',
    })
    expect(parseBrandConnectionName('default')).toBeUndefined()
    expect(parseBrandConnectionName('--ws_x')).toBeUndefined()
  })
})

describe('WP252 两个品牌连同一个 provider', () => {
  it('互不覆盖：上游各是各的一条，先连的那家凭据没被后连的顶掉', async () => {
    const rt = fakeRuntime()
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)

    const ca = await submit(a, A, 'secret-of-inmo')
    const cb = await submit(b, B, 'secret-of-rollout')

    expect(rt.puts.map((p) => p.connectionName)).toEqual([
      'default--ws_0llwvcm2',
      'default--ws_19cxxs7l',
    ])
    expect(rt.conns).toHaveLength(2)
    expect(ca.id).not.toBe(cb.id)
    expect(rt.conns.find((c) => c.id === ca.id)?.secret).toBe('secret-of-inmo')
    expect(rt.conns.find((c) => c.id === cb.id)?.secret).toBe('secret-of-rollout')
    // 界面上的别名不带品牌段
    expect(ca.alias).toBe('default')
    expect(cb.alias).toBe('default')
    expect(owners.ownerOf(ca.id)?.workspace_id).toBe(A)
    expect(owners.ownerOf(cb.id)?.workspace_id).toBe(B)
  })

  it('互不可见：各列各的；也不能断开对方那条', async () => {
    const rt = fakeRuntime()
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)
    const ca = await submit(a, A, 'sa')
    const cb = await submit(b, B, 'sb')

    expect((await a.connections(A)).map((c) => c.id)).toEqual([ca.id])
    expect((await b.connections(B)).map((c) => c.id)).toEqual([cb.id])
    // 拿别的品牌的 workspace_id 去问也问不出来
    expect(await b.connections(A)).toEqual([])

    await expect(b.removeConnection(ca.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(rt.conns.some((c) => c.id === ca.id)).toBe(true)
    await b.removeConnection(cb.id)
    expect(rt.conns.map((c) => c.id)).toEqual([ca.id])
    expect(owners.ownerOf(cb.id)).toBeUndefined()
  })

  it('token 只含本品牌连接：混进别的品牌的连接拒签；不指定连接时也只挑本品牌的', async () => {
    const rt = fakeRuntime()
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)
    const ca = await submit(a, A, 'sa') // 上游的「默认连接」是 A 的这条
    const cb = await submit(b, B, 'sb')
    const read = { kind: 'role-read' as const, allowed_actions: ['gotify.get_version'] }

    await expect(
      b.issueToken({ ...read, assignment_id: 'asg_b', allowed_connections: [ca.id] }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      b.issueToken({ ...read, assignment_id: 'asg_b', allowed_connections: [cb.id, ca.id] }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(rt.tokens).toEqual([])

    const token = await b.issueToken({
      ...read,
      assignment_id: 'asg_b',
      allowed_connections: [cb.id],
    })
    expect(rt.tokens).toEqual([{ allowedConnections: [cb.id] }])

    // 不指定连接：上游的默认是 A 的，B 只能落到自己那条
    const out = await b.execute('gotify.get_version', {}, { token: token.token })
    expect(out.meta.connection_id).toBe(cb.id)
    expect(rt.executed.at(-1)?.connectionName).toBe('default--ws_19cxxs7l')
    // 按别名点名（`default`）也是本品牌那条
    const named = await b.execute(
      'gotify.get_version',
      {},
      { token: token.token, connection: 'default' },
    )
    expect(named.meta.connection_id).toBe(cb.id)
    // 点名要 A 的那条：对 B 来说不存在
    await expect(
      b.execute('gotify.get_version', {}, { token: token.token, connection: ca.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('WP252 老数据：老 default 连接归启动品牌', () => {
  it('没人记过的老 `default`：启动品牌认领、别的品牌看不见（哪怕它先列）', async () => {
    const rt = fakeRuntime([{}]) // 上游已有一条 gotify/default（WP252 之前连的）
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)

    expect(await b.connections(B)).toEqual([]) // B 先列：不再「没记录过 = 我的」
    expect(owners.ownerOf('legacy-1')).toBeUndefined()
    const listed = await a.connections(A)
    expect(listed.map((c) => [c.id, c.alias])).toEqual([['legacy-1', 'default']])
    expect(owners.ownerOf('legacy-1')).toMatchObject({ workspace_id: A, via: 'legacy' })
    expect(await b.connections(B)).toEqual([])
    await expect(
      b.issueToken({
        assignment_id: 'asg_b',
        kind: 'role-read',
        allowed_actions: ['gotify.get_version'],
        allowed_connections: ['legacy-1'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('启动品牌重连自己的老 `default`：沿用老名字就地更新，不另起一条', async () => {
    const rt = fakeRuntime([{}])
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    await a.connections(A)
    const again = await submit(a, A, 'rotated')
    expect(again.id).toBe('legacy-1')
    expect(rt.puts).toEqual([{ service: 'gotify', connectionName: 'default' }])
    expect(rt.conns).toHaveLength(1)
    expect(rt.conns[0]?.secret).toBe('rotated')
  })

  it('别的品牌连同一个 provider（别名也叫 default）：另起一条，不碰启动品牌的老连接', async () => {
    const rt = fakeRuntime([{}])
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)
    await a.connections(A)
    const cb = await submit(b, B, 'sb')
    expect(cb.id).not.toBe('legacy-1')
    expect(rt.conns.find((c) => c.id === 'legacy-1')?.secret).toBe('old')
    expect((await a.connections(A)).map((c) => c.id)).toEqual(['legacy-1'])
    expect((await b.connections(B)).map((c) => c.id)).toEqual([cb.id])
  })

  it('归属表丢了：带本品牌段的认回来；带别的品牌段的启动品牌也不认', async () => {
    const rt = fakeRuntime([
      { id: 'c-b', connectionName: 'default--ws_19cxxs7l', default: false },
      { id: 'c-a', connectionName: 'default--ws_0llwvcm2', default: false },
    ])
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    const b = brand(rt, B, owners)
    expect((await a.connections(A)).map((c) => c.id)).toEqual(['c-a'])
    expect((await b.connections(B)).map((c) => c.id)).toEqual(['c-b'])
  })
})

describe('WP252 迁移：补记归属（幂等）', () => {
  const stateFile = (dir: string, name: string, connections: { id: string; ws: string }[]) => {
    const file = join(dir, name)
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tokens: [],
        connections: connections.map((c) => ({
          connection_id: c.id,
          workspace_id: c.ws,
          ownership: 'workspace',
        })),
      }),
    )
    return file
  }

  it('各品牌老状态文件里记过的归各自；两个品牌都记过的同一条归启动品牌、另一个品牌提示重新连接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp252-mig-'))
    const ownersFile = join(dir, 'connect-owners.json')
    // 老问题现场：A、B 都用 `default` 连了 gotify（上游同一条 legacy-1，凭据是后写的那家的）；
    // B 另有一条只有它记过的 legacy-2
    const rt = fakeRuntime([{}, { service: 'gotify', connectionName: 'eu', default: false }])
    const brands = [
      { workspace_id: A, stateFile: stateFile(dir, 'a.json', [{ id: 'legacy-1', ws: A }]) },
      {
        workspace_id: B,
        stateFile: stateFile(dir, 'b.json', [
          { id: 'legacy-1', ws: B },
          { id: 'legacy-2', ws: B },
        ]),
      },
    ]
    const owners = ConnectionOwners.open(ownersFile)
    const first = migrateConnectionOwners(owners, {
      startup: A,
      brands,
      now: '2026-10-07T00:00:00Z',
    })
    expect(first).toEqual({ claimed: 2, conflicts: 1, skipped: 0 })
    expect(owners.ownerOf('legacy-1')).toMatchObject({ workspace_id: A, via: 'migrated' })
    expect(owners.ownerOf('legacy-2')).toMatchObject({ workspace_id: B, via: 'migrated' })
    expect(owners.reconnectsOf(B)).toEqual([
      expect.objectContaining({ connection_id: 'legacy-1', kept_by: A, moved_from: B }),
    ])
    expect(owners.keptUncheckedOf(A)).toHaveLength(1)

    // 幂等：再跑一次什么都不变（文件逐字节相同）
    const before = readFileSync(ownersFile, 'utf8')
    const again = migrateConnectionOwners(owners, {
      startup: A,
      brands,
      now: '2026-10-08T00:00:00Z',
    })
    expect(again).toEqual({ claimed: 0, conflicts: 0, skipped: 2 })
    expect(readFileSync(ownersFile, 'utf8')).toBe(before)
    // 重启（新进程从文件读）也一样
    ConnectionOwners.forget(ownersFile)
    const reopened = ConnectionOwners.open(ownersFile)
    expect(reopened).not.toBe(owners)
    expect(
      migrateConnectionOwners(reopened, { startup: A, brands, now: '2026-10-09T00:00:00Z' }),
    ).toEqual({ claimed: 0, conflicts: 0, skipped: 2 })
    expect(reopened.snapshot()).toEqual(owners.snapshot())

    // 迁移后：A 只看见 legacy-1，B 只看见 legacy-2；列一遍之后「请重新连接」知道是哪家服务
    const a = brand(rt, A, reopened)
    const b = brand(rt, B, reopened, {
      stateFile: brands[1]?.stateFile ?? '',
    })
    expect((await a.connections(A)).map((c) => c.id)).toEqual(['legacy-1'])
    expect((await b.connections(B)).map((c) => c.id)).toEqual(['legacy-2'])
    expect(reopened.reconnectsOf(B)[0]).toMatchObject({
      service: 'gotify',
      connection_name: 'default',
    })

    // B 重新连接 gotify：另起一条带品牌段的，「请重新连接」随之结掉，A 那条一个字节没动
    const fresh = await submit(b, B, 'sb-new')
    expect(fresh.id).not.toBe('legacy-1')
    expect(reopened.reconnectsOf(B)).toEqual([])
    expect(rt.conns.find((c) => c.id === 'legacy-1')?.secret).toBe('old')
  })

  it('两个都不是启动品牌的品牌记过同一条：归排序最前的那个（确定性），另一个提示重新连接', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp252-mig2-'))
    const owners = new ConnectionOwners()
    const out = migrateConnectionOwners(owners, {
      startup: A,
      brands: [
        { workspace_id: 'ws_c', stateFile: stateFile(dir, 'c.json', [{ id: 'x', ws: 'ws_c' }]) },
        { workspace_id: B, stateFile: stateFile(dir, 'b.json', [{ id: 'x', ws: B }]) },
        { workspace_id: A, stateFile: join(dir, 'missing.json') },
      ],
      now: '2026-10-07T00:00:00Z',
    })
    expect(out).toEqual({ claimed: 1, conflicts: 1, skipped: 0 })
    expect(owners.ownerOf('x')?.workspace_id).toBe(B)
    expect(owners.reconnectsOf('ws_c')).toHaveLength(1)
  })

  it('「请重新连接」点了断开：只删提醒，不碰上游；留下那边测过之后提醒也收起', () => {
    const owners = new ConnectionOwners()
    owners.claim({ connection_id: 'x', workspace_id: A, via: 'migrated', since: 't' })
    owners.addConflict({ connection_id: 'x', kept_by: A, moved_from: B, at: 't' })
    expect(owners.addConflict({ connection_id: 'x', kept_by: A, moved_from: B, at: 't2' })).toBe(
      false,
    )
    owners.markKeptChecked(A, 'x')
    expect(owners.keptUncheckedOf(A)).toEqual([])
    expect(owners.dismissReconnect(B, 'x')).toBe(true)
    expect(owners.reconnectsOf(B)).toEqual([])
    expect(owners.ownerOf('x')?.workspace_id).toBe(A)
  })
})

describe('WP252 同一个品牌再推一次（令牌刷新 / 重连）', () => {
  it('按别名再推：落在本品牌带品牌段的那条上就地更新，不另起一条', async () => {
    const rt = fakeRuntime()
    const owners = new ConnectionOwners()
    const b = brand(rt, B, owners)
    const first = await submit(b, B, 'token-1')
    const again = await submit(b, B, 'token-2')
    expect(again.id).toBe(first.id)
    expect(rt.conns).toHaveLength(1)
    expect(rt.conns[0]?.secret).toBe('token-2')
  })

  it('本品牌老名字与带品牌段的都有：先认带品牌段的那条', async () => {
    const rt = fakeRuntime([
      {},
      { id: 'c-a', connectionName: 'default--ws_0llwvcm2', default: false, secret: 'new' },
    ])
    const owners = new ConnectionOwners()
    const a = brand(rt, A, owners)
    expect((await a.connections(A)).map((c) => c.id).sort()).toEqual(['c-a', 'legacy-1'])
    const pushed = await submit(a, A, 'rotated')
    expect(pushed.id).toBe('c-a')
    expect(rt.conns.find((c) => c.id === 'legacy-1')?.secret).toBe('old')
  })
})
