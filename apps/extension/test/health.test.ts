/**
 * 体检算法：**与 KOLAgents 同输入同输出**（WP119 定论 5）。
 *
 * 这里的每个数字都是从对方那一版里抄下来的边界，不是我们自己挑的——
 * 所以断言写的是「刚好在线上」与「刚好差一点」，而不是随手一个中间值。
 */
import { describe, expect, it } from 'vitest'
import {
  computeContentHealth,
  computeCreatorHealth,
  formatRatioPercent,
} from '../src/lib/health.js'
import type { ContentSnapshot, RecentItem } from '../src/lib/snapshot.js'
import { averageItemViews } from '../src/lib/snapshot.js'

const items = (...views: (number | undefined)[]): RecentItem[] =>
  views.map((v, i) => ({ content_id: `v${i}`, ...(v === undefined ? {} : { views: v }) }))

describe('computeCreatorHealth', () => {
  it('算不出来时回 unknown，而且不谎称"没买粉"以外的任何事', () => {
    expect(computeCreatorHealth({ followers: undefined, recent_items: [] }).verdict).toBe('unknown')
    expect(computeCreatorHealth({ followers: 0, recent_items: items(100) }).verdict).toBe('unknown')
    expect(computeCreatorHealth({ followers: 1000, recent_items: [] }).verdict).toBe('unknown')
    // 没数字时 views_to_followers 这一格压根不存在（不是 0）
    expect(computeCreatorHealth({ followers: 1000, recent_items: [] }).views_to_followers).toBe(
      undefined,
    )
  })

  it('买粉守卫：粉丝 ≥ 1 万且播放/粉丝 < 2% → suspicious', () => {
    const h = computeCreatorHealth({ followers: 10_000, recent_items: items(190) })
    expect(h.bought_audience_suspected).toBe(true)
    expect(h.verdict).toBe('suspicious')
  })

  it('刚好 2% 不算可疑（阈值是"小于"）', () => {
    const h = computeCreatorHealth({ followers: 10_000, recent_items: items(200) })
    expect(h.bought_audience_suspected).toBe(false)
    expect(h.verdict).toBe('weak')
  })

  it('粉丝不到 1 万的账号永远不会被判 suspicious', () => {
    const h = computeCreatorHealth({ followers: 9_999, recent_items: items(1) })
    expect(h.bought_audience_suspected).toBe(false)
    expect(h.verdict).toBe('weak')
  })

  it('三档：10% excellent / 3% normal / 其余 weak', () => {
    expect(computeCreatorHealth({ followers: 1000, recent_items: items(100) }).verdict).toBe(
      'excellent',
    )
    expect(computeCreatorHealth({ followers: 1000, recent_items: items(30) }).verdict).toBe(
      'normal',
    )
    expect(computeCreatorHealth({ followers: 1000, recent_items: items(29) }).verdict).toBe('weak')
  })

  it('调用方给了 avg_views 就用它，不再从近期作品里算', () => {
    const h = computeCreatorHealth({ followers: 1000, recent_items: items(1), avg_views: 500 })
    expect(h.avg_views).toBe(500)
    expect(h.verdict).toBe('excellent')
  })
})

describe('averageItemViews', () => {
  it('只数页面上真印了播放数的那几条', () => {
    expect(averageItemViews(items(100, undefined, 200))).toBe(150)
  })

  it('一条都没印就回 undefined（不是 0）', () => {
    expect(averageItemViews(items(undefined, undefined))).toBe(undefined)
    expect(averageItemViews([])).toBe(undefined)
  })
})

const content = (over: Partial<ContentSnapshot> = {}): ContentSnapshot => ({
  platform: 'youtube',
  content_id: 'abc',
  url: 'https://www.youtube.com/watch?v=abc',
  author: {},
  observed_at: '2026-09-19T00:00:00.000Z',
  ...over,
})

describe('computeContentHealth', () => {
  it('单条档的阈值是 100% / 10% / 2%，与频道档不同', () => {
    expect(
      computeContentHealth(content({ views: 1000, author: { followers: 1000 } })).verdict,
    ).toBe('viral')
    expect(computeContentHealth(content({ views: 100, author: { followers: 1000 } })).verdict).toBe(
      'good',
    )
    expect(computeContentHealth(content({ views: 20, author: { followers: 1000 } })).verdict).toBe(
      'normal',
    )
    expect(computeContentHealth(content({ views: 19, author: { followers: 1000 } })).verdict).toBe(
      'below',
    )
  })

  it('互动率即使 verdict 是 unknown 也照给——它自己就有意义', () => {
    const h = computeContentHealth(content({ views: 1000, likes: 50, author: {} }))
    expect(h.verdict).toBe('unknown')
    expect(h.engagement_rate).toBeCloseTo(0.05)
  })
})

describe('formatRatioPercent', () => {
  it('一位小数；算不出来是 "-" 不是 "0.0%"', () => {
    expect(formatRatioPercent(0.1234)).toBe('12.3%')
    expect(formatRatioPercent(undefined)).toBe('-')
    expect(formatRatioPercent(Number.NaN)).toBe('-')
  })
})
