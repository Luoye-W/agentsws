/**
 * WP74（37 §2.5）：图层与拖拽语义这两块**纯逻辑**。
 *
 * 分开测的理由：它们是"哪几类东西看得见"与"拖了走哪条路"两份判断，不是一段渲染。
 * 判断有了单测，日历那一屏的组件档就只用管"画出来没有"。
 */
import type { CalendarItem, CalendarSource } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { dispatchDrag, dragRoute, dragVerdict, readonlyReason } from '@/lib/calendar-drag'
import {
  countByLayer,
  defaultLayersFor,
  filterByLayers,
  LAYERS,
  loadLayers,
  loadView,
  parseLayers,
  saveLayers,
  saveView,
  serializeLayers,
  toggleLayer,
} from '@/lib/calendar-layers'
import { translate } from '@/lib/i18n'

const T0 = '2026-09-15T09:00:00.000Z'

const item = (over: Partial<CalendarItem> & { source: CalendarSource }): CalendarItem => ({
  id: `cal_${over.source}_x`,
  title: '一条',
  start: T0,
  all_day: false,
  ref: { type: over.source, id: 'x' },
  ...over,
})

/** 一份能用的内存 storage（Node 25 自带那个全局 localStorage 是残的）。 */
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

describe('图层（WP74）', () => {
  it('从哪儿进来决定默认开哪几层', () => {
    expect(defaultLayersFor('social.meta')).toEqual(['social_post', 'todo'])
    expect(defaultLayersFor('kol.outreach')).toEqual(['kol_deliverable', 'todo'])
    // 客服 / 其它 / 没给：待办 + 会议 + 卡片到期，那是任何岗位都成立的三层
    expect(defaultLayersFor('support.inbox')).toEqual(['todo', 'meeting', 'card_due'])
    expect(defaultLayersFor()).toEqual(['todo', 'meeting', 'card_due'])
  })

  it('URL 上的 layers= 只认得出来的那几个；一个都认不出来 = 没写', () => {
    expect(parseLayers('social_post, todo ,social_post')).toEqual(['social_post', 'todo'])
    expect(parseLayers('birthdays')).toBeUndefined()
    expect(parseLayers('')).toBeUndefined()
    expect(parseLayers(null)).toBeUndefined()
    // 序列化按契约那一份顺序，不按人点的先后
    expect(serializeLayers(['card_due', 'todo'])).toBe('todo,card_due')
  })

  it('勾 / 取消勾；顺序始终按契约那一份', () => {
    expect(toggleLayer(['todo'], 'meeting')).toEqual(['todo', 'meeting'])
    expect(toggleLayer(['todo', 'meeting'], 'todo')).toEqual(['meeting'])
    expect(toggleLayer(['card_due'], 'todo')).toEqual(['todo', 'card_due'])
  })

  it('过滤只影响画不画；数量把关掉的那层也数出来', () => {
    const items = [item({ source: 'todo' }), item({ source: 'meeting' }), item({ source: 'todo' })]
    expect(filterByLayers(items, ['todo'])).toHaveLength(2)
    // 一个图层都不开 = 一条都不画（空选择是人主动做的事）
    expect(filterByLayers(items, [])).toHaveLength(0)
    const counts = countByLayer(items)
    expect(counts.todo).toBe(2)
    expect(counts.meeting).toBe(1)
    expect(counts.standby).toBe(0)
    expect(Object.keys(counts)).toHaveLength(LAYERS.length)
  })

  it('记忆走 localStorage；存储抛了就当没记住，不炸', () => {
    const store = memoryStorage()
    saveLayers(['todo', 'social_post'], store)
    expect(loadLayers(store)).toEqual(['todo', 'social_post'])
    saveView('agenda', store)
    expect(loadView(store)).toBe('agenda')
    // 认不出来的视图名当没记过
    store.map.set('agentsws.calendar.view', 'gantt')
    expect(loadView(store)).toBeUndefined()

    const broken = {
      getItem: () => {
        throw new Error('隐私窗口')
      },
      setItem: () => {
        throw new Error('隐私窗口')
      },
    }
    expect(loadLayers(broken)).toBeUndefined()
    expect(() => {
      saveLayers(['todo'], broken)
    }).not.toThrow()
  })
})

