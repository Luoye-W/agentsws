/**
 * 37 工作模型的界面用例。钉住的是文档里那几条硬约束：
 * - 首页第三稿四段都在，**且仍然无图表无表格**（36 §5.2）
 * - **点待办标题 = 进入事项并定位到锚点**；**打勾不导航**（37 §2.2b）
 * - 委托之后待办上显示「N 张卡等你定」（37 §2.2 交点一）
 * - **把待办拖到日历某天 = 排期**（写 `scheduled`，37 C3）
 * - 事项页有底部对话输入（第四处入口），且有事项边界
 */
import type {
  CalendarItem,
  DailyPlan,
  Goal,
  GoalProgress,
  MatterView,
  Review,
  Todo,
} from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeData } from '@/lib/api'
import { draftCard, TILE_BAR } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-09T01:00:00.000Z'

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '回 Anna 的退货',
  owner: 'per_1',
  horizon: 'today',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: T0,
  updated_at: T0,
  ...over,
})

const progress = (over: Partial<GoalProgress> = {}): GoalProgress => ({
  goal_id: 'goal_1',
  title: '本月销售额 12 万',
  level: 'company',
  format: 'money',
  target: 120000,
  value: 41000,
  progress_pct: 34.17,
  days_left: 21,
  elapsed_pct: 30,
  status: 'ok',
  ...over,
})

const goal: Goal = {
  id: 'goal_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  level: 'company',
  owner: 'per_1',
  title: '本月销售额 12 万',
  metric: { query: 'sales.total', format: 'money' },
  target: 120000,
  period: { kind: 'month', start: T0, end: '2026-10-01T00:00:00.000Z' },
  status: 'active',
  created_at: T0,
  updated_at: T0,
}

const meeting: CalendarItem = {
  id: 'cal_meet_1',
  source: 'meeting',
  title: '周会',
  start: '2026-09-09T02:00:00.000Z',
  end: '2026-09-09T03:00:00.000Z',
  all_day: false,
  ref: { type: 'meeting', id: 'mtg_1' },
}

const review: Review = {
  id: 'rev_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  person_id: 'per_1',
  period: { kind: 'day', start: T0, end: T0 },
  goals: [progress()],
  cards: { ai_handled: 3, you_handled: 2, auto_sent: 1, blocked: 0 },
  todos: { done: 1, total: 3, completion_pct: 33.33 },
  meetings: { count: 1, outputs: 2 },
  lessons: [],
  highlights: ['待办完成 1/3，不到一半'],
  next_plan_draft: {
    date: '2026-09-10',
    person_id: 'per_1',
    basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
    suggestions: [],
    options: [],
  },
  created_at: T0,
}

