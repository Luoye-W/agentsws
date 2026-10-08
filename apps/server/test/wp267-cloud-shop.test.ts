/**
 * WP267：Shopify 收尾小单（服务端，云端那一路）。
 *
 * - （208）一点补签：`cloud-account.upgradeScopes` 打 `POST /v1/cloud/links/current/upgrade`，令牌不变、本机记的动作集跟着改；
 *   云上没这一条 / 令牌不认 → `upgrade_unavailable`（界面退回重新登录）；连接卡的 `upgrade` 只认补完有 `store`。
 * - 错误分两头：我们的令牌缺 `store`（403 `details.required_scope`）≠ Shopify 那头的 403 / 缺权限；按 WP266 回包形状解析。
 * - （209）客服回信 / 订单查询：云端连着店 → 订单、物流、退换、商品走云端代发（不碰连接器）；没连回退连接器。
 *
 * 全是替身：假 fetch / 假云调用，一个字节不出这台机器、不碰真店。
 */
import { ApiError } from '@agentsws/api'
import type { ActionMeta, Clock, RunRequest, WorkspaceId } from '@agentsws/contracts'
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID, type CloudFetch, createCloudAccount } from '../src/cloud-account.js'
import type { ConnectLike } from '../src/connections.js'
import type { KolCloudCall } from '../src/kol-cloud-sync.js'
import { createConnectRecordSource } from '../src/records.js'
import { createSecretStore } from '../src/secret-store.js'
import type { ShopAdminError } from '../src/shop-admin.js'
import {
  CLOUD_SHOP_TEXT,
  cloudShopDataOf,
  cloudShopErrorOf,
  cloudShopReader,
  createCloudShopifyAdmin,
} from '../src/shop-cloud-admin.js'
import { createShopifyConnect } from '../src/shopify-connect.js'

const clock: Clock = { now: () => '2026-10-08T09:00:00.000Z' }
const KEY = { AGENTSWS_SECRETS_KEY: 'e'.repeat(64) }
const ROLLOUT = 'ws_rollout' as WorkspaceId
const INMO = 'ws_inmo' as WorkspaceId

async function reasonOf(p: Promise<unknown>): Promise<{ code: string; reason?: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    const e = err as ApiError
    return { code: e.code, reason: (e.details as { reason?: string } | undefined)?.reason }
  }
  throw new Error('应该失败却成功了')
}

// ── （208）一点补签 ─────────────────────────────────────────────────────

function accountWith(reply: (token: string) => { status: number; body?: unknown } | 'offline') {
  const vaults = new Map<string, ReturnType<typeof createSecretStore>>()
  const vaultOf = (ws: WorkspaceId) => {
    let v = vaults.get(ws)
    if (v === undefined) {
      v = createSecretStore({ dbPath: ':memory:', clock, env: KEY })
      vaults.set(ws, v)
    }
    return v
  }
  const seen: { url: string; method: string | undefined; auth: string | undefined }[] = []
  const fetch: CloudFetch = async (url, init) => {
    const auth = init?.headers?.Authorization
    seen.push({ url, method: init?.method, auth })
    const out = reply((auth ?? '').replace(/^Bearer /, ''))
    if (out === 'offline') throw new Error('ECONNREFUSED')
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      text: async () => (out.body === undefined ? '' : JSON.stringify(out.body)),
    }
  }
  const account = createCloudAccount({
    secrets: vaultOf(ROLLOUT),
    clock,
    env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.example.invalid' },
    fetch,
    appendEvent: () => {},
    workspace_id: () => ROLLOUT,
    brands: () => [ROLLOUT, INMO],
    secretsFor: vaultOf,
    localBaseUrl: () => undefined,
  })
  const seed = (ws: WorkspaceId, token: string, scopes: string): void => {
    vaultOf(ws).put(CLOUD_TOKEN_SECRET_ID, {
      token,
      email: 'owner@example.com',
      org_id: 'org_1',
      org_name: 'Org',
      expires_at: '2027-01-01T00:00:00.000Z',
      scopes,
      linked_at: clock.now(),
    })
  }
  return { account, vaultOf, seed, seen }
}

