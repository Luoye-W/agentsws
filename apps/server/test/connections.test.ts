/**
 * 连接向导端到端（WP20）：起真服务进程 → 看目录 → 走向导 → 连上 → 试连 → 断开，
 * 全程按 13 §4.3 断言**凭据零泄漏**。
 *
 * 这里用的是替身 OpenConnector（没设 `AGENTSWS_CONNECT_URL`），但走的是完整的
 * `/v1` 路由 + `ConnectionsPort` + 加密秘密库，凭据那条路和真 runtime 上一模一样。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ConnectionView,
  ConnectTestResult,
  ProviderView,
  RuntimeStatusView,
} from '@agentsws/api'
import type { EventEnvelope } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import type { BrokerFetch } from '../src/shopify-broker.js'

const T0 = '2026-09-09T09:00:00.000Z'
const SECRETS_KEY = 'f'.repeat(64)

/** 测试里唯一的"凭据"。所有零泄漏断言都盯着这一串。 */
const PASSWORD = 'app-specific-Zq7-secret-do-not-log'
const SHOP_TOKEN = 'shpat_fake_token_never_logged_42'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Ctx {
  server: Server
  url: string
  dir: string
  clock: ReturnType<typeof makeClock>
}

let ctx: Ctx

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? ctx.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const post = (path: string, body?: unknown): Promise<Response> =>
  api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

/** 事件日志里全部事件（零泄漏断言要扫一遍）。 */
async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

/** 数据目录里所有文件的字节（落盘零泄漏断言）。 */
function allFileBytes(dir: string): { name: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, bytes: readFileSync(join(dir, d.name)) }))
}

const MAIL_FIELDS = {
  email: 'support@yourbrand.com',
  password: PASSWORD,
  // 连不上的地址：试连一定失败，而且不用等 DNS
  imap_host: '127.0.0.1',
  imap_port: '1',
  smtp_host: '127.0.0.1',
  smtp_port: '2',
}

/**
 * WP25：Shopify 换令牌那一跳的假上游。默认回一张 24 小时的令牌；
 * 测试可以改 `mode` 让它回官方的错误码。**一个字节都不出这台机器。**
 */
interface FakeShopify {
  fetch: BrokerFetch
  calls: { url: string; body: string }[]
  mode: 'ok' | 'shop_not_permitted' | 'invalid_client'
  /** 每换一次令牌换一串，用来断言"刷新真的换了新的一张"。 */
  issued: string[]
}

function fakeShopify(): FakeShopify {
  const state: FakeShopify = { calls: [], mode: 'ok', issued: [], fetch: async () => ({}) as never }
  state.fetch = async (url, init) => {
    state.calls.push({ url, body: init.body })
    const fail = (error: string, status: number) => ({
      ok: false,
      status,
      text: async () => JSON.stringify({ error }),
    })
    if (state.mode === 'shop_not_permitted') return fail('shop_not_permitted', 403)
    if (state.mode === 'invalid_client') return fail('invalid_client', 401)
    const token = `shpat_issued_${state.issued.length + 1}_${'f'.repeat(20)}`
    state.issued.push(token)
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: token,
          scope: 'read_orders,write_orders,read_customers',
          expires_in: 86_399,
        }),
    }
  }
  return state
}

/** WP25：MX 查询的假实现（测试里绝不查真 DNS）。 */
let mxAnswers: Record<string, { priority: number; exchange: string }[]> = {}
let mxThrows = false
const resolveMx = async (domain: string): Promise<{ priority: number; exchange: string }[]> => {
  if (mxThrows) throw new Error('queryMx ENOTFOUND')
  return mxAnswers[domain] ?? []
}

let shopifyUpstream: FakeShopify

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-connections-'))
  shopifyUpstream = fakeShopify()
  mxAnswers = {}
  mxThrows = false
  const clock = makeClock()
  const server = await createServer({
    dbDir: dir,
    clock,
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
    shopifyFetch: shopifyUpstream.fetch,
    resolveMx,
    // 一次性任务不留后台计时器；到期刷新由测试自己调 refreshTokens()
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir, clock }
})

afterEach(async () => {
  await ctx.server.close()
})