const plan: DailyPlan = {
  id: 'plan_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  person_id: 'per_1',
  date: '2026-09-09',
  basis: { goals: [progress()], meetings: 1, due_todos: 2, cards_waiting: 3 },
  suggestions: [],
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

const home: HomeData = {
  queue: [draftCard({ detail: { ...draftCard().detail, payload: { matter_id: 'mat_1' } } })],
  alerts: [],
  tiles: [TILE_BAR],
  estimated_minutes: 6,
  range: 'yesterday',
  goals: [progress(), progress({ goal_id: 'goal_2', title: '本月订单 800 单', status: 'behind' })],
  today: {
    timeline: [meeting],
    due: {
      todos: [todo({ matter_id: 'mat_1', anchor: { matter_event_id: 'mev_9' } })],
      cards_waiting: 3,
    },
  },
  review,
  plan,
}

const matterView: MatterView = {
  matter: {
    id: 'mat_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'conversation',
    title: 'Anna 要退 #1001',
    status: 'open',
    context: {
      summary: '客户 12 天前收货，要求退货退款。窗口内。',
      pinned: [{ type: 'order', id: 'ord_1001' }],
      participants: ['per_1'],
      last_activity: T0,
    },
    created_at: T0,
    updated_at: T0,
  },
  timeline: [
    {
      id: 'mev_9',
      matter_id: 'mat_1',
      at: T0,
      kind: 'human_message',
      text: 'I would like to return it.',
      actor: { kind: 'person', id: 'cus_anna' },
    },
  ],
  has_more: false,
  todos: [todo({ matter_id: 'mat_1', cards: ['ap_1'] })],
  open_card_ids: ['ap_1'],
  pinned_labels: [{ ref: { type: 'order', id: 'ord_1001' }, label: '#1001' }],
}

const getHome = vi.fn(async () => home)
const decide = vi.fn(async () => ({}))
const listTodos = vi.fn(async () => ({ todos: [todo()] }))
const completeTodo = vi.fn(async () => ({ todo: todo({ status: 'done' }) }))
const dropTodo = vi.fn(async () => ({ todo: todo({ status: 'dropped' }) }))
const delegateTodo = vi.fn(async () => ({ todo: todo({ status: 'doing' }) }))
const updateTodo = vi.fn(async () => ({ todo: todo() }))
const scheduleTodo = vi.fn(async () => ({ todo: todo() }))
const createTodo = vi.fn(async () => ({ todo: todo({ id: 'td_new' }) }))
const getCalendar = vi.fn(async () => ({
  items: [meeting],
  from: T0,
  to: '2026-09-16T00:00:00.000Z',
}))
const listGoals = vi.fn(async () => ({
  goals: [goal, { ...goal, id: 'goal_2', level: 'position' as const, parent_id: 'goal_1' }],
  progress: [progress(), progress({ goal_id: 'goal_2', status: 'behind' })],
}))
const getMatter = vi.fn(async () => matterView)
const postMatterMessage = vi.fn(async () => ({ event: matterView.timeline[0], run_id: 'run_1' }))
const closeMatter = vi.fn(async () => ({
  matter: matterView.matter,
  closed_todo_ids: [],
  kept_todo_ids: ['td_1'],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...a: unknown[]) => getHome(...(a as [])),
    decide: (...a: unknown[]) => decide(...(a as [])),
    listTodos: (...a: unknown[]) => listTodos(...(a as [])),
    completeTodo: (...a: unknown[]) => completeTodo(...(a as [])),
    dropTodo: (...a: unknown[]) => dropTodo(...(a as [])),
    delegateTodo: (...a: unknown[]) => delegateTodo(...(a as [])),
    updateTodo: (...a: unknown[]) => updateTodo(...(a as [])),
    scheduleTodo: (...a: unknown[]) => scheduleTodo(...(a as [])),
    createTodo: (...a: unknown[]) => createTodo(...(a as [])),
    getCalendar: (...a: unknown[]) => getCalendar(...(a as [])),
    listGoals: (...a: unknown[]) => listGoals(...(a as [])),
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    postMatterMessage: (...a: unknown[]) => postMatterMessage(...(a as [])),
    closeMatter: (...a: unknown[]) => closeMatter(...(a as [])),
  }
})

const { HomePage } = await import('@/pages/home')
const { TodosPage } = await import('@/pages/todos')
const { CalendarPage } = await import('@/pages/calendar')
const { GoalsPage } = await import('@/pages/goals')
const { MatterPage } = await import('@/pages/matter')

describe('首页第三稿（37 §3）', () => {
  beforeEach(() => {
    getHome.mockClear()
  })

  it('四段都在：目标进度 / 今天（时间轴 + 到期）/ 卡片 / 复盘', async () => {
    renderWithProviders(<HomePage />)
    expect(await screen.findByTestId('goals')).toBeDefined()
    expect(screen.getAllByTestId('goal-row')).toHaveLength(2)
    expect(screen.getByTestId('today-timeline')).toBeDefined()
    expect(screen.getByTestId('today-due')).toBeDefined()
    expect(screen.getByTestId('deck-section')).toBeDefined()
    expect(screen.getByTestId('battle-report')).toBeDefined()
    // 落后的目标有标记
    expect(screen.getByText('落后')).toBeDefined()
    // 到期清单里第二个数字：待我定的卡片数
    expect(screen.getByTestId('cards-waiting').textContent).toContain('3')
  })

  it('首页仍然无图表无表格（36 §5.2）', async () => {
    const { container } = renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    expect(container.querySelectorAll('table')).toHaveLength(0)
    expect(container.querySelectorAll('.recharts-wrapper')).toHaveLength(0)
    expect(container.querySelectorAll('[data-block-component="chart_line"]')).toHaveLength(0)
    // 迷你走势线仍然允许
    expect(container.querySelectorAll('[data-testid="sparkline"]').length).toBeGreaterThan(0)
  })

  it('首页仍然没有全局聊天框（对话只在卡片指导 / 问 AI / ⌘K / 事项页）', async () => {
    const { container } = renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    const inputs = [
      ...container.querySelectorAll('input[type="text"], input:not([type]), textarea'),
    ].filter((el) => !(el as HTMLInputElement).disabled)
    expect(inputs).toHaveLength(0)
  })

  it('今天的到期待办点标题跳事项锚点', async () => {
    renderWithProviders(<HomePage />)
    await screen.findByTestId('today-due')
    const link = within(screen.getByTestId('today-due')).getByRole('link', {
      name: '回 Anna 的退货',
    })
    expect(link.getAttribute('href')).toBe('/matters/mat_1#mev_9')
  })
})

