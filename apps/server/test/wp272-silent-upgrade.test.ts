/**
 * WP272（Luoye 10-08 真机）：补权限全自动、用户无感；离线先重试一次再判。
 *
 * - 本地 http 假云（127.0.0.1）：老令牌缺 `store` 时业务那几条回 403 `required_scope`，
 *   补签那一条（`/v1/cloud/links/current/upgrade`）就地给令牌补上 `store`（令牌不变）。
 * - 真的云客户端（`createCloud`，带 `scopeUpgrade` 钩子）+ 真的账号面（`createCloudAccount.upgradeScopes`）
 *   + 真的去重 / 冷却（`createScopeAutoUpgrade`）+ 真的连接卡端口（`createShopifyConnect`）。
 *
 * 一个字节不出这台机器、不碰真云 / 真店。
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createCloud } from '../src/cloud.js'
import { CLOUD_TOKEN_SECRET_ID, createCloudAccount } from '../src/cloud-account.js'
import type { KolCloudCall } from '../src/kol-cloud-sync.js'
import { createScopeAutoUpgrade } from '../src/scope-auto-upgrade.js'
import { createSecretStore } from '../src/secret-store.js'
import { type ShopifyCloudStandIn, shopifyCloudStandIn } from '../src/shopify-cloud-stand-in.js'
import { createShopifyConnect, SHOPIFY_CONNECT_SCOPE_MISSING } from '../src/shopify-connect.js'

const INMO = 'ws_inmo' as WorkspaceId
const ROLLOUT = 'ws_rollout' as WorkspaceId
const clock: Clock = { now: () => new Date().toISOString() }
const KEY = { AGENTSWS_SECRETS_KEY: 'e'.repeat(64) }

/** 假云认得的工作区令牌（测试合成的）。`scopes` 会被补签那一条就地改。 */
let tokens: Record<string, { workspace: string; scopes: string[] }> = {}
/** 补签那一条：`ok` 就地补 / `gone` 老云没这一条（404）/ `revoked` 令牌被撤（401）。 */
let upgradeMode: 'ok' | 'gone' | 'revoked' = 'ok'
const hits: string[] = []

let http: HttpServer
let base: string
let fake: ShopifyCloudStandIn

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
      const path = new URL(req.url ?? '/', 'http://x').pathname
      hits.push(path)
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const who = tokens[token]
      if (path === '/v1/cloud/links/current/upgrade') {
        if (upgradeMode === 'gone') return send(404, { code: 'not_found', message: '没有这条路' })
        if (upgradeMode === 'revoked' || who === undefined)
          return send(401, { code: 'unauthenticated', message: '令牌无效' })
        const added = DEFAULT_CLOUD_SCOPES.filter((x) => !who.scopes.includes(x))
        who.scopes = [...who.scopes, ...added]
        return send(200, { data: { link: { id: 'lnk_1' }, scopes: who.scopes, added } })
      }
      if (who === undefined) return send(401, { code: 'unauthenticated', message: '令牌无效' })
      if (!who.scopes.includes('store'))
        return send(403, {
          code: 'forbidden',
          message: '这把令牌没有这个动作',
          details: { required_scope: 'store' },
        })
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
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

beforeEach(() => {
  fake = shopifyCloudStandIn({ autoConnectAfterMs: -1 })
  tokens = {
    wst_old_inmo: { workspace: INMO, scopes: ['ai', 'wallet:read'] },
    wst_old_rollout: { workspace: ROLLOUT, scopes: ['ai', 'wallet:read'] },
  }
  upgradeMode = 'ok'
  hits.length = 0
})

