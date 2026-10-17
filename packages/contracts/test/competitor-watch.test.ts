import { describe, expect, it } from 'vitest'
import {
  type BrandWatchCompetitor,
  COMPETITOR_CHANGE_KIND_LABELS,
  COMPETITOR_CHANGE_KINDS,
  COMPETITOR_REMOVED_AFTER_MISSES,
  COMPETITOR_SOURCE_KINDS,
  COMPETITOR_WATCH_SETTINGS_DEFAULTS,
  type CompetitorWatchSource,
  type MonitorSource,
  type WatchItem,
} from '../src/index.js'

describe('WP392 竞品监控契约', () => {
  it('十种变化都有中英文名', () => {
    expect(COMPETITOR_CHANGE_KINDS).toHaveLength(10)
    for (const k of COMPETITOR_CHANGE_KINDS) {
      expect(COMPETITOR_CHANGE_KIND_LABELS[k].zh).not.toBe('')
      expect(COMPETITOR_CHANGE_KIND_LABELS[k].en).not.toBe('')
    }
  })

  it('默认一天一次、本地 9 点后；上新看最近 7 天；下架要连两次没读到', () => {
    expect(COMPETITOR_WATCH_SETTINGS_DEFAULTS.every_hours).toBe(24)
    expect(COMPETITOR_WATCH_SETTINGS_DEFAULTS.day_start_hour).toBe(9)
    expect(COMPETITOR_WATCH_SETTINGS_DEFAULTS.new_within_days).toBe(7)
    expect(COMPETITOR_REMOVED_AFTER_MISSES).toBe(2)
  })

  it('竞品监控源就是一条监控源（共用连接卡 / 计划卡）', () => {
    expect(COMPETITOR_SOURCE_KINDS).toEqual(['shop_catalog', 'amazon_asin'])
    const src: CompetitorWatchSource = {
      id: 'cw_shop_c1',
      workspace_id: 'ws_1' as never,
      kind: 'shop_catalog',
      url: 'https://example-bikes.test',
      group: 'competitor',
      label: 'Example Bikes',
      every_hours: 24,
      status: 'unchecked',
      added_via: 'suggest',
      created_at: '2026-10-18T00:00:00.000Z',
      competitor_id: 'c1',
      platform: 'shopify',
    }
    const asMonitor: MonitorSource = src
    expect(asMonitor.kind).toBe('shop_catalog')
  })

  it('竞品清单只加可选格；报告条目多一种 change', () => {
    const c: BrandWatchCompetitor = {
      id: 'c1',
      name: 'Example Bikes',
      aliases: [],
      domains: ['example-bikes.test'],
      store: { url: 'https://example-bikes.test', platform: 'shopify' },
      amazon: [{ marketplace: 'US', asin: 'B000000001', vs_own: 'B000000009' }],
    }
    expect(c.amazon?.[0]?.vs_own).toBe('B000000009')
    const item: WatchItem = {
      id: 'cc_1',
      platform: 'competitor',
      kind: 'change',
      scope: 'external',
      place: 'Example Bikes',
      created_at: '2026-10-18T01:00:00.000Z',
      url: 'https://example-bikes.test/products/x',
      text: 'X 降价 10%',
    }
    expect(item.kind).toBe('change')
  })
})
