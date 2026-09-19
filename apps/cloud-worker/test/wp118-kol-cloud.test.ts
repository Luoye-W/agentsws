/**
 * WP118：红人营销增值服务在 Workers 形态上走完整条路（67 §3）。
 *
 * 每一条都从**入口 Worker** 进，所以测的是真链路：
 * 验令牌（问 `AccountsDO`）→ 转给 `KolTenantDO(org_id)` → 月费由那个对象自己
 * 打 `WalletDO(org_id)` 扣。
 *
 * 要钉住的事：
 *
 * 1. 没绑那个 binding：`/v1/kol/*` 404；
 * 2. **未订阅的 org 调同步接口回 402 人话**（派工单点名）；
 * 3. 开通真的从这个组织的钱包里扣了 30 积分，而且账上认得出是哪个 cycle；
 * 4. **同一个 cycle 不重复扣费**（alarm 重跑十遍）；
 * 5. **余额不足不删数据**：进宽限、同步暂停、数据一条不动；
 * 6. **同步冲突不丢数据**：输的那一份留着，导出里带得走；
 * 7. 每个组织一个对象：A 组织看不到 B 组织的一条数据；
 * 8. 内部头伪造不了（外面塞的 principal 进门就被剥掉）。
 */

import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { INTERNAL_HEADERS, route } from '../src/index.js'
import { type FakeCloud, fakeCloud, req, tokenFromMail } from './helpers.js'

const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'
/** 管理员令牌至少 32 字节（钱那个对象在装配时就查，短了直接抛）。**测试用的假钥匙**。 */
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'

interface Json {
  data?: unknown
  code?: string
  message?: string
  [k: string]: unknown
}

async function call(
  cloud: FakeCloud,
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; res: Response }> {
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    cloud.env,
  )
  const text = await res.clone().text()
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json), res }
}

async function issueToken(
  cloud: FakeCloud,
  email: string,
  workspace_id: string,
): Promise<{ token: string; org: string }> {
  await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: CALLBACK },
  })
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', {
    method: 'POST',
    body: { token: oneTime },
  })
  const data = verified.body.data as { session_token: string; org: { id: string } }
  const link = await call(cloud, '/v1/cloud/links', {
    method: 'POST',
    token: data.session_token,
    body: { workspace_id, scopes: DEFAULT_CLOUD_SCOPES },
  })
  return { token: (link.body.data as { token: string }).token, org: data.org.id }
}

async function available(cloud: FakeCloud, token: string): Promise<number> {
  const wallet = await call(cloud, '/v1/wallet', { token })
  return (wallet.body.data as { available: number }).available
}

/** 给这个组织充点积分（走管理员那条口，与真实运营一致）。 */
async function topup(cloud: FakeCloud, org: string, credits: number): Promise<void> {
  const res = await call(cloud, '/v1/admin/topup', {
    method: 'POST',
    token: ADMIN_TOKEN,
    body: { org_id: org, credits, kind: 'purchased' },
  })
  expect(res.status).toBe(201)
}

const creator = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'creator',
  id: 'c1',
  version: 1,
  updated_at: '2026-02-01T00:00:00.000Z',
  writer: 'device:a',
  body: { handle: 'someone', followers: 1000 },
  ...over,
})

const newCloud = (): FakeCloud =>
  fakeCloud({
    kolTenant: true,
    env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN },
  })

describe('WP118 · 绑与不绑', () => {
  it('没绑 KOL_TENANT：这一段路 404（不是 500，也不是假装成功）', async () => {
    const cloud = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    const { token } = await issueToken(cloud, 'a@example.com', 'ws_1')
    const res = await call(cloud, '/v1/kol/sync/status', { token })
    expect(res.status).toBe(404)
  })
})

describe('WP118 · 订阅闸门', () => {
  it('未订阅的 org 调同步接口回 402，一句人话，且不泄露内部细节', async () => {
    const cloud = newCloud()
    const { token } = await issueToken(cloud, 'a@example.com', 'ws_1')
    const res = await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token,
      body: { writer: 'device:a', objects: [creator()] },
    })
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('payment_required')
    expect(String(res.body.message)).toContain('还没开通')
    expect(String(res.body.message)).toContain('30 积分')
    // 人话里不许出现表名 / org_id / 令牌
    expect(String(res.body.message)).not.toMatch(/kol_cloud_|org_|wst_/)
  })

  it('状态查得到（none，不是报错）——界面上那张卡总要有东西渲染', async () => {
    const cloud = newCloud()
    const { token } = await issueToken(cloud, 'a@example.com', 'ws_1')
    const res = await call(cloud, '/v1/kol/sync/status', { token })
    expect(res.status).toBe(200)
    const status = res.body as { subscription: { status: string }; object_count: number }
    expect(status.subscription.status).toBe('none')
    expect(status.object_count).toBe(0)
  })
})