/** 一整套：两个品牌各一把老令牌（缺 store），账号面 + 自动补签 + 各品牌云面 + 连接卡端口。 */
function rig() {
  const vaults = new Map<string, ReturnType<typeof createSecretStore>>()
  const vaultOf = (ws: WorkspaceId) => {
    let v = vaults.get(ws)
    if (v === undefined) {
      v = createSecretStore({ dbPath: ':memory:', clock, env: KEY })
      vaults.set(ws, v)
    }
    return v
  }
  for (const [ws, token] of [
    [INMO, 'wst_old_inmo'],
    [ROLLOUT, 'wst_old_rollout'],
  ] as const)
    vaultOf(ws).put(CLOUD_TOKEN_SECRET_ID, {
      token,
      email: 'owner@example.com',
      org_id: 'org_1',
      org_name: 'Acme',
      expires_at: '2027-01-01T00:00:00.000Z',
      scopes: 'ai,wallet:read',
      linked_at: '2026-09-01T00:00:00.000Z',
    })
  const account = createCloudAccount({
    secrets: vaultOf(ROLLOUT),
    clock,
    env: { AGENTSWS_CLOUD_BASE_URL: base },
    appendEvent: () => {},
    workspace_id: () => ROLLOUT,
    brands: () => [ROLLOUT, INMO],
    secretsFor: vaultOf,
    localBaseUrl: () => undefined,
  })
  const results: { ws: string; ok: boolean; reason?: string }[] = []
  const auto = createScopeAutoUpgrade({
    upgrade: (ws) => account.upgradeScopes(ws),
    missingOf: (ws) => account.missingScopesOf(ws),
    brands: () => [ROLLOUT, INMO],
    nowMs: () => Date.now(),
    onResult: (ws, r) => results.push({ ws, ok: r.ok, ...(r.reason === undefined ? {} : r) }),
  })
  const clouds = new Map(
    [ROLLOUT, INMO].map((ws) => [
      ws,
      createCloud({
        clock,
        secrets: vaultOf(ws),
        env: { AGENTSWS_CLOUD_BASE_URL: base },
        scopeUpgrade: () => auto.ensure(ws),
      }),
    ]),
  )
  const port = createShopifyConnect({
    clock,
    cloudOf: async (ws) => clouds.get(ws),
    emailOf: () => 'owner@example.com',
    shopHints: () => [{ shop: 'rollout-demo.myshopify.com', source: 'profile' }],
    startupBrand: ROLLOUT,
    upgrade: (ws) => account.upgradeScopes(ws),
    autoUpgrade: (ws) => auto.ensure(ws),
    offlineRetryMs: 0,
  })
  return { account, auto, port, results, vaultOf }
}

const actor = (ws: WorkspaceId) => ({ workspace_id: ws, person_id: 'p_owner' })

