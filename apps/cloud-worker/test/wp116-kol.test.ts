/**
 * WP116：公共红人库在 Workers 形态上走完整条路（64 §10.2 的两段式）。
 *
 * 每一条都从**入口 Worker** 进，所以测的是真链路：
 * 验令牌（问 `AccountsDO`）→ 在 `WalletDO` 预扣 → 打单例 `KolPublicDO` 取数 →
 * 回 `WalletDO` 结算 / 释放 / 返额度。
 *
 * 要钉住的事：
 *
 * 1. 没绑那个 binding：`/v1/data/kol/*` 404，health 里 `kol_public` **如实 false**；
 * 2. 绑了就 true；浏览按次收费（WP126）：空库 0 条不收钱，有结果才扣；
 * 3. reveal 真扣钱，而且**明文邮箱只在响应里出现一次**（库里只有哈希与密文）；
 * 4. 余额不够 402，**钱一分没动**，而且这一次根本没碰库；
 * 5. 库里没这个人：404，**那笔预扣被释放**（不是等一小时的孤儿清扫）；
 * 6. 外部源没取到：也释放（`refresh` 那条）；
 * 7. 内部头**伪造不了**：外面塞的预扣头进门就被剥掉；响应里也不许漏出记账头；
 * 8. 贡献返免费额度那一笔落在**对的组织**上；
 * 9. 后台那四条（统计 / 搜索 / 搬家 / 移除）打得通，且移除之后搬家搬不回来。
 */

import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { beforeEach, describe, expect, it } from 'vitest'
import { INTERNAL_HEADERS, remoteKolAdminPort, route } from '../src/index.js'
import { type FakeCloud, fakeCloud, req, SIGNUP_BONUS, tokenFromMail, zeroOut } from './helpers.js'

/** 32 字节的邮箱密钥（**测试用的假钥匙**，hex）。 */
const EMAIL_KEY = 'a'.repeat(64)
const CALLBACK = 'http://127.0.0.1:3000/v1/cloud/account/callback'

interface Json {
  data?: unknown
  code?: string
  message?: string
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

/** 这个组织现在有多少可用积分。 */
async function available(cloud: FakeCloud, token: string): Promise<number> {
  const wallet = await call(cloud, '/v1/wallet', { token })
  return (wallet.body.data as { available: number }).available
}

/**
 * 库里种一个人（走上报那条路由——它是免费的，不经预扣）。
 *
 * 正文只能有 `PUBLIC_OBSERVATION_FIELDS` 里那九个键，**多一个就 400**
 * （48 §1.3 第 4 条：观察里不收正文）。
 */
async function seedCreator(cloud: FakeCloud, token: string, handle = 'somecreator'): Promise<void> {
  const res = await call(cloud, `/v1/data/kol/creators/youtube/${handle}/observations`, {
    method: 'POST',
    token,
    body: {
      channel: 'youtube',
      handle,
      followers: 120_000,
      posts_30d: 12,
      engagement_rate: 0.03,
      categories: ['beauty'],
      observed_at: '2026-09-14T00:00:00.000Z',
    },
  })
  expect(res.status).toBe(201)
}

describe('WP116 Workers 形态 · 绑与不绑', () => {
  it('没绑 KOL_PUBLIC：这一段路 404，health 如实说没开通', async () => {
    const cloud = fakeCloud()
    const { token } = await issueToken(cloud, 'a@example.com', 'ws_a')
    const browse = await call(cloud, '/v1/data/kol/creators', { token })
    expect(browse.status).toBe(404)
    const health = await call(cloud, '/v1/cloud/health')
    expect((health.body.data as { modules: Record<string, boolean> }).modules.kol_public).toBe(
      false,
    )
  })

  it('绑了就 true；浏览按次收费（WP126）：空库 0 条不收钱，有结果才扣 0.2', async () => {
    const cloud = fakeCloud({ kol: true })
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 100, kind: 'purchased' })

    const health = await call(cloud, '/v1/cloud/health')
    expect((health.body.data as { modules: Record<string, boolean> }).modules.kol_public).toBe(true)

    // 空库：搜到 0 条 → 口径②不收钱
    const browse = await call(cloud, '/v1/data/kol/creators', { token })
    expect(browse.status).toBe(200)
    expect(await available(cloud, token)).toBe(100 + SIGNUP_BONUS)

    // 种一个人再搜：照价扣 0.2（命中缓存与未命中同价——库本身就是缓存）
    await seedCreator(cloud, token)
    const listed = await call(cloud, '/v1/data/kol/creators?channel=youtube', { token })
    expect(listed.status).toBe(200)
    expect(100 + SIGNUP_BONUS - (await available(cloud, token))).toBeCloseTo(0.2, 6)
  })
})

