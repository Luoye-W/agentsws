/**
 * WP265：真装配线（路由 → 端口 → 这个品牌的加密库与云客户端）+ demo 的云替身。
 *
 * - `/v1/shopify-connect*` 五条：没关联 → not_linked；关联后起授权 → 授权页（`.invalid` 假地址）
 *   → 轮询 → 连上 → 卡上有店 → 测试连接 → 断开；
 * - 云账号视图报「缺哪几项动作」（替身签的老令牌没有 `store`）；
 * - 同一个账号「重新登录一次」（`refresh: true`）换新令牌：不再 409、令牌换了；换别的账号不行。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudAccountView, ShopifyConnectView } from '@agentsws/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_PASSWORD, CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  CLOUD_TOKEN_SECRET_ID,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let dir: string
let server: Server
let url: string
let cloud: CloudStandIn

const call = async <T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; reason?: string }> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { data: T; details?: { reason?: string } }
  return {
    status: res.status,
    data: json.data,
    ...(json.details?.reason === undefined ? {} : { reason: json.details.reason }),
  }
}

const login = (refresh?: boolean) =>
  call<CloudAccountView>('POST', '/v1/cloud/account/password-login', {
    email: CLOUD_STAND_IN_REGISTERED_EMAIL,
    password: CLOUD_STAND_IN_PASSWORD,
    ...(refresh === undefined ? {} : { refresh }),
  })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp265-'))
  cloud = cloudStandIn({ autoLinkAfterMs: -1, shopify: { autoConnectAfterMs: -1 } })
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch: (input, init) => cloud.fetch(input, init),
  })
  url = (await server.listen(0)).url
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP265 /v1/shopify-connect 真装配线', () => {
  it('没关联：卡上 not_linked；关联后起授权 → 连上 → 测试 → 断开', async () => {
    const before = await call<ShopifyConnectView>('GET', '/v1/shopify-connect')
    expect(before.status).toBe(200)
    expect(before.data.linked).toBe(false)
    expect(before.data.blocked?.reason).toBe('not_linked')
    const refused = await call('POST', '/v1/shopify-connect/start', {
      shop: 'nordvolt.myshopify.com',
    })
    expect(refused.status).toBe(403)
    expect(refused.reason).toBe('not_linked')

    expect((await login()).status).toBe(200)
    const linked = await call<ShopifyConnectView>('GET', '/v1/shopify-connect')
    expect(linked.data.linked).toBe(true)
    expect(linked.data.blocked).toBeUndefined()
    expect(linked.data.email).toBe(CLOUD_STAND_IN_REGISTERED_EMAIL)

    const started = await call<{ attempt_id: string; authorize_url: string; shop: string }>(
      'POST',
      '/v1/shopify-connect/start',
      { shop: 'https://admin.shopify.com/store/nordvolt' },
    )
    expect(started.status).toBe(201)
    expect(started.data.shop).toBe('nordvolt.myshopify.com')
    // 替身的授权页是 .invalid 保留域：点出去也到不了任何地方
    expect(new URL(started.data.authorize_url).hostname.endsWith('.invalid')).toBe(true)
    // 起授权带的是这个品牌
    expect(cloud.shopify.attempts()[0]?.brand).toBe(server.bootstrap.workspace.id)

    const pending = await call<{ status: string }>(
      'GET',
      `/v1/shopify-connect/attempts/${started.data.attempt_id}`,
    )
    expect(pending.data.status).toBe('pending')
    cloud.shopify.settle(started.data.attempt_id, 'connected')
    const done = await call<{ status: string }>(
      'GET',
      `/v1/shopify-connect/attempts/${started.data.attempt_id}`,
    )
    expect(done.data.status).toBe('connected')

    const view = await call<ShopifyConnectView>('GET', '/v1/shopify-connect')
    expect(view.data.connections.map((c) => c.shop)).toEqual(['nordvolt.myshopify.com'])

    const tested = await call<{ ok: boolean; domain?: string }>(
      'POST',
      '/v1/shopify-connect/test',
      {
        shop: 'nordvolt.myshopify.com',
      },
    )
    expect(tested.data).toMatchObject({ ok: true, domain: 'nordvolt.myshopify.com' })

    const gone = await call<{ disconnected: boolean }>('POST', '/v1/shopify-connect/disconnect', {
      shop: 'nordvolt.myshopify.com',
    })
    expect(gone.data.disconnected).toBe(true)
    expect((await call<ShopifyConnectView>('GET', '/v1/shopify-connect')).data.connections).toEqual(
      [],
    )
  })
})

describe('WP265 云账号：报缺的动作集、同账号重新登录换新令牌', () => {
  it('老令牌缺 store → missing_scopes 有它；refresh 登录换一把新令牌，不 409', async () => {
    expect((await login()).status).toBe(200)
    const view = await call<CloudAccountView>('GET', '/v1/cloud/account')
    // demo 替身签的是一把老式令牌（只有 ai / wallet:read）
    expect(view.data.missing_scopes).toContain('store')

    const vault = () => server.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
    const oldToken = vault()
    expect(oldToken).toBeDefined()
    // 不带 refresh 照旧挡（已关联）
    expect((await login()).status).toBe(409)
    const again = await login(true)
    expect(again.status).toBe(200)
    expect(again.data.linked).toBe(true)
    expect(vault()).toBeDefined()
    expect(vault()).not.toBe(oldToken)
  })

  it('refresh 只许同一个账号：换别的邮箱 → 409 other_account，令牌不动', async () => {
    // 先在替身里注册一个别的账号（注册即关联），再解除、换回 demo 账号
    const other = { name: '别家', email: 'someone-else@example.com', password: 'Another-Pass-2026' }
    expect(
      (await call('POST', '/v1/cloud/account/signup', { ...other, accept_terms: true })).status,
    ).toBe(200)
    expect(
      (
        await call('POST', '/v1/cloud/account/signup/verify', {
          email: other.email,
          code: '135790',
        })
      ).status,
    ).toBe(200)
    expect((await call('POST', '/v1/cloud/account/unlink')).status).toBe(200)
    expect((await login()).status).toBe(200)
    const before = server.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token
    // 替身里任意 6 位验证码都过：用它登进那个别的账号
    expect(
      (
        await call('POST', '/v1/cloud/account/code', {
          email: 'someone-else@example.com',
          refresh: true,
        })
      ).status,
    ).toBe(200)
    const switched = await call('POST', '/v1/cloud/account/code/verify', {
      email: 'someone-else@example.com',
      code: '246810',
      refresh: true,
    })
    expect(switched.status).toBe(409)
    expect(switched.reason).toBe('other_account')
    expect(server.secrets.get(CLOUD_TOKEN_SECRET_ID)?.token).toBe(before)
  })
})
