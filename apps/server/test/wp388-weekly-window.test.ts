/**
 * WP388（决策 1091）：周报类取**到出报告前一天为止最近完整的 7 天**——日界线按品牌目标市场时区。
 * 北京时间周一 16:30 = 美西周一凌晨：美西的上一周刚过完，取的就是它。
 */
import type { WorkstationPort } from '@agentsws/api'
import type { ApprovalBus, Assignment, WorkspaceId } from '@agentsws/contracts'
import type { OrderRow, QueryContext } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { reviewWindow } from '../src/schedule.js'
import { createWeeklyReviewService } from '../src/weekly-review.js'

const MONDAY_1630_BEIJING = '2026-10-19T08:30:00.000Z'

const order = (id: string, created_at: string): OrderRow => ({
  id,
  name: id,
  email: 'buyer@example.test',
  currency: 'USD',
  created_at,
  total_price: 100,
  refunded_amount: 0,
  financial_status: 'paid',
  fulfillment_status: 'fulfilled',
})

function service(now: string, reportTz?: string) {
  const owner = {
    id: 'asg_owner',
    person_id: 'p_1',
    role_id: 'common.owner',
    workspace_id: 'ws_1',
  } as unknown as Assignment
  const port = {
    positions: async () => [{ position_id: 'asg_owner' }],
    queryContext: async (): Promise<QueryContext> =>
      ({
        now,
        tz_offset_minutes: 480,
        base_currency: 'USD',
        role_id: 'common.owner',
        position_id: 'asg_owner',
        orders: [
          order('o_prev', '2026-10-12T06:00:00.000Z'), // 美西 10-11 周日 23:00：上上周
          order('o_mon', '2026-10-12T08:00:00.000Z'), // 美西 10-12 周一 01:00：上一周
          order('o_sun', '2026-10-19T05:00:00.000Z'), // 美西 10-18 周日 22:00：上一周
          order('o_now', '2026-10-19T08:00:00.000Z'), // 美西 10-19 周一 01:00：这一周
        ],
        approvals: [],
        sources: [{ id: 'shop', label: '店铺', connected: true }],
      }) as unknown as QueryContext,
  } as unknown as WorkstationPort
  const created: { title: string }[] = []
  const approvals = {
    create: async (input: { title: string }) => {
      created.push(input)
      return { id: 'apv_1' }
    },
  } as unknown as Pick<ApprovalBus, 'create'>
  const svc = createWeeklyReviewService({
    workspace_id: 'ws_1' as WorkspaceId,
    clock: { now: () => now },
    assignments: () => [owner],
    approvals,
    port: async () => port,
    brandName: () => 'Acme',
    ...(reportTz === undefined ? {} : { reportTz: () => reportTz }),
  })
  return { svc, created }
}

describe('WP388 经营一页纸：上一周（目标市场时区）', () => {
  it('目标市场美国：北京周一 16:30 出美西 10-12 到 10-18 那一周，只算那一周的订单', async () => {
    const { svc, created } = service(MONDAY_1630_BEIJING, 'America/Los_Angeles')
    const p = await svc.build()
    expect(p?.week_of).toBe('2026-10-12')
    expect(p?.situation).toContain('2026-10-12 到 2026-10-18')
    const store = p?.findings.find((f) => f.panel === 'store_sales')
    expect(store?.text).toContain('、2 单')
    await svc.run()
    expect(created[0]?.title).toBe('上周经营一页纸 · 2026-10-12')
  })

  it('没设目标市场 = 工作区时区（北京）的上一周', async () => {
    const { svc } = service(MONDAY_1630_BEIJING, '+08:00')
    const p = await svc.build()
    expect(p?.week_of).toBe('2026-10-12')
    // 北京的上一周 = 10-11T16:00Z 到 10-18T16:00Z：o_prev、o_mon 在，o_sun（10-19T05:00Z）不在
    expect(p?.situation).toContain('2026-10-12 到 2026-10-18')
    expect(p?.findings.find((f) => f.panel === 'store_sales')?.text).toContain('、2 单')
  })

  it('改到周五出（决策 1091）：上周五到本周四，标题写起止日期', async () => {
    const { svc, created } = service('2026-10-23T09:00:00.000Z', 'America/Los_Angeles')
    const p = await svc.build()
    expect(p?.week_of).toBe('2026-10-16')
    expect(p?.situation).toContain('2026-10-16 到 2026-10-22')
    // 美西 10-16 到 10-22：o_sun（美西 10-18 22:00）、o_now（美西 10-19 01:00）在，o_mon / o_prev 不在
    expect(p?.findings.find((f) => f.panel === 'store_sales')?.text).toContain('、2 单')
    await svc.run()
    expect(created[0]?.title).toBe('经营一页纸 · 2026-10-16 至 2026-10-22')
  })
})

describe('WP388 岗位周复盘的窗口', () => {
  const todayEnd = '2026-10-19T16:00:00.000Z'
  it('周：到前一天为止最近完整的 7 天（目标市场时区）；日 / 月照旧到今天结束往回数', () => {
    expect(reviewWindow('week', MONDAY_1630_BEIJING, todayEnd, 'America/Los_Angeles')).toEqual({
      start: '2026-10-12T07:00:00.000Z',
      end: '2026-10-19T07:00:00.000Z',
    })
    expect(reviewWindow('day', MONDAY_1630_BEIJING, todayEnd, 'America/Los_Angeles')).toEqual({
      start: '2026-10-18T16:00:00.000Z',
      end: todayEnd,
    })
  })

  it('改到周五出：上周五 00:00 到本周五 00:00（北京）', () => {
    expect(
      reviewWindow('week', '2026-10-23T09:00:00.000Z', '2026-10-23T16:00:00.000Z', '+08:00'),
    ).toEqual({ start: '2026-10-15T16:00:00.000Z', end: '2026-10-22T16:00:00.000Z' })
  })
})
