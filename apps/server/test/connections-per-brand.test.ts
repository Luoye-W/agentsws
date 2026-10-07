/**
 * WP252（决策 125）端到端：一台机一个 OpenConnector、两个品牌都连 Shopify（INMO 与 Rollout 那种）。
 *
 * 走真装配线（真 connect-adapter + 真连接面 + 真路由）；「OpenConnector」是本机一个小 http 服务，
 * 按真上游的脾气写——`PUT /api/connections/:service` 按 (service, 连接名) **就地覆盖**，匿名一律 401
 * （加固检查过得去）。Shopify 换令牌那一跳用假上游。不联网。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionView } from '@agentsws/api'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_DIR } from '../src/brand-modules.js'
import { CONNECT_OWNERS_FILE } from '../src/connect-owners.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import type { BrokerFetch } from '../src/shopify-broker.js'

interface WireConn {
  id: string
  service: string
  connectionName: string
  authType: string
  configured: boolean
  default: boolean
  /** 只在假 runtime 里：现在存着的令牌（断言「没被顶掉」用）。 */
  secret: string
  profile: { accountId: string; displayName: string }
}

interface FakeRuntime {
  url: string
  conns: WireConn[]
  puts: string[]
  tokens: string[][]
}

const servers: Server[] = []
const https: HttpServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const h of https.splice(0)) h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function fakeRuntime(seed: WireConn[] = []): Promise<FakeRuntime> {
  const rt: FakeRuntime = { url: '', conns: [...seed], puts: [], tokens: [] }
  let seq = 0
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      }
      if ((req.headers.authorization ?? '') === '') return send(401, { error: 'unauthorized' })
      const u = new URL(req.url ?? '/', 'http://x')
      const method = req.method ?? 'GET'
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? undefined : JSON.parse(text)
      if (u.pathname === '/v1/health') return send(200, { ok: true })
      if (u.pathname === '/api/connections' && method === 'GET') {
        return send(
          200,
          rt.conns.map(({ secret: _s, ...c }) => c),
        )
      }
      if (u.pathname.startsWith('/api/connections/') && method === 'PUT') {
        const service = decodeURIComponent(u.pathname.slice('/api/connections/'.length))
        rt.puts.push(`${service}/${body.connectionName}`)
        const hit = rt.conns.find(
          (c) => c.service === service && c.connectionName === body.connectionName,
        )
        if (hit !== undefined) {
          hit.secret = body.values.apiKey
          hit.profile.displayName = body.values.shopDomain
        } else {
          seq += 1
          rt.conns.push({
            id: `oc-${seq}`,
            service,
            connectionName: body.connectionName,
            authType: 'api_key',
            configured: true,
            default: !rt.conns.some((c) => c.service === service),
            secret: body.values.apiKey,
            profile: { accountId: `acct-${seq}`, displayName: body.values.shopDomain },
          })
        }
        return send(200, { ok: true })
      }
      if (u.pathname.startsWith('/api/connections/') && method === 'DELETE') {
        const service = decodeURIComponent(u.pathname.slice('/api/connections/'.length))
        const name = u.searchParams.get('connectionName')
        rt.conns = rt.conns.filter((c) => !(c.service === service && c.connectionName === name))
        return send(200, { service, connectionName: name, configured: false })
      }
      if (u.pathname === '/api/runtime-tokens' && method === 'POST') {
        rt.tokens.push(body.allowedConnections)
        return send(200, {
          token: `oct_${rt.tokens.length}`,
          record: { id: `rt_${rt.tokens.length}` },
        })
      }
      if (u.pathname.startsWith('/api/runtime-tokens/') && method === 'DELETE') {
        return send(200, { revoked: true })
      }
      if (u.pathname === '/v1/providers') {
        return send(200, {
          success: true,
          data: [{ service: 'shopify_admin', authTypes: ['api_key'] }],
        })
      }
      // 目录里没有不填参数就能跑的只读动作 → 试连回 test_unavailable（这一单不测试连）
      if (u.pathname === '/v1/actions') return send(200, { success: true, data: [] })
      return send(404, { error: { code: 'not_found', message: u.pathname } })
    })
  })
  https.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  rt.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return rt
}

/** Shopify 换令牌的假上游：每换一次给一张新的（令牌里带店名，好认）。 */
const shopifyFetch: BrokerFetch = async (url) => {
  const shop = new URL(url).hostname.split('.')[0]
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        access_token: `shpat_${shop}_${'f'.repeat(16)}`,
        scope: 'read_orders',
        expires_in: 86_399,
      }),
  }
}

interface Who {
  workspace_id: string
  token: string
  assignment: string
}

