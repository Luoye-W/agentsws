/**
 * WP66（52 O1「每个品牌的所有东西都单独设置」）端到端：**一个服务进程装多套品牌模块**。
 *
 * WP65 之后按 `actor.workspace_id` 走的面已经是对的；这一档钉的是当时还跟着
 * 第一个品牌的那几面——连接、凭据、活数据源、模型设置、渠道。
 *
 * 覆盖的验收点：
 * - 两个品牌各自的连接互不可见（列表、凭据、断开）
 * - 凭据按品牌隔开：同一个加密库，key 名带品牌前缀；A 的口令在 B 的库视图里不存在
 * - 存量单品牌零感知：bootstrap 品牌的落盘位置一个字节没动，新品牌落在 `brands/<ws>/`
 * - 模型设置按品牌 + 52 O3「跟随公司默认」：默认跟随、关掉之后各管各的、跟随时不许改
 * - 能力开关（49 M5）按品牌
 * - 渠道按品牌：两个品牌各自的邮箱轮询互不串
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionView, ModelDefaultsView, ModelProviderView } from '@agentsws/api'
import type { CapabilitySourceSettings } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_DIR, secretsPrefixOf } from '../src/brand-modules.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-15T09:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)
/** 测试里唯一的两串"凭据"。隔离断言就盯着它们。 */
const PASSWORD_A = 'brand-A-mail-secret-never-crosses'
const PASSWORD_B = 'brand-B-mail-secret-never-crosses'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const servers: Server[] = []

/**
 * 模型上游的替身：拉清单与试跑都走它。**全程不联网**——这一档验的是"设置存在
 * 哪个品牌名下"，不是"能不能真的打通某一家"。
 */
const fakeModelUpstream: FetchLike = async (url) => {
  if (url.endsWith('/models')) {
    const body = { object: 'list', data: [{ id: 'a-1' }, { id: 'b-1' }] }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '好' } }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    }),
    text: async () => '{}',
  }
}

async function boot(extra: { dbDir?: string } = {}): Promise<Server> {
  const server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'wang@nordvolt.cn',
      AGENTSWS_WORKSPACE_NAME: '诺伏特户外',
      [SECRETS_KEY_ENV]: SECRETS_KEY,
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    modelFetch: fakeModelUpstream,
    ...(extra.dbDir === undefined ? {} : { dbDir: extra.dbDir }),
  })
  servers.push(server)
  return server
}

/** 统一信封：成功是 `{ data }`，失败是平铺的 `{ code, message, trace_id }`（28 §2）。 */
interface Envelope<T> {
  data?: T
  code?: string
  message?: string
}

/** 一个"以某个品牌的身份"发请求的句柄（token 绑的就是那个工作区，20 §3）。 */
interface Who {
  workspace_id: string
  token: string
  assignment: string
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; error?: { code: string; message: string } }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as Envelope<T>
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.code === undefined
      ? {}
      : { error: { code: parsed.code, message: parsed.message ?? '' } }),
  }
}

function bootstrapWho(server: Server): Who {
  return {
    workspace_id: server.bootstrap.workspace.id,
    token: server.bootstrap.internalToken,
    assignment: server.bootstrap.ownerAssignment.id,
  }
}

