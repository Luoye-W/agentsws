/**
 * WP469（决策 1521–1527）：日历与待办——待办和日历合成一页。
 *
 * 钉住的是：
 * - 三档（没日子 / 有日子没钟点 / 有钟点）每行右边怎么写；「记一条待办」认「周五下午」；
 * - 拖动就是换档（拖到钟点给时段、拖到全天给日子、拖回左边两样都清掉）；
 * - 「帮我排进空档」只画虚线候选：不点「采用」什么都不写；「换一个」不撞别的候选；
 * - 打开时记住上次那一面，第一次是清单（1523）；老地址 `/todos`、`/calendar` 转到对应那一面（1526）；
 * - 做完的待办在日历上划掉（1524）；首页那一行；左栏灰色数字。
 */
import type { CalendarItem, Todo, TodoSlotResult } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dayKeyOf,
  dayNoon,
  dropPatch,
  type Ghost,
  groupForList,
  homeTodoLine,
  inboxDeadline,
  nextOption,
  parseQuickTodo,
  whenLabel,
} from '@/lib/cal-todo'
import { eventContent } from '@/lib/calendar-view'
import { renderWithProviders } from './helpers'

/** 2026-10-22 周四 11:20（本地时间） */
const NOW = new Date(2026, 9, 22, 11, 20)
const at = (d: number, h: number, m = 0): string => new Date(2026, 9, d, h, m).toISOString()

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 'td_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '写新品页文案',
  owner: 'per_1',
  horizon: 'week',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: at(20, 9),
  updated_at: at(20, 9),
  ...over,
})

describe('三档每行右边写什么', () => {
  it('有钟点：今天只写钟点，别的天写星期 + 钟点；有日子写星期；没日子写「没排日子」', () => {
    expect(
      whenLabel(todo({ scheduled: { start: at(22, 15), end: at(22, 16) } }), NOW, 'zh'),
    ).toEqual({ kind: 'clock', text: '15:00' })
    expect(
      whenLabel(todo({ scheduled: { start: at(23, 14), end: at(23, 15) } }), NOW, 'zh').text,
    ).toBe('明天 14:00')
    expect(whenLabel(todo({ due: dayNoon('2026-10-24') }), NOW, 'zh')).toEqual({
      kind: 'day',
      text: '周六',
    })
    expect(whenLabel(todo(), NOW, 'zh')).toEqual({ kind: 'none', text: '没排日子' })
  })

  it('从收件箱带过来的期限读作「周五前」', () => {
    const label = whenLabel(
      todo({ due: dayNoon('2026-10-24'), origin: { inbox_item: 'mail:<t>' } }),
      NOW,
      'zh',
    )
    expect(label).toEqual({ kind: 'day', text: '周六前', deadline: true })
  })
})

describe('「记一条待办」认的说法', () => {
  it('周五下午 → 周五 14:00 占一小时，标题去掉日子', () => {
    const q = parseQuickTodo('周五下午拍样品', NOW)
    expect(q.title).toBe('拍样品')
    expect(q.scheduled).toEqual({ start: at(23, 14), end: at(23, 15) })
  })

  it('只有日子 → 那天（记成本地中午）；只写钟点 → 今天那个钟点', () => {
    expect(parseQuickTodo('周五 给 Maya 回报价', NOW)).toEqual({
      title: '给 Maya 回报价',
      due: dayNoon('2026-10-23'),
    })
    expect(parseQuickTodo('回复 Leo 15:00', NOW).scheduled?.start).toBe(at(22, 15))
    expect(parseQuickTodo('下周一 3点半 对账', NOW).scheduled?.start).toBe(at(26, 3, 30))
  })

  it('什么日子都没写 → 本周、没日子；「12 月」不是钟点', () => {
    expect(parseQuickTodo('给工厂确认 12 月备货量', NOW)).toEqual({
      title: '给工厂确认 12 月备货量',
      horizon: 'week',
    })
  })
})