async function boot(rt: FakeRuntime, dbDir?: string): Promise<Server> {
  const server = await createServer({
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    mdns: () => ({ reason: '测试里不开局域网' }),
    shopifyFetch,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_WORKSPACE_NAME: 'INMO',
      AGENTSWS_CONNECT_URL: rt.url,
      OOMOL_CONNECT_ENCRYPTION_KEY: 'k'.repeat(64),
      OOMOL_CONNECT_ADMIN_TOKEN: 'a'.repeat(64),
      OOMOL_CONNECT_BLOCKED_PROXIES: '*',
      [SECRETS_KEY_ENV]: 'b'.repeat(64),
    },
    ...(dbDir === undefined ? {} : { dbDir }),
  })
  servers.push(server)
  return server
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T }> {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${who.token}`,
        'X-Assignment': who.assignment,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
}

const startupWho = (server: Server): Who => ({
  workspace_id: server.bootstrap.workspace.id,
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
})

/** 切到某个品牌（建品牌也是这一步之后才拿得到它的会话 token）。 */
async function switchTo(server: Server, workspace_id: string): Promise<Who> {
  const me = startupWho(server)
  const org = (await call<{ id: string }[]>(server, me, 'GET', '/v1/orgs')).data?.[0]
  if (org === undefined) throw new Error('应该有一个组织')
  const switched = await call<{ session_token?: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org.id}/brands/${workspace_id}/switch`,
  )
  const token = switched.data?.session_token
  if (token === undefined) throw new Error('切品牌应该回一张会话 token')
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('品牌里应该有 owner 分配')
  return { workspace_id, token, assignment: assignment.id }
}

