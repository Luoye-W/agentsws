/**
 * WP447：六个新平台（只读）那三块——花费一格、账户概况、体检。按职责的平台筛；Apple 没 App 只有一行。
 */
import { describe, expect, it } from 'vitest'
import {
  type AdsDeckData,
  blocksForRole,
  type QueryContext,
  runQuery,
  type ScalarResult,
  type TableResult,
} from '../src/index.js'
import { queryContext, SOURCES } from './fixtures.js'

const withAds = SOURCES.map((s) => (s.id === 'ads' ? { ...s, connected: true } : s))
const deck: AdsDeckData = {
  spend_gate: { spent: 0, cap: 1000, remaining: 1000, by_platform: [], missing: [] },
  campaigns: [],
  pending: [],
  stop_losses: [],
  pixels: [],
  attribution: [],
  exports: [
    {
      platform: 'pinterest',
      account: 'acct1',
      since: '2026-10-13',
      until: '2026-10-19',
      metrics: { cost: 258.5, impressions: 121000, clicks: 1310 },
      campaigns: 2,
      imported_at: '2026-10-20T01:00:00Z',
      file: 'p.csv',
    },
    {
      platform: 'reddit',
      account: 'r1',
      currency: 'USD',
      metrics: { cost: 1 },
      campaigns: 1,
      imported_at: '2026-10-20T01:00:00Z',
      file: 'r.csv',
    },
  ],
  audits: [
    {
      platform: 'pinterest',
      items: [
        {
          id: 'pinterest_tag',
          title: { zh: 'Pinterest 标签装好了', en: 'x' },
          status: 'unknown',
          note: '没有证据：去商务后台「转化」页看一眼。',
          evidence: 'backend',
        },
      ],
    },
    { platform: 'apple', app_only: '这条只适合推 App', items: [] },
  ],
}
const ctx = (role_id: string): QueryContext =>
  queryContext({ role_id, sources: withAds, ads: deck })
const run = (name: string, role: string) => {
  const r = runQuery(name, ctx(role), 'last_7d')
  if (r.status !== 'ok') throw new Error(`${name} not ok`)
  return r.data
}

describe('WP447 只读新平台的三块', () => {
  it('面板就三块：花费、账户概况、体检（没有总闸 / 止损 / 待审）', () => {
    expect(blocksForRole('ads.pinterest').map((b) => b.query)).toEqual([
      'ads.export_spend',
      'ads.export_overview',
      'ads.export_audit',
      // WP452：保本线、广告与落地页（只读的平台也能看，都不碰账户）
      'ads.break_even_calc',
      'ads.landing_checks',
    ])
    // 「查看完整报告」指到那一家自己的后台（同一个 `ads` 源默认是 Meta 的）
    for (const b of blocksForRole('ads.pinterest'))
      expect(b.report_url).toBe('https://ads.pinterest.com')
  })

  it('按职责的平台筛；没写的币种 / 时区照实写「没写」', () => {
    const t = run('ads.export_overview', 'ads.pinterest') as TableResult
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0]).toMatchObject({ currency_text: '没写', timezone: '没写', cost: 258.5 })
    // 行里不许有 `currency` 这个键（表格拿它当金额币种）
    expect(t.rows[0]?.currency).toBeUndefined()
    expect(t.rows[0]?.range).toBe('2026-10-13 ~ 2026-10-19')
    expect((run('ads.export_spend', 'ads.pinterest') as ScalarResult).value).toBe(258.5)
    expect((run('ads.export_spend', 'ads.reddit') as ScalarResult).currency).toBe('USD')
  })

  it('体检：未知照写；Apple 没 App 只有一行「只适合推 App」', () => {
    const t = run('ads.export_audit', 'ads.pinterest') as TableResult
    expect(t.rows[0]).toMatchObject({ status: '未知' })
    const apple = run('ads.export_audit', 'ads.apple') as TableResult
    expect(apple.rows).toHaveLength(1)
    expect(String(apple.rows[0]?.note)).toContain('只适合推 App')
  })
})
