/**
 * WP154「内容与搜索」面板三块：数全从搜索报告卡投影（不现算），GSC 没连就「去连接」。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  blocksForRole,
  computeBlock,
  type QueryContext,
  runQuery,
  SOURCE_LABELS,
} from '../src/index.js'

const NOW = '2026-09-28T09:00:00.000Z'

const report = (variant: string, payload: object, created_at = NOW): ApprovalItem =>
  ({
    id: `ap_${variant}_${created_at}`,
    kind: 'seo_report',
    state: 'auto_approved',
    created_at,
    payload: { variant, ...payload },
  }) as unknown as ApprovalItem

const daily = report('daily', {
  picks: [
    {
      rank: 1,
      signal: 'no_clicks',
      query: 'usb c laptop charger',
      evidence: { impressions: 2400, clicks: 6, ctr: 0.0025, position: 8.4, words: 4 },
      lane: 'fix_page',
      suggestion: '把「usb c laptop charger」原样写进标题',
    },
  ],
  notes: [],
})
const older = report('daily', { picks: [], notes: ['旧的'] }, '2026-09-20T00:00:00.000Z')

function ctx(connected: string[], approvals: ApprovalItem[]): QueryContext {
  return {
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'USD',
    role_id: 'dtc.content',
    position_id: 'asg_1',
    orders: [],
    approvals,
    sources: ALL_DATA_SOURCES.map((id) => ({
      id,
      label: SOURCE_LABELS[id],
      connected: connected.includes(id),
    })),
  }
}

const rowsOf = (name: string, c: QueryContext): Record<string, unknown>[] => {
  const out = runQuery(name, c, 'last_7d')
  return out.status === 'ok' ? (out.data as { rows: Record<string, unknown>[] }).rows : []
}

describe('WP154 内容与搜索面板', () => {
  it('GSC 原始两张表换成三块 SEO 积木（不堆数据）', () => {
    const ids = blocksForRole('dtc.content').map((b) => b.id)
    expect(ids).toContain('seo.today')
    expect(ids).toContain('seo.page_revenue')
    expect(ids).toContain('seo.geo_visibility')
    expect(ids).not.toContain('gsc.queries')
  })

  it('今天值得动的 5 件事：GSC 没连 = 去连接；连了读最新那张报告', () => {
    expect(computeBlock('seo.today', ctx(['shop', 'approvals'], [daily]), 'last_7d').status).toBe(
      'not_connected',
    )
    const rows = rowsOf('seo.today', ctx(['gsc', 'approvals'], [older, daily]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rank: 1, lane: '改这页（本职责）' })
    expect(String(rows[0]?.evidence)).toContain('曝光 2400')
  })

  it('还没读过：一行人话，不出空表', () => {
    const rows = rowsOf('seo.today', ctx(['gsc'], []))
    expect(rows[0]?.what).toBe('今天早上还没读过 Search Console')
  })

  it('按页面收入：两类单独标；AI 可见度按问题汇总', () => {
    const revenue = report('weekly_revenue', {
      ga4: 'not_connected',
      rows: [
        { page: 'https://shop.example/blogs/a', clicks: 400, orders: 0, revenue: 0, flag: 'leak' },
        { page: 'https://shop.example/blogs/b', clicks: 40, orders: 6, revenue: 500, flag: 'gem' },
      ],
    })
    const rows = rowsOf('seo.page_revenue', ctx(['shop'], [revenue]))
    expect(rows.map((r) => [r.page, r.flag])).toEqual([
      ['/blogs/a', '点击多没订单'],
      ['/blogs/b', '点击少出订单'],
    ])
    const geo = report('weekly_geo', {
      rows: [
        { question: 'Q1', platform: 'chatgpt', brand_mentioned: false, our_domain_cited: false },
        { question: 'Q1', platform: 'perplexity', brand_mentioned: true, our_domain_cited: false },
      ],
      gaps: [{ question: 'Q1', suggestion: '交公关' }],
    })
    expect(rowsOf('seo.geo_visibility', ctx(['approvals'], [geo]))).toEqual([
      { question: 'Q1', seen: '1 / 2 个平台', advice: '交公关' },
    ])
  })
})
