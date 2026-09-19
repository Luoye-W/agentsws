/**
 * WP115 在 **Workers 形态**下走完整条路（65 §9 / docs/64）。
 *
 * 每一条都从**入口 Worker** 进，所以测的是真链路：擦头 → 路由分流 →
 * `AccountsDO`（后台的库与会话）→ 按组织敲 `WalletDO`（钱）→ 单例 `LedgerDO`
 * （读账）。
 *
 * 这一组要钉的是"分成三个对象之后还对不对"：
 *
 * 1. 引导第一个管理员 → 后台会话（cookie）→ 用户列表；
 * 2. 封禁 / 删除护栏在这一侧一条不少；
 * 3. 发积分落到**对的那个 WalletDO**、撤回与负向流水在同一个对象里；
 * 4. 会员 term 的 cycle 跨对象发，重跑不重发；
 * 5. **抄写与重投**：Ledger 挂了不影响扣费，恢复之后补上，且不重复；
 * 6. 聚合口径与 Compose 形态一致（同一段 SQL，只是库换了）。
 */

import { isSignupBonusRef } from '@agentsws/metering'
import { describe, expect, it } from 'vitest'
import { LEDGER_INTERNAL, route } from '../src/index.js'
import { type FakeCloud, fakeCloud, req, SIGNUP_BONUS, tokenFromMail } from './helpers.js'

const ADMIN_TOKEN = 'test-admin-token-at-least-32-bytes-long-0123456789'

interface Json {
  data?: unknown
  code?: string
  message?: string
}

async function call(
  cloud: FakeCloud,
  path: string,
  init: {
    method?: string
    body?: unknown
    session?: string
    csrf?: string
    headers?: Record<string, string>
  } = {},
): Promise<{ status: number; body: Json; res: Response }> {
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const cookies: string[] = []
  if (init.session !== undefined) cookies.push(`__Host-agentsws_admin=${init.session}`)
  if (init.csrf !== undefined) {
    cookies.push(`agentsws_admin_csrf=${init.csrf}`)
    headers.set('X-Agentsws-Csrf', init.csrf)
  }
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '))
  const res = await route(
    req(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    cloud.env,
  )
  const text = await res.clone().text()
  let body: Json = {}
  try {
    body = text === '' ? {} : (JSON.parse(text) as Json)
  } catch {
    body = {}
  }
  return { status: res.status, body, res }
}

function admins(): FakeCloud {
  return fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
}

/** 引导一个 admin，走 magic link 拿两张 cookie。 */
async function login(
  cloud: FakeCloud,
  email: string,
): Promise<{ session: string; csrf: string; account_id: string }> {
  const boot = await call(cloud, '/v1/admin/bootstrap', {
    method: 'POST',
    body: { email },
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(boot.status, JSON.stringify(boot.body)).toBe(201)
  const account_id = (boot.body.data as { account_id: string }).account_id

  const before = cloud.mails.length
  const sent = await call(cloud, '/v1/admin/auth/magic-link', { method: 'POST', body: { email } })
  expect(sent.status).toBe(200)
  expect(cloud.mails.length).toBe(before + 1)
  const oneTime = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)

  const cb = await call(cloud, `/admin/callback?token=${encodeURIComponent(oneTime)}`)
  expect(cb.status).toBe(302)
  const cookies = cb.res.headers.getSetCookie()
  const pick = (name: string): string => {
    const line = cookies.find((c) => c.startsWith(`${name}=`))
    if (line === undefined) throw new Error(`没有 ${name}：${cookies.join(' | ')}`)
    return decodeURIComponent(line.slice(name.length + 1).split(';')[0] ?? '')
  }
  return { session: pick('__Host-agentsws_admin'), csrf: pick('agentsws_admin_csrf'), account_id }
}

/** 建一个普通用户（顺手拿到他的组织号）。 */
async function makeUser(cloud: FakeCloud, email: string): Promise<string> {
  const sent = await call(cloud, '/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: 'http://127.0.0.1:3000/v1/cloud/account/callback' },
  })
  expect(sent.status).toBe(200)
  const token = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
  const verified = await call(cloud, '/v1/cloud/auth/verify', { method: 'POST', body: { token } })
  return (verified.body.data as { org: { id: string } }).org.id
}

describe('WP115 Workers 形态 · 守卫与登录', () => {
  it('没会话：/v1/admin/* 与 /admin/* 都是 404（连后台的壳都拿不到）', async () => {
    const cloud = admins()
    for (const path of ['/v1/admin/me', '/v1/admin/accounts', '/v1/admin/overview', '/admin/']) {
      const res = await call(cloud, path)
      expect(res.status, path).toBe(404)
    }
    // 登录页是公开的——不公开它就没有人进得去
    expect((await call(cloud, '/admin/login')).status).toBe(200)
  })

  it('引导 → 登录 → 有会话之后 /admin/ 才拿得到静态壳', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const me = await call(cloud, '/v1/admin/me', { session: staff.session })
    expect(me.status).toBe(200)
    expect((me.body.data as { role: string }).role).toBe('admin')

    const shell = await call(cloud, '/admin/', { session: staff.session })
    expect(shell.status).toBe(200)
    expect(await shell.res.clone().text()).toContain('Agents 工坊')
  })

  it('不是 staff 的邮箱：magic-link 回一样的话，一封信都不发', async () => {
    const cloud = admins()
    await makeUser(cloud, 'outsider@example.com')
    const before = cloud.mails.length
    const res = await call(cloud, '/v1/admin/auth/magic-link', {
      method: 'POST',
      body: { email: 'outsider@example.com' },
    })
    expect(res.status).toBe(200)
    expect(cloud.mails.length).toBe(before)
  })
})

