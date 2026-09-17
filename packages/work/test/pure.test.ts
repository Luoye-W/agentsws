/**
 * 纯逻辑那几块：util / horizon / goals / calendar。
 * 都不碰 IO，所以给同样的输入永远出同样的输出。
 */
import { describe, expect, it } from 'vitest'
import {
  buildCalendar,
  deliverableCalendarItem,
  socialPostCalendarItem,
  sortCalendar,
  standbyCalendarItem,
  todoCalendarItem,
} from '../src/calendar.js'
import { notFound, WorkError } from '../src/errors.js'
import {
  BEHIND_THRESHOLD_PCT,
  daysLeft,
  elapsedPct,
  goalProgress,
  goalProgressAll,
  goalTree,
} from '../src/goals.js'
import { deriveHorizon, isOpen, resolveHorizon, WEEK_DAYS } from '../src/horizon.js'
import {
  atLocalTime,
  byKeyThenId,
  DAY_MS,
  localDay,
  makeIdFactory,
  ms,
  overlaps,
  plusMs,
  round2,
  startOfDay,
  uniq,
} from '../src/util.js'
import { approval, goal, seeded, T0, todo } from './helpers.js'

const TZ = 480 // +08:00

describe('util', () => {
  it('id 工厂：可排序、唯一、只用注入的时间与随机', () => {
    const newId = makeIdFactory(seeded(1), () => T0)
    const a = newId('td')
    const b = newId('td')
    expect(a.startsWith('td_')).toBe(true)
    expect(a).not.toBe(b)
    // 时间前缀相同（同一时刻）
    expect(a.slice(3, 13)).toBe(b.slice(3, 13))
  })

  it('id 工厂：时间不可解析时退回 0 前缀，仍然唯一', () => {
    const newId = makeIdFactory(seeded(2), () => 'not-a-date')
    expect(newId('x').slice(2, 12)).toBe(newId('x').slice(2, 12))
  })

  it('日界线按工作区时区切', () => {
    // 北京时间 2026-09-09 09:00 = UTC 01:00 → 当天零点 = UTC 前一天 16:00
    expect(new Date(startOfDay(ms(T0), TZ)).toISOString()).toBe('2026-09-08T16:00:00.000Z')
    expect(localDay(T0, TZ)).toBe('2026-09-09')
    expect(localDay(T0, 0)).toBe('2026-09-09')
    expect(localDay('2026-09-08T23:30:00.000Z', TZ)).toBe('2026-09-09')
  })

  it('atLocalTime / plusMs / round2 / uniq / overlaps / byKeyThenId', () => {
    const day = startOfDay(ms(T0), TZ)
    expect(atLocalTime(day, 9)).toBe('2026-09-09T01:00:00.000Z')
    expect(atLocalTime(day, 9, 30)).toBe('2026-09-09T01:30:00.000Z')
    expect(plusMs(T0, DAY_MS)).toBe('2026-09-10T01:00:00.000Z')
    expect(round2(1.23456)).toBe(1.23)
    expect(uniq(['a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(overlaps(0, 10, 5, 15)).toBe(true)
    expect(overlaps(0, 10, 10, 15)).toBe(false)
    // 零长度区间当成点
    expect(overlaps(5, 5, 0, 10)).toBe(true)
    expect(overlaps(10, 10, 0, 10)).toBe(false)
    const cmp = byKeyThenId<{ id: string; v: number }>((x) => x.v)
    const list = [
      { id: 'b', v: 1 },
      { id: 'a', v: 1 },
      { id: 'c', v: 0 },
    ]
    expect([...list].sort(cmp).map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(cmp({ id: 'a', v: 1 }, { id: 'a', v: 1 })).toBe(0)
  })
})

describe('WorkError', () => {
  it('用契约的错误码，details 可省', () => {
    const e = notFound('待办', 'td_9')
    expect(e.code).toBe('not_found')
    expect(e.message).toContain('td_9')
    expect(e.details).toEqual({ id: 'td_9' })
    expect(new WorkError('invalid_input', 'x').details).toBeUndefined()
  })
})

describe('horizon 推导（37 §2.2）', () => {
  it('无 due 无 scheduled = backlog（长期待办）', () => {
    expect(deriveHorizon({}, T0, TZ)).toBe('backlog')
  })

  it('有 scheduled：今天 / 本周 / 更远', () => {
    expect(deriveHorizon({ scheduled: { start: T0, end: T0 } }, T0, TZ)).toBe('today')
    expect(deriveHorizon({ scheduled: { start: plusMs(T0, 2 * DAY_MS), end: T0 } }, T0, TZ)).toBe(
      'week',
    )
    expect(deriveHorizon({ scheduled: { start: plusMs(T0, 30 * DAY_MS), end: T0 } }, T0, TZ)).toBe(
      'backlog',
    )
  })

  it('只有 due：过期与今天都算今天，本周内算 week，更远回 backlog', () => {
    expect(deriveHorizon({ due: plusMs(T0, -5 * DAY_MS) }, T0, TZ)).toBe('today')
    expect(deriveHorizon({ due: plusMs(T0, 2 * 3_600_000) }, T0, TZ)).toBe('today')
    expect(deriveHorizon({ due: plusMs(T0, 3 * DAY_MS) }, T0, TZ)).toBe('week')
    expect(deriveHorizon({ due: plusMs(T0, WEEK_DAYS * DAY_MS) }, T0, TZ)).toBe('backlog')
  })

  it('显式给了 horizon 就用它（手动放进本周是允许的）', () => {
    expect(resolveHorizon({ horizon: 'week' }, T0, TZ)).toBe('week')
    expect(resolveHorizon({ due: T0 }, T0, TZ)).toBe('today')
  })

  it('isOpen：open / doing / blocked 算未完', () => {
    expect(isOpen(todo({ status: 'open' }))).toBe(true)
    expect(isOpen(todo({ status: 'doing' }))).toBe(true)
    expect(isOpen(todo({ status: 'blocked' }))).toBe(true)
    expect(isOpen(todo({ status: 'done' }))).toBe(false)
    expect(isOpen(todo({ status: 'dropped' }))).toBe(false)
  })
})

describe('目标进度（37 §2.3）', () => {
  const now = '2026-09-16T00:00:00.000Z' // 9 月过了一半

  it('查不到值 = no_data，进度与值都缺省', () => {
    const p = goalProgress(goal(), () => undefined, now)
    expect(p.status).toBe('no_data')
    expect(p.value).toBeUndefined()
    expect(p.progress_pct).toBeUndefined()
    expect(p.days_left).toBe(15)
  })

  it('进度跟得上时间 = ok；落后超过阈值 = behind', () => {
    const ok = goalProgress(goal(), () => ({ value: 60000, currency: 'USD' }), now)
    expect(ok.status).toBe('ok')
    expect(ok.progress_pct).toBe(60)
    expect(ok.currency).toBe('USD')
    expect(ok.elapsed_pct).toBe(50)

    const behind = goalProgress(goal(), () => ({ value: 20000 }), now)
    expect(behind.status).toBe('behind')
    expect(behind.progress_pct).toBe(20)
    expect(BEHIND_THRESHOLD_PCT).toBe(10)
  })

  it('target = 0 时不算进度，落回 no_data', () => {
    const p = goalProgress(goal({ target: 0 }), () => ({ value: 5 }), now)
    expect(p.progress_pct).toBeUndefined()
    expect(p.status).toBe('no_data')
    expect(p.value).toBe(5)
  })

  it('负值不产生负进度；带岗位的目标把 position_id 带出来', () => {
    const p = goalProgress(
      goal({ position_id: 'asg_1', level: 'position' }),
      () => ({ value: -100 }),
      now,
    )
    expect(p.progress_pct).toBe(0)
    expect(p.position_id).toBe('asg_1')
  })

  it('剩余天数与已过比例：期间外夹在 0 / 100', () => {
    expect(daysLeft('2026-09-20T00:00:00.000Z', now)).toBe(4)
    expect(daysLeft('2026-09-10T00:00:00.000Z', now)).toBe(-6)
    const period = goal().period
    expect(elapsedPct(period, '2026-08-01T00:00:00.000Z')).toBe(0)
    expect(elapsedPct(period, '2026-11-01T00:00:00.000Z')).toBe(100)
    // 零长度期间当成已过完
    expect(elapsedPct({ kind: 'week', start: T0, end: T0 }, T0)).toBe(100)
  })

  it('goalProgressAll 与三级目标树', () => {
    const goals = [
      goal(),
      goal({ id: 'goal_2', level: 'position', parent_id: 'goal_1' }),
      goal({ id: 'goal_3', level: 'person', parent_id: 'goal_2' }),
      goal({ id: 'goal_4', level: 'person', parent_id: 'goal_missing' }),
    ]
    const progress = goalProgressAll(goals, () => ({ value: 1 }), now)
    expect(progress).toHaveLength(4)
    const tree = goalTree(goals, progress)
    expect(tree.map((n) => n.goal.id)).toEqual(['goal_1', 'goal_4'])
    expect(tree[0]?.children[0]?.goal.id).toBe('goal_2')
    expect(tree[0]?.children[0]?.children[0]?.goal.id).toBe('goal_3')
    // 没有进度的目标不进树
    expect(goalTree(goals, progress.slice(0, 1)).map((n) => n.goal.id)).toEqual(['goal_1'])
  })
})

describe('日历（37 C3）', () => {
  const range = { from: '2026-09-09T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' }

  it('有排期的占时段；只有 due 的挂那天不占时段；都没有的不进日历', () => {
    expect(
      todoCalendarItem(todo({ scheduled: { start: T0, end: plusMs(T0, 3_600_000) } })),
    ).toMatchObject({ all_day: false, source: 'todo' })
    expect(todoCalendarItem(todo({ due: T0 }))).toMatchObject({ all_day: true })
    expect(todoCalendarItem(todo())).toBeUndefined()
  })

  it('四类来源合并；已完成的待办不进；范围外的滤掉', () => {
    const items = buildCalendar({
      range,
      todos: [
        todo({ id: 'td_s', scheduled: { start: T0, end: plusMs(T0, 3_600_000) } }),
        todo({ id: 'td_d', due: plusMs(T0, 3_600_000) }),
        todo({ id: 'td_done', status: 'done', due: T0 }),
        todo({ id: 'td_far', due: '2026-10-01T00:00:00.000Z' }),
        todo({ id: 'td_none' }),
      ],
      meetings: [
        {
          id: 'cal_meet_1',
          source: 'meeting',
          title: '周会',
          start: '2026-09-09T02:00:00.000Z',
          end: '2026-09-09T03:00:00.000Z',
          all_day: false,
          ref: { type: 'meeting', id: 'mtg_1' },
        },
      ],
      tasks: [
        { id: 'sch_1', state: 'active', next_fire_at: '2026-09-09T04:00:00.000Z', title: '日报' },
        { id: 'sch_2', state: 'paused', next_fire_at: '2026-09-09T05:00:00.000Z' },
        { id: 'sch_3', state: 'active' },
      ],
      cards: [
        approval({ id: 'apr_due', expires_at: '2026-09-09T06:00:00.000Z' }),
        approval({ id: 'apr_due2', due_at: '2026-09-09T07:00:00.000Z' }),
        approval({ id: 'apr_none' }),
      ],
    })
    expect(items.map((i) => i.id)).toEqual([
      'cal_todo_td_s',
      'cal_meet_1',
      'cal_todo_td_d',
      'cal_task_sch_1',
      'cal_card_apr_due',
      'cal_card_apr_due2',
    ])
  })

  it('卡片到期叠层可关；定时任务带岗位；待办带事项', () => {
    const items = buildCalendar({
      range: { ...range, include_card_due: false },
      todos: [todo({ id: 'td_m', matter_id: 'mat_1', position_id: 'asg_1', due: T0 })],
      tasks: [
        {
          id: 'sch_1',
          state: 'pending',
          next_fire_at: '2026-09-09T04:00:00.000Z',
          assignment_id: 'asg_1',
        },
      ],
      cards: [approval({ expires_at: T0 })],
    })
    expect(items.map((i) => i.source)).toEqual(['todo', 'scheduled_task'])
    expect(items[0]?.matter_id).toBe('mat_1')
    expect(items[0]?.position_id).toBe('asg_1')
    expect(items[1]?.position_id).toBe('asg_1')
    expect(items[1]?.title).toBe('sch_1')
  })

  it('拖进日历只落了一个点的待办给默认时长，画得出来', () => {
    const items = buildCalendar({
      range,
      todos: [todo({ id: 'td_p', scheduled: { start: T0, end: T0 } })],
    })
    expect(items[0]?.end).toBe(plusMs(T0, 3_600_000))
  })

  it('卡片到期项带上事项 id（挂在事项上的卡）', () => {
    const items = buildCalendar({
      range,
      todos: [],
      cards: [
        approval({
          subject: { object: { type: 'thread', id: 't' }, matter_id: 'mat_9' },
          expires_at: T0,
        }),
      ],
    })
    expect(items[0]?.matter_id).toBe('mat_9')
  })

  // ── WP74：一个日历，多图层 ────────────────────────────────────────

  it('社媒排期上日历：草稿不上（还没有时间）、已发的拖不动、撞车说明原样带过来', () => {
    expect(
      socialPostCalendarItem({ id: 'p0', account_id: 'a1', channel: 'meta', status: 'draft' }),
    ).toBeUndefined()
    const scheduled = socialPostCalendarItem({
      id: 'p1',
      account_id: 'a1',
      channel: 'meta',
      status: 'scheduled',
      scheduled_at: T0,
      body: '  新品 上线  了 ',
      conflicts: ['这个号 90 分钟内已经有一条了。'],
    })
    expect(scheduled).toMatchObject({
      source: 'social_post',
      channel: 'meta',
      all_day: false,
      drag: 'reschedule',
      title: '新品 上线 了',
      notes: ['这个号 90 分钟内已经有一条了。'],
    })
    // 一个时刻画不出来，所以给半小时的块（只为画得出来，不写回任何一张表）
    expect(scheduled?.end).toBe(plusMs(T0, 30 * 60_000))
    expect(
      socialPostCalendarItem({
        id: 'p2',
        account_id: 'a1',
        channel: 'meta',
        status: 'published',
        scheduled_at: T0,
      }),
    ).toMatchObject({ drag: 'readonly' })
  })

  it('红人交付物：没交的挂到期那天且拖不动；交了的不再占日历', () => {
    expect(
      deliverableCalendarItem({ id: 'dl_1', collaboration_id: 'c1', kind: 'video', due_at: T0 }),
    ).toMatchObject({ source: 'kol_deliverable', all_day: true, drag: 'readonly' })
    expect(
      deliverableCalendarItem({
        id: 'dl_2',
        collaboration_id: 'c1',
        kind: 'video',
        due_at: T0,
        submitted_at: T0,
      }),
    ).toBeUndefined()
    expect(
      deliverableCalendarItem({ id: 'dl_3', collaboration_id: 'c1', kind: 'video', due_at: '' }),
    ).toBeUndefined()
  })

  it('值守续期日：一个工作区一条，拖不动', () => {
    expect(
      standbyCalendarItem({ workspace_id: 'ws_a', status: 'running', period_end: T0, seats: 2 }),
    ).toMatchObject({ id: 'cal_standby_ws_a', source: 'standby', all_day: true, drag: 'readonly' })
    expect(
      standbyCalendarItem({ workspace_id: 'ws_a', status: 'running', period_end: 'x' }),
    ).toBeUndefined()
  })

  it('不传 sources = 全部（老调用方行为一个字不变）；传了只回那几层；空数组一条都不回', () => {
    const input = {
      todos: [todo({ id: 'td_s', scheduled: { start: T0, end: plusMs(T0, 3_600_000) } })],
      social_posts: [
        {
          id: 'p1',
          account_id: 'a1',
          channel: 'meta' as const,
          status: 'scheduled' as const,
          scheduled_at: '2026-09-09T02:00:00.000Z',
          body: '新品',
        },
      ],
      deliverables: [
        {
          id: 'dl_1',
          collaboration_id: 'c1',
          kind: 'video' as const,
          due_at: '2026-09-09T03:00:00.000Z',
        },
      ],
      standby: [
        {
          workspace_id: 'ws_a',
          status: 'running' as const,
          period_end: '2026-09-09T04:00:00.000Z',
        },
      ],
      cards: [approval({ id: 'apr_due', expires_at: '2026-09-09T06:00:00.000Z' })],
    }
    expect(buildCalendar({ range, ...input }).map((i) => i.source)).toEqual([
      'todo',
      'social_post',
      'kol_deliverable',
      'standby',
      'card_due',
    ])
    expect(
      buildCalendar({ range: { ...range, sources: ['social_post'] }, ...input }).map((i) => i.id),
    ).toEqual(['cal_social_p1'])
    expect(buildCalendar({ range: { ...range, sources: [] }, ...input })).toEqual([])
  })

  it('会议拖了不直接改：没给 drag 的会议默认按「提改时间」读', () => {
    const items = buildCalendar({
      range,
      todos: [],
      meetings: [
        {
          id: 'cal_meet_1',
          source: 'meeting',
          title: '周会',
          start: '2026-09-09T02:00:00.000Z',
          end: '2026-09-09T03:00:00.000Z',
          all_day: false,
          ref: { type: 'meeting', id: 'mtg_1' },
        },
      ],
    })
    expect(items[0]?.drag).toBe('propose')
  })

  it('排序：同一时刻先占时段的，再全天的，再按 id', () => {
    const sorted = sortCalendar([
      {
        id: 'b',
        source: 'todo',
        title: 'b',
        start: T0,
        all_day: true,
        ref: { type: 'todo', id: 'b' },
      },
      {
        id: 'a',
        source: 'todo',
        title: 'a',
        start: T0,
        all_day: true,
        ref: { type: 'todo', id: 'a' },
      },
      {
        id: 'c',
        source: 'meeting',
        title: 'c',
        start: T0,
        end: plusMs(T0, 1000),
        all_day: false,
        ref: { type: 'meeting', id: 'c' },
      },
    ])
    expect(sorted.map((i) => i.id)).toEqual(['c', 'a', 'b'])
  })
})