describe('WP118 · 开通与扣费', () => {
  it('开通真的从这个组织的钱包里扣了 30 积分', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 100)
    expect(await available(cloud, token)).toBe(100)

    const res = await call(cloud, '/v1/kol/subscription', { method: 'POST', token })
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('active')
    expect(await available(cloud, token)).toBe(70)
  })

  it('账上那一笔认得出是哪个 cycle（幂等键就是 request_id）', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 100)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token })
    const usage = await call(cloud, '/v1/wallet/usage', { token })
    const rows = (usage.body.data as { rows: { key: string; credits: number }[] }).rows
    const row = rows.find((r) => r.key === 'kol.service.monthly')
    expect(row?.credits).toBe(30)
  })

  it('同一个 cycle 不重复扣费——闹钟重跑十遍也只扣一次', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 200)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token })
    for (let i = 0; i < 10; i++) await cloud.kolTenant(org).alarm()
    expect(await available(cloud, token)).toBe(170)
  })

  it('余额不足：进宽限、同步暂停，**数据一条不删**', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 30)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token })
    await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token,
      body: { writer: 'device:a', objects: [creator(), creator({ id: 'c2' })] },
    })
    expect(cloud.kolTenant(org).store.count()).toBe(2)

    // 钱花光了，下一期扣不上（把订阅的 anchor 往前搬一个月来触发）
    const tenant = cloud.kolTenant(org)
    const sub = tenant.service.subscription(org)
    tenant.store.putSubscription({ ...sub, anchor_at: '2020-01-01T00:00:00.000Z' })
    await tenant.alarm()

    expect(tenant.service.liveStatus(org)).toBe('grace')
    // 数据一条没少
    expect(tenant.store.count()).toBe(2)
    const blocked = await call(cloud, '/v1/kol/sync/pull', { token })
    expect(blocked.status).toBe(402)
    expect(String(blocked.body.message)).toContain('一条都没动')
    // 欠费也导得出来——这时候拦着等于拿数据当人质
    const dump = await call(cloud, '/v1/kol/cloud/export', { token })
    expect(dump.status).toBe(200)
    expect((dump.body as { objects: unknown[] }).objects).toHaveLength(2)
  })
})

describe('WP118 · 双向同步', () => {
  it('冲突不丢数据：输的那一份留着，导出里带得走', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 100)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token })

    await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token,
      body: { writer: 'device:a', objects: [creator()] },
    })
    const second = await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token,
      body: {
        writer: 'device:b',
        objects: [
          creator({
            writer: 'device:b',
            updated_at: '2026-02-05T00:00:00.000Z',
            body: { handle: 'someone', followers: 2000 },
          }),
        ],
      },
    })
    expect(second.status).toBe(200)
    const pushed = second.body as { conflicts: { loser: { body: unknown } }[] }
    expect(pushed.conflicts).toHaveLength(1)
    expect(pushed.conflicts[0]?.loser.body).toEqual({ handle: 'someone', followers: 1000 })

    const dump = await call(cloud, '/v1/kol/cloud/export', { token })
    expect((dump.body as { conflicts: unknown[] }).conflicts).toHaveLength(1)
    const status = await call(cloud, '/v1/kol/sync/status', { token })
    expect((status.body as { pending_conflicts: number }).pending_conflicts).toBe(1)
  })

  it('每个组织一个对象：A 看不到 B 的一条数据', async () => {
    const cloud = newCloud()
    const a = await issueToken(cloud, 'a@example.com', 'ws_a')
    const b = await issueToken(cloud, 'b@example.com', 'ws_b')
    await topup(cloud, a.org, 100)
    await topup(cloud, b.org, 100)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token: a.token })
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token: b.token })

    await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token: a.token,
      body: { writer: 'device:a', objects: [creator()] },
    })
    const forB = await call(cloud, '/v1/kol/sync/pull', { token: b.token })
    expect((forB.body as { objects: unknown[] }).objects).toEqual([])
    const statusB = await call(cloud, '/v1/kol/sync/status', { token: b.token })
    expect((statusB.body as { object_count: number }).object_count).toBe(0)
  })

  it('删云端这一份：订阅留着，数据没了，账还在', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 100)
    await call(cloud, '/v1/kol/subscription', { method: 'POST', token })
    await call(cloud, '/v1/kol/sync/push', {
      method: 'POST',
      token,
      body: { writer: 'device:a', objects: [creator(), creator({ id: 'c2' })] },
    })
    const res = await call(cloud, '/v1/kol/cloud', { method: 'DELETE', token })
    expect(res.status).toBe(200)
    expect((res.body as { deleted: number }).deleted).toBe(2)
    expect(cloud.kolTenant(org).store.count()).toBe(0)
    expect(cloud.kolTenant(org).service.liveStatus(org)).toBe('active')
    expect(cloud.kolTenant(org).store.charges()).toHaveLength(1)
  })
})

describe('WP118 · 内部头伪造不了', () => {
  it('外面自己塞 principal 头也没用：进门就被剥掉，照样 401', async () => {
    const cloud = newCloud()
    const res = await call(cloud, '/v1/kol/sync/status', {
      headers: {
        [INTERNAL_HEADERS.principal]: JSON.stringify({
          account_id: 'acc_x',
          org_id: 'org_x',
          workspace_id: 'ws_x',
          scopes: ['kol'],
        }),
      },
    })
    expect(res.status).toBe(401)
  })
})

describe('WP118 · 后台那两条', () => {
  it('赠送 N 个月：那几期 0 积分，钱包一分不动', async () => {
    const cloud = newCloud()
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_1')
    await topup(cloud, org, 10) // 连一期都不够
    const tenant = cloud.kolTenant(org)
    const granted = await tenant.fetch(
      req(`/__internal/kol/tenant/grant?org=${org}&months=2`, { method: 'POST' }),
    )
    expect(granted.status).toBe(200)
    await tenant.alarm()
    expect(await available(cloud, token)).toBe(10)
    expect(tenant.service.liveStatus(org)).toBe('active')

    const summary = await tenant.fetch(req(`/__internal/kol/tenant/summary?org=${org}`))
    const body = (await summary.json()) as { subscription: { granted_months: number } }
    expect(body.subscription.granted_months).toBe(1)
  })

  it('内部路由不对外开放：从入口打进来是 404', async () => {
    const cloud = newCloud()
    const res = await call(cloud, '/__internal/kol/tenant/summary?org=org_1')
    expect(res.status).toBe(404)
  })
})
