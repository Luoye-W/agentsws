/**
 * WP46 真实店铺数据喂岗位面板（端到端 + 映射单测）。
 *
 * 1d 真账号验收发现的那个洞：Shopify 连上了、岗位也 ready 了，岗位页的数字块与
 * 「店铺后台」分块却全是空的——服务进程一直挂 `emptyDataSource()`。这里钉住修好之后的行为：
 *
 * - 连上 Shopify → `GET /v1/positions/:id/view` 的「店铺后台」分块有数、数字块有值；
 * - 断开 → 立刻变回「去连接」；
 * - 上游 401 → 换一张令牌再试一次就成；
 * - 上游持续失败 → 保留上一份缓存 + 一条 `data.refresh_failed`；
 * - **每一轮刷新的 token 都被吊销**，而且订单原文不进事件、不进任何一个落盘文件。
 *
 * 用的是替身 OpenConnector（外面套一层计数壳），跑的是完整的 `/v1` 路由 + 活数据源。
 * 真店碰不到（凭据在 Luoye 本机的加密库里），所以真身那一侧只对着形状写单测。
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionView } from '@agentsws/api'
import type { ActionMeta, Clock, ConnectToken, EventEnvelope } from '@agentsws/contracts'
import type { StatTile, ViewSection } from '@agentsws/deck'
import { defaultState, MockOpenConnector } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectLike } from '../src/connections.js'
import { createServer, type Server } from '../src/index.js'
import {
  DEFAULT_REFRESH_SECONDS,
  offsetMinutesOf,
  ordersArrayOf,
  refreshSecondsOf,
  shopCurrencyOf,
  shopTimezoneOffsetOf,
  toOrderRow,
} from '../src/live-data.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import type { BrokerFetch } from '../src/shopify-broker.js'

const T0 = '2026-09-09T09:00:00.000Z'
const SECRETS_KEY = 'a'.repeat(64)
const CLIENT_SECRET = 'shpss_wp46_client_secret_never_logged'
const DEV_APP = {
  alias: '主店',
  fields: {
    shop_domain: 'https://admin.shopify.com/store/demo',
    client_id: '9a7bcd0e1f2a3b4c5d6e7f8091a2b3c4',
    client_secret: CLIENT_SECRET,
  },
}

/** 「昨天」窗口里的两笔 + 前一天的一笔（tz +480 时日界线落在 UTC 16:00）。 */
const YESTERDAY_A = '2026-09-08T09:00:00.000Z'
const YESTERDAY_B = '2026-09-08T02:00:00.000Z'
const DAY_BEFORE = '2026-09-07T09:00:00.000Z'
/** 客户邮箱：订单原文有没有泄漏进事件 / 落盘，就盯这一串。 */
const CUSTOMER_EMAIL = 'wp46-customer-never-logged@example.com'

function makeClock(start = T0): Clock & { advance(ms: number): void } {
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

/** Shopify 换令牌那一跳的假上游（一个字节都不出这台机器）。 */
function fakeShopify(): { fetch: BrokerFetch; issued: string[] } {
  const issued: string[] = []
  return {
    issued,
    fetch: async () => {
      const token = `shpat_issued_${issued.length + 1}_${'f'.repeat(20)}`
      issued.push(token)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: token, scope: 'read_orders', expires_in: 86_399 }),
      }
    },
  }
}

/** 上游错误（带 code，跟真适配器抛的形状一样）。 */
class UpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface ConnectSpy extends ConnectLike {
  mock: MockOpenConnector
  issued: { assignment_id: string; actions: string[]; connections: string[] }[]
  revoked: string[]
  executed: string[]
  /** 下一次 `execute` 抛这个错（抛完清掉）。 */
  failNext?: Error
  /** 每次 `execute` 都抛这个错。 */
  failAlways?: Error
}

/**
 * 替身外面套一层计数壳：签了几张 token、吊销了几次、跑了哪些 Action。
 *
 * 壳不改任何形状——`execute` 的返回原样透传，形状仍是替身（= 契约）的那一份。
 */
