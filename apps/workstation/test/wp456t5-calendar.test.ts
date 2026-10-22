/**
 * WP456-T5（WP456 §3.6）：日历页的几样纯判断——图层配色、这一屏数哪几条、页头写什么、
 * 时间格里一条事件画多高、画什么、月格折叠。
 */
import type { CalendarItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { foldMonth } from '@/lib/calendar-allday'
import { LAYER_COLOR } from '@/lib/calendar-layers'
import {
  clockRange,
  countKey,
  displayEnd,
  eventContent,
  monthTitle,
  visibleRange,
  withinRange,
  writeBackEnd,
} from '@/lib/calendar-view'

const item = (over: Partial<CalendarItem> & { id: string; start: string }): CalendarItem =>
  ({
    source: 'todo',
    title: over.id,
    all_day: false,
    drag: 'reschedule',
    ...over,
  }) as unknown as CalendarItem

describe('图层配色：图表四色 + 中性灰 + 「要留意」黄', () => {
  it('四个有颜色的图层各占图表四色里的一个，不撞色', () => {
    const chart = Object.values(LAYER_COLOR).filter((c) => /--ws-chart-[1-4]\)/.test(c))
    expect(chart).toHaveLength(4)
    expect(new Set(chart).size).toBe(4)
  })

  it('没有一层是红的（红只给出错）；后台在跑的两层是中性灰', () => {
    for (const c of Object.values(LAYER_COLOR)) expect(c).not.toMatch(/bad|destructive|chart-5/)
    expect(LAYER_COLOR.scheduled_task).toBe('var(--ws-faint)')
    expect(LAYER_COLOR.standby).toBe('var(--ws-faint)')
    expect(LAYER_COLOR.card_due).toBe('var(--ws-warn)')
  })
})

describe('这一屏画的是哪一段', () => {
  const thu = new Date(2026, 9, 22, 14, 0)

  it('周 = 周一零点到下周一零点；日 = 那一天；月 / 议程 = 那个月', () => {
    const week = visibleRange('week', thu)
    expect(week.from).toEqual(new Date(2026, 9, 19))
    expect(week.to).toEqual(new Date(2026, 9, 26))
    expect(visibleRange('day', thu)).toEqual({
      from: new Date(2026, 9, 22),
      to: new Date(2026, 9, 23),
    })
    expect(visibleRange('month', thu)).toEqual({
      from: new Date(2026, 9, 1),
      to: new Date(2026, 10, 1),
    })
    expect(visibleRange('agenda', thu)).toEqual(visibleRange('month', thu))
  })

  it('「本周 N 项」只数这一周（取回来的窗口前后各宽一周，不算进去）', () => {
    const range = visibleRange('week', thu)
    const at = (d: number, h = 9) => new Date(2026, 9, d, h).toISOString()
    const items = [
      item({ id: 'before', start: at(12) }),
      item({ id: 'mon', start: at(19, 0) }),
      item({ id: 'sun', start: at(25, 23) }),
      item({ id: 'after', start: at(26, 0) }),
      // 从上周跨进来的长事项：这一屏上画着，算
      item({ id: 'span', start: at(17), end: at(20) }),
    ]
    expect(withinRange(items, range).map((i) => i.id)).toEqual(['mon', 'sun', 'span'])
  })

  it('页头说法随视图换；标题写年月', () => {
    expect(countKey('day')).toBe('calendar.count.day')
    expect(countKey('week')).toBe('calendar.count')
    expect(countKey('month')).toBe('calendar.count.month')
    expect(countKey('agenda')).toBe('calendar.count.month')
    expect(monthTitle(thu, 'zh')).toBe('2026 年 10 月')
    expect(monthTitle(thu, 'en')).toBe('October 2026')
  })
})

