/**
 * WP319 ①（Luoye 10-14 Windows 真机）：店铺在连接页一键授权连上了、「查商品」查得到，
 * 首页「店铺管理」面板与独立站岗位「数据看板 · 店铺管理」却说「还没连接店铺后台 · 去连接」。
 *
 * 根因：面板（`live-data.ts`）只认连接器里那条老的店铺连接（`shopify_admin`），没认运营工具用的那一份
 * 「店铺管理授权」（云端一键授权优先、没有才 CLI 店铺授权）。修好之后两边认同一份：
 *
 * 1. 单元：没有连接器那条、店铺管理授权读得动 → 店铺后台算连上，订单经只读 Admin GraphQL 拉；
 *    授权失效 / 缺权限 → 照实算没连；什么都没有 → 照旧「去连接」，而且一分钟内不反复去问；
 *    连接器那条在 → 照旧走连接器，不碰店铺管理授权。
 * 2. 端到端（真装配线 + 云替身 + 假店，这台机器没装 Shopify CLI）：连接页一键授权之后，
 *    「店铺后台」分块连上、总销售额 / 订单数有数。
 */
import type { Assignment, Clock } from '@agentsws/contracts'
import type { StatTile, ViewSection } from '@agentsws/deck'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_PASSWORD, CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { createLiveDataSource, type LiveShopAdmin } from '../src/live-data.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { ShopAdminError, type ShopifyAdminReader } from '../src/shop-admin.js'
import { demoShop, type FakeShop, resolveFakeShop } from '../src/shop-admin-stand-in.js'
import { SHOPIFY_STAND_IN_SCOPES } from '../src/shopify-cloud-stand-in.js'

const SHOP = 'rovella-test.myshopify.com'
const T0 = '2026-10-14T06:00:00.000Z'

/** 近 30 天里的三笔（昨天两笔、今天一笔）+ 一笔 40 天前的（窗口外，要被丢掉）。 */
function ordersPayload() {
  const order = (id: number, at: string, amount: string) => ({
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: at,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
    totalRefundedSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
  })
  return {
    shop: { currencyCode: 'USD', ianaTimezone: 'Asia/Shanghai' },
    orders: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        order(3, '2026-10-14T05:00:00.000Z', '30.00'),
        order(2, '2026-10-13T05:00:00.000Z', '71.00'),
        order(1, '2026-10-13T03:00:00.000Z', '129.00'),
        order(0, '2026-09-01T03:00:00.000Z', '999.00'),
      ],
    },
  }
}

function fakeReader(answer: () => unknown): ShopifyAdminReader & { calls: string[] } {
  const calls: string[] = []
  return {
    via: 'cloud_app',
    store: SHOP,
    calls,
    async query<T>(op: { name: string; document: string }): Promise<T> {
      calls.push(/query\s+(\w+)/.exec(op.document)?.[1] ?? op.name)
      return answer() as T
    },
  }
}

function liveWith(opts: {
  admin?: LiveShopAdmin
  connections?: { id: string; service: string; status: 'active' }[]
}) {
  const clock: Clock = { now: () => T0 }
  const executed: string[] = []
  const live = createLiveDataSource({
    connections: {
      liveConnections: () => opts.connections ?? [],
      refreshConnectionToken: async () => false,
    },
    connect: {
      actions: async () => [
        { id: 'shopify_admin.list_orders', side_effect: 'read' },
        { id: 'shopify_admin.get_shop', side_effect: 'read' },
      ],
      issueToken: async () => ({ token: 't', expires_at: T0 }),
      execute: async (id: string) => {
        executed.push(id)
        return { data: id.endsWith('list_orders') ? { orders: [] } : {} }
      },
      revokeTokens: async () => undefined,
    } as never,
    clock,
    workspace_id: 'ws_wp319' as never,
    refreshIntervalMs: 0,
    ...(opts.admin === undefined ? {} : { shopAdmin: opts.admin }),
  })
  return { live, executed }
}

const shopSource = (live: ReturnType<typeof createLiveDataSource>) =>
  live.sources().find((s) => s.id === 'shop')