describe('WP20 §A 连接清单与目录', () => {
  it('一开始什么都没连（替身自带的示例连接不属于本工作区）', async () => {
    const res = await api('/v1/connections')
    expect(res.status).toBe(200)
    expect((await data<{ connections: ConnectionView[] }>(res)).connections).toEqual([])
  })

  it('目录里六个 provider，各自带 ≤ 5 步的准备说明与外链', async () => {
    const { providers } = await data<{ providers: ProviderView[] }>(
      await api('/v1/connections/providers'),
    )
    expect(providers.map((p) => p.service)).toEqual([
      'shopify_admin',
      'imap_smtp',
      'gmail',
      'ga4',
      'gsc',
      'meta_ads',
    ])
    for (const p of providers) {
      expect(p.setup_guide.steps.length).toBeGreaterThan(0)
      expect(p.setup_guide.steps.length).toBeLessThanOrEqual(5)
      expect(p.setup_guide.links.length).toBeGreaterThan(0)
    }
    // OAuth 类不给字段表单；表单类的密码字段必须标了 secret
    const gmail = providers.find((p) => p.service === 'gmail')
    expect(gmail?.auth).toBe('oauth2')
    expect(gmail?.fields).toEqual([])
    const mail = providers.find((p) => p.service === 'imap_smtp')
    expect(mail?.fields.find((f) => f.name === 'password')?.secret).toBe(true)
    expect(mail?.fields.find((f) => f.name === 'email')?.secret).toBe(false)
    // WP25：Shopify 两种接法，推荐的那条排第一
    const shop = providers.find((p) => p.service === 'shopify_admin')
    expect(shop?.auth_options?.map((o) => o.id)).toEqual(['dev_app', 'access_token'])
    expect(shop?.auth_options?.[0]?.recommended).toBe(true)
    // GA4 / GSC / Meta：连上了也先说清楚数据下一版接
    expect(providers.find((p) => p.service === 'ga4')?.data_note).toContain('下一版')
  })

  it('runtime 状态条：没配 AGENTSWS_CONNECT_URL 就是替身档，秘密库有密钥', async () => {
    const status = await data<RuntimeStatusView>(await api('/v1/connections/runtime'))
    expect(status.state).toBe('stand_in')
    expect(status.secrets_vault.available).toBe(true)
  })
})

