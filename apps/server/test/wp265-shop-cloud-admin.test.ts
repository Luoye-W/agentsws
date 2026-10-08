/**
 * WP265（Fable 追加，接 WP261）：`ShopifyAdmin` 的云端代发实现 + 「云端已连优先、没有才回退 CLI」。
 *
 * 1. 单元：`createCloudShopifyAdmin` 经本地 http 假云代发——查询不带 `allow_mutations`、改动带；
 *    查询那一半拿到 mutation 本机先拒；缺权限 / 失效 / 断网翻成 WP261 同一套码；
 *    `preferCloudShopAdmin`：有云端连接就按云端（能做什么、岗位页那一行、查询 / 改动），没有就是 CLI 那一份。
 * 2. 端到端（真装配线 + demo 云替身 + WP261 的假店）：**这台机器没装 Shopify CLI**，连接页一键授权连上之后——
 *    岗位页那一行是「已授权」、工具面里有运营工具、改商品只出卡、人批了经云端改店并读回；
 *    连接目录（岗位「还缺必需的连接：店铺后台」同一算法）里店铺后台算已连。
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ShopAdminView } from '@agentsws/api'
import type { Assignment, Clock, RunEvent } from '@agentsws/contracts'
import { PLATFORM_KITS, storeAdminScopesFor } from '@agentsws/contracts'
import { SHOP_TOOL_NAMES } from '@agentsws/stand-ins'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCloud } from '../src/cloud.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { CLOUD_STAND_IN_PASSWORD, CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { createSecretStore, SECRETS_KEY_ENV } from '../src/secret-store.js'
import { ShopAdminError } from '../src/shop-admin.js'
import { demoShop, type FakeShop, resolveFakeShop } from '../src/shop-admin-stand-in.js'
import type { ShopAdminAssembly } from '../src/shop-auth.js'
import { createCloudShopifyAdmin, preferCloudShopAdmin } from '../src/shop-cloud-admin.js'
import {
  SHOPIFY_STAND_IN_SCOPES,
  type ShopifyCloudStandIn,
  shopifyCloudStandIn,
} from '../src/shopify-cloud-stand-in.js'

const SHOP = 'rollout-test.myshopify.com'
const kitSpec = () => PLATFORM_KITS.find((k) => k.platform === 'shopify')?.cli?.store_admin
const clock: Clock = { now: () => new Date().toISOString() }

/** 假店的 GraphQL：与 WP261 的 CLI 替身同一份解析（操作名 → 假店里的数据）。 */
function shopGraphql(shop: FakeShop) {
  return ({ query, variables }: { query: string; variables?: unknown }) => {
    const m = /^\s*(query|mutation)\s+(\w+)/.exec(query.replace(/#[^\n]*/g, ''))
    if (m === null) return undefined
    const data = resolveFakeShop(shop, m[2] ?? '', (variables ?? {}) as Record<string, unknown>)
    return data === undefined ? { errors: [{ message: 'unknown field' }] } : { data }
  }
}

describe('WP265 云端代发的 ShopifyAdmin（本地 http 假云）', () => {
  let http: HttpServer
  let base: string
  let fake: ShopifyCloudStandIn
  let fakeShop: FakeShop
  let deny: string | undefined

  beforeAll(async () => {
    http = createHttp((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8')
      })
      req.on('end', () => {
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.headers.authorization !== 'Bearer wst_fake_cloud_admin')
          return send(401, { code: 'unauthenticated', message: '令牌无效' })
        const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
        const path = new URL(req.url ?? '/', 'http://x').pathname
        if (deny !== undefined && path === '/v1/shopify/graphql')
          return send(200, {
            data: {
              errors: [
                {
                  message: `Access denied for products field. Required access: \`${deny}\` access scope.`,
                  extensions: { code: 'ACCESS_DENIED' },
                },
              ],
            },
          })
        const out = fake.handle(req.method ?? 'GET', path, body)
        if (out === undefined) return send(404, { code: 'not_found', message: '没有这条路' })
        send(out.status, out.body)
      })
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()))
  })
  beforeEach(() => {
    deny = undefined
    fakeShop = demoShop()
    fake = shopifyCloudStandIn({ autoConnectAfterMs: -1, graphql: shopGraphql(fakeShop) })
    const a = fake.handle('POST', '/v1/shopify/oauth/start', { shop: SHOP }) as {
      body: { data: { attempt_id: string } }
    }
    fake.settle(a.body.data.attempt_id, 'connected')
  })

  const callOf = (url = base) => {
    const secrets = createSecretStore({
      dbPath: ':memory:',
      clock,
      env: { AGENTSWS_SECRETS_KEY: 'f'.repeat(64) },
    })
    secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fake_cloud_admin' })
    return createCloud({ clock, secrets, env: { AGENTSWS_CLOUD_BASE_URL: url } }).call
  }

  it('查询不带 allow_mutations、改动带；回的是 data 那一层', async () => {
    const admin = createCloudShopifyAdmin({ store: SHOP, call: callOf() })
    expect(admin.via).toBe('cloud_app')
    const listed = await admin.query<{ products?: unknown }>({
      name: 'AgentswsProducts',
      document:
        'query AgentswsProducts($first: Int!) { products(first: $first) { nodes { id title } } }',
      variables: { first: 5 },
    })
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty('data')
    await expect(
      admin.query({
        name: 'x',
        document: 'mutation ProductUpdate { productUpdate { userErrors { message } } }',
      }),
    ).rejects.toMatchObject({ code: 'mutation_refused' })
    // 本机先拒：云上一条都没收到这条 mutation
    expect(fake.graphqlCalls().every((c) => !c.query.includes('mutation'))).toBe(true)
    await admin
      .mutate({
        name: 'x',
        document: 'mutation ProductUpdate { productUpdate { userErrors { message } } }',
      })
      .catch(() => undefined)
    const calls = fake.graphqlCalls()
    expect(calls[0]).toMatchObject({ shop: SHOP, allow_mutations: false })
    expect(calls.at(-1)).toMatchObject({ allow_mutations: true })
  })

  it('缺权限 → missing_scope（带缺哪项）并告诉上层；失效 → revoked；断网 → network', async () => {
    const problems: string[] = []
    const admin = createCloudShopifyAdmin({
      store: SHOP,
      call: callOf(),
      onAuthProblem: (e) => problems.push(e.code),
    })
    deny = 'read_products'
    const err = await admin
      .query({ name: 'q', document: 'query Q { shop { name } }' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ShopAdminError)
    expect(err.code).toBe('missing_scope')
    expect(err.opts.missing).toEqual(['read_products'])
    deny = undefined
    fake.reauth(SHOP, { reason: 'app_uninstalled' })
    expect(
      (await admin.query({ name: 'q', document: 'query Q { shop { name } }' }).catch((e) => e))
        .code,
    ).toBe('revoked')
    expect(problems).toEqual(['missing_scope', 'revoked'])
    const offline = createCloudShopifyAdmin({ store: SHOP, call: callOf('http://127.0.0.1:9') })
    expect(
      (await offline.query({ name: 'q', document: 'query Q { shop { name } }' }).catch((e) => e))
        .code,
    ).toBe('network')
  })

  it('preferCloudShopAdmin：有云端连接按云端，没有就是 CLI 那一份', async () => {
    const cliView: ShopAdminView = {
      applicable: true,
      state: 'no_cli',
      scopes_needed: ['write_products', 'read_orders'],
      scopes_granted: [],
      missing: [],
    }
    const cliUsed: string[] = []
    const cli: ShopAdminAssembly = {
      view: async () => cliView,
      run: async () => cliView,
      cancel: async () => cliView,
      setStore: async () => cliView,
      access: async () => {
        cliUsed.push('access')
        return undefined
      },
      reader: async () => {
        cliUsed.push('reader')
        throw new ShopAdminError('cli_missing', 'x')
      },
      admin: async () => {
        cliUsed.push('admin')
        throw new ShopAdminError('cli_missing', 'x')
      },
    }
    let link: { shop: string; scopes: string[] } | undefined = {
      shop: SHOP,
      scopes: ['write_products', 'read_orders'],
    }
    const call = callOf()
    const auth = preferCloudShopAdmin(cli, { link: async () => link, call: async () => call })
    expect(await auth.view(['dtc.store'])).toMatchObject({
      state: 'authorized',
      store: SHOP,
      missing: [],
    })
    expect((await auth.access())?.scopes).toEqual([
      'read_orders',
      'read_products',
      'write_products',
    ])
    expect((await auth.reader()).via).toBe('cloud_app')
    expect((await auth.admin()).via).toBe('cloud_app')
    expect(cliUsed).toEqual([])
    // 云端少一项 → 岗位页那一行是「缺权限」
    link = { shop: SHOP, scopes: ['write_products'] }
    expect(await auth.view(['dtc.store'])).toMatchObject({
      state: 'missing_scopes',
      missing: ['read_orders'],
    })
    // 应用 B 现在那一套权限（docs/92）对店铺管理少 write_publications：照实说缺
    link = { shop: SHOP, scopes: [...SHOPIFY_STAND_IN_SCOPES] }
    const gap = preferCloudShopAdmin(
      {
        ...cli,
        view: async () => ({
          ...cliView,
          scopes_needed: storeAdminScopesFor(kitSpec(), ['dtc.store']),
        }),
      },
      { link: async () => link, call: async () => call },
    )
    expect((await gap.view(['dtc.store'])).missing).toEqual(['write_publications'])
    // 没有云端连接 → 原样是 CLI 那一份
    link = undefined
    expect((await auth.view(['dtc.store'])).state).toBe('no_cli')
    expect(await auth.access()).toBeUndefined()
    await expect(auth.reader()).rejects.toMatchObject({ code: 'cli_missing' })
    expect(cliUsed).toEqual(['access', 'reader'])
  })
})

