import { describe, expect, it } from 'vitest'
import {
  AMAZON_AUTOCOMPLETE_BATCH_PAGES,
  AMAZON_KEYWORD_LATER_SOURCES,
  AMAZON_KEYWORD_MARK_LABELS,
  AMAZON_KEYWORD_MARKS,
  AMAZON_KEYWORD_SORT_NOTE_ZH,
  AMAZON_KEYWORD_SOURCE_LABELS,
  AMAZON_KEYWORD_SOURCES,
  type AmazonKeyword,
  type CatalogSnapshotRow,
} from '../src/index.js'

describe('WP398 Amazon 词库契约', () => {
  it('六种来源都有中英文名；广告搜索词 / 品牌分析是二期的', () => {
    expect(AMAZON_KEYWORD_SOURCES).toEqual([
      'autocomplete',
      'competitor_listing',
      'own_listing',
      'search_term_report',
      'brand_analytics',
      'user',
    ])
    for (const s of AMAZON_KEYWORD_SOURCES) {
      expect(AMAZON_KEYWORD_SOURCE_LABELS[s].zh).not.toBe('')
      expect(AMAZON_KEYWORD_SOURCE_LABELS[s].en).not.toBe('')
    }
    expect(AMAZON_KEYWORD_LATER_SOURCES).toEqual(['search_term_report', 'brand_analytics'])
  })

  it('三种用户标记：核心 / 不要 / 已埋进 Listing', () => {
    expect(AMAZON_KEYWORD_MARKS).toEqual(['core', 'exclude', 'in_listing'])
    expect(AMAZON_KEYWORD_MARK_LABELS.in_listing.zh).toBe('已埋进 Listing')
  })

  it('一个词装得下二期的来源和数字；一期数字格可以整个不出现', () => {
    const phase1: AmazonKeyword = {
      id: 'US:electric bike',
      term: 'electric bike',
      norm: 'electric bike',
      marketplace: 'US',
      language: 'en',
      sources: ['autocomplete', 'competitor_listing'],
      seen: [
        {
          source: 'competitor_listing',
          competitor_id: 'c1',
          competitor: 'Voltway',
          asin: 'B0TEST0001',
          field: 'title',
          first_seen_at: '2026-10-18T00:00:00.000Z',
          last_seen_at: '2026-10-18T00:00:00.000Z',
        },
      ],
      first_seen_at: '2026-10-18T00:00:00.000Z',
      last_seen_at: '2026-10-18T00:00:00.000Z',
      marks: [],
    }
    expect(phase1.metrics).toBeUndefined()
    const phase2: AmazonKeyword = {
      ...phase1,
      sources: [...phase1.sources, 'search_term_report'],
      metrics: {
        impressions: 1200,
        clicks: 40,
        orders: 3,
        period: { from: '2026-11-01', to: '2026-11-07' },
        source: 'search_term_report',
      },
    }
    expect(phase2.metrics?.orders).toBe(3)
  })

  it('一批联想词 = 种子词本身 + a–z；卡上写明没有搜索量', () => {
    expect(AMAZON_AUTOCOMPLETE_BATCH_PAGES).toBe(27)
    expect(AMAZON_KEYWORD_SORT_NOTE_ZH).toBe('没有搜索量，按竞品里出现的次数排')
  })

  it('竞品快照行只加了一格五点（可选）', () => {
    const row: CatalogSnapshotRow = {
      source_id: 's',
      competitor_id: 'c',
      product_key: 'B0TEST0001',
      title: 't',
      read_at: '2026-10-18T00:00:00.000Z',
    }
    expect(row.bullets).toBeUndefined()
    const withBullets: CatalogSnapshotRow = { ...row, bullets: ['Removable battery'] }
    expect(withBullets.bullets).toHaveLength(1)
  })
})