describe('WP319 ① 面板认店铺管理授权（单元）', () => {
  it('没有连接器那条、店铺管理授权读得动 → 店铺后台算连上，近 30 天订单进面板', async () => {
    const reader = fakeReader(ordersPayload)
    const { live, executed } = liveWith({
      admin: { peek: () => ({ store: SHOP }), reader: async () => reader },
    })
    // 云端说连着：还没拉之前就算连上（不先闪一下「去连接」）
    expect(shopSource(live)?.connected).toBe(true)
    await live.ensureFresh()
    expect(reader.calls).toEqual(['AgentswsLiveOrders'])
    expect(live.orders().map((o) => o.name)).toEqual(['#3', '#2', '#1'])
    expect(live.orders().reduce((s, o) => s + o.total_price, 0)).toBe(230)
    expect(live.status()).toMatchObject({ shop_connected: true, orders: 3 })
    expect(live.tz_offset_minutes).toBe(480)
    // 连接器一条只读动作都没跑
    expect(executed).toEqual([])
    // 周期内再读不重拉
    await live.ensureFresh()
    expect(reader.calls).toHaveLength(1)
    live.close()
  })

  it('CLI 店铺授权（云端没连、peek 不知道）：读成过一次之后同样算连上', async () => {
    const reader = { ...fakeReader(ordersPayload), via: 'cli_store_execute' as const }
    const { live } = liveWith({ admin: { peek: () => undefined, reader: async () => reader } })
    expect(shopSource(live)?.connected).toBe(false)
    await live.ensureFresh()
    expect(shopSource(live)?.connected).toBe(true)
    expect(live.orders()).toHaveLength(3)
    live.close()
  })

  it('授权失效 / 缺读订单权限 → 照实算没连、不留旧数；断网 → 仍算连着、留上一份', async () => {
    let fail: Error | undefined
    const reader = fakeReader(() => {
      if (fail !== undefined) throw fail
      return ordersPayload()
    })
    const { live } = liveWith({
      admin: { peek: () => ({ store: SHOP }), reader: async () => reader },
    })
    await live.refresh()
    expect(live.orders()).toHaveLength(3)

    fail = new ShopAdminError('network', '网络不通')
    const r1 = await live.refresh()
    expect(r1).toMatchObject({ status: 'failed', reason: 'network', stale: true })
    expect(shopSource(live)?.connected).toBe(true)
    expect(live.orders()).toHaveLength(3)

    fail = new ShopAdminError('missing_scope', '少了权限', { missing: ['read_orders'] })
    const r2 = await live.refresh()
    expect(r2).toMatchObject({ status: 'failed', reason: 'missing_scope' })
    expect(shopSource(live)?.connected).toBe(false)
    expect(live.orders()).toEqual([])
    live.close()
  })

  it('什么授权都没有 → 照旧「去连接」，一分钟内读面板不反复去问', async () => {
    let asked = 0
    const { live } = liveWith({
      admin: {
        peek: () => undefined,
        reader: async () => {
          asked += 1
          throw new ShopAdminError('not_authorized', '还没授权')
        },
      },
    })
    await live.ensureFresh()
    await live.ensureFresh()
    expect(asked).toBe(1)
    expect(shopSource(live)?.connected).toBe(false)
    expect(live.status().last).toMatchObject({ status: 'skipped', reason: 'no_connection' })
    // 连接变了（云端连上 / 断开）→ 下一次读之前重问
    live.invalidate()
    await live.ensureFresh()
    expect(asked).toBe(2)
    live.close()
  })

  it('连接器里有店铺连接 → 照旧走连接器，不碰店铺管理授权', async () => {
    let asked = 0
    const { live, executed } = liveWith({
      connections: [{ id: 'conn_1', service: 'shopify_admin', status: 'active' }],
      admin: {
        peek: () => ({ store: SHOP }),
        reader: async () => {
          asked += 1
          return fakeReader(ordersPayload)
        },
      },
    })
    await live.ensureFresh()
    expect(asked).toBe(0)
    expect(executed).toContain('shopify_admin.list_orders')
    live.close()
  })
})

