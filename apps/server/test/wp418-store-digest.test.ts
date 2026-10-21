/**
 * WP418（自查 B7 / B13）：店铺管理每天的日报卡 + 异常提醒；网站体检单独一条每周定时。
 *
 * 钉住：数从面板那一份上下文来（同一条 `store.daily_report` 查询）；有异常在首页告警区出一行、给担着店铺管理的人；
 * 店铺没连不出卡；时间读职责 yml 的 `digest_schedule`；定时只在有人担店铺管理时建。
 */
import type { WorkstationPort } from '@agentsws/api'
import type { Assignment, WorkspaceId } from '@agentsws/contracts'
import type { QueryContext } from '@agentsws/deck'
import { createScheduler } from '@agentsws/schedule'
import { describe, expect, it } from 'vitest'
import {
  ensureSystemTasks,
  HANDLERS,
  SITE_HEALTH_WEEKLY_CRON,
  seoScheduleGates,
} from '../src/schedule.js'
import {
  createStoreDigest,
  STORE_DIGEST_DEFAULT_CRON,
  storeDigestCron,
} from '../src/store-digest.js'

const WS = 'ws_rovella' as WorkspaceId
const NOW = '2026-09-07T01:00:00.000Z'

const order = (id: string, at: string, total: number) => ({
  id,
  name: `#${id}`,
  email: 'buyer@example.com',
  currency: 'USD',
  created_at: at,
  total_price: total,
  refunded_amount: 0,
  financial_status: 'paid',
  fulfillment_status: 'unfulfilled',
})

const ctxOf = (over: Partial<QueryContext> = {}): QueryContext =>
  ({
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'USD',
    role_id: 'dtc.store',
    position_id: 'asg_store',
    // 昨天（本地 09-06）卖了 10，前天卖了 100 → 跌 90%
    orders: [
      order('1', '2026-09-06T02:00:00.000Z', 10),
      order('2', '2026-09-05T02:00:00.000Z', 100),
    ],
    inventory: [{ id: 'inv_1', product_id: 'p1', sku: 'SKU-1', title: '收纳箱', quantity: 0 }],
    approvals: [],
    sources: [
      { id: 'shop', label: '店铺后台', connected: true },
      { id: 'approvals', label: '工作队列', connected: true },
    ],
    thresholds: { low_stock_quantity: 5, sales_drop_pct: 30 },
    ...over,
  }) as QueryContext

function make(ctx: QueryContext | undefined, held = true) {
  const created: {
    kind: string
    title: string
    summary: string
    payload: unknown
    automation: unknown
  }[] = []
  const assignments = (): Assignment[] =>
    held
      ? ([
          {
            id: 'asg_store',
            role_id: 'dtc.store',
            person_id: 'p_owner',
            workspace_id: WS,
          },
        ] as unknown as Assignment[])
      : []
  const port = {
    positions: async () => [{ position_id: 'asg_store', role_id: 'dtc.store' }],
    queryContext: async () => {
      if (ctx === undefined) throw new Error('no ctx')
      return ctx
    },
  } as unknown as WorkstationPort
  const digest = createStoreDigest({
    workspace_id: WS,
    clock: { now: () => NOW },
    assignments,
    approvals: {
      create: async (input) => {
        created.push(input as never)
        return { id: `ap_${created.length}` } as never
      },
    },
    port: async () => port,
  })
  return { digest, created }
}