/** 建第二个品牌并拿到"以它的身份"发请求的句柄（52 O2：切品牌 = 换一张会话 token）。 */
async function addBrand(server: Server, name: string): Promise<Who> {
  const me = bootstrapWho(server)
  const orgs = await call<{ id: string }[]>(server, me, 'GET', '/v1/orgs')
  const org = orgs.data?.[0]
  if (org === undefined) throw new Error('启动之后应该有一个组织')
  const created = await call<{ workspace_id: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org.id}/brands`,
    { name },
  )
  expect(created.status).toBe(201)
  const workspace_id = created.data?.workspace_id
  if (workspace_id === undefined) throw new Error('建品牌应该有回执')
  const switched = await call<{ session_token?: string }>(
    server,
    me,
    'POST',
    `/v1/orgs/${org.id}/brands/${workspace_id}/switch`,
  )
  expect(switched.status).toBe(200)
  const token = switched.data?.session_token
  if (token === undefined) throw new Error('切品牌应该回一张绑新工作区的会话 token')
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('新品牌里应该自带一条 owner 分配')
  return { workspace_id, token, assignment: assignment.id }
}

const MAIL_FIELDS = (email: string, password: string) => ({
  email,
  password,
  // 连不上的地址：试连一定失败，而且不用等 DNS
  imap_host: '127.0.0.1',
  imap_port: '1',
  smtp_host: '127.0.0.1',
  smtp_port: '2',
})

async function connectMail(
  server: Server,
  who: Who,
  email: string,
  password: string,
): Promise<ConnectionView> {
  const res = await call<{ connection: ConnectionView }>(
    server,
    who,
    'POST',
    '/v1/connections/imap_smtp/submit',
    { alias: email, fields: MAIL_FIELDS(email, password) },
  )
  expect([200, 201]).toContain(res.status)
  const connection = res.data?.connection
  if (connection === undefined) throw new Error('连邮箱应该有回执')
  return connection
}

const listConnections = async (server: Server, who: Who): Promise<ConnectionView[]> =>
  (await call<{ connections: ConnectionView[] }>(server, who, 'GET', '/v1/connections')).data
    ?.connections ?? []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

describe('WP66 连接按品牌', () => {
  it('两个品牌各连各的邮箱：清单互不可见，凭据也互不可见', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')

    const connA = await connectMail(server, a, 'support@nordvolt.cn', PASSWORD_A)
    // 品牌甲连完，品牌乙那边**什么都没有**——不是"看得到但点不动"，是根本不在
    expect(await listConnections(server, b)).toEqual([])
    expect((await listConnections(server, a)).map((c) => c.alias)).toEqual(['support@nordvolt.cn'])

    const connB = await connectMail(server, b, 'hello@nordvolt.courses', PASSWORD_B)
    expect(connA.id).not.toBe(connB.id)
    expect((await listConnections(server, a)).map((c) => c.alias)).toEqual(['support@nordvolt.cn'])
    expect((await listConnections(server, b)).map((c) => c.alias)).toEqual([
      'hello@nordvolt.courses',
    ])

    // 拿着品牌乙的令牌去断品牌甲那条连接：它在乙那里压根不存在
    const cross = await call(server, b, 'DELETE', `/v1/connections/${connA.id}`)
    expect(cross.status).toBe(404)
    expect((await listConnections(server, a)).length).toBe(1)
  })

  it('凭据按品牌隔开：同一个库、同一把密钥，key 名带品牌前缀', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')
    const connA = await connectMail(server, a, 'support@nordvolt.cn', PASSWORD_A)
    const connB = await connectMail(server, b, 'hello@nordvolt.courses', PASSWORD_B)

    const brandA = await server.brands.forWorkspace(a.workspace_id)
    const brandB = await server.brands.forWorkspace(b.workspace_id)
    // 各自的库视图里只有自己那一条
    const idsA = brandA.secrets.list().map((r) => r.connection_id)
    const idsB = brandB.secrets.list().map((r) => r.connection_id)
    expect(idsA.some((id) => id.includes(connA.id))).toBe(true)
    expect(idsA.some((id) => id.includes(connB.id))).toBe(false)
    expect(idsB.some((id) => id.includes(connB.id))).toBe(true)
    expect(idsB.some((id) => id.includes(connA.id))).toBe(false)

    // bootstrap 品牌**没有**前缀（存量凭据一个都不用搬家）；新品牌有
    expect(secretsPrefixOf(a.workspace_id, a.workspace_id)).toBe('')
    expect(secretsPrefixOf(b.workspace_id, a.workspace_id)).toBe(`ws:${b.workspace_id}/`)
    const raw = server.secrets.list().map((r) => r.connection_id)
    expect(raw.some((id) => id.startsWith(`ws:${b.workspace_id}/`))).toBe(true)
    expect(raw.filter((id) => id.includes(connA.id)).every((id) => !id.startsWith('ws:'))).toBe(
      true,
    )
  })

  it('岗位的"缺连接器"按品牌算：甲连了邮箱，乙的同一条岗位仍然说缺', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')
    // 两个品牌各挂一条要邮箱的岗位
    const asgA = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: a.workspace_id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    const asgB = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: b.workspace_id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [],
    })
    // 让两个品牌的模块都建出来（`connectedOf` 只看已经建出来的那一套）
    await server.brands.forWorkspace(b.workspace_id)
    await connectMail(server, a, 'support@nordvolt.cn', PASSWORD_A)

    expect(server.roles.effectiveConfig(asgA.id).missing_connectors).not.toContain('email')
    expect(server.roles.effectiveConfig(asgB.id).missing_connectors).toContain('email')
  })
})

describe('WP66 落盘与一次性迁移', () => {
  it('bootstrap 品牌的文件一个字节不搬家；新品牌落在 brands/<workspace_id>/ 下', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-brands-'))
    const server = await boot({ dbDir: dir })
    const a = bootstrapWho(server)
    await connectMail(server, a, 'support@nordvolt.cn', PASSWORD_A)
    // 存量位置：连接状态与模型配置都还在数据目录的根上
    expect(existsSync(join(dir, 'connections.json'))).toBe(true)
    expect(existsSync(join(dir, BRAND_DIR))).toBe(false)

    const b = await addBrand(server, '诺伏特课程')
    await connectMail(server, b, 'hello@nordvolt.courses', PASSWORD_B)
    const brandDir = join(dir, BRAND_DIR, b.workspace_id)
    expect(existsSync(join(brandDir, 'connections.json'))).toBe(true)
    // 根上那份仍然是甲的（乙的连接没有写进来）
    expect(existsSync(join(dir, 'connections.json'))).toBe(true)
  })

  it('重启之后各认各的：甲还是甲那条连接，乙还是乙那条', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-brands-'))
    const first = await boot({ dbDir: dir })
    const a1 = bootstrapWho(first)
    await connectMail(first, a1, 'support@nordvolt.cn', PASSWORD_A)
    const b1 = await addBrand(first, '诺伏特课程')
    await connectMail(first, b1, 'hello@nordvolt.courses', PASSWORD_B)
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const again = await boot({ dbDir: dir })
    const a2 = bootstrapWho(again)
    expect((await listConnections(again, a2)).map((c) => c.alias)).toEqual(['support@nordvolt.cn'])
    // 乙那条要用乙的 token 才看得到（同一个人，另一个工作区）
    const org = (await call<{ id: string }[]>(again, a2, 'GET', '/v1/orgs')).data?.[0]
    if (org === undefined) throw new Error('重启之后组织应该还在')
    const switched = await call<{ session_token?: string }>(
      again,
      a2,
      'POST',
      `/v1/orgs/${org.id}/brands/${b1.workspace_id}/switch`,
    )
    const token = switched.data?.session_token
    if (token === undefined) throw new Error('切品牌应该回一张会话 token')
    const b2: Who = { ...b1, token }
    expect((await listConnections(again, b2)).map((c) => c.alias)).toEqual([
      'hello@nordvolt.courses',
    ])
  })
})

describe('WP66 / 52 O3 模型设置按品牌，可"跟随公司默认"', () => {
  it('新品牌默认跟随公司默认：读的是公司那一份，写一律拒', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')

    const defaultsA = await call<ModelDefaultsView>(server, a, 'GET', '/v1/models/defaults')
    expect(defaultsA.data?.org_default).toBe(true)
    expect(defaultsA.data?.inherit_org).toBe(false)

    const defaultsB = await call<ModelDefaultsView>(server, b, 'GET', '/v1/models/defaults')
    expect(defaultsB.data?.inherit_org).toBe(true)
    expect(defaultsB.data?.org_default).toBe(false)
    expect(defaultsB.data?.org_default_brand).toBe('诺伏特户外')

    // 跟随时在乙这边保存 = 悄悄改公司那一份，所以拒
    const denied = await call(server, b, 'PUT', '/v1/models/providers/p_b', {
      kind: 'openai_compatible',
      base_url: 'https://api.example.com',
      model: 'x-1',
      api_key: 'sk-brand-b',
    })
    expect(denied.status).toBe(400)
    expect(denied.error?.message).toContain('跟随公司默认')
  })

  it('关掉"跟随"之后各管各的：甲乙各自一份 provider，key 也各存各的', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')

    const savedA = await call<ModelProviderView>(server, a, 'PUT', '/v1/models/providers/p_a', {
      kind: 'openai_compatible',
      base_url: 'https://api.a.example.com',
      model: 'a-1',
      api_key: 'sk-brand-a-never-crosses',
    })
    expect(savedA.status).toBe(200)

    // 乙先关掉"跟随"，才轮得到它自己那一份
    const off = await call<ModelDefaultsView>(server, b, 'PUT', '/v1/models/inheritance', {
      inherit_org: false,
    })
    expect(off.status).toBe(200)
    expect(off.data?.inherit_org).toBe(false)

    const listB = await call<{ providers: ModelProviderView[] }>(
      server,
      b,
      'GET',
      '/v1/models/providers',
    )
    // 甲那条不在乙的清单里（乙是干净的一张白纸）
    expect(listB.data?.providers.some((p) => p.id === 'p_a')).toBe(false)

    const savedB = await call<ModelProviderView>(server, b, 'PUT', '/v1/models/providers/p_b', {
      kind: 'openai_compatible',
      base_url: 'https://api.b.example.com',
      model: 'b-1',
      api_key: 'sk-brand-b-never-crosses',
    })
    expect(savedB.status).toBe(200)

    const listA = await call<{ providers: ModelProviderView[] }>(
      server,
      a,
      'GET',
      '/v1/models/providers',
    )
    expect(listA.data?.providers.some((p) => p.id === 'p_b')).toBe(false)
    expect(listA.data?.providers.some((p) => p.id === 'p_a')).toBe(true)

    // key 分别存在各自那一段加密库里（值一个都没端出来，这里只看 key 名在不在）
    const vaultA = (await server.brands.forWorkspace(a.workspace_id)).secrets
      .list()
      .map((r) => r.connection_id)
    const vaultB = (await server.brands.forWorkspace(b.workspace_id)).secrets
      .list()
      .map((r) => r.connection_id)
    expect(vaultA.some((id) => id.endsWith('p_a'))).toBe(true)
    expect(vaultA.some((id) => id.endsWith('p_b'))).toBe(false)
    expect(vaultB.some((id) => id.endsWith('p_b'))).toBe(true)
    expect(vaultB.some((id) => id.endsWith('p_a'))).toBe(false)
  })

  it('公司默认那个品牌自己没有开关可跟随', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    await addBrand(server, '诺伏特课程')
    const res = await call(server, a, 'PUT', '/v1/models/inheritance', { inherit_org: true })
    expect(res.status).toBe(400)
    expect(res.error?.message).toContain('公司默认')
  })

  it('能力开关（49 M5）也按品牌：乙关掉跟随之后改它，甲那份不动', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')
    await call(server, b, 'PUT', '/v1/models/inheritance', { inherit_org: false })

    const saved = await call<CapabilitySourceSettings>(
      server,
      b,
      'PUT',
      '/v1/settings/capability-sources',
      { capability_sources: { transcription: 'agentsws' } },
    )
    expect(saved.status).toBe(200)
    expect(saved.data?.workspace_id).toBe(b.workspace_id)
    expect(saved.data?.capability_sources.transcription).toBe('agentsws')

    const mine = await call<CapabilitySourceSettings>(
      server,
      a,
      'GET',
      '/v1/settings/capability-sources',
    )
    expect(mine.data?.capability_sources.transcription).toBeUndefined()
  })
})

describe('WP66 渠道按品牌', () => {
  it('两个品牌各自的邮箱轮询互不串：调度器一拍，两边各收各的', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')
    await connectMail(server, a, 'support@nordvolt.cn', PASSWORD_A)
    await connectMail(server, b, 'hello@nordvolt.courses', PASSWORD_B)

    const brandA = await server.brands.forWorkspace(a.workspace_id)
    const brandB = await server.brands.forWorkspace(b.workspace_id)
    // 两套渠道各自只认自己那个账号（`accounts()` 就是那个品牌的连接表）
    const reportA = await brandA.channels.poll()
    const reportB = await brandB.channels.poll()
    expect(reportA.accounts).toBe(1)
    expect(reportB.accounts).toBe(1)
    // 连不上的地址：两边都失败，但**失败的是各自那个账号**，不会互相带
    expect(reportA.failed.join()).toContain('support@nordvolt.cn')
    expect(reportA.failed.join()).not.toContain('hello@nordvolt.courses')
    expect(reportB.failed.join()).toContain('hello@nordvolt.courses')
    expect(reportB.failed.join()).not.toContain('support@nordvolt.cn')
  })

  it('聊天窗的来源白名单按品牌：甲放行的域名在乙那里不放行', async () => {
    const server = await boot()
    const a = bootstrapWho(server)
    const b = await addBrand(server, '诺伏特课程')
    const saved = await call(server, a, 'PUT', '/v1/chat/widget/settings', {
      allowed_origins: ['https://nordvolt.cn'],
    })
    expect(saved.status).toBe(200)

    const mine = await call<{ allowed_origins: string[] }>(
      server,
      a,
      'GET',
      '/v1/chat/widget/settings',
    )
    expect(mine.data?.allowed_origins).toEqual(['https://nordvolt.cn'])
    const theirs = await call<{ allowed_origins: string[] }>(
      server,
      b,
      'GET',
      '/v1/chat/widget/settings',
    )
    expect(theirs.data?.allowed_origins).toEqual([])
  })
})
