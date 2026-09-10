/**
 * 37 工作模型路由的一致性用例。
 *
 * 与其他端口一样，这里用一个内存替身实现 `WorkPort`——测的是**网关本身**：
 * 路径、信封、鉴权、参数校验、没装配时的 `not_implemented`，以及首页第三稿只加字段不改字段。
 */
import type {
  CalendarItem,
  DailyPlan,
  Goal,
  GoalProgress,
  Matter,
  MatterEvent,
  Review,
  Todo,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { GatewayDeps, WorkActor, WorkHome, WorkMatterView, WorkPort } from '../src/index.js'
import { createGateway } from '../src/index.js'
import { harness, T0 } from './helpers.js'

type Call = { method: string; args: unknown[] }

const matter = (over: Partial<Matter> = {}): Matter => ({
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  kind: 'conversation',
  title: 'Anna 的退货请求',
  status: 'open',
  context: { summary: '还在窗口内', pinned: [], participants: [], last_activity: T0 },
  created_at: T0,
  updated_at: T0,
  ...over,
})

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  title: '把新品页上线',
  owner: 'per_me',
  horizon: 'backlog',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: T0,
  updated_at: T0,
  ...over,
})

const goal: Goal = {
  id: 'goal_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  level: 'company',
  owner: 'per_me',
  title: '本月销售额 10 万',
  metric: { query: 'sales.total', format: 'money' },
  target: 100000,
  period: { kind: 'month', start: T0, end: '2026-10-01T00:00:00.000Z' },
  status: 'active',
  created_at: T0,
  updated_at: T0,
}

const progress: GoalProgress = {
  goal_id: 'goal_1',
  title: '本月销售额 10 万',
  level: 'company',
  format: 'money',
  target: 100000,
  value: 20000,
  progress_pct: 20,
  days_left: 21,
  elapsed_pct: 23,
  status: 'ok',
}

const event: MatterEvent = {
  id: 'mev_1',
  matter_id: 'mat_1',
  at: T0,
  kind: 'human_message',
  text: '先看一下这单',
  actor: { kind: 'person', id: 'per_me' },
}

const view: WorkMatterView = {
  matter: matter(),
  timeline: [event],
  has_more: false,
  todos: [todo()],
  open_card_ids: ['ap_1'],
  pinned_labels: [],
  // WP38：参与者展示名由服务端补（40 §3.3）
  participant_labels: [{ person_id: 'per_me', label: '我' }],
}

const plan: DailyPlan = {
  id: 'plan_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  person_id: 'per_me',
  date: '2026-09-07',
  basis: { goals: [progress], meetings: 0, due_todos: 1, cards_waiting: 2 },
  suggestions: [
    {
      id: 's1',
      kind: 'promote',
      title: '把新品页上线',
      reason: 'r',
      todo_id: 'td_1',
      selected: true,
    },
  ],
  options: [
    { id: 'adopt', label: '就按这个来' },
    { id: 'adjust', label: '我改几条' },
    { id: 'later', label: '稍后再说' },
  ],
  state: 'drafted',
  created_todo_ids: [],
  created_at: T0,
  updated_at: T0,
}

const review: Review = {
  id: 'rev_1',
  schema_version: 1,
  workspace_id: 'ws_test',
  person_id: 'per_me',
  period: { kind: 'day', start: T0, end: T0 },
  goals: [progress],
  cards: { ai_handled: 2, you_handled: 1, auto_sent: 1, blocked: 0 },
  todos: { done: 1, total: 2, completion_pct: 50 },
  meetings: { count: 0, outputs: 0 },
  lessons: [],
  highlights: [],
  next_plan_draft: {
    date: '2026-09-08',
    person_id: 'per_me',
    basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
    suggestions: [],
    options: [],
  },
  created_at: T0,
}

const calendarItem: CalendarItem = {
  id: 'cal_todo_td_1',
  source: 'todo',
  title: '把新品页上线',
  start: T0,
  end: '2026-09-07T10:00:00.000Z',
  all_day: false,
  ref: { type: 'todo', id: 'td_1' },
}

/** 内存替身：只记下被调了什么，返回固定形状。 */
class FakeWork implements WorkPort {
  readonly calls: Call[] = []
  actors: WorkActor[] = []

  private record(method: string, actor: WorkActor, ...args: unknown[]): void {
    this.calls.push({ method, args })
    this.actors.push(actor)
  }
  last(method: string): unknown[] | undefined {
    return [...this.calls].reverse().find((c) => c.method === method)?.args
  }