describe('店铺日报卡 + 异常提醒（自查 B7）', () => {
  it('出一张 L3 日报卡（数从面板那条查询来）；异常进标题，告警区给店铺管理那个人出一行', async () => {
    const { digest, created } = make(ctxOf())
    const out = await digest.run()
    expect(out).toMatchObject({ approval_item_id: 'ap_1', anomalies: 2, date: '2026-09-06' })
    expect(created[0]?.kind).toBe('daily_report')
    expect(created[0]?.title).toBe('店铺日报 2026-09-06 · 2 项异常')
    expect(created[0]?.summary).toContain('销售额 USD 10.00')
    expect(created[0]?.automation).toMatchObject({ level_at_creation: 'L3', auto_approved: true })
    const alerts = digest.alerts('p_owner')
    expect(alerts.map((a) => a.kind)).toEqual(['system_alert', 'system_alert'])
    expect(alerts[0]?.detail.payload).toMatchObject({
      kind: 'store_anomaly',
      open_path: '/positions/asg_store/duties/dtc.store',
    })
    // 别人看不到
    expect(digest.alerts('p_other')).toEqual([])
  })

  it('没有异常：日报照出，不出「一切正常」提醒', async () => {
    const { digest, created } = make(
      ctxOf({
        orders: [order('1', '2026-09-06T02:00:00.000Z', 100)],
        inventory: [{ id: 'inv_1', product_id: 'p1', sku: 'SKU-1', title: '收纳箱', quantity: 40 }],
      } as Partial<QueryContext>),
    )
    await digest.run()
    expect(created[0]?.title).toBe('店铺日报 2026-09-06')
    expect(digest.alerts('p_owner')).toEqual([])
  })

  it('店铺没连 / 没人担店铺管理：不出卡，照实说为什么', async () => {
    const off = make(
      ctxOf({
        sources: [{ id: 'shop', label: '店铺后台', connected: false }],
      } as Partial<QueryContext>),
    )
    expect(await off.digest.run()).toEqual({ skipped: '店铺没连上，日报没有数可写' })
    expect(off.created).toEqual([])
    const none = make(ctxOf(), false)
    expect((await none.digest.run()).skipped).toContain('没人担')
  })

  it('时间读职责 yml 的 digest_schedule（没写就每天 9 点）', () => {
    expect(storeDigestCron([{ event: 'digest.daily_report', digest_schedule: '30 8 * * *' }])).toBe(
      '30 8 * * *',
    )
    expect(storeDigestCron(undefined)).toBe(STORE_DIGEST_DEFAULT_CRON)
  })
})

describe('定时只在有人担时建（自查 B7 / B13）', () => {
  it('日报一天一次（cron 照职责 yml）、体检每周一一次；没担就都不建', async () => {
    const plan = (has: Record<string, unknown>) => ({
      workspace_id: WS,
      owner: 'p_owner',
      role_id: 'dtc.store',
      assignment_id: 'asg_store',
      tz: '+08:00',
      positions: [],
      has,
    })
    const s = createScheduler({ clock: { now: () => NOW } })
    await ensureSystemTasks(s, plan({ storeDigest: '0 9 * * *', siteHealthWeekly: true }) as never)
    const digest = s.get('sched_store_digest')
    expect(digest?.handler).toBe(HANDLERS.storeDigest)
    expect(digest?.trigger).toMatchObject({ kind: 'cron', expr: '0 9 * * *' })
    expect(s.get('sched_site_health_weekly')?.trigger).toMatchObject({
      expr: SITE_HEALTH_WEEKLY_CRON,
    })
    const empty = createScheduler({ clock: { now: () => NOW } })
    await ensureSystemTasks(empty, plan({}) as never)
    expect(empty.get('sched_store_digest')).toBeUndefined()
    expect(empty.get('sched_site_health_weekly')).toBeUndefined()
  })
})

describe('WP446：搜索那两条定时跟着「SEO 与 GEO」走（docs/109 §4.2）', () => {
  it('只担内容与博客：不建每日 / 每周搜索，也不建体检；担了 SEO 与 GEO 才建', async () => {
    const only = (roles: string[]) => seoScheduleGates((r) => roles.includes(r))
    expect(only(['dtc.content'])).toEqual({ seo: false, siteHealthWeekly: false })
    expect(only(['dtc.content', 'dtc.seo'])).toEqual({ seo: true, siteHealthWeekly: true })
    expect(only(['dtc.store'])).toEqual({ seo: false, siteHealthWeekly: true })
    const plan = (has: Record<string, unknown>) => ({
      workspace_id: WS,
      owner: 'p_owner',
      role_id: 'dtc.content',
      assignment_id: 'asg_content',
      tz: '+08:00',
      positions: [],
      has,
    })
    const s = createScheduler({ clock: { now: () => NOW } })
    await ensureSystemTasks(s, plan(only(['dtc.content'])) as never)
    expect(s.get('sched_seo_daily')).toBeUndefined()
    expect(s.get('sched_seo_weekly')).toBeUndefined()
    const t = createScheduler({ clock: { now: () => NOW } })
    await ensureSystemTasks(t, plan(only(['dtc.seo'])) as never)
    expect(t.get('sched_seo_daily')).toBeDefined()
    expect(t.get('sched_seo_weekly')).toBeDefined()
  })
})
