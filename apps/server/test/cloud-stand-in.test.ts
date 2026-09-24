/**
 * WP140（docs/78 阻断 #6 最后一段）：demo 的云账号替身。
 *
 * 真装配线（路由 → 端口 → 加密库）+ 替身云：发登录信 → 替身替用户点链接 → 已关联，
 * 余额 / 价目三块 / 充值四档都取得到；**全程没有一次请求打到 cloud.agentsws.com**
 * （全局 fetch 被换成记录器，出现就红）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudAccountView } from '@agentsws/api'
import type { CloudCreditsView, Pricing, TopupTiers } from '@agentsws/contracts'
import { pricingBlockOf } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const SECRETS_KEY = 'c'.repeat(64)

let dir: string
let server: Server
let url: string
let cloud: CloudStandIn
const outbound: string[] = []

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const data = async <T>(res: Response): Promise<T> => {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

beforeEach(async () => {
  const realFetch = globalThis.fetch
  outbound.length = 0
  // 记下这个进程里每一次真出站；只放行本机回环口（测试自己打服务 + 替身点回调）
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    outbound.push(target)
    const host = new URL(target).hostname
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`测试里不许出网：${target}`)
    return realFetch(input, init)
  })
  dir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-stand-in-'))
  cloud = cloudStandIn({ autoLinkAfterMs: 0 })
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY, AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch: cloud.fetch,
  })
  url = (await server.listen(0)).url
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('WP140 云账号替身', () => {
  it('发登录信 → 信发出去了；替身点链接之后是已关联，余额 / 价目三块 / 充值四档都有', async () => {
    const before = await data<CloudCreditsView>(await api('/v1/cloud/credits'))
    expect(before.linked).toBe(false)

    const sent = await data<{ delivered: string }>(
      await api('/v1/cloud/account/link', {
        method: 'POST',
        body: JSON.stringify({ email: 'tester@example.com' }),
      }),
    )
    expect(sent.delivered).toBe('email')
    await cloud.settled()

    const view = await data<CloudAccountView>(await api('/v1/cloud/account'))
    expect(view.linked).toBe(true)
    expect(view.email).toBe('tester@example.com')
    expect(view.cloud_base_url).toBe(CLOUD_STAND_IN_BASE_URL)

    // 关联前那份「还没关联」的缓存不挡住新状态
    const credits = await data<CloudCreditsView>(await api('/v1/cloud/credits'))
    expect(credits.linked).toBe(true)
    expect(credits.balance?.available).toBeGreaterThan(0)
    expect(credits.month_credits).toBeGreaterThan(0)

    const pricing = await data<Pricing>(await api('/v1/cloud/pricing'))
    expect(new Set(pricing.entries.map((e) => pricingBlockOf(e))).size).toBe(3)
    const tiers = await data<TopupTiers>(await api('/v1/cloud/topup/tiers'))
    expect(tiers.tiers).toHaveLength(4)

    // 充值不真收钱：回一句人话，不是 500
    const topup = await api('/v1/cloud/topup', {
      method: 'POST',
      body: JSON.stringify({ tier_id: 'usd20' }),
    })
    expect(topup.ok).toBe(false)
    expect(((await topup.json()) as { message: string }).message).not.toContain('internal')

    // 云侧的每一跳都进了替身，一次都没打到生产云
    expect(cloud.requests().length).toBeGreaterThan(0)
    expect(cloud.requests().every((r) => r.url.startsWith(CLOUD_STAND_IN_BASE_URL))).toBe(true)
    expect(outbound.some((u) => u.includes('cloud.agentsws.com'))).toBe(false)
    expect(outbound.every((u) => new URL(u).hostname === '127.0.0.1')).toBe(true)
  })

  it('解除关联：替身撤掉令牌，本地回到没关联', async () => {
    await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'tester@example.com' }),
    })
    await cloud.settled()
    const out = await data<{ unlinked: boolean; revoked_on_cloud: boolean }>(
      await api('/v1/cloud/account/unlink', { method: 'POST', body: '{}' }),
    )
    expect(out).toMatchObject({ unlinked: true, revoked_on_cloud: true })
    expect((await data<CloudAccountView>(await api('/v1/cloud/account'))).linked).toBe(false)
  })
})

describe('WP140 替身本身', () => {
  it('不认的地址与路径一律 404，不编数据；自动点链接只点本机回环口', async () => {
    const clicked: string[] = []
    const stand = cloudStandIn({
      autoLinkAfterMs: 0,
      click: async (u) => {
        clicked.push(u)
      },
    })
    expect((await stand.fetch('https://cloud.agentsws.com/v1/wallet')).status).toBe(404)
    expect((await stand.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/kol/public/search`)).status).toBe(404)
    // 没有替身签的令牌，钱包不给看
    expect((await stand.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/wallet`)).status).toBe(401)

    const res = await stand.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/cloud/auth/magic-link`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'a@example.com',
        callback_url: 'http://127.0.0.1:9/v1/cloud/account/callback',
        state: 's1',
      }),
    })
    expect(res.ok).toBe(true)
    await stand.settled()
    expect(clicked).toHaveLength(1)
    const link = new URL(clicked[0] ?? '')
    expect(link.searchParams.get('state')).toBe('s1')
    expect(link.searchParams.get('token')).toMatch(/^mlt_/)
  })

  it('autoLinkAfterMs < 0 就不替用户点', async () => {
    const clicked: string[] = []
    const stand = cloudStandIn({
      autoLinkAfterMs: -1,
      click: async (u) => {
        clicked.push(u)
      },
    })
    await stand.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/cloud/auth/magic-link`, {
      method: 'POST',
      body: JSON.stringify({
        email: 'a@example.com',
        callback_url: 'http://127.0.0.1:9/cb',
        state: 's',
      }),
    })
    await stand.settled()
    expect(clicked).toHaveLength(0)
  })
})