  home(actor: WorkActor): WorkHome {
    this.record('home', actor)
    return {
      goals: [progress],
      today: { timeline: [calendarItem], due: { todos: [todo()], cards_waiting: 2 } },
      review,
      plan,
    }
  }
  matters(actor: WorkActor, filter: unknown): Matter[] {
    this.record('matters', actor, filter)
    return [matter()]
  }
  matter(actor: WorkActor, id: string): WorkMatterView {
    this.record('matter', actor, id)
    return view
  }
  createMatter(actor: WorkActor, input: unknown): Matter {
    this.record('createMatter', actor, input)
    return matter({ id: 'mat_new' })
  }
  closeMatter(
    actor: WorkActor,
    id: string,
    unfinished: 'close_all' | 'keep',
  ): { matter: Matter; closed_todo_ids: string[]; kept_todo_ids: string[] } {
    this.record('closeMatter', actor, id, unfinished)
    return {
      matter: matter({ status: 'closed' }),
      closed_todo_ids: unfinished === 'close_all' ? ['td_1'] : [],
      kept_todo_ids: unfinished === 'keep' ? ['td_1'] : [],
    }
  }
  timeline(
    actor: WorkActor,
    id: string,
    options: unknown,
  ): { events: MatterEvent[]; has_more: boolean } {
    this.record('timeline', actor, id, options)
    return { events: [event], has_more: false }
  }
  async say(
    actor: WorkActor,
    id: string,
    text: string,
  ): Promise<{ event: MatterEvent; run_id?: string }> {
    this.record('say', actor, id, text)
    return { event, run_id: 'run_1' }
  }
  goals(actor: WorkActor, filter: unknown): { goals: Goal[]; progress: GoalProgress[] } {
    this.record('goals', actor, filter)
    return { goals: [goal], progress: [progress] }
  }
  createGoal(actor: WorkActor, input: unknown): Goal {
    this.record('createGoal', actor, input)
    return goal
  }
  todos(actor: WorkActor, filter: unknown): Todo[] {
    this.record('todos', actor, filter)
    return [todo()]
  }
  createTodo(actor: WorkActor, input: unknown): Todo {
    this.record('createTodo', actor, input)
    return todo({ id: 'td_new' })
  }
  updateTodo(actor: WorkActor, id: string, patch: unknown): Todo {
    this.record('updateTodo', actor, id, patch)
    return todo({ id })
  }
  scheduleTodo(actor: WorkActor, id: string, slot: unknown): Todo {
    this.record('scheduleTodo', actor, id, slot)
    return todo({ id })
  }
  async delegateTodo(actor: WorkActor, id: string, input: unknown): Promise<Todo> {
    this.record('delegateTodo', actor, id, input)
    return todo({ id, status: 'doing' })
  }
  splitTodo(actor: WorkActor, id: string, children: unknown): { parent: Todo; children: Todo[] } {
    this.record('splitTodo', actor, id, children)
    return { parent: todo({ id }), children: [todo({ id: 'td_c1' })] }
  }
  calendar(actor: WorkActor, range: unknown): CalendarItem[] {
    this.record('calendar', actor, range)
    return [calendarItem]
  }
  todayPlan(actor: WorkActor, refresh: boolean): DailyPlan {
    this.record('todayPlan', actor, refresh)
    return plan
  }
  async decidePlan(
    actor: WorkActor,
    id: string,
    input: unknown,
  ): Promise<{ plan: DailyPlan; todos: Todo[] }> {
    this.record('decidePlan', actor, id, input)
    return { plan: { ...plan, state: 'adopted' }, todos: [todo()] }
  }
  reviews(actor: WorkActor, filter: unknown): Review[] {
    this.record('reviews', actor, filter)
    return [review]
  }
  createReview(actor: WorkActor, kind: unknown): Review {
    this.record('createReview', actor, kind)
    return review
  }
}