describe('WP272 缺 store：后台自动补签，卡上无感', () => {
  it('打开卡：自动补签 → 卡上没有「授权要更新」，连接按钮直接可用；同公司另一品牌一起补上', async () => {
    const t = rig()
    const view = await t.port.view(actor(ROLLOUT))
    expect(view.blocked).toBeUndefined()
    expect(view.suggested_shop).toBe('rollout-demo.myshopify.com')
    // 补签只打了一次（同公司另一品牌顺手补），令牌没换
    expect(hits.filter((p) => p.endsWith('/upgrade'))).toHaveLength(2)
    expect(t.vaultOf(ROLLOUT).get(CLOUD_TOKEN_SECRET_ID)?.token).toBe('wst_old_rollout')
    expect(t.account.missingScopesOf(ROLLOUT)).toEqual([])
    expect(t.account.missingScopesOf(INMO)).toEqual([])
    // 连接按钮：直接起授权，不用任何人点「更新授权」
    const started = await t.port.start(actor(ROLLOUT), {})
    expect(started.authorize_url).toMatch(/^https:\/\//)
    // 另一品牌打开卡也不再补签
    hits.length = 0
    expect((await t.port.view(actor(INMO))).blocked).toBeUndefined()
    expect(hits.some((p) => p.endsWith('/upgrade'))).toBe(false)
  })

  it('任意一跳（云面 call）撞上 403 缺动作集：补签后原样再打一次，调用方拿到的是成功', async () => {
    const t = rig()
    const cloud = createCloud({
      clock,
      secrets: t.vaultOf(ROLLOUT),
      env: { AGENTSWS_CLOUD_BASE_URL: base },
      scopeUpgrade: () => t.auto.ensure(ROLLOUT),
    })
    const out = (await cloud.call('/v1/shopify/connections')) as KolCloudCall<unknown>
    expect(out.ok).toBe(true)
    expect(t.results).toEqual([{ ws: ROLLOUT, ok: true }])
  })

  it('启动时扫一遍：本机记着缺动作集的品牌都补上（不等谁撞上）', async () => {
    const t = rig()
    expect(t.account.missingScopesOf(ROLLOUT)).toContain('store')
    await t.auto.sweep()
    expect(t.account.missingScopesOf(ROLLOUT)).toEqual([])
    expect(t.account.missingScopesOf(INMO)).toEqual([])
    // 第一个品牌补的时候顺手补了第二个，扫到第二个时已经不缺，不再打
    expect(hits.filter((p) => p.endsWith('/upgrade'))).toHaveLength(2)
  })

  it('并发的几跳只补一次', async () => {
    const t = rig()
    const all = await Promise.all([
      t.auto.ensure(ROLLOUT),
      t.auto.ensure(ROLLOUT),
      t.auto.ensure(ROLLOUT),
    ])
    expect(all).toEqual([true, true, true])
    expect(t.results.filter((r) => r.ws === ROLLOUT)).toHaveLength(1)
  })
})

describe('WP272 补签确实不成：才引导重新登录（去设置 → 账号）', () => {
  it('老云没这一条（404）：卡上 scope_missing，那句话说「工坊账号需要重新登录」，冷却里不再敲云', async () => {
    upgradeMode = 'gone'
    const t = rig()
    const view = await t.port.view(actor(ROLLOUT))
    expect(view.blocked?.reason).toBe('scope_missing')
    expect(view.blocked?.message).toBe(SHOPIFY_CONNECT_SCOPE_MISSING)
    expect(view.blocked?.message).toContain('设置 → 账号')
    expect(view.blocked?.message).not.toContain('更新授权')
    hits.length = 0
    await t.port.view(actor(ROLLOUT))
    expect(hits.some((p) => p.endsWith('/upgrade'))).toBe(false)
    // 重新登录（新令牌）之后冷却作废
    t.auto.reset()
    upgradeMode = 'ok'
    expect((await t.port.view(actor(ROLLOUT))).blocked).toBeUndefined()
  })

  it('令牌被撤（补签 401）：同样引导重新登录', async () => {
    upgradeMode = 'revoked'
    const t = rig()
    expect((await t.port.view(actor(ROLLOUT))).blocked?.reason).toBe('scope_missing')
    expect(t.results[0]).toMatchObject({ ws: ROLLOUT, ok: false, reason: 'upgrade_unavailable' })
  })
})

describe('WP272 离线：先重试一次再判，问号里带原因码', () => {
  /** 一个假云口：按顺序回给定的几次结果。 */
  function portOf(replies: KolCloudCall<unknown>[]) {
    let n = 0
    return {
      calls: () => n,
      port: createShopifyConnect({
        clock,
        cloudOf: async () => ({
          linked: () => true,
          call: (async () => {
            const r = replies[Math.min(n, replies.length - 1)] as KolCloudCall<unknown>
            n += 1
            return r
          }) as never,
        }),
        shopHints: () => [],
        startupBrand: ROLLOUT,
        offlineRetryMs: 0,
      }),
    }
  }

  it('第一下没打通、第二下通了：卡上不是「连不上」', async () => {
    const p = portOf([
      { ok: false, status: 0, cause_code: 'ECONNRESET' },
      { ok: true, status: 200, data: { connections: [] } },
    ])
    expect((await p.port.view(actor(ROLLOUT))).blocked).toBeUndefined()
    expect(p.calls()).toBe(2)
  })

  it('两下都没打通：offline + 原因码（ENOTFOUND）', async () => {
    const p = portOf([{ ok: false, status: 0, cause_code: 'ENOTFOUND' }])
    const view = await p.port.view(actor(ROLLOUT))
    expect(view.blocked).toMatchObject({ reason: 'offline', cause_code: 'ENOTFOUND' })
    expect(p.calls()).toBe(2)
  })

  it('真的云客户端：连不上时带回根本原因的码', async () => {
    const secrets = createSecretStore({ dbPath: ':memory:', clock, env: KEY })
    secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_x', email: 'owner@example.com' })
    // 起一个口再关掉：这个口上没人听（连接被拒）
    const probe = createHttp()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const cloud = createCloud({
      clock,
      secrets,
      env: { AGENTSWS_CLOUD_BASE_URL: `http://127.0.0.1:${String(port)}` },
    })
    const out = (await cloud.call('/v1/shopify/connections')) as KolCloudCall<unknown>
    expect(out.status).toBe(0)
    expect(out.cause_code).toBe('ECONNREFUSED')
  })
})
