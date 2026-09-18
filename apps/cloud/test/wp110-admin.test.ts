/**
 * WP110 积分那一半：管理员手动充值（`POST /v1/admin/topup`）。
 *
 * 测试环境不开 Stripe（没给密钥就 501，那是现状也是有意的），但内测朋友得有额度。
 * 这条口子存在的全部理由就是"不用 SSH 进去手写 SQL"——所以它必须走钱包自己那套
 * 规矩（两类积分、到期清零、同一个 source_ref 只入一次），而不是绕过去。
 */

import { MemoryWalletStore } from '@agentsws/metering'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_TOKEN_ENV,
  ADMIN_TOPUP_CAPABILITY,
  adminExportRoutes,
  adminRoutesFromEnv,
  DEFAULT_GRANT_DAYS,
  mountEntry,
} from '../src/index.js'
import type { AdminWalletHandles } from '../src/routes/admin.js'
import { type Harness, harness, login, testClock } from './helpers.js'

/** 48 字节，够长。这一串只在测试里存在。 */
const TOKEN = 'test-admin-token-0123456789abcdef0123456789abcdef'

interface Setup {
  h: Harness
  org: string
  logs: string[]
  wallet: AdminWalletHandles
}

function setup(): Setup {
  const clock = testClock()
  const logs: string[] = []
  let handles: AdminWalletHandles | undefined
  let current: Harness | undefined
  const admin = adminRoutesFromEnv({
    env: { [ADMIN_TOKEN_ENV]: TOKEN },
    clock,
    accounts: () => {
      if (current === undefined) throw new Error('还没建服务器')
      return current.server.store
    },
    wallet: () => handles,
    log: (line) => logs.push(line),
  })
  if (admin === undefined) throw new Error('配了令牌却没挂上路由')
  const h = harness({ clock, modules: [admin] })
  current = h
  const mounted = mountEntry(h.server, {
    clock,
    walletStore: new MemoryWalletStore(),
    fetch: async () => {
      throw new Error('测试里不该打任何上游')
    },
  })
  handles = { wallet: mounted.wallet, store: mounted.store }
  const { org } = h.server.store.ensureAccount('luoye@example.com')
  return { h, org: org.id, logs, wallet: handles }
}

describe('WP110 admin 令牌那道闸', () => {
  it('没配环境变量 → 这条路由根本不挂（不是挂上去再拒）', () => {
    const routes = adminRoutesFromEnv({
      env: {},
      clock: testClock(),
      accounts: () => {
        throw new Error('不该被调到')
      },
      wallet: () => undefined,
    })
    expect(routes).toBeUndefined()
  })

  it('配了但太短 → 抛，不是悄悄不挂', () => {
    expect(() =>
      adminRoutesFromEnv({
        env: { [ADMIN_TOKEN_ENV]: 'short' },
        clock: testClock(),
        accounts: () => {
          throw new Error('不该被调到')
        },
        wallet: () => undefined,
      }),
    ).toThrow(/32/)
  })

  it('令牌不对 → 401，而且什么都没发生', async () => {
    const s = setup()
    try {
      for (const token of [undefined, 'wrong', `${TOKEN}x`]) {
        const res = await s.h.call('/v1/admin/topup', {
          method: 'POST',
          body: { org_id: s.org, credits: 100 },
          ...(token === undefined ? {} : { token }),
        })
        expect(res.status).toBe(401)
      }
      expect(s.wallet.wallet.balance(s.org).granted).toBe(0)
      expect(s.logs).toHaveLength(0)
    } finally {
      await s.h.close()
    }
  })
})