async function workHarness(): Promise<{
  h: Awaited<ReturnType<typeof harness>>
  work: FakeWork
  get(path: string): Promise<Response>
  post(path: string, body?: unknown): Promise<Response>
  put(path: string, body?: unknown): Promise<Response>
}> {
  const h = await harness()
  const work = new FakeWork()
  const deps: GatewayDeps = { ...h.deps, work }
  const gateway = createGateway(deps)
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${h.token}`,
      'X-Assignment': h.assignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  return {
    h,
    work,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
  }
}

const data = async (res: Response): Promise<Record<string, unknown>> =>
  ((await res.json()) as { data: Record<string, unknown> }).data

describe('37 工作模型路由', () => {
  it('全部在 /v1 之下，都要 Assignment', async () => {
    const { h } = await workHarness()
    const work = h.gateway.specs.filter((s) => s.tag === 'work')
    expect(work.length).toBeGreaterThanOrEqual(18)
    expect(work.every((s) => s.path.startsWith('/v1/'))).toBe(true)
    expect(work.every((s) => s.auth === 'bearer' && s.assignment === true)).toBe(true)
    // operationId 不重名（OpenAPI 要求）
    const ids = h.gateway.specs.map((s) => s.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('没装配工作模型时这些路由回 not_implemented（501）', async () => {
    const h = await harness()
    const res = await h.get('/v1/todos')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { code: string }).code).toBe('not_implemented')
  })

  it('事项：列、开、进入、时间线、说话、关闭', async () => {
    const t = await workHarness()

    const list = await t.get('/v1/matters?kind=conversation&status=open,waiting&limit=5')
    expect(list.status).toBe(200)
    expect((await data(list)).matters).toHaveLength(1)
    expect(t.work.last('matters')?.[0]).toEqual({
      kind: 'conversation',
      status: ['open', 'waiting'],
      limit: 5,
    })

    const created = await t.post('/v1/matters', { kind: 'project', title: '新品页' })
    expect(created.status).toBe(201)
    expect((await data(created)).matter).toMatchObject({ id: 'mat_new' })

    const got = await t.get('/v1/matters/mat_1')
    expect((await data(got)).open_card_ids).toEqual(['ap_1'])

    const tl = await t.get('/v1/matters/mat_1/timeline?limit=2&before=2026-09-07T00:00:00.000Z')
    expect(tl.status).toBe(200)
    expect(t.work.last('timeline')?.[1]).toEqual({
      limit: 2,
      before: '2026-09-07T00:00:00.000Z',
    })

    const said = await t.post('/v1/matters/mat_1/messages', { text: '帮我查一下' })
    expect(said.status).toBe(201)
    expect((await data(said)).run_id).toBe('run_1')

    const closed = await t.post('/v1/matters/mat_1/close', { unfinished: 'keep' })
    expect((await data(closed)).kept_todo_ids).toEqual(['td_1'])
  })

  it('事项：非法枚举与空体被拒（400）', async () => {
    const t = await workHarness()
    expect((await t.get('/v1/matters?status=gone')).status).toBe(400)
    expect((await t.get('/v1/matters?limit=0')).status).toBe(400)
    expect((await t.get('/v1/matters?limit=abc')).status).toBe(400)
    expect((await t.post('/v1/matters', { kind: 'nope', title: 'x' })).status).toBe(400)
    expect((await t.post('/v1/matters/mat_1/messages', { text: '' })).status).toBe(400)
    expect((await t.post('/v1/matters/mat_1/close', { unfinished: 'maybe' })).status).toBe(400)
  })

  it('目标：列表带进度，创建走 201', async () => {
    const t = await workHarness()
    const list = await t.get('/v1/goals?level=company')
    const body = await data(list)
    expect(body.goals).toHaveLength(1)
    expect((body.progress as GoalProgress[])[0]?.progress_pct).toBe(20)
    expect(t.work.last('goals')?.[0]).toEqual({ level: 'company' })

    const created = await t.post('/v1/goals', {
      level: 'position',
      title: '本月订单 500 单',
      target: 500,
      metric: { query: 'orders.count', format: 'count' },
      period: { kind: 'month', start: T0, end: '2026-10-01T00:00:00.000Z' },
      position_id: 'asg_ok',
    })
    expect(created.status).toBe(201)
    expect((await t.get('/v1/goals?level=nope')).status).toBe(400)
    expect((await t.post('/v1/goals', { level: 'company' })).status).toBe(400)
  })

  it('待办：CRUD + done / drop / 排期 / 委托 / 拆分', async () => {
    const t = await workHarness()

    const list = await t.get('/v1/todos?horizon=today,week&status=open&matter_id=mat_1')
    expect((await data(list)).todos).toHaveLength(1)
    expect(t.work.last('todos')?.[0]).toEqual({
      horizon: ['today', 'week'],
      status: ['open'],
      matter_id: 'mat_1',
      mine: true,
    })
    await t.get('/v1/todos?mine=false&goal_id=goal_1')
    expect(t.work.last('todos')?.[0]).toMatchObject({ mine: false, goal_id: 'goal_1' })

    expect((await t.post('/v1/todos', { title: '写文案' })).status).toBe(201)

    const updated = await t.put('/v1/todos/td_1', { title: '改名', due: null })
    expect(updated.status).toBe(200)
    expect(t.work.last('updateTodo')?.[1]).toEqual({ title: '改名', due: null })

    await t.post('/v1/todos/td_1/done')
    expect(t.work.last('updateTodo')?.[1]).toEqual({ status: 'done' })
    await t.post('/v1/todos/td_1/drop')
    expect(t.work.last('updateTodo')?.[1]).toEqual({ status: 'dropped' })

    const sched = await t.post('/v1/todos/td_1/schedule', {
      scheduled: { start: T0, end: '2026-09-07T10:00:00.000Z' },
    })
    expect(sched.status).toBe(200)
    await t.post('/v1/todos/td_1/schedule', { scheduled: null })
    expect(t.work.last('scheduleTodo')?.[1]).toBeNull()

    const delegated = await t.post('/v1/todos/td_1/delegate', { brief: '照旧' })
    expect((await data(delegated)).todo).toMatchObject({ status: 'doing' })

    const split = await t.post('/v1/todos/td_1/split', { children: [{ title: '写文案' }] })
    expect(split.status).toBe(201)
    expect((await data(split)).children).toHaveLength(1)

    expect((await t.post('/v1/todos/td_1/split', { children: [] })).status).toBe(400)
    expect((await t.get('/v1/todos?horizon=someday')).status).toBe(400)
    expect((await t.put('/v1/todos/td_1', { status: 'nope' })).status).toBe(400)
  })

  it('日历：from / to 必填且要合法', async () => {
    const t = await workHarness()
    const res = await t.get(
      '/v1/calendar?from=2026-09-07T00:00:00.000Z&to=2026-09-08T00:00:00.000Z',
    )
    expect(res.status).toBe(200)
    expect((await data(res)).items).toHaveLength(1)
    expect((await t.get('/v1/calendar')).status).toBe(400)
    expect((await t.get('/v1/calendar?from=2026-09-07T00:00:00.000Z')).status).toBe(400)
    expect((await t.get('/v1/calendar?from=x&to=y')).status).toBe(400)
    expect(
      (await t.get('/v1/calendar?from=2026-09-08T00:00:00.000Z&to=2026-09-07T00:00:00.000Z'))
        .status,
    ).toBe(400)
  })

  it('每日计划：拿今天的、采纳 / 调整 / 稍后；调整必须带勾选清单', async () => {
    const t = await workHarness()
    expect((await data(await t.get('/v1/plans/today'))).plan).toMatchObject({ state: 'drafted' })
    expect(t.work.last('todayPlan')?.[0]).toBe(false)
    await t.get('/v1/plans/today?refresh=true')
    expect(t.work.last('todayPlan')?.[0]).toBe(true)

    const adopted = await t.post('/v1/plans/plan_1/decide', { option: 'adopt' })
    expect((await data(adopted)).plan).toMatchObject({ state: 'adopted' })

    const bad = await t.post('/v1/plans/plan_1/decide', { option: 'adjust' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { details: { reason: string } }).details.reason).toBe(
      'SELECTION_REQUIRED',
    )
    expect(
      (await t.post('/v1/plans/plan_1/decide', { option: 'adjust', selected_ids: ['s1'] })).status,
    ).toBe(200)
    expect((await t.post('/v1/plans/plan_1/decide', { option: 'nope' })).status).toBe(400)
  })

  it('复盘：列表与新建', async () => {
    const t = await workHarness()
    const list = await t.get('/v1/reviews?kind=day&limit=3')
    expect((await data(list)).reviews).toHaveLength(1)
    expect(t.work.last('reviews')?.[0]).toEqual({ kind: 'day', limit: 3 })
    const created = await t.post('/v1/reviews', {})
    expect(created.status).toBe(201)
    expect(t.work.last('createReview')?.[0]).toBe('day')
    await t.post('/v1/reviews', { kind: 'week' })
    expect(t.work.last('createReview')?.[0]).toBe('week')
    expect((await t.get('/v1/reviews?kind=year')).status).toBe(400)
  })

  it('每条请求都带上本次绑定的岗位（31 §3.1）', async () => {
    const t = await workHarness()
    await t.get('/v1/todos')
    expect(t.work.actors[0]).toEqual({
      workspace_id: t.h.workspace_id,
      person_id: t.h.person_id,
      assignment_id: t.h.assignment.id,
    })
  })

  it('首页第三稿：只加字段，原有四区一个不少（36 §3 → 37 §3）', async () => {
    const t = await workHarness()
    const home = await data(await t.get('/v1/home'))
    // 老字段
    for (const key of ['queue', 'alerts', 'tiles', 'estimated_minutes', 'range'])
      expect(home[key], key).toBeDefined()
    // 新字段
    expect(home.goals).toHaveLength(1)
    expect(home.today).toMatchObject({ due: { cards_waiting: 2 } })
    expect(home.review).toMatchObject({ id: 'rev_1' })
    expect(home.plan).toMatchObject({ id: 'plan_1' })

    // 没装工作模型时首页照旧，只是不出这几个键
    const plain = await harness()
    const bare = await plain.get('/v1/home')
    const body = (await bare.json()) as { data: Record<string, unknown> }
    expect(body.data.queue).toBeDefined()
    expect(body.data.goals).toBeUndefined()
    expect(body.data.today).toBeUndefined()
  })
})