async function addBrand(server: Server, name: string): Promise<Who> {
  const me = startupWho(server)
  const org = (await call<{ id: string }[]>(server, me, 'GET', '/v1/orgs')).data?.[0]
  if (org === undefined) throw new Error('应该有一个组织')
  const created = await call<{ workspace_id: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org.id}/brands`,
    {
      name,
    },
  )
  expect(created.status).toBe(201)
  return switchTo(server, created.data?.workspace_id ?? '')
}

async function connectShop(server: Server, who: Who, shop: string): Promise<ConnectionView> {
  const res = await call<{ connection: ConnectionView }>(
    server,
    who,
    'POST',
    '/v1/connections/shopify_admin/submit',
    { fields: { shop_domain: shop, client_id: `cid-${shop}`, client_secret: `sec-${shop}` } },
  )
  expect(res.status).toBe(200)
  if (res.data === undefined) throw new Error('连店铺应该有回执')
  return res.data.connection
}

const list = async (server: Server, who: Who): Promise<ConnectionView[]> =>
  (await call<{ connections: ConnectionView[] }>(server, who, 'GET', '/v1/connections')).data
    ?.connections ?? []

const seg = (ws: string): string => ws.toLowerCase().replace(/[^a-z0-9_]/g, '')

describe('WP252 两个品牌都连 Shopify（一台机一个连接器）', () => {
  it('互不覆盖、互不可见；断不了对方的；令牌只签得出本品牌的连接', async () => {
    const rt = await fakeRuntime()
    const server = await boot(rt)
    const a = startupWho(server)
    const b = await addBrand(server, 'Rollout')

    const ca = await connectShop(server, a, 'inmo')
    const cb = await connectShop(server, b, 'rollout')

    // 上游两条，名字各带各的品牌段；先连的那家令牌没被后连的顶掉
    expect(rt.puts).toEqual([
      `shopify_admin/default--${seg(a.workspace_id)}`,
      `shopify_admin/default--${seg(b.workspace_id)}`,
    ])
    expect(rt.conns.map((c) => [c.id, c.secret.split('_')[1]])).toEqual([
      [ca.id, 'inmo'],
      [cb.id, 'rollout'],
    ])
    expect(ca.alias).toBe('default')

    const la = await list(server, a)
    const lb = await list(server, b)
    expect(la.map((c) => [c.id, c.identity?.display_name])).toEqual([[ca.id, 'inmo.myshopify.com']])
    expect(lb.map((c) => [c.id, c.identity?.display_name])).toEqual([
      [cb.id, 'rollout.myshopify.com'],
    ])

    // B 断不了 A 那条（对 B 来说它不存在）
    const denied = await call(server, b, 'DELETE', `/v1/connections/${ca.id}`)
    expect(denied.status).toBe(404)
    expect(rt.conns.some((c) => c.id === ca.id)).toBe(true)

    // 运行时令牌：B 的连接面签不出 A 的连接；签自己的那张只含自己那条
    const brandB = await server.brands.forWorkspace(b.workspace_id)
    const read = { kind: 'role-read' as const, allowed_actions: ['shopify_admin.get_shop'] }
    await expect(
      brandB.connections.connect.issueToken({
        ...read,
        assignment_id: 'asg_probe',
        allowed_connections: [ca.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const before = rt.tokens.length
    await brandB.connections.connect.issueToken({
      ...read,
      assignment_id: 'asg_probe',
      allowed_connections: [cb.id],
    })
    expect(rt.tokens.slice(before)).toEqual([[cb.id]])
    expect(rt.tokens.flat()).not.toContain(ca.id)
  })
})

describe('WP252 迁移：WP252 之前两个品牌都用 `default` 连了 Shopify', () => {
  it('归启动品牌（带核对提醒），另一个品牌一行「请重新连接」；重连后提醒结掉；再启动幂等', async () => {
    const legacy: WireConn = {
      id: 'legacy-1',
      service: 'shopify_admin',
      connectionName: 'default',
      authType: 'api_key',
      configured: true,
      default: true,
      secret: 'shpat_whoever-wrote-last',
      profile: { accountId: 'acct-legacy', displayName: 'rollout.myshopify.com' },
    }
    const rt = await fakeRuntime([legacy])
    const dir = mkdtempSync(join(tmpdir(), 'wp252-srv-'))
    dirs.push(dir)

    // 第一次起：建好第二个品牌，然后把数据目录做成「WP252 之前」的样子
    const first = await boot(rt, dir)
    const bId = (await addBrand(first, 'Rollout')).workspace_id
    const aId = first.bootstrap.workspace.id
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const oldState = (ws: string) =>
      JSON.stringify({
        version: 1,
        tokens: [],
        connections: [{ connection_id: 'legacy-1', workspace_id: ws, ownership: 'workspace' }],
      })
    writeFileSync(join(dir, 'connect-adapter.json'), oldState(aId))
    writeFileSync(join(dir, BRAND_DIR, bId, 'connect-adapter.json'), oldState(bId))
    rmSync(join(dir, CONNECT_OWNERS_FILE), { force: true })

    // 升级后第一次起：迁移补记归属
    const server = await boot(rt, dir)
    const a = startupWho(server)
    const b = await switchTo(server, bId)
    const la = await list(server, a)
    expect(la.map((c) => [c.id, c.brand_conflict?.kind])).toEqual([['legacy-1', 'kept']])
    const lb = await list(server, b)
    expect(lb).toHaveLength(1)
    const row = lb[0] as ConnectionView
    expect(row).toMatchObject({
      service: 'shopify_admin',
      alias: 'default',
      status: 'reauth_required',
      brand_conflict: { kind: 'reconnect' },
    })
    expect(row.id.startsWith('reconnect_')).toBe(true)
    expect(row.identity).toBeUndefined() // 别的品牌的账号名不漏过来
    const tested = await call<{ ok: boolean; reason: string }>(
      server,
      b,
      'POST',
      `/v1/connections/${row.id}/test`,
    )
    expect(tested.data).toMatchObject({ ok: false, reason: 'reconnect_required' })

    // B 重新连接：另起一条只属于 B 的，「请重新连接」结掉；A 那条一个字节没动
    const fresh = await connectShop(server, b, 'rollout')
    expect(fresh.id).not.toBe('legacy-1')
    expect((await list(server, b)).map((c) => c.id)).toEqual([fresh.id])
    expect(rt.conns.find((c) => c.id === 'legacy-1')?.secret).toBe('shpat_whoever-wrote-last')

    // A 点一次「测试」核对过 → 提醒收起
    await call(server, a, 'POST', '/v1/connections/legacy-1/test')
    expect((await list(server, a))[0]?.brand_conflict).toBeUndefined()

    // 再启动一次：归属表逐字节不变（迁移幂等，提醒不会死灰复燃）
    const ownersFile = join(dir, CONNECT_OWNERS_FILE)
    const snapshot = readFileSync(ownersFile, 'utf8')
    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const again = await boot(rt, dir)
    expect(readFileSync(ownersFile, 'utf8')).toBe(snapshot)
    const b2 = await switchTo(again, bId)
    expect((await list(again, b2)).map((c) => c.id)).toEqual([fresh.id])
    expect((await list(again, startupWho(again))).map((c) => c.id)).toEqual(['legacy-1'])
  })

  it('「请重新连接」点断开：只收起提醒，上游那条不删', async () => {
    const rt = await fakeRuntime()
    const dir = mkdtempSync(join(tmpdir(), 'wp252-srv-'))
    dirs.push(dir)
    const first = await boot(rt, dir)
    const bId = (await addBrand(first, 'Rollout')).workspace_id
    const aId = first.bootstrap.workspace.id
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    rt.conns.push({
      id: 'legacy-1',
      service: 'shopify_admin',
      connectionName: 'default',
      authType: 'api_key',
      configured: true,
      default: true,
      secret: 'x',
      profile: { accountId: 'acct', displayName: 'inmo.myshopify.com' },
    })
    const old = (ws: string) =>
      JSON.stringify({ connections: [{ connection_id: 'legacy-1', workspace_id: ws }] })
    writeFileSync(join(dir, 'connect-adapter.json'), old(aId))
    writeFileSync(join(dir, BRAND_DIR, bId, 'connect-adapter.json'), old(bId))
    rmSync(join(dir, CONNECT_OWNERS_FILE), { force: true })

    const server = await boot(rt, dir)
    const b = await switchTo(server, bId)
    const [row] = await list(server, b)
    expect(row?.brand_conflict?.kind).toBe('reconnect')
    const removed = await call(server, b, 'DELETE', `/v1/connections/${row?.id}`)
    expect(removed.status).toBeLessThan(300)
    expect(await list(server, b)).toEqual([])
    expect(rt.conns.map((c) => c.id)).toEqual(['legacy-1'])
    expect(existsSync(join(dir, CONNECT_OWNERS_FILE))).toBe(true)
  })
})