describe('WP267 一点补签（cloud-account.upgradeScopes）', () => {
  it('老令牌缺 store：打补签那一条（带这把令牌）→ 本机记的动作集跟着改、令牌不变；别的品牌顺手补', async () => {
    const full = [...DEFAULT_CLOUD_SCOPES]
    const t = accountWith(() => ({
      status: 200,
      body: { data: { link: { id: 'lnk_1' }, scopes: full, added: ['store'] } },
    }))
    t.seed(ROLLOUT, 'wst_old_rollout', 'ai,wallet:read')
    t.seed(INMO, 'wst_old_inmo', 'ai,wallet:read')
    expect((await t.account.port.status(ROLLOUT)).missing_scopes).toContain('store')
    const out = await t.account.upgradeScopes(ROLLOUT)
    expect(out).toEqual({ scopes: full, added: ['store'] })
    expect(t.seen[0]).toMatchObject({
      url: 'https://cloud.example.invalid/v1/cloud/links/current/upgrade',
      method: 'POST',
      auth: 'Bearer wst_old_rollout',
    })
    // INMO 那一把也补了（本机记的也缺）
    expect(t.seen.map((x) => x.auth)).toEqual(['Bearer wst_old_rollout', 'Bearer wst_old_inmo'])
    const after = t.vaultOf(ROLLOUT).get(CLOUD_TOKEN_SECRET_ID)
    expect(after?.token).toBe('wst_old_rollout')
    expect(after?.scopes).toBe(full.join(','))
    expect((await t.account.port.status(ROLLOUT)).missing_scopes).toBeUndefined()
  })

  it('云上没这一条（404）/ 令牌不认（401）→ upgrade_unavailable；断网 → offline；没令牌 → not_linked', async () => {
    for (const status of [404, 405, 401, 501]) {
      const t = accountWith(() => ({ status, body: { code: 'x', message: 'no' } }))
      t.seed(ROLLOUT, 'wst_old', 'ai,wallet:read')
      expect(await reasonOf(t.account.upgradeScopes(ROLLOUT))).toMatchObject({
        reason: 'upgrade_unavailable',
      })
      // 没成就不改本机记的
      expect(t.vaultOf(ROLLOUT).get(CLOUD_TOKEN_SECRET_ID)?.scopes).toBe('ai,wallet:read')
    }
    const off = accountWith(() => 'offline')
    off.seed(ROLLOUT, 'wst_old', 'ai,wallet:read')
    expect(await reasonOf(off.account.upgradeScopes(ROLLOUT))).toMatchObject({ reason: 'offline' })
    const none = accountWith(() => ({ status: 200 }))
    expect(await reasonOf(none.account.upgradeScopes(ROLLOUT))).toMatchObject({
      reason: 'not_linked',
    })
    expect(none.seen).toEqual([])
  })
})

describe('WP267 连接卡的 upgrade', () => {
  const portWith = (
    upgrade?: (ws: WorkspaceId) => Promise<{ scopes: string[]; added: string[] }>,
  ) =>
    createShopifyConnect({
      clock,
      cloudOf: async () => ({
        call: async <T>(): Promise<KolCloudCall<T>> => ({ ok: true, status: 200 }),
        linked: () => true,
      }),
      shopHints: () => [],
      startupBrand: ROLLOUT,
      ...(upgrade === undefined ? {} : { upgrade }),
    })
  const actor = { workspace_id: ROLLOUT, person_id: 'p_owner' }

  it('补完有 store = 成；补完仍没有（云上默认集还没加）/ 没装配 = upgrade_unavailable', async () => {
    const ok = portWith(async () => ({ scopes: ['ai', 'wallet:read', 'store'], added: ['store'] }))
    expect(await ok.upgrade?.(actor)).toEqual({
      upgraded: true,
      added: ['store'],
      scopes: ['ai', 'wallet:read', 'store'],
    })
    const already = portWith(async () => ({ scopes: ['ai', 'store'], added: [] }))
    expect(await already.upgrade?.(actor)).toMatchObject({ upgraded: false, added: [] })
    const still = portWith(async () => ({ scopes: ['ai', 'wallet:read'], added: [] }))
    expect(await reasonOf(Promise.resolve(still.upgrade?.(actor)))).toMatchObject({
      reason: 'upgrade_unavailable',
    })
    expect(await reasonOf(Promise.resolve(portWith().upgrade?.(actor)))).toMatchObject({
      reason: 'upgrade_unavailable',
    })
  })
})

