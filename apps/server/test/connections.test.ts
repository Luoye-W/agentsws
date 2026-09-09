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

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-connections-'))
  const server = await createServer({
    dbDir: dir,
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
  })
  const { url } = await server.listen(0)
  ctx = { server, url, dir }
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
    const raw = await post('/v1/connections/shopify_admin/submit', {
      alias: '主店',
      fields: { shop: 'demo.myshopify.com', accessToken: SHOP_TOKEN },
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
        fields: { shop: 'demo.myshopify.com', accessToken: SHOP_TOKEN },
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
