/**
 * WP265：连接页 Shopify 一键授权，本机这一头 ↔ **本地 http 假云**（127.0.0.1 上起的服务，
 * 五条接口照 WP263 的形状，由 `shopifyCloudStandIn` 演；一个字节不出这台机器、不碰真店）。
 *
 * 走的是真的云客户端（`createCloud`：令牌从这个品牌的加密库里取、真打 HTTP），覆盖：
 * start → pending → connected、失败 / 过期 / 取消、要重新授权 / 缺权限、未关联、501、
 * 老令牌缺 `store`、连不上、测试连接、断开，以及按品牌隔开（IVRA 与 Rovella 各连各的）。
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ShopifyConnectPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCloud } from '../src/cloud.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createSecretStore } from '../src/secret-store.js'
import { type ShopifyCloudStandIn, shopifyCloudStandIn } from '../src/shopify-cloud-stand-in.js'
import { createCloudShopLinks, createShopifyConnect } from '../src/shopify-connect.js'

const IVRA = 'ws_ivra' as WorkspaceId
const ROVELLA = 'ws_rovella' as WorkspaceId
const clock: Clock = { now: () => new Date().toISOString() }
const KEY = { AGENTSWS_SECRETS_KEY: 'd'.repeat(64) }

/** 假云认得的工作区令牌（测试合成的，不是真令牌）。 */
const TOKENS: Record<string, { workspace: string; scopes: string[] }> = {
  wst_fake_ivra_0001: { workspace: IVRA, scopes: ['ai', 'wallet:read', 'store'] },
  wst_fake_rovella_0001: { workspace: ROVELLA, scopes: ['ai', 'wallet:read', 'store'] },
  wst_fake_old_0001: { workspace: IVRA, scopes: ['ai', 'wallet:read'] },
}

let http: HttpServer
let base: string
let fake: ShopifyCloudStandIn
/** 假云这会儿查不查 `store`（WP263 上线那一版查没查不确定，两种都测）。 */
let checkScope = true
const seenBrands: (string | undefined)[] = []