// ── 错误分两头（WP266 回包形状）──────────────────────────────────────────

const fail = (
  status: number,
  code?: string,
  details?: Record<string, unknown>,
  message?: string,
): KolCloudCall<unknown> => ({
  ok: false,
  status,
  ...(code === undefined ? {} : { code }),
  ...(message === undefined ? {} : { message }),
  ...(details === undefined ? {} : { details }),
})

describe('WP267 cloudShopErrorOf：我们这头 vs Shopify 那头', () => {
  it('我们的令牌缺 store（403 required_scope）→ 去连接页「更新授权」，不是「重新授权」', () => {
    const e = cloudShopErrorOf(fail(403, 'forbidden', { required_scope: 'store' }))
    expect(e.code).toBe('not_authorized')
    expect(e.message).toBe(CLOUD_SHOP_TEXT.scope_store)
    expect(cloudShopErrorOf(fail(401, 'unauthenticated')).message).toBe(CLOUD_SHOP_TEXT.token)
  })

  it('Shopify 那头的 403 / ACCESS_DENIED / Required access：缺权限，点名缺哪项', () => {
    const e = cloudShopErrorOf(
      fail(403, 'shopify_error', {
        shop: 'x.myshopify.com',
        shopify_status: 403,
        errors: [{ message: 'Access denied. Required access: `read_orders` access scope.' }],
      }),
    )
    expect(e.code).toBe('missing_scope')
    expect(e.opts.missing).toEqual(['read_orders'])
    expect(e.message).toContain('重新授权')
    expect(e.message).not.toBe(CLOUD_SHOP_TEXT.scope_store)
    // 没点名的 Shopify 403：照样是店铺授权的权限问题，不叫人重新登录
    const bare = cloudShopErrorOf(fail(403, 'shopify_error', { shopify_status: 403 }))
    expect(bare.code).toBe('missing_scope')
    expect(bare.message).not.toContain('登录')
  })

  it('Shopify 429 / 402 / 423 / 5xx / 401；店铺令牌失效 409 reauth_required；断网', () => {
    expect(cloudShopErrorOf(fail(429, 'rate_limited', { shopify_status: 429 })).message).toBe(
      CLOUD_SHOP_TEXT.rate_limited,
    )
    expect(cloudShopErrorOf(fail(402, 'shopify_error', { shopify_status: 402 })).code).toBe(
      'store_unavailable',
    )
    expect(cloudShopErrorOf(fail(423, 'shopify_error', { shopify_status: 423 })).code).toBe(
      'store_unavailable',
    )
    expect(cloudShopErrorOf(fail(502, 'shopify_error', { shopify_status: 503 })).message).toBe(
      CLOUD_SHOP_TEXT.shopify_down,
    )
    expect(cloudShopErrorOf(fail(401, 'shopify_error', { shopify_status: 401 })).code).toBe(
      'revoked',
    )
    const gone = cloudShopErrorOf(fail(409, 'conflict', { shop: 'x', reason: 'reauth_required' }))
    expect(gone.code).toBe('revoked')
    expect(gone.message).toBe(CLOUD_SHOP_TEXT.revoked)
    expect(cloudShopErrorOf({ ok: false, status: 0 }).code).toBe('network')
    expect(cloudShopErrorOf(fail(404, 'not_found')).message).toBe(CLOUD_SHOP_TEXT.not_connected)
  })

  it('成功回包：取 data；errors 里缺权限认出来、别的照 Shopify 原话；data: null 不当结果；老云没套层照用', () => {
    expect(cloudShopDataOf({ data: { shop: { name: 'R' } } })).toEqual({ shop: { name: 'R' } })
    const denied = (() => {
      try {
        cloudShopDataOf({
          data: null,
          errors: [
            {
              message: 'Access denied for orders field. Required access: `read_orders`.',
              extensions: { code: 'ACCESS_DENIED' },
            },
          ],
        })
      } catch (e) {
        return e as ShopAdminError
      }
      return undefined
    })()
    expect(denied?.code).toBe('missing_scope')
    expect(denied?.opts.missing).toEqual(['read_orders'])
    expect(() => cloudShopDataOf({ data: null })).toThrow(/没回数据/)
    expect(() => cloudShopDataOf({ errors: [{ message: "Field 'x' doesn't exist" }] })).toThrow(
      /Field 'x' doesn't exist/,
    )
    // 老云（不套层）：直接就是 Shopify 的 data
    expect(cloudShopDataOf({ shop: { name: 'R' } })).toEqual({ shop: { name: 'R' } })
  })

  it('经 createCloudShopifyAdmin 端到端：成功套一层 data、失败信封都翻对', async () => {
    const replies: KolCloudCall<unknown>[] = [
      { ok: true, status: 200, data: { data: { shop: { name: 'Rollout' } } } },
      fail(403, 'forbidden', { required_scope: 'store' }),
    ]
    const problems: string[] = []
    const admin = createCloudShopifyAdmin({
      store: '6suegp-md.myshopify.com',
      call: async <T>() => replies.shift() as KolCloudCall<T>,
      onAuthProblem: (e) => problems.push(e.code),
    })
    expect(await admin.query({ name: 't', document: '{ shop { name } }' })).toEqual({
      shop: { name: 'Rollout' },
    })
    await expect(admin.query({ name: 't', document: '{ shop { name } }' })).rejects.toThrow(
      CLOUD_SHOP_TEXT.scope_store,
    )
    expect(problems).toEqual(['not_authorized'])
  })
})