describe('待办箱（37 §2.2b：打勾 / 菜单 / 点标题 / 拖到日历）', () => {
  beforeEach(() => {
    completeTodo.mockClear()
    dropTodo.mockClear()
    delegateTodo.mockClear()
    updateTodo.mockClear()
    listTodos.mockClear()
  })

  it('三段都在；没有事项的待办不给链接，只能打勾', async () => {
    listTodos.mockResolvedValueOnce({ todos: [todo({ horizon: 'backlog' })] })
    renderWithProviders(<TodosPage />)
    await screen.findByTestId('todos')
    expect(screen.getByTestId('horizon-today')).toBeDefined()
    expect(screen.getByTestId('horizon-week')).toBeDefined()
    expect(screen.getByTestId('horizon-backlog')).toBeDefined()
    expect(screen.queryByRole('link', { name: '回 Anna 的退货' })).toBeNull()
  })

  it('点标题进入事项并定位到锚点；打勾不导航', async () => {
    listTodos.mockResolvedValueOnce({
      todos: [todo({ matter_id: 'mat_1', anchor: { matter_event_id: 'mev_9' } })],
    })
    renderWithProviders(<TodosPage />)
    await screen.findByTestId('todos')
    const link = screen.getByTestId('todo-title')
    expect(link.getAttribute('href')).toBe('/matters/mat_1#mev_9')

    // 打勾只发 done，不改地址
    const before = globalThis.location.pathname
    fireEvent.click(screen.getByTestId('todo-check'))
    await waitFor(() => {
      expect(completeTodo).toHaveBeenCalledWith('td_1')
    })
    expect(globalThis.location.pathname).toBe(before)
  })

  it('委托之后待办显示卡数与「AI 在做」', async () => {
    listTodos.mockResolvedValueOnce({
      todos: [
        todo({
          cards: ['ap_1', 'ap_2'],
          delegate: { assignment_id: 'asg_1', brief: '照旧', state: 'running', at: T0 },
        }),
      ],
    })
    renderWithProviders(<TodosPage />)
    await screen.findByTestId('todos')
    expect(screen.getByTestId('todo-cards').textContent).toContain('2')
    expect(screen.getByTestId('todo-delegated')).toBeDefined()
  })

  it.each([
    ['交给 AI 做', () => delegateTodo],
    ['关闭', () => dropTodo],
    ['改到明天', () => updateTodo],
  ])('菜单里的「%s」打对应的接口', async (label, fn) => {
    renderWithProviders(<TodosPage />)
    await screen.findByTestId('todos')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: label }))
    await waitFor(() => {
      expect(fn()).toHaveBeenCalled()
    })
  })

  it('待办可以拖走（拖出去的就是 todo id）', async () => {
    renderWithProviders(<TodosPage />)
    await screen.findByTestId('todos')
    expect(screen.getByTestId('todo-row').getAttribute('draggable')).toBe('true')
  })
})