beforeAll(async () => {
  http = createHttp((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const who = TOKENS[token]
      if (who === undefined) return send(401, { code: 'unauthenticated', message: '令牌无效' })
      if (checkScope && !who.scopes.includes('store'))
        return send(403, {
          code: 'forbidden',
          message: '这把令牌没有这个动作',
          details: { required_scope: 'store' },
        })
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === '/v1/shopify/oauth/start') seenBrands.push(body.brand as string | undefined)
      const out = fake.handle(req.method ?? 'GET', path, body, { workspace: who.workspace })
      if (out === undefined) return send(404, { code: 'not_found', message: '没有这条路' })
      send(out.status, out.body)
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

/** 一个品牌的云客户端：令牌放进它自己的加密库（没给就是没关联）。 */
function cloudWith(token: string | undefined, url = base) {
  const secrets = createSecretStore({ dbPath: ':memory:', clock, env: KEY })
  if (token !== undefined) secrets.put(CLOUD_TOKEN_SECRET_ID, { token, email: 'owner@example.com' })
  return createCloud({ clock, secrets, env: { AGENTSWS_CLOUD_BASE_URL: url } })
}

function portWith(
  tokens: Partial<Record<WorkspaceId, string | undefined>>,
  hints: Partial<Record<WorkspaceId, { shop: string; source: 'profile' | 'cli' }[]>> = {},
  url = base,
): ShopifyConnectPort {
  const clouds = new Map(Object.entries(tokens).map(([ws, t]) => [ws, cloudWith(t, url)]))
  return createShopifyConnect({
    clock,
    cloudOf: async (ws) => clouds.get(ws),
    emailOf: () => 'owner@example.com',
    shopHints: (ws) => hints[ws] ?? [],
    startupBrand: IVRA,
  })
}

const actor = (ws: WorkspaceId) => ({ workspace_id: ws, person_id: 'p_owner' })

async function reasonOf(p: Promise<unknown> | unknown): Promise<{ code: string; reason?: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    const e = err as ApiError
    return { code: e.code, reason: (e.details as { reason?: string } | undefined)?.reason }
  }
  throw new Error('应该失败却成功了')
}

beforeEach(() => {
  fake = shopifyCloudStandIn({
    autoConnectAfterMs: -1,
    unsupported: (shop) => shop.startsWith('ivra-'),
    shopName: (shop) => (shop.startsWith('6demox') ? 'Rovella' : shop),
  })
  checkScope = true
  seenBrands.length = 0
})

describe('WP265 一键授权：start → pending → connected', () => {
  it('店铺域名自动带（档案 > CLI），起授权带 brand，连上之后卡上有店、权限', async () => {
    const port = portWith(
      { [ROVELLA]: 'wst_fake_rovella_0001' },
      {
        [ROVELLA]: [
          { shop: '6demox-md.myshopify.com', source: 'profile' },
          { shop: 'https://admin.shopify.com/store/other-shop', source: 'cli' },
        ],
      },
    )
    const before = await port.view(actor(ROVELLA))
    expect(before.linked).toBe(true)
    expect(before.blocked).toBeUndefined()
    expect(before.connections).toEqual([])
    expect(before.suggested_shop).toBe('6demox-md.myshopify.com')
    // 后台地址栏那一串也认得
    expect(before.candidates.map((c) => c.shop)).toEqual([
      '6demox-md.myshopify.com',
      'other-shop.myshopify.com',
    ])

    const started = await port.start(actor(ROVELLA), {})
    expect(started.shop).toBe('6demox-md.myshopify.com')
    expect(started.authorize_url.startsWith('https://')).toBe(true)
    expect(seenBrands).toEqual([ROVELLA])

    expect((await port.attempt(actor(ROVELLA), started.attempt_id)).status).toBe('pending')
    fake.settle(started.attempt_id, 'connected')
    const done = await port.attempt(actor(ROVELLA), started.attempt_id)
    expect(done).toEqual({ status: 'connected', shop: '6demox-md.myshopify.com' })

    const after = await port.view(actor(ROVELLA))
    expect(after.connections).toHaveLength(1)
    expect(after.connections[0]?.shop).toBe('6demox-md.myshopify.com')
    expect(after.connections[0]?.status).toBe('connected')
    expect(after.connections[0]?.scopes).toContain('write_products')
    expect(after.connections[0]?.missing_scopes).toEqual([])
    // 连上的那家不再当「建议」
    expect(after.suggested_shop).toBe('other-shop.myshopify.com')
  })

  it('按品牌：Rovella 连的店 IVRA 看不到，IVRA 自己连自己的', async () => {
    const port = portWith({ [IVRA]: 'wst_fake_ivra_0001', [ROVELLA]: 'wst_fake_rovella_0001' })
    const r = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(r.attempt_id, 'connected')
    const i = await port.start(actor(IVRA), { shop: 'ivraglobal.myshopify.com' })
    fake.settle(i.attempt_id, 'connected')
    expect((await port.view(actor(ROVELLA))).connections.map((c) => c.shop)).toEqual([
      '6demox-md.myshopify.com',
    ])
    expect((await port.view(actor(IVRA))).connections.map((c) => c.shop)).toEqual([
      'ivraglobal.myshopify.com',
    ])
    expect(seenBrands).toEqual([ROVELLA, IVRA])
  })

  it('没有任何来源、也没填：照实要一格域名', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    expect((await port.view(actor(ROVELLA))).suggested_shop).toBeUndefined()
    expect(await reasonOf(port.start(actor(ROVELLA), {}))).toEqual({
      code: 'invalid_input',
      reason: 'need_shop',
    })
    expect(await reasonOf(port.start(actor(ROVELLA), { shop: 'not a shop!' }))).toEqual({
      code: 'invalid_input',
      reason: 'invalid_shop',
    })
  })
})

describe('WP265 授权没成：失败 / 过期 / 取消', () => {
  it('店主没点安装 → failed（带云上那句话）；过期 → expired；云上没这张单 → 当过期', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(a.attempt_id, 'failed')
    const failed = await port.attempt(actor(ROVELLA), a.attempt_id)
    expect(failed.status).toBe('failed')
    expect(failed.message).toContain('安装')
    const b = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(b.attempt_id, 'expired')
    expect((await port.attempt(actor(ROVELLA), b.attempt_id)).status).toBe('expired')
    expect((await port.attempt(actor(ROVELLA), 'sha_nope')).status).toBe('expired')
    expect((await port.view(actor(ROVELLA))).connections).toEqual([])
  })

  it('取消 = 卡上不再轮询：授权单留在 pending，什么都没连上', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    expect((await port.attempt(actor(ROVELLA), a.attempt_id)).status).toBe('pending')
    expect((await port.view(actor(ROVELLA))).connections).toEqual([])
    expect(fake.attempts()[0]?.status).toBe('pending')
  })
})

