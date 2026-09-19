/**
 * WP125（72 §1.E / §P0-3 ⑤）：四个优先级带的名字与分组计数。
 *
 * 要钉的是「**派生不存列**」这条：分组数与排序读的是同一个 `priority_band`，
 * 所以"客户在等 3"与列表里真的排在最前的那三张永远是同一批。
 */
import { describe, expect, it } from 'vitest'
import { BAND_LABELS, BAND_ORDER, bandCounts, bandSummaryLine, groupByBand } from '../src/bands.js'
import { sortCards } from '../src/queue.js'
import type { DeckCard, PriorityBand } from '../src/types.js'

const card = (id: string, band: PriorityBand): DeckCard =>
  ({
    id,
    priority_band: band,
    priority: band === 'P0' ? 'immediate' : 'queue',
    detail: { created_at: '2026-09-19T00:00:00.000Z' },
  }) as unknown as DeckCard

const cards = [
  card('c1', 'P3'),
  card('c2', 'P0'),
  card('c3', 'P1'),
  card('c4', 'P0'),
  card('c5', 'P2'),
]

describe('优先级带', () => {
  it('四个带、四句话，顺序固定', () => {
    expect(BAND_ORDER).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(BAND_LABELS).toEqual({
      P0: '客户在等',
      P1: '待你确认',
      P2: '需要处理',
      P3: '无人等待',
    })
  })

  it('分组：空带也回（「客户在等 0」是一句有用的话）', () => {
    const groups = groupByBand([card('x', 'P1')])
    expect(groups.map((g) => g.band)).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(groups[0]).toMatchObject({ label: '客户在等', count: 0 })
    expect(groups[1]?.count).toBe(1)
  })

  it('分组计数与队列序是同一份 band（数字对得上列表）', () => {
    const sorted = sortCards(cards)
    const counts = bandCounts(cards)
    expect(counts).toEqual({ P0: 2, P1: 1, P2: 1, P3: 1 })
    // 排在最前的那 counts.P0 张，正好就是被数进「客户在等」的那几张
    expect(sorted.slice(0, counts.P0).every((c) => c.priority_band === 'P0')).toBe(true)
  })

  it('一行摘要：零的那几带不出现（减字）', () => {
    expect(bandSummaryLine(cards)).toBe('客户在等 2 · 待你确认 1 · 需要处理 1 · 无人等待 1')
    expect(bandSummaryLine([card('x', 'P1')])).toBe('待你确认 1')
    expect(bandSummaryLine([])).toBe('')
  })
})