describe('WP110 手动充值', () => {
  it('按邮箱发：granted 积分 + 默认 90 天到期', async () => {
    const s = setup()
    try {
      const res = await s.h.call('/v1/admin/topup', {
        method: 'POST',
        body: { email: 'luoye@example.com', credits: 200 },
        token: TOKEN,
      })
      expect(res.status).toBe(201)
      const data = res.body.data as { org_id: string; kind: string; expires_at: string }
      expect(data.org_id).toBe(s.org)
      expect(data.kind).toBe('granted')
      expect(Date.parse(data.expires_at) - Date.parse(s.h.clock.now())).toBe(
        DEFAULT_GRANT_DAYS * 24 * 60 * 60 * 1000,
      )
      const balance = s.wallet.wallet.balance(s.org)
      expect(balance.granted).toBe(200)
      // 送的额度不该变成"永不过期的钱"
      expect(balance.purchased).toBe(0)
    } finally {
      await s.h.close()
    }
  })

  it('记一条 0 积分的计量事件：用量看板知道这笔额度是怎么来的，但它不是花费', async () => {
    const s = setup()
    try {
      await s.h.call('/v1/admin/topup', {
        method: 'POST',
        body: { org_id: s.org, credits: 50 },
        token: TOKEN,
      })
      const events = s.wallet.store.events({ org_id: s.org })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        capability: ADMIN_TOPUP_CAPABILITY,
        unit: 'credit',
        quantity: 50,
        credits: 0,
      })
      // 记成花费的话用量总数会凭空多出一块
      expect(s.wallet.wallet.usage({ org_id: s.org, group: 'capability' }).total_credits).toBe(0)
    } finally {
      await s.h.close()
    }
  })

  it('同一个 source_ref 只入一次（重发不变成第二笔额度）', async () => {
    const s = setup()
    try {
      for (let i = 0; i < 3; i += 1)
        await s.h.call('/v1/admin/topup', {
          method: 'POST',
          body: { org_id: s.org, credits: 100, source_ref: 'neice-001' },
          token: TOKEN,
        })
      expect(s.wallet.wallet.balance(s.org).granted).toBe(100)
    } finally {
      await s.h.close()
    }
  })

  it('没登录过的邮箱 / 不存在的组织 → 404，一句人话', async () => {
    const s = setup()
    try {
      const byEmail = await s.h.call('/v1/admin/topup', {
        method: 'POST',
        body: { email: 'nobody@example.com', credits: 10 },
        token: TOKEN,
      })
      expect(byEmail.status).toBe(404)
      expect(byEmail.body.message).toContain('本地关联')
      const byOrg = await s.h.call('/v1/admin/topup', {
        method: 'POST',
        body: { org_id: 'org_不存在', credits: 10 },
        token: TOKEN,
      })
      expect(byOrg.status).toBe(404)
    } finally {
      await s.h.close()
    }
  })

  it('org_id 与 email 一个都不给 / 积分不是正数 → 400', async () => {
    const s = setup()
    try {
      for (const body of [{ credits: 10 }, { org_id: 'x', credits: 0 }, { org_id: 'x' }])
        expect(
          (await s.h.call('/v1/admin/topup', { method: 'POST', body, token: TOKEN })).status,
        ).toBe(400)
    } finally {
      await s.h.close()
    }
  })

  it('审计行只有组织、积分、到期、请求号；没有令牌，邮箱只到域名', async () => {
    const s = setup()
    try {
      await s.h.call('/v1/admin/topup', {
        method: 'POST',
        body: { email: 'luoye@example.com', credits: 30 },
        token: TOKEN,
      })
      const line = s.logs.join('')
      expect(line).toContain(s.org)
      expect(line).toContain('example.com')
      expect(line).not.toContain('luoye@example.com')
      expect(line).not.toContain(TOKEN)
    } finally {
      await s.h.close()
    }
  })
})

describe('WP114 GET /v1/admin/export（Compose 形态）', () => {
  it('同一把钥匙：不对 401，对了导出账号 / 组织 / 关联 / 积分批次，且没有明文凭据', async () => {
    const clock = testClock()
    let current: Harness | undefined
    let handles: AdminWalletHandles | undefined
    const routes = adminExportRoutes({
      clock,
      token: TOKEN,
      accounts: () => {
        if (current === undefined) throw new Error('还没建服务器')
        return current.server.store
      },
      // Compose 形态下钱包就在手边，同步取一把包成 Promise
      walletLots: async (org_id) => handles?.store.lots(org_id) ?? [],
      log: () => undefined,
    })
    const h = harness({ clock, modules: [routes] })
    current = h
    const mounted = mountEntry(h.server, {
      clock,
      walletStore: new MemoryWalletStore(),
      fetch: async () => {
        throw new Error('测试里不该打任何上游')
      },
    })
    handles = { wallet: mounted.wallet, store: mounted.store }
    try {
      const { org } = await login(h, 'luoye@example.com')
      mounted.wallet.topup({ org_id: org, credits: 42, kind: 'granted' })
      const issued = h.server.store.createLink({
        workspace_id: 'ws_a',
        cloud_org_id: org,
        created_by: 'acc_test',
      })

      expect((await h.call('/v1/admin/export', { token: 'nope' })).status).toBe(401)

      const res = await h.call('/v1/admin/export', { token: TOKEN })
      expect(res.status).toBe(200)
      const data = res.body.data as {
        accounts: { email: string }[]
        orgs: { id: string }[]
        links: { token_sha256: string }[]
        wallets: { org_id: string; lots: { credits: number; kind: string }[] }[]
      }
      expect(data.accounts.map((a) => a.email)).toEqual(['luoye@example.com'])
      expect(data.orgs.map((o) => o.id)).toEqual([org])
      expect(data.links[0]?.token_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(data.wallets[0]?.lots[0]?.credits).toBe(42)
      // 令牌明文一个都没有——库里本来就没存过
      expect(JSON.stringify(data)).not.toContain(issued.token)
      expect(JSON.stringify(data)).not.toContain('cs_')
      expect(JSON.stringify(data)).not.toContain('cml_')
    } finally {
      await h.close()
    }
  })
})