function connectSpy(mock: MockOpenConnector): ConnectSpy {
  const spy: ConnectSpy = {
    mock,
    issued: [],
    revoked: [],
    executed: [],
    providers: () => mock.providers(),
    actions: (service: string): Promise<ActionMeta[]> => mock.actions(service),
    connections: (workspace_id) => mock.connections(workspace_id),
    beginConnect: (service, opts) => mock.beginConnect(service, opts),
    pollConnect: (request_id) => mock.pollConnect(request_id),
    submitForm: (service, input) => mock.submitForm(service, input),
    removeConnection: (id) => mock.removeConnection(id),
    async issueToken(input): Promise<ConnectToken> {
      spy.issued.push({
        assignment_id: input.assignment_id,
        actions: [...input.allowed_actions],
        connections: [...input.allowed_connections],
      })
      return mock.issueToken(input)
    },
    async revokeTokens(assignment_id): Promise<void> {
      spy.revoked.push(assignment_id)
      await mock.revokeTokens(assignment_id)
    },
    async execute(action_id, input, opts) {
      spy.executed.push(action_id)
      const once = spy.failNext
      if (once !== undefined) {
        spy.failNext = undefined
        throw once
      }
      if (spy.failAlways !== undefined) throw spy.failAlways
      return mock.execute(action_id, input, opts)
    },
  }
  return spy
}

interface Ctx {
  server: Server
  url: string
  dir: string
  connect: ConnectSpy
  clock: ReturnType<typeof makeClock>
  /**
   * 面板与积木都以**售后客服**岗位的身份看：owner 的职责里没有 `order` 域，
   * 面板上连「店铺后台」这一块都不该出（19 §3 过滤下推）。
   */
  assignment: string
}

let ctx: Ctx

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? ctx.assignment)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const post = (path: string, body?: unknown, assignment?: string): Promise<Response> =>
  api(path, {
    method: 'POST',
    ...(assignment === undefined ? {} : { assignment }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

function allFileBytes(dir: string): { name: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, bytes: readFileSync(join(dir, d.name)) }))
}

/** 连一家店（走真装配线：客户端凭据 → 令牌 → 替身连接器）。 */
async function connectShop(): Promise<ConnectionView> {
  // 连接页是所有者的活（`policy.stage`）；面板才是客服岗位在看
  const res = await post(
    '/v1/connections/shopify_admin/submit',
    DEV_APP,
    ctx.server.bootstrap.ownerAssignment.id,
  )
  expect(res.status, await res.clone().text()).toBe(200)
  return (await data<{ connection: ConnectionView }>(res)).connection
}

const shopSection = (sections: ViewSection[]): ViewSection | undefined =>
  sections.find((s) => s.source === 'shop')

