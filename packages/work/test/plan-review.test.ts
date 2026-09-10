/**
 * 每日计划与复盘（37 §2.4）。两个都是纯函数：
 * - 计划**只给建议**，一条待办都不写（37 C6）
 * - 复盘的产物是明天计划的草案
 */
import type { CalendarItem, GoalProgress } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUSY_MAX_SUGGESTIONS,
  DEFAULT_SELECTED,
  draftDailyPlan,
  freeSlots,
  MAX_SUGGESTIONS,
  planSummary,
  planTitle,
} from '../src/plan.js'
import {
  battleReport,
  buildReview,
  type CardOutcome,
  reviewSummary,
  reviewTitle,
} from '../src/review.js'
import { plusMs } from '../src/util.js'
import { review, T0, todo } from './helpers.js'

const TZ = 480
const HOUR = 3_600_000

const progress = (over: Partial<GoalProgress> = {}): GoalProgress => ({
  goal_id: 'goal_1',
  title: '本月销售额 10 万',
  level: 'company',
  format: 'money',
  target: 100000,
  value: 20000,
  progress_pct: 20,
  days_left: 15,
  elapsed_pct: 50,
  status: 'behind',
  ...over,
})

const meeting = (startHourUtc: number, hours = 1): CalendarItem => ({
  id: `cal_meet_${startHourUtc}`,
  source: 'meeting',
  title: '会',
  start: `2026-09-09T0${startHourUtc}:00:00.000Z`,
  end: `2026-09-09T0${startHourUtc + hours}:00:00.000Z`,
  all_day: false,
  ref: { type: 'meeting', id: `mtg_${startHourUtc}` },
})

const emptyInbox = { backlog: [], week: [], today: [] }

describe('freeSlots', () => {
  it('跳过已经过去的时段与被会议占掉的时段', () => {
    // T0 = 北京时间 09:00；工作时段 9–18，09:00 那格整格都还在，所以它是第一个
    const slots = freeSlots(T0, TZ, [meeting(3)], 3) // 会议 = 北京 11:00–12:00
    expect(slots.map((s) => s.start)).toEqual([
      '2026-09-09T01:00:00.000Z', // 09:00
      '2026-09-09T02:00:00.000Z', // 10:00
      '2026-09-09T04:00:00.000Z', // 12:00（11:00 被会占了）
    ])
  })

  it('全天会议不占时段；下班后没有空档', () => {
    const allDay: CalendarItem = {
      id: 'cal_x',
      source: 'meeting',
      title: '全天',
      start: T0,
      all_day: true,
      ref: { type: 'meeting', id: 'm' },
    }
    expect(freeSlots(T0, TZ, [allDay], 1)[0]?.start).toBe('2026-09-09T01:00:00.000Z')
    // 无 end 的会议按 1 小时算 → 09:00 那格被它占掉，第一个空档变成 10:00
    const noEnd: CalendarItem = { ...allDay, all_day: false }
    expect(freeSlots(T0, TZ, [noEnd], 1)[0]?.start).toBe('2026-09-09T02:00:00.000Z')
    expect(freeSlots('2026-09-09T12:00:00.000Z', TZ, [], 3)).toEqual([])
  })
})