describe('拖动就是换档（决策 1522）', () => {
  const timed = todo({ scheduled: { start: at(23, 14), end: at(23, 15, 30) } })

  it('拖到某个钟点：给时段，有钟点的保留原来的长短，没钟点的占一小时', () => {
    expect(dropPatch(todo(), { kind: 'time', day: '2026-10-22', minutes: 14 * 60 })).toEqual({
      scheduled: { start: at(22, 14), end: at(22, 15) },
    })
    expect(dropPatch(timed, { kind: 'time', day: '2026-10-21', minutes: 9 * 60 })).toEqual({
      scheduled: { start: at(21, 9), end: at(21, 10, 30) },
    })
  })

  it('拖到全天：只定日子（清掉钟点）；月格里有钟点的换天不换钟点', () => {
    expect(dropPatch(timed, { kind: 'day', day: '2026-10-24' })).toEqual({
      due: dayNoon('2026-10-24'),
      scheduled: null,
    })
    expect(dropPatch(timed, { kind: 'day', day: '2026-10-26', keepClock: true })).toEqual({
      scheduled: { start: at(26, 14), end: at(26, 15, 30) },
    })
  })

  it('拖回左边：两样都清掉，按落在哪一组放；落回原处什么都不改', () => {
    expect(dropPatch(timed, { kind: 'rail', horizon: 'backlog' })).toEqual({
      due: null,
      scheduled: null,
      horizon: 'backlog',
    })
    expect(dropPatch(todo(), { kind: 'rail', horizon: 'week' })).toBeUndefined()
    expect(
      dropPatch(todo({ due: dayNoon('2026-10-24') }), { kind: 'day', day: '2026-10-24' }),
    ).toBe(undefined)
  })
})

describe('清单分组', () => {
  it('今天做完的留在「今天」（排在后面），更早做完的进「做完的」；收件箱来的排在本周最上面', () => {
    const g = groupForList(
      [
        todo({ id: 'a', horizon: 'today', scheduled: { start: at(22, 15), end: at(22, 16) } }),
        todo({ id: 'b' }),
        todo({ id: 'c', origin: { inbox_item: 'card:ap_1' }, created_at: at(22, 10) }),
        todo({ id: 'd', horizon: 'backlog' }),
      ],
      [
        todo({ id: 'e', status: 'done', closed_at: at(22, 9, 40) }),
        todo({ id: 'f', status: 'done', closed_at: at(20, 9) }),
      ],
      NOW,
    )
    expect(g.today.map((x) => x.id)).toEqual(['a', 'e'])
    expect(g.week.map((x) => x.id)).toEqual(['c', 'b'])
    expect(g.later.map((x) => x.id)).toEqual(['d'])
    expect(g.done.map((x) => x.id)).toEqual(['f'])
  })
})

describe('收件箱的期限、首页那一行、「换一个」', () => {
  it('卡的到期（7 天内）或信里写的「3 天内」带成日子；没有就不带', () => {
    expect(inboxDeadline({ expires_at: at(24, 18) }, NOW)).toBe(dayNoon('2026-10-24'))
    expect(inboxDeadline({ text: '请在 3 天内补齐营业执照' }, NOW)).toBe(dayNoon('2026-10-25'))
    expect(inboxDeadline({ text: '没有期限' }, NOW)).toBeUndefined()
    expect(inboxDeadline({ expires_at: at(31, 18) }, NOW)).toBeUndefined()
  })

  it('首页：今天几件、下一件有钟点的、几件没排期', () => {
    const line = homeTodoLine(
      [
        todo({
          id: 'a',
          horizon: 'today',
          title: '回复 Leo',
          scheduled: { start: at(22, 15), end: at(22, 16) },
        }),
        todo({ id: 'b', horizon: 'today', due: dayNoon('2026-10-22') }),
        todo({ id: 'c' }),
        todo({ id: 'd', horizon: 'backlog' }),
      ],
      NOW,
    )
    expect(line).toEqual({ today: 2, next: { title: '回复 Leo', at: at(22, 15) }, unscheduled: 2 })
  })

  it('「换一个」跳过和别的候选撞的那个', () => {
    const a: Ghost = {
      todo_id: 'a',
      title: 'A',
      minutes: 60,
      at: 0,
      options: [
        { start: at(22, 13), end: at(22, 14) },
        { start: at(22, 14), end: at(22, 15) },
        { start: at(22, 16), end: at(22, 17) },
      ],
    }
    const b: Ghost = { ...a, todo_id: 'b', options: [{ start: at(22, 14), end: at(22, 15) }] }
    expect(nextOption(a, [a, b])).toBe(2)
  })
})