// ── （209）客服回信 / 订单查询走云端 ─────────────────────────────────────

const GQL_ORDER = {
  id: 'gid://shopify/Order/5550001',
  name: '#1001',
  createdAt: '2026-10-01T02:00:00Z',
  currencyCode: 'USD',
  email: 'wp267-buyer@example.com',
  displayFinancialStatus: 'PARTIALLY_REFUNDED',
  displayFulfillmentStatus: 'FULFILLED',
  returnStatus: 'RETURN_REQUESTED',
  totalPriceSet: { shopMoney: { amount: '129.00', currencyCode: 'USD' } },
  totalRefundedSet: { shopMoney: { amount: '20.00', currencyCode: 'USD' } },
  customer: { displayName: 'Anna Lee', email: 'wp267-buyer@example.com' },
  shippingAddress: {
    name: 'Anna Lee',
    address1: '1 St',
    city: 'Portland',
    zip: '97205',
    country: 'US',
  },
  lineItems: {
    nodes: [
      {
        id: 'gid://shopify/LineItem/1',
        title: '3C Charger',
        sku: 'CH-1',
        quantity: 2,
        product: { id: 'gid://shopify/Product/9' },
        originalTotalSet: { shopMoney: { amount: '129.00', currencyCode: 'USD' } },
      },
    ],
  },
  fulfillments: [
    {
      status: 'SUCCESS',
      displayStatus: 'DELIVERED',
      createdAt: '2026-10-02T00:00:00Z',
      deliveredAt: '2026-10-05T00:00:00Z',
      trackingInfo: [{ company: 'UPS', number: '1Z999', url: 'https://ups.example/1Z999' }],
    },
  ],
  refunds: [
    { createdAt: '2026-10-06T00:00:00Z', totalRefundedSet: { shopMoney: { amount: '20.00' } } },
  ],
}
/** 应用没过「受保护的顾客数据」那一关时 Shopify 只给这几格。 */
const { email: _e, customer: _c, shippingAddress: _s, ...GQL_ORDER_LITE } = GQL_ORDER