describe('WP265 要重新授权 / 缺权限', () => {
  it('云上标了 reauth_required、少了几项权限：卡上照实带出来', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(a.attempt_id, 'connected')
    fake.reauth('6demox-md.myshopify.com', { missing_scopes: ['read_orders'] })
    let row = (await port.view(actor(ROVELLA))).connections[0]
    expect(row?.status).toBe('connected')
    expect(row?.missing_scopes).toEqual(['read_orders'])
    fake.reauth('6demox-md.myshopify.com', { reason: 'app_uninstalled' })
    row = (await port.view(actor(ROVELLA))).connections[0]
    expect(row?.status).toBe('reauth_required')
    expect(row?.reauth_reason).toBe('app_uninstalled')
    // 失效的店测试不通（记成「没通」，不是整张卡出错）
    const tested = await port.test(actor(ROVELLA), '6demox-md.myshopify.com')
    expect(tested.ok).toBe(false)
    expect(tested.message).toContain('重新授权')
  })
})

describe('WP265 点不了的几种：未关联 / 501 / 老令牌缺 store / 连不上', () => {
  it('没关联 Agents 工坊账号：卡上一句话，起授权回 not_linked', async () => {
    const port = portWith({ [ROVELLA]: undefined })
    const view = await port.view(actor(ROVELLA))
    expect(view.linked).toBe(false)
    expect(view.blocked?.reason).toBe('not_linked')
    expect(view.blocked?.message).toContain('先登录 Agents 工坊账号')
    expect(await reasonOf(port.start(actor(ROVELLA), { shop: 'a.myshopify.com' }))).toEqual({
      code: 'forbidden',
      reason: 'not_linked',
    })
  })

  it('云上 501（这家店不在应用范围）：原话照搬 + unsupported', async () => {
    const port = portWith({ [IVRA]: 'wst_fake_ivra_0001' })
    let message = ''
    try {
      await port.start(actor(IVRA), { shop: 'ivra-global.myshopify.com' })
    } catch (err) {
      message = (err as ApiError).message
      expect((err as ApiError).code).toBe('not_implemented')
      expect(((err as ApiError).details as { reason: string }).reason).toBe('unsupported')
    }
    expect(message).toContain('暂不支持一键授权')
  })

  it('老令牌缺 store（云上查）：卡上 scope_missing，起授权也回它', async () => {
    const port = portWith({ [IVRA]: 'wst_fake_old_0001' })
    const view = await port.view(actor(IVRA))
    expect(view.linked).toBe(true)
    expect(view.blocked?.reason).toBe('scope_missing')
    expect(view.email).toBe('owner@example.com')
    expect(await reasonOf(port.start(actor(IVRA), { shop: 'a.myshopify.com' }))).toEqual({
      code: 'forbidden',
      reason: 'scope_missing',
    })
  })

  it('云上还没查 store：老令牌照样能连（不凭空拦）', async () => {
    checkScope = false
    const port = portWith({ [IVRA]: 'wst_fake_old_0001' })
    expect((await port.view(actor(IVRA))).blocked).toBeUndefined()
    const a = await port.start(actor(IVRA), { shop: 'ivraglobal.myshopify.com' })
    fake.settle(a.attempt_id, 'connected')
    expect((await port.view(actor(IVRA))).connections).toHaveLength(1)
  })

  it('连不上云：卡上 offline，起授权回 provider_unavailable', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' }, {}, 'http://127.0.0.1:9')
    expect((await port.view(actor(ROVELLA))).blocked?.reason).toBe('offline')
    expect(await reasonOf(port.start(actor(ROVELLA), { shop: 'a.myshopify.com' }))).toEqual({
      code: 'provider_unavailable',
      reason: 'offline',
    })
  })
})