describe('日历（37 C3：视图 + 排期面）', () => {
  beforeEach(() => {
    scheduleTodo.mockClear()
    getCalendar.mockClear()
  })

  it('周视图 7 格、月视图 42 格，四类来源都画得出来', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    renderWithProviders(<CalendarPage />)
    expect(await screen.findAllByTestId('calendar-day')).toHaveLength(7)
    expect(screen.getAllByTestId('calendar-item')[0]?.getAttribute('data-source')).toBe('meeting')
    await user.click(screen.getByRole('button', { name: '月' }))
    expect(await screen.findAllByTestId('calendar-day')).toHaveLength(42)
  })

  it('把待办拖到某一天 = 写 scheduled', async () => {
    renderWithProviders(<CalendarPage />)
    const cell = (await screen.findAllByTestId('calendar-day'))[3]
    if (cell === undefined) throw new Error('没有日历格子')
    const data = new Map<string, string>([['application/x-agentsws-todo', 'td_1']])
    const dataTransfer = {
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => data.set(type, value),
      dropEffect: 'none',
      effectAllowed: 'move',
    }
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.dragOver(cell, { dataTransfer })
    expect(cell.getAttribute('data-over')).toBe('true')
    fireEvent.drop(cell, { dataTransfer })
    await waitFor(() => {
      expect(scheduleTodo).toHaveBeenCalledTimes(1)
    })
    const [id, slot] = scheduleTodo.mock.calls[0] as unknown as [
      string,
      { start: string; end: string },
    ]
    expect(id).toBe('td_1')
    expect(new Date(slot.start).getHours()).toBe(9)
  })

  it('翻页会重新取数（窗口在服务端算）', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    renderWithProviders(<CalendarPage />)
    await screen.findAllByTestId('calendar-day')
    const first = getCalendar.mock.calls.length
    await user.click(screen.getByRole('button', { name: '下一页' }))
    await screen.findAllByTestId('calendar-day')
    expect(getCalendar.mock.calls.length).toBeGreaterThan(first)
  })
})

describe('目标页（37 §2.3）', () => {
  it('三级树 + 进度；子目标缩进在父目标下', async () => {
    renderWithProviders(<GoalsPage />)
    await screen.findByTestId('goals-page')
    const nodes = screen.getAllByTestId('goal-node')
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.getAttribute('data-depth')).toBe('0')
    expect(nodes[1]?.getAttribute('data-depth')).toBe('1')
    expect(screen.getByText('落后')).toBeDefined()
  })
})

describe('事项页（37 §2.2b：唯一的上下文容器）', () => {
  beforeEach(() => {
    postMatterMessage.mockClear()
    closeMatter.mockClear()
  })

  it('顶部摘要 + 固定记录 + 待办 + 时间线 + 底部对话输入', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/matters/:id" element={<MatterPage />} />
      </Routes>,
      '/matters/mat_1',
    )
    await screen.findByTestId('matter')
    expect(screen.getByTestId('matter-summary').textContent).toContain('窗口内')
    expect(within(screen.getByTestId('matter-pinned')).getByText('#1001')).toBeDefined()
    expect(within(screen.getByTestId('matter-todos')).getByText('回 Anna 的退货')).toBeDefined()
    expect(screen.getByTestId('timeline-event')).toBeDefined()
    expect(screen.getByTestId('matter-say')).toBeDefined()
    // 未决的卡数
    expect(screen.getByText('未决的卡：1 张')).toBeDefined()
  })

  it('底部对话输入发出去 = 在这个事项里起一次 Run（第四处入口，有边界）', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/matters/:id" element={<MatterPage />} />
      </Routes>,
      '/matters/mat_1',
    )
    await screen.findByTestId('matter')
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.type(screen.getByLabelText('在这个事项里说一句'), '帮我查一下物流')
    await user.click(screen.getByRole('button', { name: '发' }))
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalledWith('mat_1', '帮我查一下物流')
    })
  })

  it('关闭事项会先问「一并关掉 / 留着」，不自动关未完待办', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/matters/:id" element={<MatterPage />} />
      </Routes>,
      '/matters/mat_1',
    )
    await screen.findByTestId('matter')
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(screen.getByRole('button', { name: '关闭事项' }))
    expect(screen.getByTestId('close-dialog')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '留着' }))
    await waitFor(() => {
      expect(closeMatter).toHaveBeenCalledWith('mat_1', 'keep')
    })
  })
})
