/**
 * WP457（WP456 §3.6 P0）：周视图全天区一条横带——每天最多 2 条，多的折成「还有 N 项」；
 * 「卡片到期」不再是红色（红只给出错）。
 */
import type { CalendarItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { ALL_DAY_MAX, foldAllDay, MORE_ID_PREFIX, moreDayOf } from '@/lib/calendar-allday'
import { LAYER_COLOR } from '@/lib/calendar-layers'

const item = (id: string, start: string, all_day: boolean): CalendarItem =>
  ({
    id,
    source: 'card_due',
    title: id,
    start,
    all_day,
    drag: 'readonly',
  }) as unknown as CalendarItem

const dayOf = (iso: string) => iso.slice(0, 10)

describe('WP457 全天区折叠', () => {
  it('一天 13 条全天项：画前 2 条，其余 11 条折起来；时间格里的照画', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      item(`c${i}`, '2026-10-25T00:00:00.000Z', true),
    )
    const timed = item('meet', '2026-10-25T03:00:00.000Z', false)
    const out = foldAllDay([...many, timed], dayOf)
    expect(ALL_DAY_MAX).toBe(2)
    expect(out.shown.map((i) => i.id)).toEqual(['meet', 'c0', 'c1'])
    expect(out.hidden.get('2026-10-25')?.map((i) => i.id)).toEqual(many.slice(2).map((i) => i.id))
  })

  it('只比上限多 1 条时照画（「还有 1 项」也占一行，不如直接画出来）', () => {
    const three = ['a', 'b', 'c'].map((id) => item(id, '2026-10-21T00:00:00.000Z', true))
    const out = foldAllDay(three, dayOf)
    expect(out.shown).toHaveLength(3)
    expect(out.hidden.size).toBe(0)
  })

  it('按天分开数：别的天不受影响', () => {
    const out = foldAllDay(
      [
        ...['a', 'b', 'c', 'd'].map((id) => item(id, '2026-10-21T00:00:00.000Z', true)),
        item('e', '2026-10-22T00:00:00.000Z', true),
      ],
      dayOf,
    )
    expect(out.shown.map((i) => i.id).sort()).toEqual(['a', 'b', 'e'])
    expect([...out.hidden.keys()]).toEqual(['2026-10-21'])
  })

  it('「还有 N 项」的事件 id 认得出那一天；别的 id 不认', () => {
    expect(moreDayOf(`${MORE_ID_PREFIX}2026-10-25`)).toBe('2026-10-25')
    expect(moreDayOf('cal_card_1')).toBeUndefined()
  })
})

describe('WP457 图层颜色：红只给出错', () => {
  it('「卡片到期」是「要留意」的黄，不是红', () => {
    expect(LAYER_COLOR.card_due).toBe('var(--ws-warn)')
    expect(LAYER_COLOR.card_due).not.toMatch(/destructive|bad/)
  })

  it('黄只给「卡片到期」一层，不和定时任务撞色', () => {
    const yellow = Object.entries(LAYER_COLOR).filter(([, c]) =>
      /--ws-warn\b|var\(--chart-4\)/.test(c),
    )
    expect(yellow.map(([k]) => k)).toEqual(['card_due'])
  })
})