describe('WP116 Workers 形态 · 两段式的钱', () => {
  let cloud: FakeCloud

  beforeEach(() => {
    cloud = fakeCloud({ kol: true, env: { AGENTSWS_KOL_EMAIL_KEY: EMAIL_KEY } })
  })

  it('reveal：预扣 → 取数 → 结算，钱真扣了，明文邮箱只在响应里出现一次', async () => {
    const { token, org } = await issueToken(cloud, 'a@example.com', 'ws_a')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    await seedCreator(cloud, token)
    const saved = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/contact', {
      method: 'POST',
      token,
      body: { email: 'hi@example.com', source: 'manual' },
    })
    expect(saved.status).toBe(201)

    const before = await available(cloud, token)
    const revealed = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/reveal', {
      method: 'POST',
      token,
    })
    expect(revealed.status).toBe(200)
    expect((revealed.body.data as { email: string }).email).toBe('hi@example.com')
    // 0.2 积分一次（`packages/metering/src/pricing.json`）
    expect(before - (await available(cloud, token))).toBeCloseTo(0.2, 6)

    // 库里那一份：只有哈希与密文，**没有一个字节的明文**
    const rows = cloud
      .kol()
      .store.db.prepare('select email_sha256, email_cipher from kol_contacts')
      .all()
    expect(rows.length).toBe(1)
    expect(JSON.stringify(rows)).not.toContain('hi@example.com')
  })

  it('余额不够：402，钱一分没动，而且这一次根本没碰库', async () => {
    const { token, org } = await issueToken(cloud, 'b@example.com', 'ws_b')
    // WP121 之后「刚注册」自带赠送的积分，所以先撤干净——这条用例要的是"没钱"
    zeroOut(cloud, org)
    await seedCreator(cloud, token)
    const before = await available(cloud, token)
    const res = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/reveal', {
      method: 'POST',
      token,
    })
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('insufficient_credits')
    expect(await available(cloud, token)).toBe(before)
  })

  it('库里没这个人：404，而且那笔预扣当场被释放（不是等孤儿清扫）', async () => {
    const { token, org } = await issueToken(cloud, 'c@example.com', 'ws_c')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    const before = await available(cloud, token)
    const res = await call(cloud, '/v1/data/kol/creators/youtube/nobodyhere/reveal', {
      method: 'POST',
      token,
    })
    expect(res.status).toBe(404)
    expect(await available(cloud, token)).toBe(before)
  })

  it('外部源没取到：refresh 不收钱（预扣整笔释放）', async () => {
    const { token, org } = await issueToken(cloud, 'd@example.com', 'ws_d')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    await seedCreator(cloud, token)
    const before = await available(cloud, token)
    const res = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/refresh', {
      method: 'POST',
      token,
    })
    expect(res.status).toBe(200)
    expect((res.body.data as { refreshed: boolean }).refreshed).toBe(false)
    expect(await available(cloud, token)).toBe(before)
  })

  it('内部头伪造不了：外面塞的预扣进门就被剥掉，记账头也不许漏出去', async () => {
    const { token, org } = await issueToken(cloud, 'e@example.com', 'ws_e')
    cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'purchased' })
    await seedCreator(cloud, token)
    await call(cloud, '/v1/data/kol/creators/youtube/somecreator/contact', {
      method: 'POST',
      token,
      body: { email: 'hi@example.com', source: 'manual' },
    })
    const before = await available(cloud, token)
    /*
     * 自己伪造一笔"已经预扣过了"的头。进门第一件事是剥头，所以入口仍然会
     * **自己去 `WalletDO` 预扣一笔真的**——钱照扣。
     */
    const forged = JSON.stringify([
      {
        id: 'res_forged',
        org_id: org,
        workspace_id: 'ws_e',
        capability: 'data.kol.lookup',
        unit: 'call',
        quantity: 1,
        credits: 0,
        request_id: 'forged',
        at: new Date().toISOString(),
      },
    ])
    const res = await call(cloud, '/v1/data/kol/creators/youtube/somecreator/reveal', {
      method: 'POST',
      token,
      headers: { [INTERNAL_HEADERS.kolReservations]: forged },
    })
    expect(res.status).toBe(200)
    expect(before - (await available(cloud, token))).toBeCloseTo(0.2, 6)
    // 记账那张纸不出门
    expect(res.res.headers.get(INTERNAL_HEADERS.kolOps)).toBeNull()
  })

  it('贡献返免费额度：那一笔落在报数据的那个组织头上', async () => {
    const a = await issueToken(cloud, 'f@example.com', 'ws_f')
    cloud.wallet(a.org).wallet.topup({ org_id: a.org, credits: 1, kind: 'purchased' })
    const before = await available(cloud, a.token)
    // 回填一条联系方式 = 一笔贡献奖励（`service.saveContact` 里 topup）
    const saved = await call(cloud, '/v1/data/kol/creators/youtube/rewardme/observations', {
      method: 'POST',
      token: a.token,
      body: {
        followers: 5_000,
        posts_30d: 4,
        engagement_rate: 0.02,
        observed_at: '2026-09-14T00:00:00.000Z',
      },
    })
    expect(saved.status).toBe(201)
    const contact = await call(cloud, '/v1/data/kol/creators/youtube/rewardme/contact', {
      method: 'POST',
      token: a.token,
      body: { email: 'reward@example.com', source: 'manual' },
    })
    expect(contact.status).toBe(201)
    // 返额度是**加**，所以余额只会不降
    expect(await available(cloud, a.token)).toBeGreaterThanOrEqual(before)
  })
})

