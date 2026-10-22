/**
 * WP469（决策 1521–1527）：日历与待办合成一页——工作模型这一侧要钉住的几件事：
 * - 没日子的待办（「本周」）改字 / 打勾不再掉回「以后」；
 * - 做完的待办要了才上日历（划掉、变淡），拖不动；
 * - 「帮我排进空档」：工作时间、不排周末、避开会议与直播前后半小时、候选互不重叠、只给候选不写。
 */
import type { CalendarItem, Todo } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { buildCalendar } from '../src/calendar.js'
import { createWork } from '../src/service.js'
import { estimateTodoMinutes, proposeSlots, slotStarts } from '../src/slots.js'
import { FakeClock, seeded } from './helpers.js'

const TZ = 480
/** 2026-09-09 周三 北京 09:00 */
const WED_9 = '2026-09-09T01:00:00.000Z'
/** 那一周：周一 09-07 00:00 到下周一 00:00（北京） */
const WEEK = { from: '2026-09-06T16:00:00.000Z', to: '2026-09-13T16:00:00.000Z' }

const bj = (day: number, hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 8, day, hh - 8, mm)).toISOString()

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '给工厂确认备货量',
  owner: 'per_1',
  horizon: 'week',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: WED_9,
  updated_at: WED_9,
  ...over,
})

const meeting = (start: string, end: string, title = '周会'): CalendarItem => ({
  id: `cal_meet_${start}`,
  source: 'meeting',
  title,
  start,
  end,
  all_day: false,
  ref: { type: 'meeting', id: start },
})

function make() {
  const clock = new FakeClock(WED_9)
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    random: seeded(7),
    tz_offset_minutes: TZ,
  })
  return { work, clock }
}

describe('没日子的待办改一下不换档（WP469）', () => {
  it('「本周」没日子的：改字、打勾都还在本周', () => {
    const { work } = make()
    const t = work.createTodo({ title: '写新品页文案', owner: 'per_1', horizon: 'week' })
    expect(t.horizon).toBe('week')
    expect(work.updateTodo(t.id, { title: '写新品页文案（v2）' }).horizon).toBe('week')
    expect(work.updateTodo(t.id, { status: 'done' }).horizon).toBe('week')
  })

  it('拖回「还没排期的」：两样都清掉、按给的那档放', () => {
    const { work } = make()
    const t = work.createTodo({
      title: '拍主图样品',
      owner: 'per_1',
      scheduled: { start: bj(10, 14), end: bj(10, 15) },
    })
    expect(t.horizon).toBe('week')
    const back = work.updateTodo(t.id, { scheduled: null, due: null, horizon: 'backlog' })
    expect(back.scheduled).toBeUndefined()
    expect(back.due).toBeUndefined()
    expect(back.horizon).toBe('backlog')
  })

  it('有日子的照旧按日子推（拖到今天 → 今天）', () => {
    const { work } = make()
    const t = work.createTodo({ title: '给 Maya 回报价', owner: 'per_1', horizon: 'week' })
    expect(work.updateTodo(t.id, { due: bj(9, 12) }).horizon).toBe('today')
  })
})

describe('做完的待办上日历（决策 1524）', () => {
  const done = todo({ id: 'td_done', status: 'done', due: bj(9, 12) })
  const open = todo({ id: 'td_open', due: bj(9, 12) })

  it('不要就不给（老调用方行为不变）', () => {
    const items = buildCalendar({ range: { ...WEEK }, todos: [done, open] })
    expect(items.map((i) => i.ref.id)).toEqual(['td_open'])
  })

  it('要了就给，状态 done、拖不动', () => {
    const items = buildCalendar({ range: { ...WEEK, include_done: true }, todos: [done, open] })
    const d = items.find((i) => i.ref.id === 'td_done')
    expect(d?.status).toBe('done')
    expect(d?.drag).toBe('readonly')
    expect(items.find((i) => i.ref.id === 'td_open')?.drag).toBe('reschedule')
  })

  it('服务层：include_done 才把做完的取出来', () => {
    const { work } = make()
    const t = work.createTodo({ title: '核对退款单', owner: 'per_1', due: bj(9, 12) })
    work.complete(t.id)
    expect(work.calendar(WEEK, { person_id: 'per_1' })).toHaveLength(0)
    expect(work.calendar({ ...WEEK, include_done: true }, { person_id: 'per_1' })).toHaveLength(1)
  })
})

