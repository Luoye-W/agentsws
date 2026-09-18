/**
 * WP115 ②：用户管理动作（65 §5）与审计。
 *
 * 删除那一条是整个后台里唯一不可逆的动作，所以它的测试也最长：五道护栏各试一次，
 * 再验"钱与账留下来了、邮箱与它的别名进了黑名单"。
 */

import { normalizeEmailAlias } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { adminHarness, seedEvent, staffLogin } from './wp115-helpers.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

describe('WP115 用户管理', () => {
  it('封禁要理由、封了就断线、解封写 lifted_at 不删行', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')
    // 给他一张活着的云账号会话，验"封了就断线"
    const login = ah.h.server.store.issueLogin(victim.account.id)
    const session = ah.h.server.store.verifyLogin(login.token)?.session_token ?? ''

    const noReason = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: {},
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(noReason.status).toBe(400)

    const banned = await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '刷接口' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(banned.status).toBe(201)
    expect(ah.admin.activeBan(victim.account.id)?.reason).toBe('刷接口')
    expect(ah.h.server.store.session(session)).toBeUndefined()

    const lifted = await ah.call(`/v1/admin/accounts/${victim.account.id}/unban`, {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(lifted.status).toBe(200)
    expect(ah.admin.activeBan(victim.account.id)).toBeUndefined()
    // 行还在：谁在什么时候封过必须查得到
    const rows = ah.admin.db
      .prepare('SELECT COUNT(*) AS n FROM account_bans WHERE account_id = ?')
      .get(victim.account.id) as { n: number }
    expect(rows.n).toBe(1)
  })

  it('到期的封禁自动失效（判在读的时候，不靠定时任务）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')
    const expires_at = new Date(Date.parse(ah.clock.now()) + 60_000).toISOString()
    await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '冷静一小时', expires_at },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(ah.admin.activeBan(victim.account.id)).toBeDefined()
    ah.clock.advance(120_000)
    expect(ah.admin.activeBan(victim.account.id)).toBeUndefined()
  })

  it('改角色：不能改自己、不能把最后一个 admin 降掉', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const self = await ah.call(`/v1/admin/accounts/${admin.account_id}/role`, {
      method: 'POST',
      body: { role: 'user' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(self.status).toBe(400)

    // 换另一个 admin 来降他：只剩一个 admin 时也要被拦住
    const other = await staffLogin(ah, 'second@example.com', 'admin')
    const downOther = await ah.call(`/v1/admin/accounts/${other.account_id}/role`, {
      method: 'POST',
      body: { role: 'support' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(downOther.status).toBe(200)
    // 现在只剩 boss 一个 admin，support 那位没法再降他（他也降不了自己）
    expect(ah.admin.adminCount()).toBe(1)
  })

  it('删除：五道护栏 + 钱与账留下来并匿名化 + 邮箱别名进黑名单', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('a.b+tag@gmail.com')
    const orgId = victim.org.id
    ah.wallet.topup({ org_id: orgId, credits: 20, kind: 'purchased', source_ref: 'pay_1' })
    seedEvent(ah, { at: ah.clock.now(), org_id: orgId, credits: 3, cost_micros: 1_000_000 })

    const del = (body: unknown) =>
      ah.call(`/v1/admin/accounts/${victim.account.id}/delete`, {
        method: 'POST',
        body,
        session: admin.session,
        csrf: admin.csrf,
      })

    // ① 没封禁就删 → 拦
    let res = await del({ email_confirm: 'a.b+tag@gmail.com', reason: '退款后跑路' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('先封禁')

    await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '退款后跑路' },
      session: admin.session,
      csrf: admin.csrf,
    })

    // ② 邮箱打错 → 拦
    res = await del({ email_confirm: 'ab@gmail.com', reason: '退款后跑路' })
    expect(res.status).toBe(400)

    // ③ 删自己 → 拦（连封禁都不用先做，它在最前面）
    res = await ah.call(`/v1/admin/accounts/${admin.account_id}/delete`, {
      method: 'POST',
      body: { email_confirm: 'boss@example.com', reason: '手滑' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(res.status).toBe(400)

    // ④ 真删
    res = await del({ email_confirm: 'a.b+tag@gmail.com', reason: '退款后跑路' })
    expect(res.status).toBe(200)
    const out = res.body.data as { deleted: boolean; orgs: number; anonymized_rows: number }
    expect(out.deleted).toBe(true)
    expect(out.orgs).toBe(1)
    expect(out.anonymized_rows).toBeGreaterThan(0)

    // ⑤ 钱与账**没被删掉**，只是指不回人了（账要对得上）
    const events = ah.meter
      .prepare('SELECT COUNT(*) AS n, SUM(credits) AS credits FROM metering_events')
      .get() as { n: number; credits: number }
    expect(events.n).toBe(1)
    expect(events.credits).toBe(3)
    const stillMine = ah.meter
      .prepare('SELECT COUNT(*) AS n FROM metering_events WHERE org_id = ?')
      .get(orgId) as { n: number }
    expect(stillMine.n).toBe(0)

    // 邮箱与**规范化别名**都进了黑名单：`ab@gmail.com` 也回不来
    expect(ah.admin.emailBanned('a.b+tag@gmail.com')).toBe(true)
    expect(ah.admin.emailBanned('ab@gmail.com')).toBe(true)
    expect(normalizeEmailAlias('A.B+other@Gmail.com')).toBe('ab@gmail.com')
    expect(ah.admin.emailBanned('someoneelse@gmail.com')).toBe(false)
  })

  it('不能删管理员（先降级再说）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const other = await staffLogin(ah, 'second@example.com', 'admin')
    await ah.call(`/v1/admin/accounts/${other.account_id}/ban`, {
      method: 'POST',
      body: { reason: '试试' },
      session: admin.session,
      csrf: admin.csrf,
    })
    const res = await ah.call(`/v1/admin/accounts/${other.account_id}/delete`, {
      method: 'POST',
      body: { email_confirm: 'second@example.com', reason: '试试' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('管理员')
  })

  it('审计：危险动作先写 intent 再写 done，details 里没有完整邮箱', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const victim = ah.h.server.store.ensureAccount('victim@example.com')
    await ah.call(`/v1/admin/accounts/${victim.account.id}/ban`, {
      method: 'POST',
      body: { reason: '刷接口' },
      session: admin.session,
      csrf: admin.csrf,
    })
    const page = await ah.call('/v1/admin/audit', { session: admin.session })
    const rows = (page.body.data as { rows: { action: string; outcome: string }[] }).rows
    const bans = rows.filter((r) => r.action === 'account.ban')
    expect(bans.map((r) => r.outcome).sort()).toEqual(['done', 'intent'])
    // 登录也有一条
    expect(rows.some((r) => r.action === 'admin.login')).toBe(true)
    const raw = JSON.stringify(rows)
    expect(raw).not.toContain('victim@example.com')
  })

  it('组织停用 / 恢复 + 吊销关联令牌（抽屉里只显示前缀与动作集）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const user = ah.h.server.store.ensureAccount('shop@example.com')
    const issued = ah.h.server.store.createLink({
      workspace_id: 'ws_a',
      cloud_org_id: user.org.id,
      created_by: user.account.id,
    })

    const drawer = await ah.call(`/v1/admin/orgs/${user.org.id}`, { session: admin.session })
    expect(drawer.status).toBe(200)
    const body = drawer.body.data as { links: { prefix: string; active: boolean }[] }
    expect(body.links[0]?.prefix).toBe('wst_')
    expect(body.links[0]?.active).toBe(true)
    // 令牌明文与哈希一个字节都不该出现在抽屉里
    expect(JSON.stringify(body)).not.toContain(issued.token)
    expect(JSON.stringify(body)).not.toContain(issued.link.token_sha256)

    const suspended = await ah.call(`/v1/admin/orgs/${user.org.id}/suspend`, {
      method: 'POST',
      body: { reason: '欠费' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(suspended.status).toBe(200)
    expect(ah.admin.orgSuspension(user.org.id)?.reason).toBe('欠费')

    const revoked = await ah.call(`/v1/admin/links/${issued.link.id}/revoke`, {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(revoked.status).toBe(200)
    expect(await ah.h.server.verifyToken(issued.token)).toBeUndefined()

    await ah.call(`/v1/admin/orgs/${user.org.id}/resume`, {
      method: 'POST',
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(ah.admin.orgSuspension(user.org.id)).toBeUndefined()
  })

  it('用户列表：徽章优先级 封禁 > 会员 > 付费过 > 免费，两类积分分开显示', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const free = ah.h.server.store.ensureAccount('free@example.com')
    const paid = ah.h.server.store.ensureAccount('paid@example.com')
    const member = ah.h.server.store.ensureAccount('member@example.com')
    const bad = ah.h.server.store.ensureAccount('bad@example.com')

    ah.wallet.topup({ org_id: paid.org.id, credits: 100, kind: 'purchased', source_ref: 'pay_1' })
    ah.wallet.topup({ org_id: member.org.id, credits: 50, kind: 'granted' })
    ah.wallet.topup({ org_id: bad.org.id, credits: 10, kind: 'purchased', source_ref: 'pay_2' })
    await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { org_id: member.org.id, plan_id: 'beta-tester', months: 3 },
      session: admin.session,
      csrf: admin.csrf,
    })
    await ah.call(`/v1/admin/accounts/${bad.account.id}/ban`, {
      method: 'POST',
      body: { reason: '刷接口' },
      session: admin.session,
      csrf: admin.csrf,
    })

    const list = await ah.call('/v1/admin/accounts?limit=50', { session: admin.session })
    const rows = (
      list.body.data as {
        rows: {
          email: string
          badge: string
          credits_granted: number
          credits_purchased: number
        }[]
      }
    ).rows
    const by = (email: string) => rows.find((r) => r.email === email)
    expect(by('free@example.com')?.badge).toBe('free')
    expect(by('paid@example.com')?.badge).toBe('paid')
    expect(by('member@example.com')?.badge).toBe('member')
    // 付了钱但被封了：封禁排在最前
    expect(by('bad@example.com')?.badge).toBe('banned')
    expect(by('paid@example.com')?.credits_purchased).toBe(100)
    expect(by('paid@example.com')?.credits_granted).toBe(0)
  })
})
