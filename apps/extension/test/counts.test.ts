/**
 * 页面数字解析与阈值筛选。
 *
 * 这一组测试真正在守的是一句话：**认不出来的数字要放行，不要当 0**。
 * 把它写错的后果不是"少一个功能"，是"用户设了 1 万订阅的门槛之后，
 * 搜索结果里所有视频行全部消失"——而那些恰恰是最值得发现的人。
 */
import { describe, expect, it } from 'vitest'
import type { BulkCandidate } from '../src/lib/bulk.js'
import {
  applyBulkFailure,
  applyBulkResult,
  applyCaptureFilters,
  candidateBestViews,
  chunkItems,
  dedupeCandidates,
  emptyTally,
  parseFilterPrefs,
  randomBatchDelayMs,
} from '../src/lib/bulk.js'
import { formatCount, parseCompactCount } from '../src/lib/counts.js'

describe('parseCompactCount', () => {
  it('认中文单位', () => {
    expect(parseCompactCount('1.2万位订阅者')).toBe(12_000)
    expect(parseCompactCount('2亿次观看')).toBe(200_000_000)
    expect(parseCompactCount('3千')).toBe(3_000)
  })

  it('认拉丁单位，但必须是整词', () => {
    expect(parseCompactCount('1.2K subscribers')).toBe(1_200)
    expect(parseCompactCount('3.4M views')).toBe(3_400_000)
    expect(parseCompactCount('2B')).toBe(2_000_000_000)
    // `members` 里的 m 不是百万
    expect(parseCompactCount('1234 members')).toBe(1_234)
  })

  it('认 en 的千分位逗号', () => {
    expect(parseCompactCount('1,234,567')).toBe(1_234_567)
  })

  it('认 de 风格的点千分位——但只在没有单位的时候', () => {
    expect(parseCompactCount('1.234')).toBe(1_234)
    // 有单位时点必须是小数点，否则 1.234M 会变成 12.34 亿
    expect(parseCompactCount('1.234M')).toBe(1_234_000)
  })

  it('认 fr / ru 的空格千分位（含 NBSP 与窄 NBSP）', () => {
    expect(parseCompactCount('1 234 567')).toBe(1_234_567)
    expect(parseCompactCount('12 345')).toBe(12_345)
  })

  it('认不出来回 undefined，不回 0', () => {
    expect(parseCompactCount(undefined)).toBe(undefined)
    expect(parseCompactCount('')).toBe(undefined)
    expect(parseCompactCount('订阅')).toBe(undefined)
  })
})

describe('formatCount', () => {
  it('写回人看的样子', () => {
    expect(formatCount(12_000)).toBe('1.2万')
    expect(formatCount(200_000_000)).toBe('2.0亿')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(undefined)).toBe('-')
  })
})

const candidate = (over: Partial<BulkCandidate> = {}): BulkCandidate => ({
  external_id: 'UC1',
  videos: [],
  source: 'channel_result',
  ...over,
})

describe('阈值筛选', () => {
  it('文本阈值解析成数字；填不出数的当没填', () => {
    expect(parseFilterPrefs({ min_views_text: '10万', min_subscribers_text: '' })).toEqual({
      min_views: 100_000,
    })
    expect(parseFilterPrefs({ min_subscribers_text: '0' })).toEqual({})
  })

  it('取该创作者所见视频的播放【最大值】，不是平均', () => {
    const c = candidate({
      videos: [
        { content_id: 'a', views_text: '1000' },
        { content_id: 'b', views_text: '50万' },
      ],
    })
    expect(candidateBestViews(c)).toBe(500_000)
  })

  it('量到了并且不达标才滤掉', () => {
    const rows = [
      candidate({ external_id: 'low', videos: [{ content_id: 'a', views_text: '100' }] }),
      candidate({ external_id: 'high', videos: [{ content_id: 'b', views_text: '20万' }] }),
    ]
    const out = applyCaptureFilters(rows, { min_views: 100_000 })
    expect(out.visible.map((r) => r.external_id)).toEqual(['high'])
    expect(out.hidden).toBe(1)
    expect(out.unknown).toBe(0)
  })

  it('页面没印那个数字的行一律放行，并单独记进 unknown', () => {
    const rows = [candidate({ external_id: 'nobyline', videos: [{ content_id: 'a' }] })]
    const out = applyCaptureFilters(rows, { min_subscribers: 1_000 })
    expect(out.visible).toHaveLength(1)
    expect(out.hidden).toBe(0)
    expect(out.unknown).toBe(1)
  })

  it('一条阈值都没填时原样返回', () => {
    const rows = [candidate(), candidate({ external_id: 'UC2' })]
    const out = applyCaptureFilters(rows, {})
    expect(out.visible).toHaveLength(2)
    expect(out.hidden).toBe(0)
    expect(out.unknown).toBe(0)
  })
})

describe('去重与分块', () => {
  it('同一个人的频道行与视频署名行合成一行，身份以频道行为准', () => {
    const merged = dedupeCandidates([
      candidate({
        external_id: 'UC1',
        display_name: '正名',
        subscriber_count_text: '10万',
        source: 'channel_result',
      }),
      candidate({
        external_id: 'UC1',
        display_name: '署名',
        videos: [{ content_id: 'v1' }],
        source: 'video_attribution',
      }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.display_name).toBe('正名')
    expect(merged[0]?.source).toBe('channel_result')
    expect(merged[0]?.videos).toHaveLength(1)
  })

  it('分块，size < 1 时整包一块（不然会死循环）', () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkItems([1, 2], 0)).toEqual([[1, 2]])
    expect(chunkItems([], 0)).toEqual([])
  })

  it('块间隔在 300–800ms 之间', () => {
    expect(randomBatchDelayMs(() => 0)).toBe(300)
    expect(randomBatchDelayMs(() => 1)).toBe(800)
  })
})

describe('批量回执的账', () => {
  it('没答上来的那几条记 failed——账必须对得上', () => {
    const tally = applyBulkResult(emptyTally(), [{ status: 'ok' }, { status: 'deduped' }], 5)
    expect(tally).toEqual({ ok: 1, deduped: 1, invalid: 0, failed: 3 })
    expect(tally.ok + tally.deduped + tally.invalid + tally.failed).toBe(5)
  })

  it('认不得的 status 一律记 invalid', () => {
    expect(applyBulkResult(emptyTally(), [{ status: '???' }], 1).invalid).toBe(1)
  })

  it('整块失败就整块记 failed', () => {
    expect(applyBulkFailure(emptyTally(), 20).failed).toBe(20)
  })
})
