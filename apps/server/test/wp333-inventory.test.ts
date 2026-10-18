/**
 * WP333（决策 633）：首页 / 独立站「店铺管理」面板的「库存告急数」经店铺管理授权读库存。
 *
 * 1. 单元：授权里有 `read_inventory` → 订单拉完顺手拉一轮库存（不跟踪的、下架的丢掉）；
 *    没这个权限 / 没给权限口 / 撞上授权问题 → `inventory()` 回 undefined（面板照实没连，不出 0）；
 *    断网 → 留上一份；连接器那条在时，库存照样经店铺管理授权读。
 * 2. 端到端（真装配线 + 云替身 + 假店）：一键授权之后「库存告急数」有数；授权里没有读库存 →
 *    那一块没连，销售额照常有数。
 */
import type { Assignment, Clock } from '@agentsws/contracts'
import type { StatTile } from '@agentsws/deck'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_PASSWORD, CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import { CLOUD_STAND_IN_BASE_URL, cloudStandIn, createServer, type Server } from '../src/index.js'
import { createLiveDataSource, inventoryRowsOf, type LiveShopAdmin } from '../src/live-data.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { ShopAdminError, type ShopifyAdminReader } from '../src/shop-admin.js'
import { demoShop, type FakeShop, resolveFakeShop } from '../src/shop-admin-stand-in.js'
import { SHOPIFY_STAND_IN_SCOPES } from '../src/shopify-cloud-stand-in.js'

const SHOP = 'rovella-test.myshopify.com'
const T0 = '2026-10-15T06:00:00.000Z'

const ORDERS = {
  shop: { currencyCode: 'USD', ianaTimezone: 'Asia/Shanghai' },
  orders: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        id: 'gid://shopify/Order/1',
        name: '#1',
        createdAt: '2026-10-14T05:00:00.000Z',
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        currentTotalPriceSet: { shopMoney: { amount: '30.00', currencyCode: 'USD' } },
        totalRefundedSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
      },
    ],
  },
}

const variant = (
  id: number,
  qty: number,
  extra: { tracked?: boolean; status?: string; title?: string } = {},
) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title: extra.title ?? 'Default Title',
  sku: `LB-${id}`,
  inventoryQuantity: qty,
  inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked: extra.tracked ?? true },
  product: {
    id: `gid://shopify/Product/${id}`,
    title: `小蓝灯 ${id}`,
    status: extra.status ?? 'ACTIVE',
  },
})

const INVENTORY = {
  productVariants: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      variant(1, 2, { title: '蓝色' }),
      variant(2, 0),
      variant(3, 40),
      variant(4, 0, { tracked: false }),
      variant(5, 1, { status: 'ARCHIVED' }),
    ],
  },
}

function fakeReader(fail?: () => Error | undefined): ShopifyAdminReader & { calls: string[] } {
  const calls: string[] = []
  return {
    via: 'cloud_app',
    store: SHOP,
    calls,
    async query<T>(op: { name: string; document: string }): Promise<T> {
      const name = /query\s+(\w+)/.exec(op.document)?.[1] ?? op.name
      calls.push(name)
      if (name === 'AgentswsLiveInventory') {
        const e = fail?.()
        if (e !== undefined) throw e
        return INVENTORY as T
      }
      return ORDERS as T
    },
  }
}

function liveWith(opts: {
  admin: LiveShopAdmin
  connections?: { id: string; service: string; status: 'active' }[]
}) {
  const clock: Clock = { now: () => T0 }
  return createLiveDataSource({
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
      execute: async (id: string) => ({ data: id.endsWith('list_orders') ? { orders: [] } : {} }),
      revokeTokens: async () => undefined,
    } as never,
    clock,
    workspace_id: 'ws_wp333' as never,
    refreshIntervalMs: 0,
    shopAdmin: opts.admin,
  })
}

const scopes =
  (...s: string[]) =>
  async () => ({ scopes: s })

describe('WP333 库存经店铺管理授权读（单元）', () => {
  it('回包 → 库存行：不跟踪的、下架的丢掉；规格名不是默认的带上', () => {
    expect(inventoryRowsOf(INVENTORY)).toEqual([
      {
        id: 'gid://shopify/InventoryItem/1',
        title: '小蓝灯 1 / 蓝色',
        quantity: 2,
        product_id: 'gid://shopify/Product/1',
        sku: 'LB-1',
      },
      {
        id: 'gid://shopify/InventoryItem/2',
        title: '小蓝灯 2',
        quantity: 0,
        product_id: 'gid://shopify/Product/2',
        sku: 'LB-2',
      },
      {
        id: 'gid://shopify/InventoryItem/3',
        title: '小蓝灯 3',
        quantity: 40,
        product_id: 'gid://shopify/Product/3',
        sku: 'LB-3',
      },
    ])
    expect(inventoryRowsOf(undefined)).toEqual([])
  })

  it('有 read_inventory：订单拉完顺手拉库存', async () => {
    const reader = fakeReader()
    const live = liveWith({
      admin: {
        peek: () => ({ store: SHOP }),
        reader: async () => reader,
        access: scopes('read_orders', 'read_inventory'),
      },
    })
    await live.ensureFresh()
    expect(reader.calls).toEqual(['AgentswsLiveOrders', 'AgentswsLiveInventory'])
    expect(live.inventory?.()?.map((r) => r.quantity)).toEqual([2, 0, 40])
    live.close()
  })

  it('没有 read_inventory / 没给权限口 → 不去读，库存算没连（undefined，不是空表）', async () => {
    for (const access of [scopes('read_orders'), undefined]) {
      const reader = fakeReader()
      const live = liveWith({
        admin: {
          peek: () => ({ store: SHOP }),
          reader: async () => reader,
          ...(access === undefined ? {} : { access }),
        },
      })
      await live.ensureFresh()
      expect(reader.calls).toEqual(['AgentswsLiveOrders'])
      expect(live.inventory?.()).toBeUndefined()
      expect(live.orders()).toHaveLength(1)
      live.close()
    }
  })

  it('读库存撞上授权问题 → 没连；断网 → 留上一份', async () => {
    let fail: Error | undefined
    const reader = fakeReader(() => fail)
    const live = liveWith({
      admin: {
        peek: () => ({ store: SHOP }),
        reader: async () => reader,
        access: scopes('read_orders', 'read_inventory'),
      },
    })
    await live.refresh()
    expect(live.inventory?.()).toHaveLength(3)
    fail = new ShopAdminError('network', '网络不通')
    await live.refresh()
    expect(live.inventory?.()).toHaveLength(3)
    fail = new ShopAdminError('missing_scope', '少了权限', { missing: ['read_inventory'] })
    await live.refresh()
    expect(live.inventory?.()).toBeUndefined()
    // 订单照常
    expect(live.orders()).toHaveLength(1)
    live.close()
  })

  it('连接器那条在：订单走连接器，库存照样经店铺管理授权读', async () => {
    const reader = fakeReader()
    const live = liveWith({
      connections: [{ id: 'conn_1', service: 'shopify_admin', status: 'active' }],
      admin: {
        peek: () => ({ store: SHOP }),
        reader: async () => reader,
        access: scopes('read_inventory'),
      },
    })
    await live.ensureFresh()
    expect(reader.calls).toEqual(['AgentswsLiveInventory'])
    expect(live.inventory?.()).toHaveLength(3)
    live.close()
  })
})

