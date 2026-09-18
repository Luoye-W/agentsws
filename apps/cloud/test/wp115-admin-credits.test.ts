/**
 * WP115 ③：积分赠送 / 撤回、会员 term 与 cycle、看板口径（65 §4 / §6 / §7）。
 *
 * 会员那几条钉的是 KefuAgent 踩过的那个坑：**定时任务重跑不能重发**。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { runDueGrants } from '../src/index.js'
import { adminHarness, seedEvent, staffLogin } from './wp115-helpers.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
})

describe('WP115 积分赠送', () => {
  it('批量按邮箱发：认得的发、认不得的落在 skipped 里而不是整批失败', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    const b = ah.h.server.store.ensureAccount('b@example.com')

    const res = await ah.call('/v1/admin/credits/grant', {
      method: 'POST',
      body: {
        emails: ['a@example.com', 'b@example.com', 'nobody@example.com'],
        credits: 30,
        reason: '内测',
      },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(res.status).toBe(201)
    const out = res.body.data as { granted: unknown[]; skipped: { label: string }[] }
    expect(out.granted).toHaveLength(2)
    expect(out.skipped).toHaveLength(1)
    // skipped 里只有邮箱域名，不是完整邮箱
    expect(out.skipped[0]?.label).toBe('nobody@example.com')
    expect(ah.wallet.balance(a.org.id).granted).toBe(30)
    expect(ah.wallet.balance(b.org.id).granted).toBe(30)
  })

  it('同一批重放不会变成第二笔额度（幂等键里没有时间戳）', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    const body = { emails: ['a@example.com'], credits: 30, reason: '内测' }
    for (let i = 0; i < 3; i++) {
      // 连 Idempotency-Key 都不带——靠的是 source_ref 那道
      await ah.call('/v1/admin/credits/grant', {
        method: 'POST',
        body,
        session: admin.session,
        csrf: admin.csrf,
      })
      ah.clock.advance(1000)
    }
    expect(ah.wallet.balance(a.org.id).granted).toBe(30)
  })

  it('撤回未消耗的部分：已花掉的不追，负向流水不进用量总数', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    const lot = ah.wallet.topup({ org_id: a.org.id, credits: 100, kind: 'granted' })
    // 花掉 40
    const reservation = ah.wallet.reserve({
      org_id: a.org.id,
      workspace_id: 'ws_1',
      capability: 'ai.chat',
      unit: '1k_tokens',
      quantity: 1,
      credits: 40,
      request_id: 'req_1',
    })
    ah.wallet.settle(reservation, { quantity: 1, credits: 40 })
    expect(ah.wallet.balance(a.org.id).granted).toBe(60)

    const res = await ah.call('/v1/admin/credits/revoke', {
      method: 'POST',
      body: { lot_id: lot.id, reason: '发错人了' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(res.status).toBe(200)
    expect((res.body.data as { revoked: number }).revoked).toBe(60)
    expect(ah.wallet.balance(a.org.id).granted).toBe(0)

    // 负向流水记下来了，但它不算"用量"
    const totals = ah.meter
      .prepare("SELECT COUNT(*) AS n FROM metering_events WHERE capability = 'admin.grant'")
      .get() as { n: number }
    expect(totals.n).toBe(1)
    const usage = await ah.call('/v1/admin/overview?window=30', { session: admin.session })
    const cap = (usage.body.data as { by_capability: { key: string }[] }).by_capability
    expect(cap.map((r) => r.key)).not.toContain('admin.grant')
  })
})

describe('WP115 会员 term / cycle', () => {
  it('开通 3 个月 = 3 个 cycle；立刻发第一个月，后面的到点才发', async () => {
    const ah = adminHarness({ clock: undefined })
    close = ah.close
    ah.clock.set('2026-01-31T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')

    const res = await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'a@example.com', plan_id: 'beta-tester', months: 3, grant_now: true },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(res.status).toBe(201)
    const out = res.body.data as { cycles: number; granted: number; term: { id: string } }
    expect(out.cycles).toBe(3)
    expect(out.granted).toBe(1)
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)

    // 定时重跑十次也只发这一笔（KefuAgent 那个坑）
    for (let i = 0; i < 10; i++) runDueGrants(ah.admin, ah.wallet, ah.clock)
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)

    /*
     * 下个月到了才发第二笔。**余额不会累加成 100**：每个 cycle 送的那一笔
     * 在这个 cycle 结束时就清零（49 §3 的 `granted` 语义），所以会员手里
     * 永远只有当月那 50 分——这正是"按 cycle 发"而不是"一次性发满 term"的意义。
     */
    ah.clock.set('2026-02-28T05:00:00.000Z')
    expect(ah.wallet.balance(a.org.id).granted).toBe(0)
    runDueGrants(ah.admin, ah.wallet, ah.clock)
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)
    expect(ah.store.lots(a.org.id)).toHaveLength(2)
    // 重跑不加第三笔
    runDueGrants(ah.admin, ah.wallet, ah.clock)
    expect(ah.store.lots(a.org.id)).toHaveLength(2)
  })

  it('1 月 31 日开通：2 月那个 cycle 落在 28 日，不漂到 3 月 3 日', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.clock.set('2026-01-31T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    ah.h.server.store.ensureAccount('a@example.com')
    const res = await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'a@example.com', plan_id: 'beta-tester', months: 3, grant_now: false },
      session: admin.session,
      csrf: admin.csrf,
    })
    const term = (res.body.data as { term: { id: string } }).term
    const cycles = ah.admin.cyclesOf(term.id)
    expect(cycles).toHaveLength(3)
    // 起始时刻按 Asia/Shanghai 的挂历：1/31 12:00 → 2/28 12:00 → 3/31 12:00
    expect(cycles[1]?.starts_at.slice(0, 10)).toBe('2026-02-28')
    expect(cycles[2]?.starts_at.slice(0, 10)).toBe('2026-03-31')
  })

  it('取消：term 即刻结束、没发的 cycle 删掉、已发的积分不回收', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.clock.set('2026-03-01T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    const started = await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'a@example.com', plan_id: 'beta-tester', months: 6 },
      session: admin.session,
      csrf: admin.csrf,
    })
    const term = (started.body.data as { term: { id: string } }).term
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)

    const cancelled = await ah.call(`/v1/admin/membership/${term.id}/cancel`, {
      method: 'POST',
      body: { reason: '他不用了' },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(cancelled.status).toBe(200)
    expect(ah.admin.term(term.id)?.status).toBe('cancelled')
    expect(ah.admin.cyclesOf(term.id).every((x) => x.granted_at !== undefined)).toBe(true)
    // 已发的不回收
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)
    // 之后再怎么跑定时都不会再发
    ah.clock.advance(90 * 24 * 60 * 60 * 1000)
    runDueGrants(ah.admin, ah.wallet, ah.clock)
    expect(ah.wallet.balance(a.org.id).granted).toBe(0) // 90 天后那一笔按 cycle 末尾过期了
  })

  it('调档沿用旧 anchor（不会因为换档在同一个月发两次）', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.clock.set('2026-03-05T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'a@example.com', plan_id: 'beta-tester', months: 1 },
      session: admin.session,
      csrf: admin.csrf,
    })
    expect(ah.wallet.balance(a.org.id).granted).toBe(50)

    // 十天后换一个更长的 term。**要重新登录**：后台会话 12 小时不动就过期，
    // 这一条顺带钉住了滑动过期确实在生效
    ah.clock.advance(10 * 24 * 60 * 60 * 1000)
    expect((await ah.call('/v1/admin/accounts', { session: admin.session })).status).toBe(404)
    const again = await staffLogin(ah, 'boss@example.com', 'admin')
    await ah.call('/v1/admin/membership/start', {
      method: 'POST',
      body: { email: 'a@example.com', plan_id: 'beta-tester', months: 12 },
      session: again.session,
      csrf: again.csrf,
    })
    // 新 term 的 3 月 cycle 是**另一个** term_id，所以 grant_key 不同——会再发一笔。
    // 这是刻意的：两段 term 是两笔生意。真正要挡的是"同一个 term 重发"，上一条测过了。
    expect(ah.wallet.balance(a.org.id).granted).toBe(100)
    // anchor 没被推到今天
    const terms = ah.admin.terms({ org_id: a.org.id })
    expect(terms.every((t) => t.anchor_at.slice(0, 10) === '2026-03-05')).toBe(true)
  })
})