describe('做完的待办在日历上划掉（决策 1524）', () => {
  const item: CalendarItem = {
    id: 'cal_todo_td_1',
    source: 'todo',
    title: '核对退款单',
    start: at(22, 12),
    all_day: true,
    ref: { type: 'todo', id: 'td_1' },
    status: 'done',
    drag: 'readonly',
  }

  it('勾选框是勾上的、标题划掉；做完的不能拖', () => {
    const html = eventContent(item, {
      color: 'var(--ws-chart-1)',
      layerName: '待办',
      todo: { checkLabel: '打勾完成', drag: true },
    }).dateGrid
    expect(html).toContain('data-todo-check="td_1"')
    expect(html).toContain('data-done="true"')
    expect(html).toContain('ws-ev-done')
    expect(html).not.toContain('draggable')
  })

  it('只有待办才划掉：会议的 status 是它自己的（开过的会不划）', () => {
    const html = eventContent(
      { ...item, id: 'cal_meet_1', source: 'meeting', ref: { type: 'meeting', id: 'm1' } },
      { color: 'x', layerName: '会议' },
    ).timeGrid
    expect(html).not.toContain('ws-ev-done')
  })

  it('没做完的整块能拖，勾是空的', () => {
    const html = eventContent(
      { ...item, status: 'open', drag: 'reschedule' },
      { color: 'x', layerName: '待办', todo: { checkLabel: '打勾完成', drag: true } },
    ).timeGrid
    expect(html).toContain('draggable="true"')
    expect(html).toContain('data-done="false"')
  })
})

/* ── 页面 ─────────────────────────────────────────────── */

const state = vi.hoisted(() => ({
  open: [] as Todo[],
  done: [] as Todo[],
  calendar: [] as CalendarItem[],
}))
const updateTodo = vi.fn(async (id: string, _patch: unknown) => ({ todo: { id } }))
const completeTodo = vi.fn(async (id: string) => ({ todo: { id } }))
const proposeTodoSlots = vi.fn(
  async (_input: unknown): Promise<TodoSlotResult> => ({ proposals: [], unplaced: [] }),
)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listTodos: async (q = '') => ({ todos: q.includes('done') ? state.done : state.open }),
    updateTodo: (id: string, patch: unknown) => updateTodo(id, patch),
    completeTodo: (id: string) => completeTodo(id),
    proposeTodoSlots: (input: unknown) => proposeTodoSlots(input),
    getCalendar: async (from: string, to: string) => ({ items: state.calendar, from, to }),
    listGoals: async () => ({ goals: [], progress: [] }),
    getPositions: async () => ({ positions: [], instances: [], tile_library: [], max_tiles: 0 }),
  }
})

const { CalTodoPage, CalTodoRedirect } = await import('@/pages/cal-todo')

function Where(): React.ReactNode {
  const loc = useLocation()
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>
}

function app(route: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/planner" element={<CalTodoPage />} />
        <Route path="/todos" element={<CalTodoRedirect face="list" />} />
        <Route path="/calendar" element={<CalTodoRedirect face="calendar" />} />
      </Routes>
      <Where />
    </>,
    route,
  )
}