/** 把首页数字块设成店铺那两个（owner 岗位默认没有数字块）。 */
async function shopTiles(ids = ['sales_total', 'orders_count']): Promise<StatTile[]> {
  const res = await api('/v1/me/home-tiles', {
    method: 'PUT',
    body: JSON.stringify({
      position_id: ctx.assignment,
      tile_ids: ids,
      range: 'yesterday',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return (await data<{ tiles: StatTile[] }>(res)).tiles
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-live-data-'))
  const clock = makeClock()
  // 替身自带的示例订单是相对数据集起点生成的；这里换成「昨天 / 前天」那三笔，
  // 好让数字块的窗口（昨天 vs 前一天）算出确定的数。
  const state = defaultState(T0)
  state.orders = [
    {
      ...(state.orders[0] as (typeof state.orders)[number]),
      id: 'ord_a',
      name: '#2001',
      email: CUSTOMER_EMAIL,
      created_at: YESTERDAY_A,
      total_price: 129,
      refunded_amount: 0,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
    },
    {
      ...(state.orders[0] as (typeof state.orders)[number]),
      id: 'ord_b',
      name: '#2002',
      email: 'b@example.com',
      created_at: YESTERDAY_B,
      total_price: 71,
      refunded_amount: 0,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
    },
    {
      ...(state.orders[0] as (typeof state.orders)[number]),
      id: 'ord_c',
      name: '#2003',
      email: 'c@example.com',
      created_at: DAY_BEFORE,
      total_price: 50,
      refunded_amount: 0,
      financial_status: 'paid',
      fulfillment_status: 'fulfilled',
    },
  ]
  const connect = connectSpy(
    new MockOpenConnector({ clock, random: seeded(), state, workspace_id: 'ws_stand_in' }),
  )
  const server = await createServer({
    dbDir: dir,
    clock,
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY },
    connect,
    shopifyFetch: fakeShopify().fetch,
    tokenRefreshIntervalMs: 0,
    // 后台定时器交给测试自己驱动：读之前的 `ensureFresh` 才是首屏那条路
    liveDataIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  // 售后客服岗位：它的面板就是「店铺后台」那一块（`VIEW_BY_ROLE['dtc.aftersales']`）
  const aftersales = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.aftersales',
    granted_by: server.bootstrap.person.id,
    // 31 §3.1：范围为空的岗位不许用 `assigned` 范围查询，面板上一个块都出不来
    ranges: [{ kind: 'store', id: 'store_main' }],
  })
  ctx = { server, url, dir, connect, clock, assignment: aftersales.id }
})

afterEach(async () => {
  await ctx.server.close()
})

describe('WP46 §A 连上店铺 → 面板有数', () => {
  it('没连之前：「店铺后台」分块是「去连接」，数字块也是', async () => {
    const view = await data<{ sections: ViewSection[] }>(
      await api(`/v1/positions/${ctx.assignment}/view`),
    )
    expect(shopSection(view.sections)?.connected).toBe(false)
    const tiles = await shopTiles()
    expect(tiles.map((t) => t.status)).toEqual(['not_connected', 'not_connected'])
    // 一条只读动作都没跑过：没连接就不该去打上游
    expect(ctx.connect.executed).toEqual([])
  })

  it('连上之后：分块 connected、最近订单表有行、数字块有值（昨天 200 / 2 笔）', async () => {
    await connectShop()
    const view = await data<{ sections: ViewSection[] }>(
      await api(`/v1/positions/${ctx.assignment}/view`),
    )
    const shop = shopSection(view.sections)
    expect(shop?.connected).toBe(true)
    expect(shop?.report_url).toBe('https://admin.shopify.com')
    expect((shop?.blocks ?? []).map((b) => b.id)).toContain('shop.recent_orders')

    // 「最近订单」= 拉回来的三笔全在，按下单时间倒序。
    // WP49：这张表不受右上角时间窗限制（"最近"就是字面意思），所以 range=yesterday
    // 也会带出前天那笔 #2003——以前是窗内取，今天刚下的单反而看不见。
    const recent = await data<{ status: string; payload: { rows: { order: string }[] } }>(
      await api('/v1/blocks/shop.recent_orders/data?range=yesterday'),
    )
    expect(recent.status).toBe('ok')
    expect(recent.payload.rows.map((r) => r.order)).toEqual(['#2001', '#2002', '#2003'])

    // 数字块：昨天 129 + 71 = 200，两笔；环比是前一天那 50 / 1 笔
    const tiles = await shopTiles()
    const sales = tiles.find((t) => t.id === 'sales_total')
    expect(sales?.status).toBe('ok')
    expect(sales?.value).toBe(200)
    expect(sales?.previous).toBe(50)
    expect(sales?.currency).toBe('USD')
    expect(tiles.find((t) => t.id === 'orders_count')?.value).toBe(2)

    // 「超期未发」按结构化字段判：#2001 还没发货，但只过了一天，不算超期
    const overdue = await data<{ payload: { rows: unknown[] } }>(
      await api('/v1/blocks/shop.overdue_orders/data?range=yesterday'),
    )
    expect(overdue.payload.rows).toEqual([])
  })

  it('币种与日界线来自 get_shop（替身报 USD / Asia/Shanghai）', async () => {
    await connectShop()
    await shopTiles()
    expect(ctx.connect.executed).toContain('shopify_admin.get_shop')
    expect(ctx.server.liveData?.base_currency).toBe('USD')
    expect(ctx.server.liveData?.tz_offset_minutes).toBe(480)
  })

  it('断开之后：orders() 立刻回空，分块又变回「去连接」', async () => {
    const conn = await connectShop()
    expect((await shopTiles())[0]?.status).toBe('ok')

    const removed = await api(`/v1/connections/${conn.id}`, {
      method: 'DELETE',
      assignment: ctx.server.bootstrap.ownerAssignment.id,
    })
    expect(removed.status).toBe(200)
    expect(ctx.server.liveData?.orders()).toEqual([])
    const view = await data<{ sections: ViewSection[] }>(
      await api(`/v1/positions/${ctx.assignment}/view`),
    )
    expect(shopSection(view.sections)?.connected).toBe(false)
    expect((await shopTiles()).map((t) => t.status)).toEqual(['not_connected', 'not_connected'])
  })
})

describe('WP46 §B 令牌：现签、只允许这一条连接、用完即吊销', () => {
  it('每一轮刷新签一张 role-read token（只两个只读动作 + 这条连接），跑完立刻吊销', async () => {
    const conn = await connectShop()
    await shopTiles()
    const live = ctx.connect.issued.filter((t) => t.assignment_id === 'asg_live_data')
    expect(live.length).toBeGreaterThanOrEqual(1)
    for (const token of live) {
      expect(token.connections).toEqual([conn.id])
      expect(token.actions.sort()).toEqual(['shopify_admin.get_shop', 'shopify_admin.list_orders'])
    }
    // 签几张就吊销几次
    expect(ctx.connect.revoked.filter((a) => a === 'asg_live_data').length).toBe(live.length)
    const revoked = await allEvents()
    expect(revoked.some((e) => e.type === 'data.refreshed')).toBe(true)
  })

  it('缓存还新就不再打上游（一次首屏一轮，不是一个块一轮）', async () => {
    await connectShop()
    // 先读一次把缓存烘热，再看后面三条读路径还打不打上游
    await shopTiles()
    const before = ctx.connect.executed.filter((a) => a.endsWith('list_orders')).length
    expect(before).toBeGreaterThan(0)
    await api(`/v1/positions/${ctx.assignment}/view`)
    await api(`/v1/positions/${ctx.assignment}/summary`)
    await api('/v1/blocks/shop.recent_orders/data')
    expect(ctx.connect.executed.filter((a) => a.endsWith('list_orders')).length).toBe(before)
  })
})

describe('WP46 §C 上游出问题时', () => {
  it('401 → 换一张令牌再跑一次就成（数字块照样有值）', async () => {
    await connectShop()
    const beforeIssued = ctx.server.connections.shopify.list()[0]?.refreshed_at
    ctx.connect.failNext = new UpstreamError('unauthenticated', '401 Unauthorized')
    ctx.clock.advance(60_000)
    ctx.server.liveData?.invalidate()

    const tiles = await shopTiles()
    expect(tiles.find((t) => t.id === 'sales_total')?.value).toBe(200)
    expect(ctx.server.liveData?.status().last?.refreshed_token).toBe(true)
    // 真去换了一张（经纪人的记录时间变了）
    expect(ctx.server.connections.shopify.list()[0]?.refreshed_at).not.toBe(beforeIssued)
  })

  it('持续失败 → 保留上一份缓存 + 一条 data.refresh_failed（事件里只有原因码与条数）', async () => {
    await connectShop()
    expect((await shopTiles()).find((t) => t.id === 'sales_total')?.value).toBe(200)

    ctx.connect.failAlways = new UpstreamError('provider_unavailable', '上游 503')
    ctx.clock.advance(60_000)
    ctx.server.liveData?.invalidate()
    const tiles = await shopTiles()
    // 旧缓存还在：面板不会因为一次上游抽风就空掉
    expect(tiles.find((t) => t.id === 'sales_total')?.value).toBe(200)
    expect(ctx.server.liveData?.status().stale).toBe(true)

    const failed = (await allEvents()).filter((e) => e.type === 'data.refresh_failed')
    expect(failed.length).toBeGreaterThanOrEqual(1)
    const payload = failed[0]?.payload as Record<string, unknown>
    expect(payload.reason).toBe('provider_unavailable')
    expect(payload.kept_cached_orders).toBe(3)
    // 失败那一轮的 token 一样要吊销
    expect(ctx.connect.revoked.filter((a) => a === 'asg_live_data').length).toBeGreaterThanOrEqual(
      2,
    )
  })

  it('目录里没有 list_orders → 记一条失败，不抛、不把面板打成 500', async () => {
    await connectShop()
    ctx.connect.actions = async () => []
    ctx.clock.advance(60_000)
    ctx.server.liveData?.invalidate()
    const report = await (ctx.server.liveData as NonNullable<Server['liveData']>).refresh()
    expect(report.status).toBe('failed')
    expect(report.reason).toBe('action_unavailable')
    const view = await api(`/v1/positions/${ctx.assignment}/view`)
    expect(view.status).toBe(200)
  })
})

describe('WP46 §D 订单只在内存里', () => {
  it('订单原文不进事件、不进数据目录任何一个文件（事件里只有条数与耗时）', async () => {
    await connectShop()
    await shopTiles()
    expect(ctx.server.liveData?.orders().map((o) => o.id)).toEqual(['ord_a', 'ord_b', 'ord_c'])

    const events = await allEvents()
    const text = JSON.stringify(events)
    expect(text).not.toContain(CUSTOMER_EMAIL)
    expect(text).not.toContain('#2001')
    const refreshed = events.find((e) => e.type === 'data.refreshed')
    if (refreshed === undefined) throw new Error('没有 data.refreshed 事件')
    const payload = refreshed.payload as { orders: number }
    expect(Object.keys(payload).sort()).toEqual([
      'connection_id',
      'duration_ms',
      'orders',
      'pages',
      'source',
    ])
    expect(payload.orders).toBe(3)

    for (const f of allFileBytes(ctx.dir)) {
      expect(f.bytes.includes(Buffer.from(CUSTOMER_EMAIL, 'utf8')), `${f.name}`).toBe(false)
      expect(f.bytes.includes(Buffer.from(CLIENT_SECRET, 'utf8')), `${f.name}`).toBe(false)
    }
  })
})

// ── 真身那一侧：只能对着形状写（真店碰不到）─────────────────────────────

describe('WP46 §E 上游返回 → OrderRow（真身与替身两种形状）', () => {
  it('替身的 { orders, count }', () => {
    const rows = ordersArrayOf({ orders: [{ id: 'o1' }], count: 1 })
    expect(rows).toEqual([{ id: 'o1' }])
  })

  it('REST 风格（snake_case、钱是字符串、未发货那一格是 null）', () => {
    const row = toOrderRow(
      {
        id: 5001,
        order_number: 1001,
        email: 'a@b.com',
        created_at: '2026-09-08T09:00:00Z',
        currency: 'EUR',
        total_price: '129.90',
        financial_status: 'paid',
        fulfillment_status: null,
        refunds: [{ amount: '10.00' }, { amount: '5.00' }],
      },
      'USD',
    )
    expect(row).toEqual({
      id: '5001',
      name: '1001',
      email: 'a@b.com',
      currency: 'EUR',
      created_at: '2026-09-08T09:00:00Z',
      total_price: 129.9,
      refunded_amount: 15,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
    })
  })

  it('GraphQL 风格（edges/node、钱包结构、状态大写）', () => {
    const rows = ordersArrayOf({
      data: { orders: { edges: [{ node: { id: 'gid://shopify/Order/1' } }] } },
    })
    expect(rows).toEqual([{ id: 'gid://shopify/Order/1' }])
    const row = toOrderRow(
      {
        id: 'gid://shopify/Order/1',
        name: '#1001',
        createdAt: '2026-09-08T09:00:00Z',
        customer: { email: 'a@b.com' },
        totalPriceSet: { shopMoney: { amount: '88.00', currencyCode: 'CAD' } },
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
      },
      'USD',
    )
    expect(row?.currency).toBe('CAD')
    expect(row?.total_price).toBe(88)
    expect(row?.email).toBe('a@b.com')
    expect(row?.financial_status).toBe('paid')
    expect(row?.fulfillment_status).toBe('unfulfilled')
  })

  it('缺下单时间或 id 的行直接丢掉（宁可少一条也不猜）', () => {
    expect(toOrderRow({ id: 'x' }, 'USD')).toBeUndefined()
    expect(toOrderRow({ created_at: '2026-09-08T09:00:00Z' }, 'USD')).toBeUndefined()
    expect(ordersArrayOf({ nope: 1 })).toEqual([])
  })

  it('get_shop：币种与时区（IANA 名与 (GMT-05:00) 两种写法都认）', () => {
    const at = Date.parse(T0)
    expect(shopCurrencyOf({ shop: { currency: 'jpy' } })).toBe('JPY')
    expect(shopTimezoneOffsetOf({ shop: { iana_timezone: 'Asia/Shanghai' } }, at)).toBe(480)
    expect(
      shopTimezoneOffsetOf({ shop: { timezone: '(GMT-05:00) Eastern Time (US & Canada)' } }, at),
    ).toBe(-300)
    expect(offsetMinutesOf('UTC', at)).toBe(0)
    // 认不出来的时区名不该炸，回 undefined 让工作区默认接手
    expect(offsetMinutesOf('Mars/Olympus', at)).toBeUndefined()
  })

  it('刷新周期：默认 5 分钟，环境变量可调，写坏了回默认', () => {
    expect(refreshSecondsOf({})).toBe(DEFAULT_REFRESH_SECONDS)
    expect(refreshSecondsOf({ AGENTSWS_LIVE_DATA_REFRESH_SECONDS: '30' })).toBe(30)
    expect(refreshSecondsOf({ AGENTSWS_LIVE_DATA_REFRESH_SECONDS: 'soon' })).toBe(
      DEFAULT_REFRESH_SECONDS,
    )
  })
})

describe('WP46 真身形状（09-11 对着 OpenConnector shopify_admin 源码核的）', () => {
  it('list_orders 回 { orders: [normalized], pageInfo }：totalAmount / totalCurrencyCode / displayFinancialStatus 都认', () => {
    const payload = {
      orders: [
        {
          id: 'gid://shopify/Order/1',
          name: '#1003',
          email: 'a@b.c',
          phone: null,
          displayFinancialStatus: 'PAID',
          displayFulfillmentStatus: 'UNFULFILLED',
          currencyCode: 'USD',
          totalAmount: '22.50',
          totalCurrencyCode: 'USD',
          customerId: null,
          customerDisplayName: 'A B',
          createdAt: '2026-09-06T10:00:00Z',
          updatedAt: '2026-09-06T10:00:00Z',
          cursor: 'eyJ',
          raw: {},
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: 'eyJ',
        endCursor: 'eyJ',
      },
    }
    const rows = ordersArrayOf(payload).map((r) => toOrderRow(r, 'EUR'))
    expect(rows).toEqual([
      {
        id: 'gid://shopify/Order/1',
        name: '#1003',
        email: 'a@b.c',
        currency: 'USD',
        created_at: '2026-09-06T10:00:00Z',
        total_price: 22.5,
        refunded_amount: 0,
        financial_status: 'paid',
        fulfillment_status: 'unfulfilled',
      },
    ])
  })
})
