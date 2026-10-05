/**
 * WP224（docs/91 §2.2 #1 / #3、§7 #2）：毛利率事实卡、盈亏线并排显示、两条止损线对照、
 * 本周经营一页纸——端到端（起真进程 → 打 HTTP → 过真 guardrail）。
 *
 * 钉的几件事：
 *
 * 1. 毛利率是**一张事实卡**：负责人填的直接生效、清掉是退役（留痕不删）、填错当场 400；
 *    投放那条职责改不了它（策略层写只给负责人）。
 * 2. 止损卡上判据旁边并排一格盈亏线；**自动止损线一个数没动**——ROAS 1.8 照旧不是止损。
 * 3. 两条线的对照从记账那天起逐日攒，按 campaign 汇。
 * 4. 一页纸：数字只从面板取、取不到写「没接」；推给老板是一张 `weekly_review` 卡，
 *    同一周再推一次取代上一张；每周一的定时任务在。
 */
import type { Assignment, GrossMarginsView, WeeklyReviewPayload } from '@agentsws/contracts'
import { isQueueCard } from '@agentsws/deck'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-05T01:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

let server: Server
let url: string
let owner: Assignment
let meta: Assignment

const api = async (
  path: string,
  init: RequestInit & { assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', init.assignment ?? owner.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const put = (path: string, body: unknown, assignment?: string) =>
  api(path, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })
const post = (path: string, body: unknown, assignment?: string) =>
  api(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(assignment === undefined ? {} : { assignment }),
  })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function seedCampaign(roas: number, spend = 400) {
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  const ws = server.bootstrap.workspace.id
  brand.ads.saveAccount({
    id: 'aa_1',
    workspace_id: ws,
    platform: 'meta',
    external_id: 'act_1',
    name: '测试广告账户',
    currency: 'CNY',
    status: 'active',
    observed_at: T0,
  })
  brand.ads.saveCampaign({
    id: 'cmp_1',
    account_id: 'aa_1',
    platform: 'meta',
    external_id: '120000001',
    name: '十月新品',
    status: 'active',
    daily_budget: 1000,
    metrics: { spend, roas, observed_at: T0 },
  })
  return brand
}

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  ;({ url } = await server.listen(0))
  const ws = server.bootstrap.workspace.id
  const base = {
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
  }
  owner =
    server.roles.assignments
      .listByWorkspace(ws)
      .find((a) => a.role_id === 'common.owner' && a.revoked_at === undefined) ??
    server.roles.assignments.create({ ...base, role_id: 'common.owner' })
  meta = server.roles.assignments.create({ ...base, role_id: 'ads.meta' })
})

afterEach(async () => {
  await server.close()
})

describe('毛利率事实卡', () => {
  it('没填就是空的；填一格品牌、一格品类，读回来按品牌 → 品类排', async () => {
    expect(await data<GrossMarginsView>(await api('/v1/economics/margins'))).toEqual({
      entries: [],
    })
    await put('/v1/economics/margins', { scope: 'category', key: '耳机', margin_pct: 30 })
    const view = await data<GrossMarginsView>(
      await put('/v1/economics/margins', { scope: 'brand', margin_pct: 40 }),
    )
    expect(view.entries.map((e) => [e.scope, e.key, e.margin_pct])).toEqual([
      ['brand', undefined, 40],
      ['category', '耳机', 30],
    ])
    // 就是一张事实卡：知识库里查得到，生效、带出处
    const card = await server.knowledge.store.get(view.entries[0]?.fact_card_id ?? '', {
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      assignment_id: owner.id,
      role_id: 'common.owner',
      grants: [
        { domain: 'knowledge', ops: ['read'], range: 'workspace', max_sensitivity: 'internal' },
      ],
    } as never)
    expect(card?.status).toBe('active')
    expect(card?.statement).toContain('毛利率是 40%')
  })

  it('改一格 = 旧卡退役新卡生效；清掉 = 那一格没了（不写 0）', async () => {
    await put('/v1/economics/margins', { scope: 'brand', margin_pct: 40 })
    const changed = await data<GrossMarginsView>(
      await put('/v1/economics/margins', { scope: 'brand', margin_pct: 35 }),
    )
    expect(changed.entries).toHaveLength(1)
    expect(changed.entries[0]?.margin_pct).toBe(35)
    const cleared = await data<GrossMarginsView>(
      await put('/v1/economics/margins', { scope: 'brand', margin_pct: null }),
    )
    expect(cleared.entries).toEqual([])
  })

  it('填错当场 400（0、超过 100、品类不写名）；投放职责改不了它', async () => {
    expect((await put('/v1/economics/margins', { scope: 'brand', margin_pct: 0 })).status).toBe(400)
    expect((await put('/v1/economics/margins', { scope: 'brand', margin_pct: 140 })).status).toBe(
      400,
    )
    expect((await put('/v1/economics/margins', { scope: 'sku', margin_pct: 20 })).status).toBe(400)
    const res = await put('/v1/economics/margins', { scope: 'brand', margin_pct: 40 }, meta.id)
    expect(res.status).toBe(403)
  })
})