describe('draftDailyPlan（只给建议，不写待办）', () => {
  it('目标落后 → 把挂在它下面的本周 / backlog 待办挑到今天，最多两条', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [progress()],
      todos: {
        backlog: [todo({ id: 'td_b', goal_id: 'goal_1', title: 'A' })],
        week: [
          todo({ id: 'td_w1', goal_id: 'goal_1', title: 'B', horizon: 'week' }),
          todo({ id: 'td_w2', goal_id: 'goal_1', title: 'C', horizon: 'week' }),
        ],
        today: [],
      },
      today_meetings: [],
    })
    expect(draft.date).toBe('2026-09-09')
    expect(draft.suggestions.map((s) => s.todo_id)).toEqual(['td_w1', 'td_w2'])
    expect(draft.suggestions[0]?.kind).toBe('promote')
    expect(draft.suggestions[0]?.reason).toContain('落后')
    expect(draft.options.map((o) => o.id)).toEqual(['adopt', 'adjust', 'later'])
    expect(draft.basis.goals).toHaveLength(1)
  })

  it('目标没落后就不因为目标建议；今天到期没排时段的给空档', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [progress({ status: 'ok', progress_pct: 60 })],
      todos: {
        backlog: [],
        week: [],
        today: [
          todo({ id: 'td_t1', horizon: 'today', due: T0 }),
          todo({
            id: 'td_t2',
            horizon: 'today',
            due: T0,
            scheduled: { start: T0, end: plusMs(T0, HOUR) },
          }),
        ],
      },
      today_meetings: [],
      cards_waiting: 3,
    })
    expect(draft.suggestions.map((s) => s.id)).toEqual(['sug_schedule_td_t1'])
    expect(draft.suggestions[0]?.scheduled?.start).toBe('2026-09-09T01:00:00.000Z')
    expect(draft.basis.due_todos).toBe(2)
    expect(draft.basis.cards_waiting).toBe(3)
  })

  it('有事项上下文又没委托的本周待办 → 建议交给 Agent（要有 delegate_to）', () => {
    const base = {
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [],
      todos: {
        backlog: [],
        week: [todo({ id: 'td_m', horizon: 'week', matter_id: 'mat_1' })],
        today: [],
      },
      today_meetings: [],
    } as const
    // 没有 delegate_to 就不给委托建议；backlog 空，兜底那条也不出
    expect(draftDailyPlan(base).suggestions).toEqual([])
    const withDelegate = draftDailyPlan({ ...base, delegate_to: 'asg_1' })
    expect(withDelegate.suggestions[0]).toMatchObject({
      kind: 'delegate',
      assignment_id: 'asg_1',
      matter_id: 'mat_1',
      brief: '把新品页上线',
    })
    // 已经委托过的不再建议
    const delegated = draftDailyPlan({
      ...base,
      delegate_to: 'asg_1',
      todos: {
        backlog: [],
        week: [
          todo({
            id: 'td_m',
            horizon: 'week',
            matter_id: 'mat_1',
            delegate: { assignment_id: 'asg_1', brief: 'x', state: 'running', at: T0 },
          }),
        ],
        today: [],
      },
    })
    expect(delegated.suggestions).toHaveLength(0)
  })

  it('note 优先当 brief', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [],
      todos: {
        backlog: [],
        week: [todo({ id: 'td_m', horizon: 'week', matter_id: 'mat_1', note: '按老规矩来' })],
        today: [],
      },
      today_meetings: [],
      delegate_to: 'asg_1',
    })
    expect(draft.suggestions[0]?.brief).toBe('按老规矩来')
  })

  it('昨天复盘的草案排最前，并标出处；同一条待办不重复建议', () => {
    const yesterday = review({
      next_plan_draft: {
        date: '2026-09-09',
        person_id: 'per_1',
        basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
        suggestions: [
          {
            id: 'sug_promote_td_w1',
            kind: 'promote',
            title: 'B',
            reason: '昨天没做完',
            todo_id: 'td_w1',
            selected: true,
          },
        ],
        options: [],
      },
    })
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [progress()],
      todos: {
        backlog: [],
        week: [todo({ id: 'td_w1', goal_id: 'goal_1', horizon: 'week' })],
        today: [],
      },
      yesterday_review: yesterday,
      today_meetings: [],
    })
    expect(draft.suggestions).toHaveLength(1)
    expect(draft.suggestions[0]?.reason).toBe('昨天复盘：昨天没做完')
    expect(draft.basis.yesterday_review_id).toBe('rev_1')
  })

  it('什么都没有时至少挑 backlog 最老的一条；已完成的待办不算', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [],
      todos: {
        backlog: [todo({ id: 'td_done', status: 'done' }), todo({ id: 'td_old', title: '最老的' })],
        week: [],
        today: [],
      },
      today_meetings: [],
    })
    expect(draft.suggestions.map((s) => s.todo_id)).toEqual(['td_old'])
    expect(draft.suggestions[0]?.reason).toBe('待办箱里最久没动的一条')
  })

  it('全空 → 一条建议都没有', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [],
      todos: emptyInbox,
      today_meetings: [],
    })
    expect(draft.suggestions).toEqual([])
    expect(planTitle(draft)).toBe('今天的安排：0 条建议')
    expect(planSummary(draft)).toContain('0 个会')
  })

  it('会多就少建议；默认勾选前三条；总数封顶', () => {
    // 六个各自落后的目标，各挂一条本周待办 → 六条建议，超过上限
    const goals = Array.from({ length: 6 }, (_, i) => progress({ goal_id: `goal_${i}` }))
    const week = Array.from({ length: 6 }, (_, i) =>
      todo({ id: `td_${i}`, goal_id: `goal_${i}`, horizon: 'week' }),
    )
    const base = {
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals,
      todos: { backlog: [], week, today: [] },
    } as const

    const full = draftDailyPlan({ ...base, today_meetings: [] })
    expect(full.suggestions).toHaveLength(MAX_SUGGESTIONS)
    expect(full.suggestions.filter((s) => s.selected)).toHaveLength(DEFAULT_SELECTED)

    const busy = draftDailyPlan({ ...base, today_meetings: [meeting(6), meeting(7), meeting(8)] })
    expect(busy.suggestions).toHaveLength(BUSY_MAX_SUGGESTIONS)
    expect(busy.basis.meetings).toBe(3)

    // 一个目标最多带两条：九条待办全挂同一个目标时只出两条
    const many = Array.from({ length: 9 }, (_, i) =>
      todo({ id: `m${i}`, goal_id: 'goal_1', horizon: 'week' }),
    )
    const capped = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [progress()],
      todos: { backlog: [], week: many, today: [] },
      today_meetings: [],
    })
    expect(capped.suggestions).toHaveLength(2)
  })

  it('planSummary 提到落后的目标数', () => {
    const draft = draftDailyPlan({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [progress()],
      todos: emptyInbox,
      today_meetings: [],
    })
    expect(planSummary(draft)).toContain('1 个目标落后')
  })
})