describe('WP265 测试连接与断开', () => {
  it('测试连接 = 一次只读查询（店名 + 域名）；断开之后卡上没了，再断一次也不报错', async () => {
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(a.attempt_id, 'connected')
    const tested = await port.test(actor(ROVELLA), '6demox-md.myshopify.com')
    expect(tested).toMatchObject({
      ok: true,
      name: 'Rovella',
      domain: '6demox-md.myshopify.com',
    })
    // 测过之后卡上有店名
    expect((await port.view(actor(ROVELLA))).connections[0]?.name).toBe('Rovella')
    expect(await port.disconnect(actor(ROVELLA), '6demox-md.myshopify.com')).toEqual({
      disconnected: true,
    })
    expect((await port.view(actor(ROVELLA))).connections).toEqual([])
    expect(fake.connections()).toEqual([])
    expect(await port.disconnect(actor(ROVELLA), '6demox-md.myshopify.com')).toEqual({
      disconnected: true,
    })
  })

  it('断开只断这个品牌的：同一家店另一个品牌连着的那条还在', async () => {
    const port = portWith({ [IVRA]: 'wst_fake_ivra_0001', [ROVELLA]: 'wst_fake_rovella_0001' })
    for (const ws of [IVRA, ROVELLA]) {
      const a = await port.start(actor(ws), { shop: 'shared.myshopify.com' })
      fake.settle(a.attempt_id, 'connected')
    }
    await port.disconnect(actor(ROVELLA), 'shared.myshopify.com')
    expect((await port.view(actor(ROVELLA))).connections).toEqual([])
    expect((await port.view(actor(IVRA))).connections.map((c) => c.shop)).toEqual([
      'shared.myshopify.com',
    ])
  })
})

describe('WP265 云端连接缓存（运营工具 / 岗位就绪按它认）', () => {
  it('问一次云：本品牌连着的那家 + 去掉没授到的权限；别的品牌、要重新授权的不算', async () => {
    const clouds = new Map([
      [IVRA, cloudWith('wst_fake_ivra_0001')],
      [ROVELLA, cloudWith('wst_fake_rovella_0001')],
    ])
    const changed: string[] = []
    const links = createCloudShopLinks({
      cloudOf: async (ws) => clouds.get(ws),
      startupBrand: IVRA,
      clock,
      onChange: (ws) => changed.push(ws),
    })
    const port = portWith({ [ROVELLA]: 'wst_fake_rovella_0001' })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(a.attempt_id, 'connected')
    fake.reauth('6demox-md.myshopify.com', { missing_scopes: ['read_orders'] })
    expect(links.peek(ROVELLA)).toBeUndefined()
    const link = await links.link(ROVELLA)
    expect(link?.shop).toBe('6demox-md.myshopify.com')
    expect(link?.scopes).toContain('write_products')
    expect(link?.scopes).not.toContain('read_orders')
    expect(links.peek(ROVELLA)?.shop).toBe('6demox-md.myshopify.com')
    expect(await links.link(IVRA)).toBeUndefined()
    expect(changed).toEqual([ROVELLA])
    // 失效之后：作废缓存、再问一次就不算连着了
    fake.reauth('6demox-md.myshopify.com', { reason: 'app_uninstalled' })
    links.invalidate(ROVELLA)
    expect(await links.link(ROVELLA)).toBeUndefined()
    expect(links.peek(ROVELLA)).toBeUndefined()
  })

  it('卡上看一次就记住；断开即作废', async () => {
    const links = createCloudShopLinks({
      cloudOf: async () => cloudWith('wst_fake_rovella_0001'),
      startupBrand: IVRA,
      clock,
    })
    const port = createShopifyConnect({
      clock,
      cloudOf: async () => cloudWith('wst_fake_rovella_0001'),
      shopHints: () => [],
      startupBrand: IVRA,
      links,
    })
    const a = await port.start(actor(ROVELLA), { shop: '6demox-md.myshopify.com' })
    fake.settle(a.attempt_id, 'connected')
    await port.view(actor(ROVELLA))
    expect(links.peek(ROVELLA)?.shop).toBe('6demox-md.myshopify.com')
    await port.disconnect(actor(ROVELLA), '6demox-md.myshopify.com')
    expect(await links.link(ROVELLA)).toBeUndefined()
  })
})