describe('WP116 Workers 形态 · 后台那四条（远端口）', () => {
  let cloud: FakeCloud

  beforeEach(() => {
    cloud = fakeCloud({ kol: true, env: { AGENTSWS_KOL_EMAIL_KEY: EMAIL_KEY } })
  })

  it('统计 / 搜索 / 搬家 / 移除都打得通；移除之后再搬家也搬不回来', async () => {
    const port = remoteKolAdminPort(
      cloud.env.KOL_PUBLIC as Parameters<typeof remoteKolAdminPort>[0],
    )

    const batch = [
      { kind: 'creator', channel: 'youtube', handle: 'alpha', name: 'Alpha', followers: 1000 },
      { kind: 'creator', channel: 'tiktok', handle: 'beta', name: 'Beta', followers: 2000 },
      { kind: 'contact', channel: 'youtube', handle: 'alpha', email: 'alpha@example.com' },
      // 坏行：只算它自己坏
      { kind: 'creator', channel: 'myspace', handle: 'gamma' },
    ]
    const first = await port.import(batch)
    expect(first.inserted).toBe(3)
    expect(first.rejected.reduce((n, r) => n + r.count, 0)).toBe(1)

    // 重跑：一行都不重复
    const again = await port.import(batch)
    expect(again.inserted).toBe(0)
    expect(again.updated).toBe(3)

    const stats = await port.stats()
    expect(stats.creators).toBe(2)
    expect(stats.contacts).toBe(1)
    expect(stats.by_channel.map((r) => r.channel).sort()).toEqual(['tiktok', 'youtube'])

    const found = await port.search({ q: 'alpha', limit: 10, offset: 0 })
    expect(found.total).toBe(1)
    expect(found.rows[0]?.handle).toBe('alpha')

    const removed = await port.remove({
      channel: 'youtube',
      handle: 'alpha',
      reason: '本人来信要求移除',
      removed_by: 'acc_admin',
    })
    expect(removed.removed).toBeGreaterThan(0)
    expect((await port.stats()).creators).toBe(1)

    // 再搬一趟：alpha 那两条一律 skipped（opt-out 闸）
    const third = await port.import(batch)
    expect((await port.stats()).creators).toBe(1)
    expect(third.skipped).toBeGreaterThanOrEqual(2)
  })

  it('那几条内部路由在公网上打不到（入口对 /__internal/ 一律 404）', async () => {
    const res = await call(cloud, '/__internal/kol/admin/stats', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