describe('帮我排进空档（决策 1522）', () => {
  it('时长按标题里的动词估', () => {
    expect(estimateTodoMinutes('写新品页文案')).toBe(120)
    expect(estimateTodoMinutes('整理 3 个红人的寄样清单')).toBe(90)
    expect(estimateTodoMinutes('给工厂确认 12 月备货量')).toBe(60)
  })

  it('起点：工作时间、半小时对齐、不早于现在、不排周末', () => {
    const starts = slotStarts({ ...WEEK, now: bj(9, 9, 10), tz_offset_minutes: TZ })
    const first = starts[0] as number
    expect(new Date(first).toISOString()).toBe(bj(9, 9, 30))
    const days = new Set(starts.map((s) => new Date(s + TZ * 60_000).getUTCDay()))
    expect(days.has(0)).toBe(false)
    expect(days.has(6)).toBe(false)
    for (const s of starts) {
      const local = new Date(s + TZ * 60_000)
      const min = local.getUTCHours() * 60 + local.getUTCMinutes()
      expect(min).toBeGreaterThanOrEqual(9 * 60)
      expect(min).toBeLessThan(18 * 60)
    }
  })

  it('避开会议，直播前后再空半小时；候选互不重叠', () => {
    const items = [meeting(bj(9, 9), bj(9, 10)), meeting(bj(9, 11), bj(9, 12), '直播彩排')]
    const out = proposeSlots({
      todos: [
        todo({ id: 'a', title: '写新品页文案' }),
        todo({ id: 'b', title: '给工厂确认备货量' }),
      ],
      items,
      ...WEEK,
      now: WED_9,
      tz_offset_minutes: TZ,
    })
    expect(out.unplaced).toEqual([])
    const a = out.proposals.find((p) => p.todo_id === 'a')
    const b = out.proposals.find((p) => p.todo_id === 'b')
    // 写文案 2 小时：10:00 起会撞直播前半小时（10:30），所以落到直播后半小时 12:30
    expect(a?.minutes).toBe(120)
    expect(a?.options[0]).toEqual({ start: bj(9, 12, 30), end: bj(9, 14, 30) })
    // 确认 1 小时：10:00–11:00 撞直播前那半小时，10:00 不行；14:30 起
    expect(b?.options[0]?.start).toBe(bj(9, 14, 30))
    // 「换一个」那几个：不撞自己的、不撞别人的头一个
    for (const p of out.proposals) {
      const others = out.proposals.filter((x) => x !== p).map((x) => x.options[0])
      for (const o of p.options) {
        for (const x of others) {
          if (x === undefined) continue
          expect(
            Date.parse(o.start) < Date.parse(x.end) && Date.parse(x.start) < Date.parse(o.end),
          ).toBe(false)
        }
      }
      expect(p.options.length).toBeGreaterThan(1)
    }
  })

  it('只排没日子、没做完、不在 AI 手上的；排不下的记进 unplaced', () => {
    const out = proposeSlots({
      todos: [
        todo({ id: 'dated', due: bj(10, 12) }),
        todo({
          id: 'ai',
          delegate: { assignment_id: 'asg', brief: '', state: 'running', at: WED_9 },
        }),
        todo({ id: 'done', status: 'done' }),
        todo({ id: 'ok' }),
      ],
      items: [],
      from: bj(12, 0),
      to: bj(13, 0),
      now: WED_9,
      tz_offset_minutes: TZ,
    })
    // 09-12 是周六：一个空档都没有
    expect(out.proposals).toEqual([])
    expect(out.unplaced).toEqual(['ok'])
  })
})