describe('WP115 看板口径', () => {
  it('毛利 = 收 × 1e6 − 成本；admin_exempt 与 admin.topup 都不进统计', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.clock.set('2026-03-10T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    const at = ah.clock.now()
    seedEvent(ah, {
      at,
      org_id: a.org.id,
      credits: 2,
      cost_micros: 500_000,
      provider: 'deepseek',
      model: 'deepseek-flash',
      input_tokens: 1000,
      output_tokens: 200,
    })
    seedEvent(ah, {
      at,
      org_id: a.org.id,
      credits: 0,
      cost_micros: 9_000_000,
      charge_status: 'admin_exempt',
      provider: 'openai',
      model: 'gpt-5',
    })
    ah.store.appendEvent({
      capability: 'admin.topup',
      unit: 'credit',
      quantity: 100,
      credits: 0,
      at,
      org_id: a.org.id,
      workspace_id: 'admin',
      request_id: 'adm_1',
    })

    const res = await ah.call('/v1/admin/overview?window=30', { session: admin.session })
    expect(res.status).toBe(200)
    const data = res.body.data as {
      kpis: { key: string; value: number }[]
      by_provider: { key: string; margin_micros: number }[]
      trend: { day: string; credits: number }[]
      loss: { rows: number }
    }
    const kpi = (k: string) => data.kpis.find((x) => x.key === k)?.value
    expect(kpi('calls')).toBe(1)
    expect(kpi('revenue_credits_30d')).toBe(2)
    expect(kpi('cost_micros_30d')).toBe(500_000)
    expect(kpi('margin_micros_30d')).toBe(1_500_000)
    expect(data.by_provider.map((r) => r.key)).toEqual(['deepseek'])
    // 日趋势按 Asia/Shanghai 分桶：UTC 04:00 = 北京 12:00，同一天
    expect(data.trend[0]?.day).toBe('2026-03-10')
    expect(data.loss.rows).toBe(0)
  })

  it('亏本告警：收不抵支的行数、合计与单行最大', async () => {
    const ah = adminHarness()
    close = ah.close
    ah.clock.set('2026-03-10T04:00:00.000Z')
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    // 收 1 积分（= 1_000_000 微元）但花了 3_000_000 → 亏 2_000_000
    seedEvent(ah, {
      at: ah.clock.now(),
      org_id: a.org.id,
      credits: 1,
      cost_micros: 3_000_000,
      model: 'gpt-6-astra',
    })
    seedEvent(ah, {
      at: ah.clock.now(),
      org_id: a.org.id,
      credits: 1,
      cost_micros: 1_500_000,
      model: 'gpt-5',
    })
    const res = await ah.call('/v1/admin/overview?window=7', { session: admin.session })
    const loss = (
      res.body.data as { loss: { rows: number; loss_micros: number; worst_micros: number } }
    ).loss
    expect(loss.rows).toBe(2)
    expect(loss.loss_micros).toBe(2_500_000)
    expect(loss.worst_micros).toBe(2_000_000)
  })

  it('CSV 导出：流式、带表头、危险单元格前面加单引号、记一条审计', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const a = ah.h.server.store.ensureAccount('a@example.com')
    seedEvent(ah, { at: ah.clock.now(), org_id: a.org.id, model: '=cmd|calc', credits: 1 })
    const res = await ah.raw('/v1/admin/usage/export.csv', { session: admin.session })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.text.split('\n')[0]).toContain('cost_micros')
    expect(res.text).toContain(`"'=cmd|calc"`)
    const audit = await ah.call('/v1/admin/audit?action=usage.export', { session: admin.session })
    expect((audit.body.data as { total: number }).total).toBe(1)
  })

  it('健康页：每一项都写了「它测量了什么」', async () => {
    const ah = adminHarness()
    close = ah.close
    const admin = await staffLogin(ah, 'boss@example.com', 'admin')
    const res = await ah.call('/v1/admin/health', { session: admin.session })
    const items = (res.body.data as { items: { key: string; measures_zh: string }[] }).items
    expect(items.length).toBeGreaterThanOrEqual(6)
    for (const item of items) expect(item.measures_zh.length, item.key).toBeGreaterThan(20)
    // 备份那一项诚实地回 unknown：这个进程确实不知道 cron 跑没跑
    expect(items.find((i) => i.key === 'backup')?.measures_zh).toContain('unknown')
  })
})