/** 假店的 GraphQL（与 WP265 同一份解析：操作名 → 假店里的数据）。 */
function shopGraphql(shop: FakeShop) {
  return ({ query, variables }: { query: string; variables?: unknown }) => {
    const m = /^\s*(query|mutation)\s+(\w+)/.exec(query.replace(/#[^\n]*/g, ''))
    if (m === null) return undefined
    const data = resolveFakeShop(shop, m[2] ?? '', (variables ?? {}) as Record<string, unknown>)
    return data === undefined ? { errors: [{ message: 'unknown field' }] } : { data }
  }
}

describe('WP319 ① 端到端：连接页一键授权之后，面板「店铺后台」有数', () => {
  let server: Server
  let store: Assignment
  let cloud: CloudStandIn

  const call = async (method: string, path: string, body?: unknown, asg?: string) => {
    const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
    headers.set('X-Assignment', asg ?? store.id)
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
    if (parsed.data === undefined)
      throw new Error(`${method} ${path} → ${res.status} ${parsed.code} ${parsed.message}`)
    return parsed.data as never
  }

  beforeEach(async () => {
    cloud = cloudStandIn({
      autoLinkAfterMs: -1,
      shopify: {
        autoConnectAfterMs: -1,
        graphql: shopGraphql(demoShop()),
        scopes: [...SHOPIFY_STAND_IN_SCOPES, 'read_publications', 'write_publications'],
      },
    })
    // 这台机器上没有 Shopify CLI（Rovella 那台 Windows 也一样：店是在连接页一键授权连的）
    const exec: ProbeExec = async (bin) =>
      bin === 'node' ? { ok: true, stdout: 'v22.12.0' } : { ok: false, stdout: '', missing: true }
    server = await createServer({
      quiet: true,
      clock: { now: () => new Date().toISOString() },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      liveDataIntervalMs: 0,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      env: {
        AGENTSWS_OWNER_EMAIL: 'owner@example.test',
        [SECRETS_KEY_ENV]: 'a'.repeat(64),
        AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL,
      },
      platformCliExec: exec,
      cloudFetch: (input, init) => cloud.fetch(input, init),
    })
    const ws = server.bootstrap.workspace.id
    store = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'dtc.store',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    const owner = server.bootstrap.ownerAssignment.id
    await call(
      'PUT',
      '/v1/workspace/profile',
      { legal_name: 'Rovella', storefront_platform: 'shopify' },
      owner,
    )
    await call(
      'POST',
      '/v1/cloud/account/password-login',
      { email: CLOUD_STAND_IN_REGISTERED_EMAIL, password: CLOUD_STAND_IN_PASSWORD },
      owner,
    )
  })
  afterEach(async () => {
    await server.close()
  })

  const shopSection = async (): Promise<ViewSection | undefined> =>
    (
      (await call('GET', `/v1/positions/${store.id}/view`)) as { sections: ViewSection[] }
    ).sections.find((s) => s.source === 'shop')
  const tiles = async (): Promise<StatTile[]> =>
    (
      (await call('PUT', '/v1/me/home-tiles', {
        position_id: store.id,
        tile_ids: ['sales_total', 'orders_count'],
        range: 'last_7d',
      })) as { tiles: StatTile[] }
    ).tiles

  it('连之前「去连接」；一键授权连上 → 分块连上、总销售额 / 订单数有数', async () => {
    expect((await shopSection())?.connected).toBe(false)
    expect((await tiles()).map((t) => t.status)).toEqual(['not_connected', 'not_connected'])

    const owner = server.bootstrap.ownerAssignment.id
    const started = (await call('POST', '/v1/shopify-connect/start', { shop: SHOP }, owner)) as {
      attempt_id: string
    }
    cloud.shopify.settle(started.attempt_id, 'connected')
    await call('GET', `/v1/shopify-connect/attempts/${started.attempt_id}`, undefined, owner)

    expect((await shopSection())?.connected).toBe(true)
    const t = await tiles()
    expect(t.find((x) => x.id === 'sales_total')).toMatchObject({ status: 'ok', value: 49.8 })
    expect(t.find((x) => x.id === 'orders_count')).toMatchObject({ status: 'ok', value: 1 })
    // 云上只收到查询（面板只读）
    expect(cloud.shopify.graphqlCalls().every((c) => !c.allow_mutations)).toBe(true)
    expect(cloud.shopify.graphqlCalls().some((c) => c.query.includes('AgentswsLiveOrders'))).toBe(
      true,
    )
  })
})
