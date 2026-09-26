/**
 * 49 M3 合并点：WP58 签的令牌 → WP59 的服务入口，同一个进程、同一份验证。
 *
 * 三条要钉住的事：
 * 1. 账号层签出来的 `wst_` 令牌能直接打 `/v1/wallet`（scope 对得上，两边不再各说各话）；
 * 2. 撤销之后入口立刻拒——验证是同一个函数，不存在"账号层撤了、入口还认"的窗口；
 * 3. 没有 `ai` 的令牌打 `/v1/ai/*` 是 403 而不是 401（令牌本身没问题，是动作集不够）。
 */
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { MemoryWalletStore } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { mountEntry } from '../src/entry.js'
import { type Harness, harness } from './helpers.js'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

function setup(): {
  h: Harness
  store: MemoryWalletStore
  org: string
  token: string
  noAi: string
} {
  h = harness()
  const store = new MemoryWalletStore()
  const mounted = mountEntry(h.server, {
    clock: h.clock,
    walletStore: store,
    fetch: async () => {
      throw new Error('测试里不该打任何上游')
    },
  })
  const { account, org } = h.server.store.ensureAccount('luoye@example.com')
  mounted.wallet.topup({ org_id: org.id, credits: 100, kind: 'purchased' })
  const token = h.server.store.createLink({
    workspace_id: 'ws_a',
    cloud_org_id: org.id,
    created_by: account.id,
    scopes: [...DEFAULT_CLOUD_SCOPES],
  }).token
  const noAi = h.server.store.createLink({
    workspace_id: 'ws_b',
    cloud_org_id: org.id,
    created_by: account.id,
    scopes: ['wallet:read'],
  }).token
  return { h, store, org: org.id, token, noAi }
}

describe('49 M3：入口挂进云侧进程', () => {
  it('账号层签的令牌直接能看余额；账号层的路由还在', async () => {
    const s = setup()
    const wallet = await s.h.call('/v1/wallet', { token: s.token })
    expect(wallet.status).toBe(200)
    expect((wallet.body.data as { available: number }).available).toBe(100)
    const health = await s.h.call('/v1/cloud/health')
    expect(health.status).toBe(200)
  })

  it('撤销之后入口立刻拒：验证是同一个函数', async () => {
    const s = setup()
    const link = s.h.server.store.activeLinkOfWorkspace('ws_a')
    expect(link).toBeDefined()
    if (link === undefined) return
    s.h.server.store.revokeLink(link.id)
    const res = await s.h.call('/v1/wallet', { token: s.token })
    expect(res.status).toBe(401)
  })

  it('没有 ai 动作集的令牌打模型口是 403，不是 401', async () => {
    const s = setup()
    const res = await s.h.call('/v1/ai/models', { token: s.noAi })
    expect(res.status).toBe(403)
    const ok = await s.h.call('/v1/wallet', { token: s.noAi })
    expect(ok.status).toBe(200)
  })
})

describe('WP155：搜索数据挂进同一个入口（Compose 形态）', () => {
  it('没配 key：状态如实说没开通；配了（环境变量）：开通、单价常显、不写服务商名', async () => {
    const s = setup()
    const off = await s.h.call('/v1/data/search/status', { token: s.token })
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ configured: false, route: 'none' })

    const h2 = harness()
    h = h2
    mountEntry(h2.server, {
      clock: h2.clock,
      walletStore: new MemoryWalletStore(),
      env: { AGENTSWS_SEARCH_DATA_KEY: 'svc-login:not-a-real-password' },
      fetch: async () => {
        throw new Error('测试里不该打任何上游')
      },
    })
    const { account, org } = h2.server.store.ensureAccount('luoye@example.com')
    const token = h2.server.store.createLink({
      workspace_id: 'ws_a',
      cloud_org_id: org.id,
      created_by: account.id,
      scopes: [...DEFAULT_CLOUD_SCOPES],
    }).token
    const on = await h2.call('/v1/data/search/status', { token })
    expect(on.body).toMatchObject({
      configured: true,
      route: 'official',
      prices: { serp: 0.2, ai_answer: 0.4 },
    })
    expect(JSON.stringify(on.body)).not.toMatch(/dataforseo/i)
    await s.h.close()
  })
})