describe('止损卡上并排一格盈亏线；自动止损线不动', () => {
  it('填了毛利率 40%：卡上写「盈亏线 ROAS 2.5」；ROAS 1.8 照旧不是止损（转人审）', async () => {
    await seedCampaign(1.8)
    await put('/v1/economics/margins', { scope: 'brand', margin_pct: 40 })
    const out = await data<{ approval_item_id?: string }>(
      await post('/v1/ads/campaigns/cmp_1/pause', { reason: 'stop_loss' }, meta.id),
    )
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    const after = (item?.payload as { after?: Record<string, unknown> } | undefined)?.after ?? {}
    expect(after.break_even_note).toBe('盈亏线 ROAS 2.5（毛利率 40%）')
    expect(after.break_even_roas).toBe(2.5)
    // 现在那条线还是 1：ROAS 1.8 不算止损，不自己走
    expect(item?.automation.auto_approved).toBe(false)
    expect(item?.automation.mandate_check.caps_hit ?? []).toContain('stop_loss_conditions_unmet')
  })

  it('没填毛利率：那一格写「没填毛利率」；真的止损照旧自己走', async () => {
    await seedCampaign(0.6)
    const out = await data<{ approval_item_id?: string }>(
      await post('/v1/ads/campaigns/cmp_1/pause', { reason: 'stop_loss' }, meta.id),
    )
    const item = await server.txn.approvals.get(out.approval_item_id ?? '')
    const after = (item?.payload as { after?: Record<string, unknown> } | undefined)?.after ?? {}
    expect(after.break_even_note).toBe('没填毛利率')
    expect(item?.automation.auto_approved).toBe(true)
  })
})

describe('两条止损线对照', () => {
  it('记一天：ROAS 1.8 现在的线不停、盈亏线会停 → 「只有盈亏线会停」1 天', async () => {
    const brand = await seedCampaign(1.8)
    await put('/v1/economics/margins', { scope: 'brand', margin_pct: 40 })
    expect(await brand.lineCompareSnapshot()).toEqual({ rows: 1, date: '2026-10-05' })
    const view = await data<{
      started_on?: string
      days: number
      summary: { only_break_even_days: number; fixed_stop_days: number }[]
    }>(await api('/v1/economics/line-compare'))
    expect(view.started_on).toBe('2026-10-05')
    expect(view.days).toBe(1)
    expect(view.summary[0]).toMatchObject({ only_break_even_days: 1, fixed_stop_days: 0 })
  })
})

describe('本周经营一页纸', () => {
  it('预览：五段齐、每条发现带数和出处、没人担的写「没接」', async () => {
    const p = await data<WeeklyReviewPayload>(await api('/v1/economics/weekly-review'))
    expect(p.kind).toBe('weekly_review')
    expect(p.week_of).toBe('2026-10-05')
    expect(p.situation).not.toBe('')
    for (const f of p.findings) {
      expect(f.value).not.toBe('')
      expect(f.source).not.toBe('')
    }
    const reasons = Object.fromEntries(p.not_connected.map((g) => [g.panel, g.reason]))
    expect(reasons.kol_attribution).toBe('没人担红人营销')
    expect(reasons.support_volume).toBe('没人担客服')
    expect(p.length).toBeLessThanOrEqual(500)
  })

  it('推给老板：一张 weekly_review 卡（L3 出、不进队列）；同一周再推是同一张的新一版', async () => {
    const first = await data<{ approval_item_id?: string }>(
      await post('/v1/economics/weekly-review/run', {}),
    )
    const item = await server.txn.approvals.get(first.approval_item_id ?? '')
    expect(item?.kind).toBe('weekly_review')
    expect(item?.role_id).toBe('common.owner')
    expect(item?.routing.recipients[0]?.person).toBe(owner.person_id)
    // 同日报 / 搜索报告：L3 出、不进审批队列（deck 的 NOT_A_CARD），面板上是一块报表
    expect(item?.automation.level_at_creation).toBe('L3')
    expect(isQueueCard(item?.kind ?? 'weekly_review')).toBe(false)
    const second = await data<{ approval_item_id?: string }>(
      await post('/v1/economics/weekly-review/run', {}),
    )
    // 上一张还没看（没归档）：同一张卡出新一版，不是一周两张
    expect(second.approval_item_id).toBe(first.approval_item_id)
    const newer = await server.txn.approvals.get(second.approval_item_id ?? '')
    expect(newer?.revision).toBe(2)
  })

  it('每周一早上那条定时在；设置里改成周三 09:30 就改的是这一条', async () => {
    expect(server.schedule.scheduler.get('sched_weekly_review')?.trigger).toMatchObject({
      kind: 'cron',
      expr: '0 8 * * 1',
    })
    expect(await data(await api('/v1/economics/weekly-review/schedule'))).toEqual({
      weekday: 1,
      time: '08:00',
      paused: false,
    })
    const next = await data(
      await put('/v1/economics/weekly-review/schedule', { weekday: 3, time: '09:30' }),
    )
    expect(next).toEqual({ weekday: 3, time: '09:30', paused: false })
    expect(server.schedule.scheduler.get('sched_weekly_review')?.trigger).toMatchObject({
      kind: 'cron',
      expr: '30 9 * * 3',
    })
    // 写错当场 400；投放那条职责改不了
    expect(
      (await put('/v1/economics/weekly-review/schedule', { weekday: 3, time: '9:30' })).status,
    ).toBe(400)
    expect(
      (await put('/v1/economics/weekly-review/schedule', { weekday: 1, time: '08:00' }, meta.id))
        .status,
    ).toBe(403)
  })
})