describe('拖拽语义按来源（WP74）', () => {
  /** 用**真的**词表：顺带钉住"每一类都有自己那句话"，少一条这一档就红。 */
  const t = (key: string, vars?: Record<string, string | number>): string =>
    translate('zh', key, vars)
  const line = (key: string): string => translate('zh', key)

  it('待办与社媒排期拖得动', () => {
    expect(dragVerdict(item({ source: 'todo', drag: 'reschedule' }), t)).toEqual({ kind: 'allow' })
    expect(dragVerdict(item({ source: 'social_post', drag: 'reschedule' }), t)).toEqual({
      kind: 'allow',
    })
  })

  it('会议拖了不直接改：出「改时间」那条路', () => {
    expect(dragVerdict(item({ source: 'meeting', drag: 'propose' }), t)).toEqual({
      kind: 'propose',
    })
  })

  it.each([
    ['kol_deliverable', 'calendar.drag.why.kol_deliverable'],
    ['standby', 'calendar.drag.why.standby'],
    ['card_due', 'calendar.drag.why.card_due'],
    ['scheduled_task', 'calendar.drag.why.scheduled_task'],
  ] as const)('只读来源「%s」拖了回弹，并且说得出为什么', (source, why) => {
    const one = item({ source, drag: 'readonly' })
    const verdict = dragVerdict(one, t)
    expect(verdict.kind).toBe('bounce')
    // 每一类都有自己那句话，不是一句"这一类只看不改"打发掉
    expect(readonlyReason(one, t)).toBe(line(why))
    expect(readonlyReason(one, t)).not.toBe(line('calendar.drag.why.default'))
    if (verdict.kind === 'bounce') {
      expect(verdict.why).toContain(line(why))
      expect(verdict.why).toContain(one.title)
    }
  })

  it('已经发出去的社媒帖子拖不动（那是历史，不是计划）', () => {
    const published = item({ source: 'social_post', drag: 'readonly', status: 'published' })
    expect(dragVerdict(published, t).kind).toBe('bounce')
    expect(readonlyReason(published, t)).toBe(line('calendar.drag.why.social_published'))
  })

  it('认不出来的那一条也回弹：拿不准的时候不改东西', () => {
    expect(dragVerdict(undefined, t).kind).toBe('bounce')
  })

  it('拖完了分发：待办走 todo 路由、社媒走 social schedule 路由、只读一条都不发', () => {
    const sinks = { todo: vi.fn(), socialPost: vi.fn() }
    const slot = { start: T0, end: '2026-09-15T10:00:00.000Z' }

    expect(
      dispatchDrag(
        item({ source: 'todo', drag: 'reschedule', ref: { type: 'todo', id: 'td_1' } }),
        slot,
        sinks,
      ),
    ).toBe('todo')
    expect(sinks.todo).toHaveBeenCalledWith('td_1', slot)

    expect(
      dispatchDrag(
        item({
          source: 'social_post',
          drag: 'reschedule',
          ref: { type: 'social_post', id: 'sp_1' },
        }),
        slot,
        sinks,
      ),
    ).toBe('social_post')
    // 社媒只有一个时刻（到点就发），所以只递 start
    expect(sinks.socialPost).toHaveBeenCalledWith('sp_1', T0)

    expect(dispatchDrag(item({ source: 'kol_deliverable', drag: 'readonly' }), slot, sinks)).toBe(
      'none',
    )
    expect(dragRoute(item({ source: 'meeting', drag: 'propose' }))).toBe('none')
    expect(sinks.todo).toHaveBeenCalledTimes(1)
    expect(sinks.socialPost).toHaveBeenCalledTimes(1)
  })
})