describe('时间格里一条事件画多高', () => {
  const start = '2026-10-20T01:00:00.000Z'

  it('只有一个时刻、或不到一小时的，按一小时画；一小时以上照原样', () => {
    expect(displayEnd(item({ id: 'p', start }))).toEqual({
      end: '2026-10-20T02:00:00.000Z',
      padded: true,
    })
    expect(displayEnd(item({ id: 'h', start, end: '2026-10-20T01:30:00.000Z' })).padded).toBe(true)
    expect(displayEnd(item({ id: 'l', start, end: '2026-10-20T03:00:00.000Z' }))).toEqual({
      end: '2026-10-20T03:00:00.000Z',
      padded: false,
    })
    expect(displayEnd(item({ id: 'a', start, all_day: true })).padded).toBe(false)
  })

  it('拖走（长度还是补过的那一小时）回写原来的长度；真拉长了就听人的', () => {
    const half = item({ id: 'h', start, end: '2026-10-20T01:30:00.000Z' })
    const moved = '2026-10-20T05:00:00.000Z'
    expect(writeBackEnd(half, moved, '2026-10-20T06:00:00.000Z')).toBe('2026-10-20T05:30:00.000Z')
    expect(writeBackEnd(half, moved, '2026-10-20T07:00:00.000Z')).toBe('2026-10-20T07:00:00.000Z')
    const point = item({ id: 'p', start })
    expect(writeBackEnd(point, moved, '2026-10-20T06:00:00.000Z')).toBe(moved)
    const long = item({ id: 'l', start, end: '2026-10-20T03:00:00.000Z' })
    expect(writeBackEnd(long, moved, '2026-10-20T07:00:00.000Z')).toBe('2026-10-20T07:00:00.000Z')
  })
})

describe('一条事件里画什么', () => {
  it('图层色细条 + 标题 + 「9:00 · 图层名」；标题转义', () => {
    const start = new Date(2026, 9, 20, 9, 0)
    const html = eventContent(
      item({ id: 'x', title: '<b>直播</b> & 抽奖', start: start.toISOString() }),
      { color: 'var(--ws-chart-4)', layerName: '社媒排期' },
    )
    expect(html.timeGrid).toContain('background:var(--ws-chart-4)')
    expect(html.timeGrid).toContain('&lt;b&gt;直播&lt;/b&gt; &amp; 抽奖')
    expect(html.timeGrid).not.toContain('<b>')
    expect(html.timeGrid).toContain('9:00 · 社媒排期')
    expect(html.monthGrid).toContain('ws-ev-clock')
    expect(html.dateGrid).not.toContain('ws-ev-meta')
  })

  it('全天项在月格里不出钟点', () => {
    const html = eventContent(item({ id: 'a', start: '2026-10-20T00:00:00.000Z', all_day: true }), {
      color: 'var(--ws-warn)',
      layerName: '卡片到期',
    })
    expect(html.monthGrid).not.toContain('ws-ev-clock')
  })

  it('钟点不补零，有结束写成一段', () => {
    expect(clockRange(new Date(2026, 9, 20, 9, 0), undefined)).toBe('9:00')
    expect(clockRange(new Date(2026, 9, 20, 14, 0), new Date(2026, 9, 20, 15, 30))).toBe(
      '14:00–15:30',
    )
  })
})

describe('月格也每天 2 条 + 「还有 N 项」', () => {
  const dayOf = (iso: string) => iso.slice(0, 10)

  it('全天项和定了钟点的都算进那一天；先全天、再按钟点，截前 2 条', () => {
    const out = foldMonth(
      [
        item({ id: 't10', start: '2026-10-25T10:00:00.000Z' }),
        item({ id: 't09', start: '2026-10-25T09:00:00.000Z' }),
        item({ id: 'all', start: '2026-10-25T00:00:00.000Z', all_day: true }),
        item({ id: 't11', start: '2026-10-25T11:00:00.000Z' }),
        item({ id: 'other', start: '2026-10-26T09:00:00.000Z' }),
      ],
      dayOf,
    )
    expect(out.shown.map((i) => i.id)).toEqual(['all', 't09', 'other'])
    expect(out.hidden.get('2026-10-25')?.map((i) => i.id)).toEqual(['t10', 't11'])
  })

  it('正好 3 条照画（「还有 1 项」也占一行）', () => {
    const out = foldMonth(
      ['a', 'b', 'c'].map((id) => item({ id, start: '2026-10-21T09:00:00.000Z' })),
      dayOf,
    )
    expect(out.shown).toHaveLength(3)
    expect(out.hidden.size).toBe(0)
  })
})