let store: Map<string, string>
beforeEach(() => {
  state.open = [
    todo({ id: 'td_a', title: '写新品页文案' }),
    todo({ id: 'td_b', title: '给工厂确认备货量' }),
    todo({ id: 'td_c', title: '把 FAQ 翻成德语', horizon: 'backlog' }),
  ]
  state.done = []
  state.calendar = []
  updateTodo.mockClear()
  completeTodo.mockClear()
  proposeTodoSlots.mockClear()
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store.clear()
    },
    key: () => null,
    length: 0,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('打开哪一面（决策 1523）与老地址（决策 1526）', () => {
  it('第一次是清单；切到日历记下来，下次打开就是日历', async () => {
    const user = userEvent.setup()
    const first = app('/planner')
    expect((await screen.findByTestId('cal-todo')).getAttribute('data-face')).toBe('list')
    await screen.findByTestId('horizon-week')
    await user.click(screen.getByTestId('caltodo-face-calendar'))
    expect(screen.getByTestId('cal-todo').getAttribute('data-face')).toBe('calendar')
    expect(store.get('agentsws.cal_todo.face')).toBe('calendar')
    expect(screen.getByTestId('where').textContent).toContain('view=calendar')
    first.unmount()
    app('/planner')
    expect((await screen.findByTestId('cal-todo')).getAttribute('data-face')).toBe('calendar')
  })

  it('地址上写了就听地址', async () => {
    store.set('agentsws.cal_todo.face', 'calendar')
    app('/planner?view=list')
    expect((await screen.findByTestId('cal-todo')).getAttribute('data-face')).toBe('list')
  })

  it('/todos → 清单（?tab=goals 照旧）；/calendar → 日历（?layers= 照旧）', async () => {
    const one = app('/todos?tab=goals')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/planner?tab=goals&view=list')
    })
    expect(await screen.findByTestId('goals-page')).toBeTruthy()
    one.unmount()
    app('/calendar?layers=social_post,todo')
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe(
        '/planner?layers=social_post%2Ctodo&view=calendar',
      )
    })
    expect((await screen.findByTestId('cal-todo')).getAttribute('data-face')).toBe('calendar')
    const on = (await screen.findAllByTestId('calendar-layer'))
      .filter((n) => n.getAttribute('data-on') === 'true')
      .map((n) => n.getAttribute('data-layer'))
    expect(on).toEqual(['todo', 'social_post'])
  })
})

describe('清单那一面', () => {
  it('三档写在右边；没日子的那一行有「排进日历」', async () => {
    state.open = [
      todo({ id: 't1', horizon: 'today', scheduled: { start: at(22, 15), end: at(22, 16) } }),
      todo({ id: 't2', title: '拍主图样品' }),
    ]
    app('/planner?view=list')
    const rows = await screen.findAllByTestId('todo-row')
    const r1 = rows.find((r) => r.getAttribute('data-todo') === 't1') as HTMLElement
    const r2 = rows.find((r) => r.getAttribute('data-todo') === 't2') as HTMLElement
    expect(r1.getAttribute('data-level')).toBe('timed')
    expect(within(r1).getByTestId('todo-when').getAttribute('data-kind')).toBe('clock')
    expect(within(r2).getByTestId('todo-when').textContent).toBe('没排日子')
    expect(within(r2).getByTestId('todo-place').getAttribute('href')).toBe(
      '/planner?view=calendar&focus=t2',
    )
  })

  it('「改日子…」填了钟点就是第三档（排上时段）', async () => {
    app('/planner?view=list')
    const rows = await screen.findAllByTestId('todo-row')
    const r = rows[0] as HTMLElement
    fireEvent.click(within(r).getByRole('button', { name: '更多' }))
    fireEvent.click(await screen.findByTestId('todo-menu-date'))
    fireEvent.change(await screen.findByTestId('todo-date-day'), {
      target: { value: '2026-10-23' },
    })
    fireEvent.change(screen.getByTestId('todo-date-time'), { target: { value: '14:00' } })
    fireEvent.click(screen.getByTestId('todo-date-save'))
    await waitFor(() => {
      expect(updateTodo).toHaveBeenCalledWith('td_a', {
        scheduled: { start: at(23, 14), end: at(23, 15) },
      })
    })
  })
})

