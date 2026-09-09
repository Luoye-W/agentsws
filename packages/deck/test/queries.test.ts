import { describe, expect, it } from 'vitest'
import type { ScalarResult, SeriesResult, TableResult } from '../src/index.js'
import {
  DeckError,
  queryDef,
  queryNames,
  rangeWindows,
  runQuery,
  startOfDay,
} from '../src/index.js'
import { item, NOW, queryContext, refundItem, TZ } from './fixtures.js'

const scalar = (
  name: string,
  range: 'yesterday' | 'last_7d',
  ctx = queryContext(),
): ScalarResult => {
  const r = runQuery(name, ctx, range)
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`)
  return r.data as ScalarResult
}

describe('时间窗（36 §3 昨天 vs 前一天、近 7 天 vs 前 7 天）', () => {
  it('按工作区时区切日界线', () => {
    // 2026-09-07T01:00Z = 北京时间 09:07 09:00 → 当天零点是 2026-09-06T16:00Z
    expect(new Date(startOfDay(Date.parse(NOW), TZ)).toISOString()).toBe('2026-09-06T16:00:00.000Z')
    expect(new Date(startOfDay(Date.parse(NOW), 0)).toISOString()).toBe('2026-09-07T00:00:00.000Z')
  })

  it('yesterday 是一天，last_7d 是七天，走势永远 7 桶', () => {
    const y = rangeWindows('yesterday', NOW, TZ)
    expect(y.current.to - y.current.from).toBe(86_400_000)
    expect(y.previous.to).toBe(y.current.from)
    expect(y.spark).toHaveLength(7)
    const w = rangeWindows('last_7d', NOW, TZ)
    expect(w.current.to - w.current.from).toBe(7 * 86_400_000)
  })
})

describe('命名查询注册表（29 原则 ①）', () => {
  it('未注册的名字直接拒', () => {
    expect(() => queryDef('nope.nope')).toThrow(DeckError)
    try {
      queryDef('nope.nope')
    } catch (e) {
      expect((e as DeckError).reason).toBe('UNKNOWN_QUERY')
      expect((e as DeckError).code).toBe('not_found')
    }
  })
  it('名字表是排好序的', () => {
    const names = queryNames()
    expect(names).toContain('sales.total')
    expect([...names].sort()).toEqual(names)
  })
})

describe('店铺侧的数（来自 mock connect 的订单）', () => {
  it('总销售额：昨天一单 129，前一天一单 89', () => {
    const r = scalar('sales.total', 'yesterday')
    expect(r.value).toBe(129)
    expect(r.previous).toBe(89)
    expect(r.currency).toBe('USD')
    expect(r.delta_pct).toBeCloseTo(44.94, 1)
    expect(r.spark).toHaveLength(7)
  })

  it('订单数：近 7 天三单', () => {
    expect(scalar('orders.count', 'last_7d').value).toBe(3)
  })

  it('环比基数为 0 时不给 delta_pct（不编造 ∞）', () => {
    const ctx = queryContext({ orders: [] })
    const r = scalar('sales.total', 'yesterday', ctx)
    expect(r.value).toBe(0)
    expect(r.previous).toBe(0)
    expect(r.delta_pct).toBeUndefined()
  })

  it('最近订单表 / 超期未发表', () => {
    const recent = runQuery('orders.recent', queryContext(), 'last_7d')
    if (recent.status !== 'ok') throw new Error('expected ok')
    expect((recent.data as TableResult).rows).toHaveLength(3)
    expect((recent.data as TableResult).columns[0]?.key).toBe('order')

    const overdue = runQuery('orders.overdue', queryContext(), 'last_7d')
    if (overdue.status !== 'ok') throw new Error('expected ok')
    // ord_c 09-02 未发货，超过 3 天；ord_b 09-05 未发货但没到 3 天
    expect((overdue.data as TableResult).rows.map((r) => r.order)).toEqual(['#1003'])
  })

  it('销售走势是 7 天两条线', () => {
    const r = runQuery('sales.trend', queryContext(), 'yesterday')
    if (r.status !== 'ok') throw new Error('expected ok')
    const data = r.data as SeriesResult
    expect(data.x).toHaveLength(7)
    expect(data.series.map((s) => s.key)).toEqual(['sales', 'orders'])
    expect(data.currency).toBe('USD')
  })
})

describe('审批侧的数', () => {
  const approvals = [
    // 昨天建的草稿，1 小时后就决定了 → 计入 24h 回复率
    item({
      id: 'a1',
      created_at: '2026-09-06T02:00:00.000Z',
      state: 'approved',
      decision: { action: 'approve', by: 'p', at: '2026-09-06T03:00:00.000Z', via: 'workstation' },
    }),
    // 昨天建的草稿，三天后才决定 → 不计入
    item({
      id: 'a2',
      created_at: '2026-09-06T04:00:00.000Z',
      state: 'approved',
      decision: { action: 'approve', by: 'p', at: '2026-09-09T04:00:00.000Z', via: 'workstation' },
    }),
    // 还压着的草稿（本窗口之前建的）
    item({ id: 'a3', created_at: '2026-09-01T04:00:00.000Z', state: 'pending' }),
    // 还压着的草稿（本窗口内建的）
    item({ id: 'a4', created_at: '2026-09-06T06:00:00.000Z', state: 'in_review' }),
    // 前一天的草稿，没决定
    item({ id: 'a5', created_at: '2026-09-05T04:00:00.000Z', state: 'expired' }),
    // 退款：昨天建、昨天施行
    refundItem({
      id: 'r1',
      created_at: '2026-09-06T02:30:00.000Z',
      state: 'applied',
      apply: {
        attempts: [
          {
            at: '2026-09-06T03:30:00.000Z',
            by_executor: 'x',
            idempotency_key: 'k',
            result: 'ok',
          },
        ],
      },
    }),
    // 退款：建了但没施行 → 不进退款额
    refundItem({ id: 'r2', created_at: '2026-09-06T05:00:00.000Z', state: 'pending' }),
    // 退款：施行失败 → 不进退款额
    refundItem({
      id: 'r3',
      created_at: '2026-09-06T05:00:00.000Z',
      state: 'apply_failed',
      apply: {
        attempts: [
          {
            at: '2026-09-06T06:00:00.000Z',
            by_executor: 'x',
            idempotency_key: 'k',
            result: 'failed',
          },
        ],
      },
    }),
    // 退款：施行了但 payload 里没金额 → 跳过
    refundItem({
      id: 'r4',
      payload: { kind: 'refund' },
      state: 'applied',
      apply: {
        attempts: [
          { at: '2026-09-06T07:00:00.000Z', by_executor: 'x', idempotency_key: 'k', result: 'ok' },
        ],
      },
    }),
  ]
  const ctx = queryContext({ approvals })

  it('待回复是存量：现在压着 2 条，窗口开始时压着 1 条', () => {
    const r = scalar('approvals.pending_replies', 'yesterday', ctx)
    expect(r.value).toBe(2)
    expect(r.previous).toBe(1)
    expect(r.spark).toHaveLength(7)
  })

  it('待回复：previous 为 0 时不给 delta_pct', () => {
    const r = scalar(
      'approvals.pending_replies',
      'yesterday',
      queryContext({ approvals: [item({ id: 'z', state: 'pending' })] }),
    )
    expect(r.delta_pct).toBeUndefined()
  })

  it('24h 回复率：昨天三条草稿，一条按时 → 33.33%', () => {
    const r = scalar('approvals.reply_rate_24h', 'yesterday', ctx)
    expect(r.value).toBe(33.33)
    expect(r.previous).toBe(0)
    expect(r.delta_pct).toBeUndefined()
  })

  it('24h 回复率：前一窗口有数时给环比', () => {
    const r = scalar(
      'approvals.reply_rate_24h',
      'yesterday',
      queryContext({
        approvals: [
          item({
            id: 'p1',
            created_at: '2026-09-05T02:00:00.000Z',
            decision: {
              action: 'approve',
              by: 'p',
              at: '2026-09-05T03:00:00.000Z',
              via: 'workstation',
            },
          }),
          item({
            id: 'p2',
            created_at: '2026-09-06T02:00:00.000Z',
            decision: {
              action: 'approve',
              by: 'p',
              at: '2026-09-06T03:00:00.000Z',
              via: 'workstation',
            },
          }),
        ],
      }),
    )
    expect(r.value).toBe(100)
    expect(r.previous).toBe(100)
    expect(r.delta_pct).toBe(0)
  })

  it('退款申请数按创建时间；退款额按施行时间', () => {
    expect(scalar('approvals.refund_requests', 'yesterday', ctx).value).toBe(3)
    expect(scalar('refunds.total', 'yesterday', ctx).value).toBe(42)
  })

  it('money 只有 amount 时也能算', () => {
    const r = scalar(
      'refunds.total',
      'yesterday',
      queryContext({
        approvals: [
          refundItem({
            payload: { kind: 'refund', money: { amount: 8, currency: 'USD' } },
            apply: {
              attempts: [
                {
                  at: '2026-09-06T07:00:00.000Z',
                  by_executor: 'x',
                  idempotency_key: 'k',
                  result: 'ok',
                },
              ],
            },
          }),
        ],
      }),
    )
    expect(r.value).toBe(8)
  })

  it('payload 不是对象的退款项被跳过', () => {
    const r = scalar(
      'refunds.total',
      'yesterday',
      queryContext({ approvals: [refundItem({ payload: 'x' })] }),
    )
    expect(r.value).toBe(0)
  })

  it('记录时间线按 updated_at 倒序', () => {
    const r = runQuery('records.timeline', ctx, 'last_7d')
    if (r.status !== 'ok') throw new Error('expected ok')
    const rows = (r.data as { rows: { id: string }[] }).rows
    expect(rows.length).toBe(approvals.length)
  })
})

describe('没接的数据源', () => {
  it('GA4 / Search Console / 广告 / 满意度一律 not_connected', () => {
    for (const name of [
      'analytics.conversion_rate',
      'analytics.active_users',
      'analytics.events',
      'gsc.top_queries',
      'gsc.landing_pages',
      'csat.score',
      'ads.spend',
      'ads.roas',
      'ads.cpa',
      'ads.ctr',
      'ads.trend',
    ]) {
      expect(runQuery(name, queryContext(), 'yesterday').status).toBe('not_connected')
    }
  })

  it('数据源根本没在清单里 → 也当未连接', () => {
    expect(runQuery('sales.total', queryContext({ sources: [] }), 'yesterday').status).toBe(
      'not_connected',
    )
  })

  it('接上了就出（空）数据，形状仍然对', () => {
    const ctx = queryContext({
      sources: [
        { id: 'ga4', label: 'GA4', connected: true },
        { id: 'ads', label: '广告后台', connected: true },
        { id: 'gsc', label: 'Search Console', connected: true },
        { id: 'csat', label: '满意度调查', connected: true },
      ],
    })
    expect(scalar('analytics.conversion_rate', 'yesterday', ctx).spark).toHaveLength(7)
    expect(scalar('csat.score', 'yesterday', ctx).value).toBe(0)
    expect(scalar('ads.spend', 'yesterday', ctx).value).toBe(0)
    expect(scalar('ads.roas', 'yesterday', ctx).value).toBe(0)
    expect(scalar('ads.cpa', 'yesterday', ctx).value).toBe(0)
    expect(scalar('ads.ctr', 'yesterday', ctx).value).toBe(0)
    expect(scalar('analytics.active_users', 'yesterday', ctx).value).toBe(0)
    const events = runQuery('analytics.events', ctx, 'yesterday')
    expect(events.status).toBe('ok')
    expect(runQuery('gsc.top_queries', ctx, 'yesterday').status).toBe('ok')
    expect(runQuery('gsc.landing_pages', ctx, 'yesterday').status).toBe('ok')
    expect(runQuery('ads.trend', ctx, 'yesterday').status).toBe('ok')
  })
})