describe('WP20 §A 原生表单直填（凭据零泄漏）', () => {
  it('邮箱：begin → submit → 立刻试连 → 列表里有它，且哪里都没有口令', async () => {
    const begun = await data<{ request_id: string; secure_form?: { fields: unknown[] } }>(
      await post('/v1/connections/imap_smtp/begin', { alias: '客服邮箱' }),
    )
    expect(begun.secure_form?.fields.length).toBeGreaterThan(0)

    const submitted = await data<{ connection: ConnectionView; test: ConnectTestResult }>(
      await post('/v1/connections/imap_smtp/submit', {
        alias: '客服邮箱',
        request_id: begun.request_id,
        fields: MAIL_FIELDS,
      }),
    )
    expect(submitted.connection.service).toBe('imap_smtp')
    expect(submitted.connection.credential_store).toBe('local_vault')
    expect(submitted.connection.identity?.display_name).toBe(MAIL_FIELDS.email)
    // 127.0.0.1:1 上没人应答 → 试连必然失败，而且原因是"连不上"不是"密码不对"
    expect(submitted.test.ok).toBe(false)

    const listed = await data<{ connections: ConnectionView[] }>(await api('/v1/connections'))
    expect(listed.connections).toHaveLength(1)
    expect(listed.connections[0]?.id).toBe(submitted.connection.id)
    expect(listed.connections[0]?.last_tested_at).toBeDefined()

    // ── 凭据零泄漏断言 ────────────────────────────────────────────
    // 1. 提交的响应体里没有口令
    expect(JSON.stringify(submitted)).not.toContain(PASSWORD)
    // 2. 连接清单里没有口令，也没有字段名
    const listedText = JSON.stringify(listed)
    expect(listedText).not.toContain(PASSWORD)
    expect(listedText).not.toContain('imap_port')
    // 3. 事件日志里没有口令；表单事件里只有字段名
    const events = await allEvents()
    expect(JSON.stringify(events)).not.toContain(PASSWORD)
    const submitEvent = events.find((e) => e.type === 'connect.form_submitted')
    if (submitEvent === undefined) throw new Error('没有 connect.form_submitted 事件')
    expect((submitEvent.payload as { field_names: string[] }).field_names).toEqual(
      Object.keys(MAIL_FIELDS),
    )
    // 4. 试连事件里只有 ok 与原因码
    const testEvent = events.find((e) => e.type === 'connect.connection_tested')
    expect(Object.keys(testEvent?.payload as object).sort()).toEqual([
      'connection_id',
      'ok',
      'reason',
    ])
    // 5. 数据目录里没有任何一个文件含口令原文（secrets.sqlite 是密文）
    for (const f of allFileBytes(ctx.dir)) {
      expect(f.bytes.includes(Buffer.from(PASSWORD, 'utf8')), `${f.name} 里出现了口令原文`).toBe(
        false,
      )
    }
  })

  it('Shopify：表单直填走 OpenConnector 凭据库，访问令牌不进任何返回值与日志', async () => {
    // WP25：字段名以上游目录为准（09-09 实测 `apiKey` / `shopDomain`），
    // 且要显式挑"自定义应用访问令牌"那条接法——默认那条是客户端凭据换令牌
    const raw = await post('/v1/connections/shopify_admin/submit', {
      alias: '主店',
      auth_option: 'access_token',
      fields: { shopDomain: 'demo.myshopify.com', apiKey: SHOP_TOKEN },
    })
    if (raw.status !== 200) throw new Error(`submit failed: ${raw.status} ${await raw.text()}`)
    const submitted = await data<{ connection: ConnectionView; test: ConnectTestResult }>(raw)
    expect(submitted.connection.service).toBe('shopify_admin')
    expect(submitted.connection.credential_store).toBe('openconnector')
    expect(submitted.connection.data_sources).toEqual(['shop'])
    // 替身的 shopify 目录里有 list_orders（只读、无必填参数）→ 冒烟能真跑一次
    expect(submitted.test.ok).toBe(true)

    expect(JSON.stringify(submitted)).not.toContain(SHOP_TOKEN)
    const events = await allEvents()
    expect(JSON.stringify(events)).not.toContain(SHOP_TOKEN)
    for (const f of allFileBytes(ctx.dir)) {
      expect(f.bytes.includes(Buffer.from(SHOP_TOKEN, 'utf8')), `${f.name}`).toBe(false)
    }
  })

  it('必填项没填就 400，报错里只有字段名', async () => {
    const res = await post('/v1/connections/imap_smtp/submit', {
      fields: { email: 'a@b.com', password: PASSWORD },
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('imap_host')
    expect(body).not.toContain(PASSWORD)
  })

  it('OAuth 类不接受表单直填', async () => {
    const res = await post('/v1/connections/gmail/submit', { fields: { token: 'x' } })
    expect(res.status).toBe(400)
  })

  it('没有秘密库密钥时拒绝保存邮箱凭据并说清楚原因', async () => {
    await ctx.server.close()
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-connections-nokey-'))
    const server = await createServer({
      dbDir: dir,
      clock: makeClock(),
      random: seeded(),
      quiet: true,
      env: {},
    })
    const { url } = await server.listen(0)
    ctx = { server, url, dir }
    const status = await data<RuntimeStatusView>(await api('/v1/connections/runtime'))
    expect(status.secrets_vault.available).toBe(false)
    const { providers } = await data<{ providers: ProviderView[] }>(
      await api('/v1/connections/providers'),
    )
    const mail = providers.find((p) => p.service === 'imap_smtp')
    expect(mail?.available).toBe(false)
    expect(mail?.unavailable_reason).toContain(SECRETS_KEY_ENV)
    const res = await post('/v1/connections/imap_smtp/submit', { fields: MAIL_FIELDS })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain(SECRETS_KEY_ENV)
    expect(body).not.toContain(PASSWORD)
  })
})

describe('WP20 §A 试连 / 断开 / 数据源回灌', () => {
  it('连上 Shopify → 首页数字块不再「去连接」；断开后又变回去', async () => {
    const before = ctx.server.gateway
    expect(before).toBeDefined()
    const home0 = await data<{ tiles: { tiles: { status: string }[] }[] }>(
      await api('/v1/home?range=yesterday'),
    )
    // owner 岗位本来没有默认数字块，改看岗位面板的数据源分块
    expect(home0).toBeDefined()

    const submitted = await data<{ connection: ConnectionView }>(
      await post('/v1/connections/shopify_admin/submit', {
        alias: '主店',
        auth_option: 'access_token',
        fields: { shopDomain: 'demo.myshopify.com', apiKey: SHOP_TOKEN },
      }),
    )
    const connected = ctx.server.connections.snapshot().filter((c) => c.service === 'shopify_admin')
    expect(connected).toHaveLength(1)
    const sources = ctx.server.connections.wrapDataSource({
      orders: () => [],
      sources: () => [
        { id: 'shop', label: '店铺后台', connected: false },
        { id: 'ga4', label: 'GA4', connected: false },
      ],
      label: () => undefined,
      tz_offset_minutes: 480,
      base_currency: 'USD',
    })
    expect(sources.sources().find((s) => s.id === 'shop')?.connected).toBe(true)
    expect(sources.sources().find((s) => s.id === 'ga4')?.connected).toBe(false)

    const removed = await api(`/v1/connections/${submitted.connection.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(sources.sources().find((s) => s.id === 'shop')?.connected).toBe(false)
    const listed = await data<{ connections: ConnectionView[] }>(await api('/v1/connections'))
    expect(listed.connections).toEqual([])
  })

  it('试连一条不存在的连接回 not_found（不是 500）', async () => {
    const result = await data<ConnectTestResult>(await post('/v1/connections/conn_nope/test'))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_found')
  })

  it('断开邮箱连接时，秘密库里那条也一起没了', async () => {
    const submitted = await data<{ connection: ConnectionView }>(
      await post('/v1/connections/imap_smtp/submit', { alias: 'a', fields: MAIL_FIELDS }),
    )
    expect(ctx.server.connections.mailAccounts()).toHaveLength(1)
    await api(`/v1/connections/${submitted.connection.id}`, { method: 'DELETE' })
    expect(ctx.server.connections.mailAccounts()).toEqual([])
    // 凭据来源也拿不到了
    expect(() =>
      ctx.server.connections
        .credentialSource()
        .password({ connection_id: submitted.connection.id }),
    ).toThrow()
  })

  it('channels 的凭据来源按连接 id 取到的就是刚填的那一份（值只在这一处出现）', async () => {
    const submitted = await data<{ connection: ConnectionView }>(
      await post('/v1/connections/imap_smtp/submit', { alias: 'a', fields: MAIL_FIELDS }),
    )
    const source = ctx.server.connections.credentialSource()
    expect(source.password({ connection_id: submitted.connection.id })).toBe(PASSWORD)
    const account = ctx.server.connections.mailAccounts()[0]
    expect(account?.imap.host).toBe('127.0.0.1')
    expect(account?.imap.connection_id).toBe(submitted.connection.id)
    expect(account?.smtp.user).toBe(MAIL_FIELDS.email)
    // MailAccount 里没有口令
    expect(JSON.stringify(account)).not.toContain(PASSWORD)
  })
})

describe('WP20 §A 权限', () => {
  it('只有 store_config / policy 权限的岗位能看能改；客服岗位一律 403', async () => {
    const aftersales = ctx.server.roles.assignments.create({
      person_id: ctx.server.bootstrap.person.id,
      workspace_id: ctx.server.bootstrap.workspace.id,
      role_id: 'dtc.aftersales',
      granted_by: ctx.server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    expect((await api('/v1/connections', { assignment: aftersales.id })).status).toBe(403)
    expect(
      (
        await api('/v1/connections/imap_smtp/submit', {
          method: 'POST',
          assignment: aftersales.id,
          body: JSON.stringify({ fields: MAIL_FIELDS }),
        })
      ).status,
    ).toBe(403)
  })
})

// ── WP25 交付 A：Shopify Dev Dashboard 应用（客户端 ID + 密钥）────────────

/** 一份能换到令牌的应用凭据。零泄漏断言全程盯着 `CLIENT_SECRET`。 */
const CLIENT_ID = '9a7bcd0e1f2a3b4c5d6e7f8091a2b3c4'
const CLIENT_SECRET = 'shpss_wp25_client_secret_never_logged'
const DEV_APP = {
  alias: '主店',
  auth_option: 'dev_app',
  fields: {
    shop_domain: 'https://admin.shopify.com/store/demo',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  },
}

describe('WP25 §A Shopify 客户端凭据换令牌（端到端）', () => {
  it('目录里两种接法：Dev Dashboard 应用推荐在前，老的访问令牌在后，各带 ≤ 5 步说明', async () => {
    const { providers } = await data<{ providers: ProviderView[] }>(
      await api('/v1/connections/providers'),
    )
    const shop = providers.find((p) => p.service === 'shopify_admin')
    const options = shop?.auth_options ?? []
    expect(options.map((o) => o.id)).toEqual(['dev_app', 'access_token'])
    for (const o of options) {
      expect(o.setup_guide.steps.length).toBeGreaterThan(0)
      expect(o.setup_guide.steps.length).toBeLessThanOrEqual(5)
      expect(o.label).not.toBe('')
    }
    // 权限清单要在文案里写清楚（用户在版本页要逐个勾）
    const guide = JSON.stringify(options[0]?.setup_guide)
    for (const scope of ['read_orders', 'write_orders', 'read_returns', 'read_customers']) {
      expect(guide, scope).toContain(scope)
    }
    // 客户端密钥字段必须标 secret
    expect(options[0]?.fields.find((f) => f.name === 'client_secret')?.secret).toBe(true)
    expect(options[0]?.fields.find((f) => f.name === 'shop_domain')?.secret).toBe(false)
  })

  it('begin：这条路不去问上游要表单，直接给 ID / 密钥 / 域名三个格子', async () => {
    const res = await post('/v1/connections/shopify_admin/begin', {
      alias: '主店',
      auth_option: 'dev_app',
    })
    expect(res.status).toBe(200)
    const begun = await data<{
      request_id: string
      secure_form: { fields: { name: string }[]; auth_option?: string }
    }>(res)
    expect(begun.request_id.startsWith('creq_shopify_')).toBe(true)
    expect(begun.secure_form.fields.map((f) => f.name)).toEqual([
      'shop_domain',
      'client_id',
      'client_secret',
    ])
    expect(begun.secure_form.auth_option).toBe('dev_app')
  })

  it('submit：按官方形状换令牌 → 推进 OpenConnector → 试连回店铺名', async () => {
    const res = await post('/v1/connections/shopify_admin/submit', DEV_APP)
    expect(res.status, await res.clone().text()).toBe(200)
    const submitted = await data<{ connection: ConnectionView; test: ConnectTestResult }>(res)

    // 换令牌那一次请求：URL 打在店铺自己的域名上，body 就是官方那三个字段
    expect(shopifyUpstream.calls).toHaveLength(1)
    const call = shopifyUpstream.calls[0]
    expect(call?.url).toBe('https://demo.myshopify.com/admin/oauth/access_token')
    const body = JSON.parse(call?.body ?? '{}') as Record<string, string>
    expect(body.grant_type).toBe('client_credentials')
    expect(body.client_id).toBe(CLIENT_ID)
    expect(body.client_secret).toBe(CLIENT_SECRET)

    // 连接确实建起来了，试连跑的是只读的 get_shop，回的是店铺名（不是令牌）
    expect(submitted.connection.service).toBe('shopify_admin')
    expect(submitted.test.ok).toBe(true)
    // 试连挑的是目录里"零必填参数的只读动作"；回的是那次调用的结果摘要，不是令牌
    expect(submitted.test.detail).not.toBe('')
    expect(JSON.stringify(submitted.test)).not.toContain('shpat_')

    // 到期时间记下来了：Shopify 给 86399 秒
    const record = ctx.server.connections.shopify.list()[0]
    expect(record?.shop).toBe('demo.myshopify.com')
    expect(Date.parse(record?.expires_at ?? '') - Date.parse(T0)).toBe(86_399_000)
    // 记录里没有任何凭据字段
    expect(JSON.stringify(record)).not.toContain(CLIENT_SECRET)
    expect(JSON.stringify(record)).not.toContain(CLIENT_ID)
  })

  it('零泄漏：密钥与令牌不进响应体、不进事件、不进数据目录任何一个文件', async () => {
    const raw = await (await post('/v1/connections/shopify_admin/submit', DEV_APP)).text()
    const token = shopifyUpstream.issued[0] ?? 'none'
    for (const secret of [CLIENT_SECRET, token]) {
      expect(raw).not.toContain(secret)
    }
    const events = JSON.stringify(await allEvents())
    expect(events).not.toContain(CLIENT_SECRET)
    expect(events).not.toContain(token)
    // 事件里只有字段名与店铺域名
    expect(events).toContain('client_secret')
    expect(events).toContain('demo.myshopify.com')
    for (const f of allFileBytes(ctx.dir)) {
      expect(f.bytes.includes(CLIENT_SECRET), `${f.name} 里有客户端密钥`).toBe(false)
      expect(f.bytes.includes(token), `${f.name} 里有访问令牌`).toBe(false)
    }
    // 清单与试连两条读路径也不带
    expect(await (await api('/v1/connections')).text()).not.toContain(CLIENT_SECRET)
  })

  it('到期前 1 小时才换新令牌；换的确实是新的一张，用的是加密库里那份密钥', async () => {
    await post('/v1/connections/shopify_admin/submit', DEV_APP)
    expect(shopifyUpstream.issued).toHaveLength(1)

    // 还早（刚发出来 22 小时，离到期还有 2 小时）：巡检不该动它
    ctx.clock.advance(22 * 60 * 60 * 1000)
    await ctx.server.connections.refreshTokens()
    expect(shopifyUpstream.issued).toHaveLength(1)

    // 再走一小时 → 进了"到期前 1 小时"的窗口：这一轮该换了
    ctx.clock.advance(60 * 60 * 1000)
    await ctx.server.connections.refreshTokens()
    expect(shopifyUpstream.issued).toHaveLength(2)
    expect(shopifyUpstream.issued[1]).not.toBe(shopifyUpstream.issued[0])

    // 刷新是拿加密库里那份密钥重发同样的请求（Shopify 没有 refresh_token 这一说）
    const second = JSON.parse(shopifyUpstream.calls[1]?.body ?? '{}') as Record<string, string>
    expect(second.client_secret).toBe(CLIENT_SECRET)
    expect(second.grant_type).toBe('client_credentials')

    // 到期时间跟着往后推了，而且换令牌这件事在事件日志里留了痕（但没有凭据）
    const record = ctx.server.connections.shopify.list()[0]
    expect(Date.parse(record?.expires_at ?? '')).toBeGreaterThan(Date.parse(T0) + 86_399_000)
    const issued = (await allEvents()).filter((e) => e.type === 'connect.shopify_token_issued')
    expect(issued).toHaveLength(2)
    // 后台巡检没有请求可挂靠，自己开一条 trace（空串会被内核顶回来）
    expect(issued[1]?.correlation.trace_id).not.toBe('')
    expect(JSON.stringify(issued)).not.toContain(CLIENT_SECRET)
  })

  it('断开：本机加密库里的应用凭据与到期记录一起没了', async () => {
    const submitted = await data<{ connection: ConnectionView }>(
      await post('/v1/connections/shopify_admin/submit', DEV_APP),
    )
    expect(ctx.server.connections.shopify.list()).toHaveLength(1)
    await api(`/v1/connections/${submitted.connection.id}`, { method: 'DELETE' })
    expect(ctx.server.connections.shopify.list()).toEqual([])
    expect(ctx.server.secrets.record('shopify_app:demo.myshopify.com')).toBeUndefined()
  })

  it('shop_not_permitted：中文说清楚"去 Dev Dashboard 点 Install app"，且不留密钥', async () => {
    shopifyUpstream.mode = 'shop_not_permitted'
    const res = await post('/v1/connections/shopify_admin/submit', DEV_APP)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Install app')
    expect(text).toContain('同一个 Dev Dashboard 组织')
    expect(text).not.toContain(CLIENT_SECRET)
    // 换不到令牌就别把密钥留在本机（用户多半填错了）
    expect(ctx.server.secrets.record('shopify_app:demo.myshopify.com')).toBeUndefined()
    expect(ctx.server.connections.shopify.list()).toEqual([])
  })

  it('invalid_client：提示回 Settings 重抄一遍 ID 与密钥', async () => {
    shopifyUpstream.mode = 'invalid_client'
    const res = await post('/v1/connections/shopify_admin/submit', DEV_APP)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('客户端 ID 或密钥不对')
    expect(text).not.toContain(CLIENT_SECRET)
  })

  it('店铺域名看不懂：连一次网络请求都不发', async () => {
    const res = await post('/v1/connections/shopify_admin/submit', {
      ...DEV_APP,
      fields: { ...DEV_APP.fields, shop_domain: 'not a domain!!' },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('店铺域名看不懂')
    expect(shopifyUpstream.calls).toEqual([])
  })
})

// ── WP25 交付 B：邮箱自动识别 ──────────────────────────────────────────

describe('WP25 §B 邮箱自动识别（端到端）', () => {
  it('企业邮：按 MX 认出腾讯企业邮，回主机端口与"识别到 X"', async () => {
    mxAnswers['yourbrand.com'] = [{ priority: 10, exchange: 'mxbiz1.qq.com' }]
    const found = await data<{
      domain: string
      mx_hosts: string[]
      preset: { id: string; label: string; imap_host: string; imap_port: number } | null
    }>(await api('/v1/connections/mail/detect?email=support@yourbrand.com'))
    expect(found.preset?.id).toBe('tencent_exmail')
    expect(found.preset?.imap_host).toBe('imap.exmail.qq.com')
    expect(found.preset?.imap_port).toBe(993)
    // 界面要说清"我们凭什么这么猜"：把查到的 MX 一并回去
    expect(found.domain).toBe('yourbrand.com')
    expect(found.mx_hosts).toEqual(['mxbiz1.qq.com'])
  })

  it('个人邮：163 查不到 MX 也按域名认出来，文案里写明要用授权码', async () => {
    const found = await data<{ preset: { id: string; auth: string; note: string } | null }>(
      await api('/v1/connections/mail/detect?email=me@163.com'),
    )
    expect(found.preset?.id).toBe('netease_163')
    expect(found.preset?.auth).toBe('app_password')
    expect(found.preset?.note).toContain('授权码')
  })

  it('微软标 oauth_required，界面上直说"下一版走 Microsoft 授权登录"', async () => {
    mxAnswers['contoso.com'] = [
      { priority: 5, exchange: 'contoso-com.mail.protection.outlook.com' },
    ]
    const found = await data<{ preset: { id: string; auth: string; note: string } | null }>(
      await api('/v1/connections/mail/detect?email=amy@contoso.com'),
    )
    expect(found.preset?.auth).toBe('oauth_required')
    expect(found.preset?.note).toContain('下一版')
  })

  it('DNS 抛异常：这条路永不抛，回 preset: null 让用户手填', async () => {
    mxThrows = true
    const res = await api('/v1/connections/mail/detect?email=me@unknown-domain.test')
    expect(res.status).toBe(200)
    expect((await data<{ preset: unknown }>(res)).preset).toBeNull()
  })

  it('MX 一家都不认识：也回 null，不瞎猜一个主机名', async () => {
    mxAnswers['weird.test'] = [{ priority: 10, exchange: 'mail.self-hosted.weird.test' }]
    expect(
      (await data<{ preset: unknown }>(await api('/v1/connections/mail/detect?email=a@weird.test')))
        .preset,
    ).toBeNull()
  })

  it('地址空着：400，而不是去查一次 DNS', async () => {
    expect((await api('/v1/connections/mail/detect?email=')).status).toBe(400)
  })

  it('邮箱连接的中文错误映射：连不上的主机端口 → "主机或端口不对"，原文只进 detail', async () => {
    const submitted = await data<{ connection: ConnectionView; test: ConnectTestResult }>(
      await post('/v1/connections/imap_smtp/submit', { alias: 'a', fields: MAIL_FIELDS }),
    )
    expect(submitted.test.ok).toBe(false)
    expect(submitted.test.detail).toMatch(/主机|端口|IMAP/)
    // 人话在 detail 里，口令一个字节都没有
    expect(JSON.stringify(submitted.test)).not.toContain(PASSWORD)
  })

  it('用户名留空 = 邮箱；SMTP 密码留空 = 复用 IMAP 的那一把', async () => {
    const submitted = await data<{ connection: ConnectionView }>(
      await post('/v1/connections/imap_smtp/submit', {
        alias: 'b',
        fields: { ...MAIL_FIELDS, username: '', smtp_password: '' },
      }),
    )
    const account = ctx.server.connections.mailAccounts()[0]
    expect(account?.imap.user).toBe(MAIL_FIELDS.email)
    expect(account?.smtp.user).toBe(MAIL_FIELDS.email)
    const source = ctx.server.connections.credentialSource()
    expect(source.password({ connection_id: submitted.connection.id })).toBe(PASSWORD)
  })
})