function cloudRecords(
  opts: { cloud?: boolean; protectedDenied?: boolean; connector?: boolean } = {},
) {
  const sent: { query: string; variables?: unknown }[] = []
  const executed: string[] = []
  const call = async <T>(_path: string, init?: { body?: unknown }): Promise<KolCloudCall<T>> => {
    const body = init?.body as { query: string; variables?: Record<string, unknown> }
    sent.push({ query: body.query, variables: body.variables })
    const withCustomer = /customer \{/.test(body.query)
    if (withCustomer && opts.protectedDenied === true)
      return {
        ok: true,
        status: 200,
        data: {
          data: null,
          errors: [{ message: 'This app is not approved to access the Customer object.' }],
        },
      } as KolCloudCall<T>
    const order = withCustomer ? GQL_ORDER : GQL_ORDER_LITE
    const data = /AgentswsSupportOrders/.test(body.query)
      ? { orders: { nodes: [order] } }
      : /AgentswsSupportOrder\b/.test(body.query)
        ? { order }
        : /AgentswsSupportProducts/.test(body.query)
          ? {
              products: {
                nodes: [
                  {
                    id: 'gid://shopify/Product/9',
                    title: '3C Charger',
                    variants: { nodes: [{ id: 'v1', sku: 'CH-1', price: '64.50' }] },
                  },
                ],
              },
            }
          : {
              product: {
                id: 'gid://shopify/Product/9',
                title: '3C Charger',
                status: 'ACTIVE',
                variants: { nodes: [] },
              },
            }
    return { ok: true, status: 200, data: { data } } as KolCloudCall<T>
  }
  const notUsed = (): never => {
    throw new Error('connector not used')
  }
  const connect = {
    providers: notUsed,
    connections: notUsed,
    beginConnect: notUsed,
    pollConnect: notUsed,
    submitForm: notUsed,
    removeConnection: notUsed,
    actions: async (service: string): Promise<ActionMeta[]> =>
      ['shopify_admin.get_order', 'shopify_admin.list_orders'].map((id) => ({
        id,
        service,
        input_schema: {},
        side_effect: 'read' as const,
      })),
    issueToken: async (input: { kind: string; assignment_id: string }) => ({
      token: 'tok',
      kind: input.kind,
      assignment_id: input.assignment_id,
      expires_at: clock.now(),
      allowed_actions: [],
      allowed_connections: [],
      allowed_proxies: [],
    }),
    revokeTokens: async () => {},
    execute: async (action_id: string) => {
      executed.push(action_id)
      return { data: { orders: [] } }
    },
  } as unknown as ConnectLike
  const source = createConnectRecordSource({
    connect,
    connections: {
      liveConnections: () =>
        opts.connector === true
          ? [{ id: 'cxn_shop', service: 'shopify_admin', status: 'active' as const }]
          : [],
    },
    clock,
    workspace_id: ROLLOUT,
    cloudShop: () =>
      cloudShopReader(
        {
          link: async () =>
            opts.cloud === false
              ? undefined
              : { shop: '6suegp-md.myshopify.com', scopes: ['read_orders', 'read_products'] },
          call: async () => call,
        },
        ['read_orders'],
      ),
  })
  const run = (name: string, input: Record<string, unknown>) => {
    const exec = source.executeTool
    if (exec === undefined) throw new Error('no executor')
    return exec({
      name,
      input,
      request: {
        actor: { person_id: 'p', assignment_id: 'asg', role_id: 'dtc.support' },
        tools: { allow: [name], connect_token: '', side_effect_policy: 'executor' },
      } as unknown as RunRequest,
    })
  }
  return { source, run, sent, executed }
}

describe('WP267 订单 / 客服那一路：云端连着店就走云端代发', () => {
  it('「#1001」先按订单号查成那一张：物流单号、送达、退换、退款、顾客都带上；没碰连接器', async () => {
    const t = cloudRecords({ connector: true })
    const out = await t.run('get_order', { order_id: '#1001' })
    expect(out.status).toBe('ok')
    expect(out.data).toMatchObject({
      id: 'gid://shopify/Order/5550001',
      name: '#1001',
      total_price: 129,
      refunded_amount: 20,
      financial_status: 'partially_refunded',
      fulfillment_status: 'fulfilled',
      return_status: 'return_requested',
      delivered_at: '2026-10-05T00:00:00Z',
      email: 'wp267-buyer@example.com',
      customer_name: 'Anna Lee',
      shipments: [
        {
          status: 'delivered',
          company: 'UPS',
          number: '1Z999',
          url: 'https://ups.example/1Z999',
          delivered_at: '2026-10-05T00:00:00Z',
        },
      ],
    })
    expect(t.sent[0]?.variables).toEqual({ first: 5, query: 'name:#1001' })
    // 只读：查询里没有 mutation
    expect(t.sent.every((s) => !/^\s*mutation/.test(s.query))).toBe(true)
    expect(t.executed).toEqual([])
    // record() 也走云端（订单 ref 的 id 是 gid）
    const rec = await t.source.record({ type: 'order', id: 'gid://shopify/Order/5550001' })
    expect(rec).toMatchObject({ name: '#1001' })
  })

  it('应用没过受保护顾客数据 → 退一步不带顾客那几格再查；订单状态与物流照样有', async () => {
    const t = cloudRecords({ protectedDenied: true })
    const out = await t.run('get_order', { order_id: 'gid://shopify/Order/5550001' })
    expect(out.status).toBe('ok')
    expect(out.data).toMatchObject({ name: '#1001', shipments: [{ number: '1Z999' }] })
    expect((out.data as { email?: string }).email).toBeUndefined()
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]?.query).not.toMatch(/customer \{|shippingAddress|\bemail\b/)
  })

  it('list_orders / get_product / list_products 也走云端；数字 id 补成 gid', async () => {
    const t = cloudRecords()
    const listed = await t.run('list_orders', { first: 3, query: 'status:open' })
    expect(listed.status).toBe('ok')
    expect((listed.data as { orders: unknown[] }).orders).toHaveLength(1)
    expect(t.sent[0]?.variables).toEqual({ first: 3, query: 'status:open' })
    const product = await t.run('get_product', { product_id: '9' })
    expect(product.data).toMatchObject({ id: 'gid://shopify/Product/9', title: '3C Charger' })
    expect(t.sent[1]?.variables).toEqual({ id: 'gid://shopify/Product/9' })
    const found = await t.run('list_products', { query: 'charger' })
    expect(found.data).toMatchObject({ products: [{ title: '3C Charger' }] })
  })

  it('云端没连（或没授 read_orders）→ 回退连接器那条 Shopify 连接；两样都没有 → not_connected', async () => {
    const t = cloudRecords({ cloud: false, connector: true })
    await t.run('list_orders', {})
    expect(t.sent).toEqual([])
    expect(t.executed).toEqual(['shopify_admin.list_orders'])
    const none = cloudRecords({ cloud: false })
    const out = await none.run('get_order', { order_id: '#1001' })
    expect(out.status).toBe('error')
    expect(out.reason).toMatch(/^not_connected/)
    // 只授了商品、没授订单：不走云端
    const reader = await cloudShopReader(
      {
        link: async () => ({ shop: 'x.myshopify.com', scopes: ['read_products'] }),
        call:
          async () =>
          async <T>() =>
            ({ ok: true, status: 200 }) as KolCloudCall<T>,
      },
      ['read_orders'],
    )
    expect(reader).toBeUndefined()
  })
})