/** 假店的 GraphQL（与 WP319 同一份解析：操作名 → 假店里的数据）。 */
function shopGraphql(shop: FakeShop) {
  return ({ query, variables }: { query: string; variables?: unknown }) => {
    const m = /^\s*(query|mutation)\s+(\w+)/.exec(query.replace(/#[^\n]*/g, ''))
    if (m === null) return undefined
    const data = resolveFakeShop(shop, m[2] ?? '', (variables ?? {}) as Record<string, unknown>)
    return data === undefined ? { errors: [{ message: 'unknown field' }] } : { data }
  }
}

describe('WP333 端到端：一键授权之后「库存告急数」', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const boot = async (grant: readonly string[]) => {
    const shop = demoShop()
    // 一个规格只剩 3 件（默认线 5 以下）
    const first = shop.products[0]?.variants[0]
    if (first !== undefined) first.inventoryQuantity = 3
    const cloud = cloudStandIn({
      autoLinkAfterMs: -1,
      shopify: { autoConnectAfterMs: -1, graphql: shopGraphql(shop), scopes: [...grant] },
    })
    const exec: ProbeExec = async (bin) =>
      bin === 'node' ? { ok: true, stdout: 'v22.12.0' } : { ok: false, stdout: '', missing: true }
    const s = await createServer({
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
    server = s
    const ws = s.bootstrap.workspace.id
    const store: Assignment = s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'dtc.store',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    const call = async (method: string, path: string, body?: unknown, asg?: string) => {
      const headers = new Headers({ Authorization: `Bearer ${s.bootstrap.internalToken}` })
      headers.set('X-Assignment', asg ?? store.id)
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await s.gateway.fetch(
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
    const owner = s.bootstrap.ownerAssignment.id
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
    const tiles = async (): Promise<StatTile[]> =>
      (
        (await call('PUT', '/v1/me/home-tiles', {
          position_id: store.id,
          tile_ids: ['sales_total', 'low_stock_count'],
          range: 'last_7d',
        })) as { tiles: StatTile[] }
      ).tiles
    const connect = async () => {
      const started = (await call('POST', '/v1/shopify-connect/start', { shop: SHOP }, owner)) as {
        attempt_id: string
      }
      cloud.shopify.settle(started.attempt_id, 'connected')
      await call('GET', `/v1/shopify-connect/attempts/${started.attempt_id}`, undefined, owner)
    }
    return { tiles, connect, cloud }
  }

  it('授权里有读库存：连之前没连；连上之后「库存告急数」= 1', async () => {
    const { tiles, connect, cloud } = await boot([
      ...SHOPIFY_STAND_IN_SCOPES,
      'read_publications',
      'write_publications',
    ])
    expect((await tiles()).map((t) => t.status)).toEqual(['not_connected', 'not_connected'])
    await connect()
    const t = await tiles()
    expect(t.find((x) => x.id === 'sales_total')).toMatchObject({ status: 'ok' })
    expect(t.find((x) => x.id === 'low_stock_count')).toMatchObject({ status: 'ok', value: 1 })
    expect(
      cloud.shopify.graphqlCalls().some((c) => c.query.includes('AgentswsLiveInventory')),
    ).toBe(true)
    expect(cloud.shopify.graphqlCalls().every((c) => !c.allow_mutations)).toBe(true)
  })

  it('授权里没有读库存：「库存告急数」没连（不出 0），销售额照常有数', async () => {
    const { tiles, connect, cloud } = await boot(
      SHOPIFY_STAND_IN_SCOPES.filter((s) => s !== 'read_inventory' && s !== 'write_inventory'),
    )
    await connect()
    const t = await tiles()
    expect(t.find((x) => x.id === 'sales_total')).toMatchObject({ status: 'ok' })
    const low = t.find((x) => x.id === 'low_stock_count')
    expect(low?.status).toBe('not_connected')
    expect(low?.value).toBeUndefined()
    expect(
      cloud.shopify.graphqlCalls().some((c) => c.query.includes('AgentswsLiveInventory')),
    ).toBe(false)
  })
})
