/**
 * WP158：GSC / GA4 那几块从「占位空表」变成真数（宿主递进来的当天汇总）；
 * 连上但没选站点 / 媒体资源时照实说一句，不出空表；GA4 口径收入与 Shopify 主口径并排。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  type QueryContext,
  runQuery,
  type SearchDeckData,
  SOURCE_LABELS,
} from '../src/index.js'

const NOW = '2026-09-28T09:00:00.000Z'

function ctx(search: SearchDeckData | undefined, approvals: ApprovalItem[] = []): QueryContext {
  return {
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'USD',
    role_id: 'dtc.analytics',
    position_id: 'asg_1',
    orders: [],
    approvals,
    sources: ALL_DATA_SOURCES.map((id) => ({ id, label: SOURCE_LABELS[id], connected: true })),
    ...(search === undefined ? {} : { search }),
  }
}

const data = (name: string, c: QueryContext): unknown => {
  const out = runQuery(name, c, 'last_7d')
  return out.status === 'ok' ? out.data : out
}
const rowsOf = (name: string, c: QueryContext) =>
  (data(name, c) as { rows: Record<string, unknown>[] }).rows

const SEARCH: SearchDeckData = {
  gsc: {
    site_label: 'example-shop.com（整个域名）',
    window: { start: '2026-09-18', end: '2026-09-24' },
    queries: [{ key: 'usb c charger', clicks: 40, impressions: 900, ctr: 0.0444, position: 7.4 }],
    pages: [
      {
        key: 'https://www.example-shop.com/blogs/news/travel-tips',
        clicks: 7,
        impressions: 360,
        ctr: 0.0194,
        position: 15,
      },
    ],
  },
  ga4: {
    currency: 'USD',
    current: { active_users: 1234, sessions: 1500, purchases: 30, revenue: 1890 },
    previous: { active_users: 1100, sessions: 1320, purchases: 24, revenue: 1512.4 },
    events: [{ event: 'purchase', count: 30, key_events: 30 }],
  },
}

describe('WP158 GSC / GA4 那几块', () => {
  it('没装读数那一层：照旧空（不编数）', () => {
    expect(rowsOf('gsc.top_queries', ctx(undefined))).toEqual([])
    expect(data('analytics.active_users', ctx(undefined))).toMatchObject({ value: 0, previous: 0 })
  })

  it('查询词表 / 落地页表：点击率换成百分数、页面只显示路径', () => {
    expect(rowsOf('gsc.top_queries', ctx(SEARCH))).toEqual([
      { key: 'usb c charger', clicks: 40, impressions: 900, ctr: 4.44, position: 7.4 },
    ])
    expect(rowsOf('gsc.landing_pages', ctx(SEARCH))[0]?.key).toBe('/blogs/news/travel-tips')
  })

  it('GA4：活跃用户与转化率本周 vs 上周；事件表', () => {
    expect(data('analytics.active_users', ctx(SEARCH))).toMatchObject({
      value: 1234,
      previous: 1100,
      delta_pct: 12.18,
    })
    expect(data('analytics.conversion_rate', ctx(SEARCH))).toMatchObject({
      value: 2,
      previous: 1.82,
    })
    expect(rowsOf('analytics.events', ctx(SEARCH))).toEqual([
      { event: 'purchase', count: 30, key: 30 },
    ])
  })

  it('连上了没选：一行人话', () => {
    const pick: SearchDeckData = {
      gsc: { needs_pick: true, queries: [], pages: [] },
      ga4: { needs_pick: true, events: [] },
    }
    expect(String(rowsOf('gsc.top_queries', ctx(pick))[0]?.key)).toContain('还没选是哪个站点')
    expect(String(rowsOf('analytics.events', ctx(pick))[0]?.event)).toContain('媒体资源')
  })

  it('按页面收入：接了 GA4 时 GA4 口径收入并排，Shopify 那列标明口径', () => {
    const item = {
      id: 'ap_rev',
      kind: 'seo_report',
      state: 'auto_approved',
      created_at: NOW,
      payload: {
        variant: 'weekly_revenue',
        ga4: 'connected',
        rows: [
          {
            page: 'https://shop.example/products/a',
            clicks: 30,
            orders: 1,
            revenue: 59.9,
            conversion_rate: 0.125,
            ga4_revenue: 249.75,
          },
        ],
      },
    } as unknown as ApprovalItem
    const out = data('seo.page_revenue', ctx(SEARCH, [item])) as {
      columns: { key: string; label: string }[]
      rows: Record<string, unknown>[]
    }
    expect(out.columns.find((c) => c.key === 'revenue')?.label).toBe('收入（Shopify 落地页）')
    expect(out.rows[0]).toMatchObject({ revenue: 59.9, cr: 12.5, ga4_revenue: 249.75 })
  })
})