describe('日历那一面', () => {
  it('左边「还没排期的」分本周 / 以后；周视图顶上一条「还有 N 件没排日子」', async () => {
    app('/planner?view=calendar')
    const rail = await screen.findByTestId('caltodo-rail')
    expect((await within(rail).findByTestId('caltodo-rail-week')).textContent).toContain(
      '写新品页文案',
    )
    expect(within(rail).getByTestId('caltodo-rail-later').textContent).toContain('把 FAQ 翻成德语')
    expect((await screen.findByTestId('caltodo-strip')).textContent).toContain('还有 2 件没排日子')
  })

  it('「做完的待办」默认开：要日历时带 done；关掉记下来', async () => {
    const user = userEvent.setup()
    app('/planner?view=calendar')
    const done = await screen.findByTestId('calendar-layer-done')
    expect(done.getAttribute('data-on')).toBe('true')
    await user.click(done)
    await waitFor(() => {
      expect(store.get('agentsws.calendar.done')).toBe('off')
    })
  })

  it('帮我排进空档：只画候选，什么都不写；「采用」才写 scheduled；「都不要」收掉', async () => {
    proposeTodoSlots.mockResolvedValueOnce({
      proposals: [
        {
          todo_id: 'td_a',
          title: '写新品页文案',
          minutes: 120,
          options: [{ start: at(22, 13, 30), end: at(22, 15, 30) }],
        },
        {
          todo_id: 'td_b',
          title: '给工厂确认备货量',
          minutes: 60,
          options: [{ start: at(23, 10), end: at(23, 11) }],
        },
      ],
      unplaced: [],
    })
    const user = userEvent.setup()
    app('/planner?view=calendar')
    await screen.findByTestId('caltodo-rail')
    await user.click(screen.getByTestId('caltodo-ai'))
    await waitFor(() => {
      expect(proposeTodoSlots).toHaveBeenCalled()
    })
    // 没选就排「本周要做」里能排的那几件（「以后」那件不排）
    const sent = proposeTodoSlots.mock.calls[0]?.[0] as { todo_ids: string[] } | undefined
    expect(sent?.todo_ids).toEqual(['td_a', 'td_b'])
    const bar = await screen.findByTestId('caltodo-ai-bar')
    expect(bar.textContent).toContain('不点「采用」不会排上')
    expect(screen.getByTestId('caltodo-ai').getAttribute('data-state')).toBe('found')
    expect(updateTodo).not.toHaveBeenCalled()
    // 选上的那几行写「约 2 小时」
    expect(screen.getAllByTestId('caltodo-rail-est')[0]?.textContent).toContain('约 2 小时')

    const host = screen.getByTestId('calendar-host')
    const take = await waitFor(() => {
      const btn = host.querySelector('[data-ghost-act="take"][data-ghost="td_a"]')
      if (btn === null) throw new Error('虚线块还没画出来')
      return btn as HTMLElement
    })
    fireEvent.click(take)
    await waitFor(() => {
      expect(updateTodo).toHaveBeenCalledWith('td_a', {
        scheduled: { start: at(22, 13, 30), end: at(22, 15, 30) },
      })
    })
    expect(updateTodo).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId('caltodo-ai-none'))
    expect(screen.queryByTestId('caltodo-ai-bar')).toBeNull()
    expect(updateTodo).toHaveBeenCalledTimes(1)
  })

  it('日历格子里的勾：打勾 = 做完（不打开小卡）', async () => {
    state.calendar = [
      {
        id: 'cal_todo_td_d',
        source: 'todo',
        title: '给 Maya 回报价',
        start: dayNoon(dayKeyOf(new Date())),
        all_day: true,
        ref: { type: 'todo', id: 'td_d' },
        status: 'open',
        drag: 'reschedule',
      },
    ]
    app('/planner?view=calendar')
    const host = await screen.findByTestId('calendar-host')
    const check = await waitFor(() => {
      const el = host.querySelector('[data-todo-check="td_d"]')
      if (el === null) throw new Error('那一条还没画出来')
      return el as HTMLElement
    })
    fireEvent.click(check)
    await waitFor(() => {
      expect(completeTodo).toHaveBeenCalledWith('td_d')
    })
    expect(screen.queryByTestId('calendar-event-card')).toBeNull()
  })
})