describe('WP265 端到端：没装 CLI，连接页一键授权之后运营工具走云端', () => {
  let server: Server
  let store: Assignment
  let shop: FakeShop
  let cloud: CloudStandIn
  let now = '2026-10-08T09:00:00.000Z'

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
  const toolsCalled = (run_id: string): string[] =>
    server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.correlation?.run_id === run_id && e.type === 'tool.call')
      .map((e) => (e.payload as Extract<RunEvent, { type: 'tool.call' }>).tool)

  beforeEach(async () => {
    now = '2026-10-08T09:00:00.000Z'
    shop = demoShop()
    cloud = cloudStandIn({
      autoLinkAfterMs: -1,
      shopify: {
        autoConnectAfterMs: -1,
        graphql: shopGraphql(shop),
        // 店铺管理要的 `write_publications` 不在应用 B 现在那一套里（docs/92）——这里按补上之后测
        scopes: [...SHOPIFY_STAND_IN_SCOPES, 'read_publications', 'write_publications'],
      },
    })
    // 这台机器上没有 Shopify CLI
    const exec: ProbeExec = async (bin) =>
      bin === 'node' ? { ok: true, stdout: 'v22.12.0' } : { ok: false, stdout: '', missing: true }
    server = await createServer({
      quiet: true,
      clock: { now: () => now },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
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
      { legal_name: 'Rollout', storefront_platform: 'shopify' },
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

  it('一键授权 → 已授权、有工具 → 改商品只出卡 → 批了经云端改店、读回', async () => {
    const owner = server.bootstrap.ownerAssignment.id
    // 连之前：CLI 没装，那一行是 no_cli；工具面里没有运营工具
    expect(((await call('GET', '/v1/shop-admin?roles=dtc.store')) as ShopAdminView).state).toBe(
      'no_cli',
    )
    const started = (await call('POST', '/v1/shopify-connect/start', { shop: SHOP }, owner)) as {
      attempt_id: string
    }
    cloud.shopify.settle(started.attempt_id, 'connected')
    expect(
      (
        (await call(
          'GET',
          `/v1/shopify-connect/attempts/${started.attempt_id}`,
          undefined,
          owner,
        )) as {
          status: string
        }
      ).status,
    ).toBe('connected')

    const v = (await call('GET', '/v1/shop-admin?roles=dtc.store')) as ShopAdminView
    expect(v).toMatchObject({ state: 'authorized', store: SHOP, missing: [] })

    // 岗位「还缺必需的连接：店铺后台」同一算法：店铺后台算已连
    const dir = (await call('GET', '/v1/connection-directory', undefined, owner)) as {
      entries: { kind: string; state: string }[]
    }
    expect(dir.entries.find((e) => e.kind === 'shop')?.state).toBe('connected')

    const out = (await call('POST', `/v1/positions/${store.id}/matters`, {
      title: '把第一个商品的标题改一下',
      role_id: 'dtc.store',
    })) as { run_id?: string }
    const used = toolsCalled(out.run_id ?? '')
    expect(used.filter((t) => SHOP_TOOL_NAMES.includes(t))).toEqual([
      'shop_list_products',
      'shop_get_product',
      'shop_save_product',
    ])
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱')
    // 到此为止云上只收到查询
    expect(cloud.shopify.graphqlCalls().every((c) => !c.allow_mutations)).toBe(true)

    const pending = (
      await server.txn.approvals.queue({
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((a) => (a.payload as { kind?: string } | undefined)?.kind === 'listing_edit')
    expect(pending).toHaveLength(1)
    const card = pending[0]
    await server.txn.approvals.decide(card?.id ?? '', card?.deliveries[0]?.to as never, {
      action: 'approve',
      decision_token: card?.deliveries[0]?.decision_token ?? '',
      via: 'workstation',
    })
    now = '2026-10-08T10:00:00.000Z'
    await server.txn.executor.applyApproval(card?.id ?? '')
    expect(shop.products[0]?.title).toBe('Rollout 折叠收纳箱（新版）')
    expect(cloud.shopify.graphqlCalls().some((c) => c.allow_mutations)).toBe(true)
  })
})