describe('战报四格与复盘', () => {
  const outcome = (over: Partial<CardOutcome> = {}): CardOutcome => ({
    id: 'apr_1',
    kind: 'outbound_draft',
    state: 'approved',
    auto_approved: false,
    decided_by_person: false,
    applied: false,
    blocked: false,
    ...over,
  })

  it('四格：AI 自主处理 / 你已处理 / 自动发送 / 拦截', () => {
    expect(
      battleReport([
        outcome({ id: '1', auto_approved: true, applied: true }),
        outcome({ id: '2', auto_approved: true }),
        outcome({ id: '3', decided_by_person: true }),
        outcome({ id: '4', blocked: true, auto_approved: true }),
        outcome({ id: '5' }),
      ]),
    ).toEqual({ ai_handled: 2, you_handled: 1, auto_sent: 1, blocked: 1 })
    expect(battleReport([])).toEqual({
      ai_handled: 0,
      you_handled: 0,
      auto_sent: 0,
      blocked: 0,
    })
  })

  it('复盘：完成率、亮点、明天草案', () => {
    const draft = buildReview({
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      period: { kind: 'day', start: T0, end: plusMs(T0, 3600_000) },
      goals: [progress()],
      cards_events: [
        outcome({ id: '1', auto_approved: true, applied: true }),
        outcome({ id: '2', blocked: true }),
      ],
      todos: [todo({ id: 'a', status: 'done' }), todo({ id: 'b' }), todo({ id: 'c' })],
      meetings: [meeting(3)],
      meeting_outputs: 2,
      lessons: [{ id: 'les_1', text: '这类问题以后直接退' }],
      tomorrow: { now: plusMs(T0, 86_400_000), todos: emptyInbox, today_meetings: [] },
    })
    expect(draft.todos).toEqual({ done: 1, total: 3, completion_pct: 33.33 })
    expect(draft.cards).toEqual({ ai_handled: 1, you_handled: 0, auto_sent: 1, blocked: 1 })
    expect(draft.meetings).toEqual({ count: 1, outputs: 2 })
    expect(draft.highlights).toEqual([
      '目标「本月销售额 10 万」落后：进度 20%，时间已过 50%',
      '待办完成 1/3，不到一半',
      '拦下 1 张没过预检的卡',
      'AI 自主处理 1 张，其中发出去 1 张',
      'Agent 记下 1 条经验，明天会问你要不要采纳',
    ])
    expect(draft.next_plan_draft.date).toBe('2026-09-10')
    // 明天的草案沿用今天的目标（tomorrow.goals 没给）
    expect(draft.next_plan_draft.basis.goals).toHaveLength(1)
    expect(reviewTitle(draft)).toContain('今天的复盘')
    expect(reviewSummary(draft)).toContain('1/3')
  })

  it('待办全清 / 没有待办 / 周与月的标题', () => {
    const base = {
      now: T0,
      person_id: 'per_1',
      tz_offset_minutes: TZ,
      goals: [],
      cards_events: [],
      meetings: [],
      tomorrow: { now: T0, todos: emptyInbox, today_meetings: [], goals: [] },
    }
    const clean = buildReview({
      ...base,
      period: { kind: 'week', start: T0, end: T0 },
      todos: [todo({ status: 'done' })],
    })
    expect(clean.todos.completion_pct).toBe(100)
    expect(clean.highlights).toEqual(['待办全清：1 条'])
    expect(reviewTitle(clean)).toContain('本周')

    const empty = buildReview({ ...base, period: { kind: 'month', start: T0, end: T0 }, todos: [] })
    expect(empty.todos).toEqual({ done: 0, total: 0, completion_pct: 100 })
    expect(empty.highlights).toEqual([])
    expect(empty.lessons).toEqual([])
    expect(reviewTitle(empty)).toContain('本月')
  })
})

describe('40 §2.2 第 4 条：复盘里的"疑似重复"', () => {
  const base = {
    now: T0,
    person_id: 'per_1',
    tz_offset_minutes: TZ,
    period: { kind: 'week' as const, start: T0, end: T0 },
    goals: [],
    cards_events: [],
    todos: [],
    meetings: [],
    tomorrow: { now: T0, todos: emptyInbox, today_meetings: [], goals: [] },
  }
  const pair = {
    a: { id: 'schedule:a', title: '每天早上汇总退款单', owner: 'p_li', kind: 'schedule' },
    b: { id: 'schedule:b', title: '早上汇总退款单', owner: 'p_wang', kind: 'schedule' },
    similarity: 0.83,
    both_in_use: true,
  }

  it('给了就端到复盘上，并在 highlights 里写一句人话', () => {
    const draft = buildReview({ ...base, duplicates: [pair] })
    expect(draft.duplicates).toEqual([pair])
    expect(draft.highlights.join('')).toContain('疑似重复 1 对')
    expect(draft.highlights.join('')).toContain('每天早上汇总退款单')
  })

  it('不给就一个字都不多（日复盘不报重复）', () => {
    expect(buildReview(base).duplicates).toBeUndefined()
  })
})