describe('WP115 Workers 形态 · 钱跨对象', () => {
  it('发积分落到对的那个 WalletDO；列表页看得到（读的是 Ledger 副本）', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'shop@example.com')

    const granted = await call(cloud, '/v1/admin/credits/grant', {
      method: 'POST',
      body: { emails: ['shop@example.com'], credits: 120, reason: '内测' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(granted.status, JSON.stringify(granted.body)).toBe(201)
    // 钱真的进了那个组织自己的对象（120 是这条用例发的，另一笔是 WP121 注册赠送）
    expect(cloud.wallet(org).wallet.balance(org).granted).toBe(120 + SIGNUP_BONUS)

    await cloud.settle()
    // 副本里也有那一笔（发放流水），所以列表页与"积分与会员"那一页看得见
    const page = await call(cloud, '/v1/admin/credits', { session: staff.session })
    expect(page.status).toBe(200)
    const grants = (page.body.data as { grants: { rows: { org_id: string }[] } }).grants
    expect(grants.rows.map((r) => r.org_id)).toContain(org)

    // 抽屉里的余额问的是**真值**（按组织敲 WalletDO），不是副本
    const drawer = await call(cloud, `/v1/admin/orgs/${org}`, { session: staff.session })
    expect((drawer.body.data as { balance: { granted: number } }).balance.granted).toBe(
      120 + SIGNUP_BONUS,
    )
  })

  it('撤回未消耗部分：钱与那条负向流水落在同一个对象里', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'shop@example.com')
    const lot = cloud.wallet(org).wallet.topup({ org_id: org, credits: 80, kind: 'granted' })

    const revoked = await call(cloud, '/v1/admin/credits/revoke', {
      method: 'POST',
      body: { lot_id: lot.id, org_id: org, reason: '发错人了' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect((revoked.body.data as { revoked: number }).revoked).toBe(80)
    // 撤的是这一笔 80，WP121 注册赠送那一笔**不该被撤掉**
    expect(cloud.wallet(org).wallet.balance(org).granted).toBe(SIGNUP_BONUS)
    const events = cloud.wallet(org).store.events({ org_id: org })
    expect(events.filter((e) => e.capability === 'admin.grant')).toHaveLength(1)
  })

  it('不给 org_id 的撤回：说清楚为什么不行，不静默回「没找到」', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'shop@example.com')
    const lot = cloud.wallet(org).wallet.topup({ org_id: org, credits: 10, kind: 'granted' })
    const res = await call(cloud, '/v1/admin/credits/revoke', {
      method: 'POST',
      body: { lot_id: lot.id, reason: '试试' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('org_id')
  })

  it('会员 term：cycle 跨对象发，重跑不重发', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'shop@example.com')

    const started = await call(cloud, '/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'shop@example.com', plan_id: 'beta-tester', months: 3, grant_now: false },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(started.status, JSON.stringify(started.body)).toBe(201)
    expect((started.body.data as { cycles: number }).cycles).toBe(3)

    // 第一期由 alarm 发（Workers 形态下会员续发搭在账号对象的闹钟上）
    const first = await cloud.accounts().grantDueCycles()
    expect(first).toBe(1)
    // 这一期的 50 + WP121 注册赠送
    expect(cloud.wallet(org).wallet.balance(org).granted).toBe(50 + SIGNUP_BONUS)

    // 重跑十次也只有那一笔（grant_key 里没有时间戳 + 唯一索引兜底）
    for (let i = 0; i < 10; i++) await cloud.accounts().grantDueCycles()
    // 把 WP121 注册赠送那一笔排掉，剩下的才是会员续发
    const cycleLots = cloud
      .wallet(org)
      .store.lots(org)
      .filter((l) => !isSignupBonusRef(l.source_ref))
    expect(cycleLots).toHaveLength(1)
  })
})

describe('WP115 Workers 形态 · Ledger 抄写', () => {
  it('每条计量事件抄一份进单例 Ledger；聚合读的是那一份', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'shop@example.com')
    const wallet = cloud.wallet(org)
    wallet.wallet.topup({ org_id: org, credits: 100, kind: 'purchased', source_ref: 'seed' })

    const reservation = wallet.wallet.reserve({
      org_id: org,
      workspace_id: 'ws_1',
      capability: 'ai.chat',
      unit: '1k_tokens',
      quantity: 1,
      credits: 2,
      request_id: 'req_1',
    })
    wallet.wallet.settle(reservation, {
      quantity: 1,
      credits: 2,
      provider: 'deepseek',
      model: 'deepseek-flash',
      input_tokens: 1000,
      output_tokens: 500,
      cost_micros: 500_000,
      cost_currency: 'USD',
      charge_status: 'charged',
    })
    // 排队了，但还没抄出去（抄写在响应之后）
    expect(wallet.outbox.size()).toBeGreaterThan(0)
    await wallet.flushOutbox()
    expect(wallet.outbox.size()).toBe(0)

    const overview = await call(cloud, '/v1/admin/overview?window=30', { session: staff.session })
    expect(overview.status, JSON.stringify(overview.body)).toBe(200)
    const kpis = (overview.body.data as { kpis: { key: string; value: number }[] }).kpis
    const kpi = (k: string): number | undefined => kpis.find((x) => x.key === k)?.value
    expect(kpi('calls')).toBe(1)
    expect(kpi('revenue_credits_30d')).toBe(2)
    expect(kpi('cost_micros_30d')).toBe(500_000)
    // 毛利 = 收 × 1e6 − 支（与 Compose 形态同一段 SQL）
    expect(kpi('margin_micros_30d')).toBe(1_500_000)

    const by = (overview.body.data as { by_provider: { key: string }[] }).by_provider
    expect(by.map((r) => r.key)).toEqual(['deepseek'])
  })

  it('Ledger 挂了：扣费照常、队列留着；恢复之后补上，且不重复', async () => {
    const cloud = admins()
    const org = 'org_offline'
    let ledgerUp = false
    const flaky = {
      fetch: async (request: Request): Promise<Response> => {
        if (!ledgerUp) throw new Error('ledger down')
        return cloud.ledger().fetch(request)
      },
    }
    const wallet = cloud.wallet(org)
    wallet.wallet.topup({ org_id: org, credits: 50, kind: 'purchased', source_ref: 'seed' })
    const reservation = wallet.wallet.reserve({
      org_id: org,
      workspace_id: 'ws_1',
      capability: 'ai.chat',
      unit: '1k_tokens',
      quantity: 1,
      credits: 1,
      request_id: 'req_down',
    })
    wallet.wallet.settle(reservation, { quantity: 1, credits: 1, provider: 'deepseek' })

    // 扣费完成了（钱真的少了）——抄写成不成与它无关
    expect(wallet.wallet.balance(org).available).toBe(49)
    const queued = wallet.outbox.size()
    expect(queued).toBeGreaterThan(0)

    // Ledger 还没起来：抄不出去，队列留着，重试次数 +1
    const { copyEventsTo } = await import('../src/index.js')
    expect(await copyEventsTo(flaky, wallet.store.events({ org_id: org }))).toBe(false)
    expect(wallet.outbox.size()).toBe(queued)

    // 起来了：补上
    ledgerUp = true
    expect(await copyEventsTo(flaky, wallet.store.events({ org_id: org }))).toBe(true)
    // 再投一次：唯一索引把它挡回来（`copied` 为 0，不是报错）
    const again = await cloud.ledger().fetch(
      new Request(`https://do.internal${LEDGER_INTERNAL.events}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          wallet.store.events({ org_id: org }).map((e) => ({
            ...e,
            event_id: `${e.org_id}|${e.request_id}|${e.at}|${e.capability}`,
          })),
        ),
      }),
    )
    expect(await again.json()).toEqual({ received: 1, copied: 0 })
  })

  it('没绑 LEDGER：看板回 503（不画一堆 0），钱那一侧一个字不受影响', async () => {
    const cloud = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    // 把 binding 摘掉，重新走一遍（AccountsDO 在构造时读它）
    const noLedger = fakeCloud({ env: { AGENTSWS_CLOUD_ADMIN_TOKEN: ADMIN_TOKEN } })
    noLedger.env.LEDGER = undefined
    const staff = await login(noLedger, 'boss@example.com')
    const overview = await call(noLedger, '/v1/admin/overview', { session: staff.session })
    expect(overview.status).toBe(503)
    // 但写动作照常（那一侧不依赖 Ledger）
    const org = await makeUser(noLedger, 'shop@example.com')
    const granted = await call(noLedger, '/v1/admin/credits/grant', {
      method: 'POST',
      body: { org_ids: [org], credits: 10, reason: '内测' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(granted.status).toBe(201)
    // 这条用例发的 10 + WP121 注册赠送
    expect(noLedger.wallet(org).wallet.balance(org).granted).toBe(10 + SIGNUP_BONUS)
    expect(cloud.env.LEDGER).toBeDefined()
  })
})

describe('WP115 Workers 形态 · 用户管理', () => {
  it('封禁 → 删除五道护栏 → 钱与账匿名化留着', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'a.b+tag@gmail.com')
    cloud
      .wallet(org)
      .wallet.topup({ org_id: org, credits: 30, kind: 'purchased', source_ref: 'p1' })
    await cloud.settle()

    const list = await call(cloud, '/v1/admin/accounts', { session: staff.session })
    const rows = (list.body.data as { rows: { email: string; account_id: string }[] }).rows
    const victim = rows.find((r) => r.email === 'a.b+tag@gmail.com')
    expect(victim).toBeDefined()
    const id = victim?.account_id ?? ''

    // ① 没封禁就删 → 拦
    let res = await call(cloud, `/v1/admin/accounts/${id}/delete`, {
      method: 'POST',
      body: { email_confirm: 'a.b+tag@gmail.com', reason: '跑路' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(res.status).toBe(400)

    await call(cloud, `/v1/admin/accounts/${id}/ban`, {
      method: 'POST',
      body: { reason: '跑路' },
      session: staff.session,
      csrf: staff.csrf,
    })

    // ② 邮箱打错 → 拦
    res = await call(cloud, `/v1/admin/accounts/${id}/delete`, {
      method: 'POST',
      body: { email_confirm: 'ab@gmail.com', reason: '跑路' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(res.status).toBe(400)

    // ③ 真删
    res = await call(cloud, `/v1/admin/accounts/${id}/delete`, {
      method: 'POST',
      body: { email_confirm: 'a.b+tag@gmail.com', reason: '跑路' },
      session: staff.session,
      csrf: staff.csrf,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    // 钱与账**没被删掉**，只是指不回人了（跨对象也一样）
    const lots = cloud.wallet(org).store.lots(org)
    expect(lots).toHaveLength(0)
    const tomb = cloud.wallet(org).store.lots(`org_deleted_${org.slice(-8)}`)
    // 这条用例发的 30，外加 WP121 注册赠送那一笔——匿名化是把**每一笔**都搬过去
    expect(tomb.filter((l) => !isSignupBonusRef(l.source_ref))).toEqual([
      expect.objectContaining({ credits: 30 }),
    ])
    expect(tomb).toHaveLength(SIGNUP_BONUS > 0 ? 2 : 1)

    // 邮箱与规范化别名都进了黑名单
    expect(cloud.accounts().admin.emailBanned('a.b+tag@gmail.com')).toBe(true)
    expect(cloud.accounts().admin.emailBanned('ab@gmail.com')).toBe(true)
  })

  it('support 只读：写接口一律 404', async () => {
    const cloud = admins()
    const staff = await login(cloud, 'boss@example.com')
    const org = await makeUser(cloud, 'help@example.com')
    const list = await call(cloud, '/v1/admin/accounts', { session: staff.session })
    const rows = (list.body.data as { rows: { email: string; account_id: string }[] }).rows
    const helper = rows.find((r) => r.email === 'help@example.com')?.account_id ?? ''
    await call(cloud, `/v1/admin/accounts/${helper}/role`, {
      method: 'POST',
      body: { role: 'support' },
      session: staff.session,
      csrf: staff.csrf,
    })
    const support = await (async () => {
      const before = cloud.mails.length
      await call(cloud, '/v1/admin/auth/magic-link', {
        method: 'POST',
        body: { email: 'help@example.com' },
      })
      expect(cloud.mails.length).toBe(before + 1)
      const token = tokenFromMail(cloud.mails[cloud.mails.length - 1] as never)
      const cb = await call(cloud, `/admin/callback?token=${encodeURIComponent(token)}`)
      const cookies = cb.res.headers.getSetCookie()
      const pick = (name: string): string =>
        decodeURIComponent(
          (cookies.find((c) => c.startsWith(`${name}=`)) ?? '')
            .slice(name.length + 1)
            .split(';')[0] ?? '',
        )
      return { session: pick('__Host-agentsws_admin'), csrf: pick('agentsws_admin_csrf') }
    })()

    expect((await call(cloud, '/v1/admin/accounts', { session: support.session })).status).toBe(200)
    const denied = await call(cloud, '/v1/admin/credits/grant', {
      method: 'POST',
      body: { org_ids: [org], credits: 5, reason: '试试' },
      session: support.session,
      csrf: support.csrf,
    })
    expect(denied.status).toBe(404)
  })
})
