/**
 * 37 工作模型的端到端用例（demo 世界当后端，全程走真的 `/v1`）：
 *
 * 首页第三稿多出来的三段有真数据；事项就是那封 Anna 的信、卡片挂在它上面；
 * 待办箱三段；日历合并四类来源；每日计划**采纳才写待办**。
 */
import { resolve } from 'node:path'
import type {
  CalendarItem,
  DailyPlan,
  Goal,
  GoalProgress,
  Matter,
  MatterView,
  Meeting,
  MeetingOutputs,
  Review,
  Todo,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDemo, type Demo } from '../src/demo.js'

const ROOT = resolve(import.meta.dirname, '../../..')

let demo: Demo

const call = async (
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${demo.server.bootstrap.internalToken}`,
    'X-Assignment': demo.world.assignment.id,
  })
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return demo.server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )
}

const data = async <T>(res: Response, status = 200): Promise<T> => {
  expect(res.status).toBe(status)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  demo = await createDemo({ root: ROOT, quiet: true })
}, 60_000)

afterAll(async () => {
  await demo.close()
})

describe('demo 的工作模型（37）', () => {
  it('目标：1 个公司目标 + 2 个岗位目标，进度是服务端按期间算出来的', async () => {
    const out = await data<{ goals: Goal[]; progress: GoalProgress[] }>(await call('/v1/goals'))
    expect(out.goals).toHaveLength(3)
    expect(out.goals.filter((g) => g.level === 'company')).toHaveLength(1)
    expect(out.goals.filter((g) => g.level === 'position')).toHaveLength(2)
    // 指标名就是 29 的命名查询名
    expect(out.goals.map((g) => g.metric.query).sort()).toEqual([
      'orders.count',
      'refunds.total',
      'sales.total',
    ])
    const company = out.progress.find((p) => p.level === 'company')
    expect(company?.value).toBeGreaterThanOrEqual(0)
    expect(company?.target).toBe(120000)
    expect(company?.elapsed_pct).toBeGreaterThanOrEqual(0)
  })

  it('待办：3 条长期待办，一条已拆两条短期，一条排期到今天', async () => {
    const { todos } = await data<{ todos: Todo[] }>(await call('/v1/todos'))
    const titles = todos.map((t) => t.title)
    expect(titles).toContain('Q4 前上线新品页')
    expect(titles).toContain('把退货政策页重写一遍')
    expect(titles).toContain('核对昨天的退款单')

    const parent = todos.find((t) => t.title === 'Q4 前上线新品页')
    const children = todos.filter((t) => t.parent_id === parent?.id)
    expect(children.map((c) => c.title).sort()).toEqual(['做新品页主图', '写新品页文案'])

    const scheduled = todos.find((t) => t.title === '核对昨天的退款单')
    expect(scheduled?.scheduled).toBeDefined()
    expect(scheduled?.horizon).toBe('today')
  })

  it('事项：Anna 那封信就是一个 conversation 事项，场景真跑出来的卡挂在它上面', async () => {
    const { matters } = await data<{ matters: Matter[] }>(await call('/v1/matters'))
    const matter = matters.find((m) => m.kind === 'conversation')
    expect(matter?.title).toBe('Anna 要退 #1001')
    expect(matter?.context.summary).toContain('退货')
    if (matter === undefined) throw new Error('demo 没种出 conversation 事项')

    const view = await data<MatterView>(await call(`/v1/matters/${matter.id}`))
    // 固定记录的展示名是服务端补的（不露裸 id）
    expect(view.pinned_labels.map((p) => p.label)).toContain('#1001')
    expect(view.pinned_labels.some((p) => p.label === 'Anna Meyer')).toBe(true)
    // 时间线：人的话 + Agent 的运行 + 回填的卡
    expect(view.timeline.map((e) => e.kind)).toContain('human_message')
    expect(view.timeline.map((e) => e.kind)).toContain('card')
    // 卡片回填到了待办上
    expect(view.open_card_ids.length).toBeGreaterThan(0)
    const followUp = view.todos.find((t) => t.title.startsWith('等 Anna'))
    expect(followUp?.cards.length).toBeGreaterThan(0)
  })

  it('日历：今天这一段里有排期的待办；范围参数必填', async () => {
    const now = Date.parse(demo.world.clock.now())
    const from = new Date(now - 86_400_000).toISOString()
    const to = new Date(now + 2 * 86_400_000).toISOString()
    const out = await data<{ items: CalendarItem[] }>(
      await call(`/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    )
    expect(out.items.some((i) => i.source === 'todo' && !i.all_day)).toBe(true)
    expect((await call('/v1/calendar')).status).toBe(400)
  })

  it('每日计划：首页给的就是那张卡，采纳之前一条待办都不写', async () => {
    const home = await data<{
      queue: DeckCard[]
      goals?: GoalProgress[]
      today?: { timeline: CalendarItem[]; due: { todos: Todo[]; cards_waiting: number } }
      plan?: DailyPlan
      review?: Review
    }>(await call('/v1/home'))
    // 首页第三稿的新字段
    expect(home.goals?.length).toBe(3)
    expect(home.today).toBeDefined()
    expect(home.today?.due.cards_waiting).toBeGreaterThan(0)
    expect(home.plan?.state).toBe('drafted')
    // 队列里有那张 daily_plan 卡，而且是选择题
    const planCard = home.queue.find((c) => c.kind === 'daily_plan')
    expect(planCard?.options?.map((o) => o.id)).toEqual(['adopt', 'adjust', 'later'])

    const plan = home.plan
    if (plan === undefined) throw new Error('首页没有今天的计划')
    const before = (await data<{ todos: Todo[] }>(await call('/v1/todos'))).todos.length

    // 稍后：什么都不写
    const later = await data<{ plan: DailyPlan; todos: Todo[] }>(
      await call(`/v1/plans/${plan.id}/decide`, { method: 'POST', body: { option: 'later' } }),
    )
    expect(later.plan.state).toBe('later')
    expect(later.todos).toEqual([])
    expect((await data<{ todos: Todo[] }>(await call('/v1/todos'))).todos).toHaveLength(before)

    // 采纳：这一步才动待办（建议都是 promote / schedule，所以条数不变但 horizon 变了）
    const adopted = await data<{ plan: DailyPlan; todos: Todo[] }>(
      await call(`/v1/plans/${plan.id}/decide`, { method: 'POST', body: { option: 'adopt' } }),
    )
    expect(adopted.plan.state).toBe('adopted')
    expect(adopted.todos.length).toBe(plan.suggestions.filter((s) => s.selected).length)
  })

  it('打勾 / 关闭走 /v1，改的是真的待办', async () => {
    const { todos } = await data<{ todos: Todo[] }>(await call('/v1/todos?horizon=backlog'))
    const target = todos[0]
    if (target === undefined) throw new Error('待办箱是空的')
    const done = await data<{ todo: Todo }>(
      await call(`/v1/todos/${target.id}/done`, { method: 'POST' }),
    )
    expect(done.todo.status).toBe('done')
    const left = await data<{ todos: Todo[] }>(await call('/v1/todos?status=open'))
    expect(left.todos.some((t) => t.id === target.id)).toBe(false)
  })

  it('复盘：现做一次，战报四格与明天的计划草案都在', async () => {
    const { review } = await data<{ review: Review }>(
      await call('/v1/reviews', { method: 'POST', body: { kind: 'day' } }),
      201,
    )
    expect(review.cards).toHaveProperty('ai_handled')
    expect(review.cards).toHaveProperty('blocked')
    expect(review.next_plan_draft.options.map((o) => o.id)).toEqual(['adopt', 'adjust', 'later'])
    const list = await data<{ reviews: Review[] }>(await call('/v1/reviews'))
    expect(list.reviews[0]?.id).toBe(review.id)
  })

  it('委托：起真 Run → 卡出现在待办上 → 事项时间线有 run 事件（37 §2.1 交点一）', async () => {
    const { matters } = await data<{ matters: Matter[] }>(await call('/v1/matters'))
    const matter = matters.find((m) => m.kind === 'conversation')
    if (matter === undefined) throw new Error('demo 没种出 conversation 事项')
    const todo = await data<{ todo: Todo }>(
      await call('/v1/todos', {
        method: 'POST',
        body: { title: '替我回一下 Anna 这封信', matter_id: matter.id },
      }),
      201,
    )
    const before = (await data<MatterView>(await call(`/v1/matters/${matter.id}`))).timeline.length

    const out = await data<{ todo: Todo }>(
      await call(`/v1/todos/${todo.todo.id}/delegate`, {
        method: 'POST',
        body: { brief: 'Anna 想退 #1001，帮我按政策回一封' },
      }),
    )
    // 委托状态与 run 都回填到了待办上
    expect(out.todo.delegate?.state).toBeDefined()
    expect(out.todo.runs).toHaveLength(1)
    expect(out.todo.matter_id).toBe(matter.id)
    // Run 里产生的卡挂回这条待办（subject.todo_id）
    expect(out.todo.cards.length).toBeGreaterThan(0)
    const card = await data<{ id: string; kind: string; subject: { todo_id?: string } }>(
      await call(`/v1/approvals/${out.todo.cards[0]}`),
    )
    expect(card.subject.todo_id).toBe(todo.todo.id)

    // 事项时间线上有这次运行，摘要被 onRunCompleted 更新过
    const view = await data<MatterView>(await call(`/v1/matters/${matter.id}`))
    expect(view.timeline.length).toBeGreaterThan(before)
    const runs = view.timeline.filter((e) => e.kind === 'run')
    expect(runs.some((e) => e.run_id === out.todo.runs[0])).toBe(true)
    expect(view.matter.context.summary).not.toBe('')
  })

  it('事项发言：说一句 → 起 Run → 时间线上人话与 Agent 的运行都在（对话入口第四处）', async () => {
    const { matters } = await data<{ matters: Matter[] }>(await call('/v1/matters'))
    const matter = matters.find((m) => m.kind === 'conversation')
    if (matter === undefined) throw new Error('demo 没种出 conversation 事项')
    const out = await data<{ event: { kind: string; text: string }; run_id?: string }>(
      await call(`/v1/matters/${matter.id}/messages`, {
        method: 'POST',
        body: { text: '这封信按 14 天窗口回，别自己拍板退款' },
      }),
      201,
    )
    expect(out.event.kind).toBe('human_message')
    expect(out.run_id).toBeDefined()
    const view = await data<MatterView>(await call(`/v1/matters/${matter.id}`))
    expect(view.timeline.some((e) => e.run_id === out.run_id)).toBe(true)
  })

  it('会议 → 事项：处理完开一个 meeting 事项，Meeting.matter_id 回填，产出挂时间线', async () => {
    const meetings = await data<Meeting[]>(await call('/v1/meetings'))
    expect(meetings.length).toBeGreaterThan(0)
    const meeting = meetings.find((m) => m.matter_id !== undefined)
    if (meeting?.matter_id === undefined) throw new Error('会议没有回填 matter_id')

    const view = await data<MatterView>(await call(`/v1/matters/${meeting.matter_id}`))
    expect(view.matter.kind).toBe('meeting')
    expect(view.matter.title).toBe(meeting.title)
    // 会议本身固定在现场里
    expect(view.matter.context.pinned.some((r) => r.id === meeting.id)).toBe(true)
    // 产出挂在这条事项的时间线上
    expect(view.timeline.filter((e) => e.kind === 'meeting').length).toBeGreaterThan(0)
  })

  it('会议上日历：会议那天的日历里有它（37 §2 表第三行）', async () => {
    const meetings = await data<Meeting[]>(await call('/v1/meetings'))
    const meeting = meetings[0]
    if (meeting === undefined) throw new Error('demo 没种出会议')
    const from = new Date(Date.parse(meeting.start) - 3_600_000).toISOString()
    const to = new Date(Date.parse(meeting.end) + 3_600_000).toISOString()
    const out = await data<{ items: CalendarItem[] }>(
      await call(`/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    )
    const item = out.items.find((i) => i.source === 'meeting' && i.ref?.id === meeting.id)
    expect(item).toBeDefined()
    expect(item?.matter_id).toBe(meeting.matter_id)
  })

  it('认领卡接下来 → 建待办（source=meeting、matter_id 指向会议事项、anchor 指向那条产出）', async () => {
    const meetings = await data<Meeting[]>(await call('/v1/meetings'))
    let sent: { approval_id: string } | undefined
    let target: Meeting | undefined
    for (const meeting of meetings) {
      const outs = await data<MeetingOutputs[]>(await call(`/v1/meetings/${meeting.id}/outputs`))
      // 没被明确指派给别人的那条：认领卡才会发到本人手上（31 I13 本人确认才形成责任）
      const outputs = outs.find((o) => o.todos.some((t) => t.assignee_person_id === undefined))
      const proposal = outputs?.todos.find((t) => t.assignee_person_id === undefined)
      if (outputs === undefined || proposal === undefined) continue
      sent = await data<{ approval_id: string }>(
        await call(`/v1/meetings/${meeting.id}/outputs/send`, {
          method: 'POST',
          body: { record_id: outputs.record_id, kind: 'claim', item_id: proposal.id },
        }),
      )
      target = meeting
      break
    }
    if (sent === undefined || target?.matter_id === undefined) throw new Error('没有可发的认领卡')

    const decided = await data<{ todo?: Todo }>(
      await call(`/v1/approvals/${sent.approval_id}/decide`, {
        method: 'POST',
        body: { action: 'approve' },
      }),
    )
    expect(decided.todo).toBeDefined()
    expect(decided.todo?.source).toBe('meeting')
    expect(decided.todo?.matter_id).toBe(target.matter_id)
    expect(decided.todo?.anchor?.matter_event_id).toBeDefined()
    expect(decided.todo?.origin?.card_id).toBe(sent.approval_id)
  })

  it('战报四格：读的是合一后的事件日志，demo 里不是四个零（21 §1）', async () => {
    const home = await data<{
      battle_report: { ai_handled: number; handled: number; auto_sent: number; intercepted: number }
    }>(await call('/v1/home?range=yesterday'))
    const r = home.battle_report
    // 场景真跑出来的卡都算「拦截待确认」；四个数加起来必须大于零，否则就是日志没接上
    expect(r.intercepted).toBeGreaterThan(0)
    expect(r.ai_handled + r.handled + r.auto_sent + r.intercepted).toBeGreaterThan(0)
  })

  it('全程没有任何 model.* 事件（stub 运行时根本不叫模型）', () => {
    expect(demo.world.events.filter((e) => e.type.startsWith('model.'))).toHaveLength(0)
  })
})
