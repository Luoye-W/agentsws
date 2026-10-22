/**
 * WP474：
 * - 决策 1531：上周没做完挪过来的（服务端标 `carried_over`）排在「本周」最上面，行上写「上周没做完」；
 *   「还没排期的 · 本周要做」也排最上面；
 * - 决策 1530：「设置 → 通用」里一行「我的作息」，改了就存（只影响「帮我排进空档」）。
 */
import type { CalendarItem, Todo, WorkHours } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { groupForList, unscheduled } from '@/lib/cal-todo'
import { renderWithProviders } from './helpers'

const NOW = new Date(2026, 9, 26, 9, 0)
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
  created_at: at(26, 8),
  updated_at: at(26, 8),
  ...over,
})

describe('上周没做完的排在本周最上面（WP474）', () => {
  it('清单「本周」：上周没做完的 → 收件箱记过来的 → 其余', () => {
    const groups = groupForList(
      [
        todo({ id: 'plain' }),
        todo({ id: 'inbox', origin: { inbox_item: 'card:ap_1' } }),
        todo({ id: 'carried', carried_over: true, created_at: at(22, 10) }),
      ],
      [],
      NOW,
    )
    expect(groups.week.map((t) => t.id)).toEqual(['carried', 'inbox', 'plain'])
  })

  it('「还没排期的 · 本周要做」也是上周没做完的在前', () => {
    const u = unscheduled([
      todo({ id: 'a' }),
      todo({ id: 'b', carried_over: true }),
      todo({ id: 'c', horizon: 'backlog' }),
    ])
    expect(u.week.map((t) => t.id)).toEqual(['b', 'a'])
    expect(u.later.map((t) => t.id)).toEqual(['c'])
  })
})

/* ── 页面 ─────────────────────────────────────────────── */

const state = vi.hoisted(() => ({
  open: [] as Todo[],
  calendar: [] as CalendarItem[],
  hours: undefined as WorkHours | undefined,
}))
const putHours = vi.fn(async (_body: unknown) => undefined)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/v1/settings/work-hours') {
        if (init?.method === 'PUT') {
          await putHours(init.body)
          state.hours = init.body as WorkHours
        }
        return state.hours
      }
      return actual.api(path, init as never)
    },
    listTodos: async (q = '') => ({ todos: q.includes('done') ? [] : state.open }),
    getCalendar: async (from: string, to: string) => ({ items: state.calendar, from, to }),
    listGoals: async () => ({ goals: [], progress: [] }),
    getPositions: async () => ({ positions: [], instances: [], tile_library: [], max_tiles: 0 }),
  }
})

const { CalTodoPage } = await import('@/pages/cal-todo')
const { WorkHoursSetting } = await import('@/components/settings/work-hours-setting')

beforeEach(() => {
  state.open = []
  state.hours = {
    start_min: 540,
    end_min: 1080,
    weekends: false,
    live_buffer_min: 30,
    avoid_lunch: false,
  }
  putHours.mockClear()
})

describe('清单那一面：上周没做完（WP474）', () => {
  it('那一行写「上周没做完」，排在本周第一行', async () => {
    state.open = [
      todo({ id: 'now', title: '给工厂确认备货量' }),
      todo({ id: 'old', title: '回 Leo 的合作邮件', carried_over: true }),
    ]
    renderWithProviders(
      <Routes>
        <Route path="/planner" element={<CalTodoPage />} />
      </Routes>,
      '/planner?view=list',
    )
    const rows = await screen.findAllByTestId('todo-row')
    expect(rows[0]?.getAttribute('data-todo')).toBe('old')
    expect(within(rows[0] as HTMLElement).getByTestId('todo-carried').textContent).toBe(
      '上周没做完',
    )
    expect(within(rows[1] as HTMLElement).queryByTestId('todo-carried')).toBeNull()
  })
})

describe('设置 · 我的作息（WP474）', () => {
  it('默认 9:00–18:00；打开「周末也排」「避开午饭」、改上班时间都存一次', async () => {
    renderWithProviders(<WorkHoursSetting />, '/')
    const start = (await screen.findByTestId('work-hours-start')) as HTMLSelectElement
    expect(start.value).toBe('540')
    expect((screen.getByTestId('work-hours-end') as HTMLSelectElement).value).toBe('1080')
    expect((screen.getByTestId('work-hours-live') as HTMLSelectElement).value).toBe('30')
    fireEvent.click(screen.getByTestId('work-hours-weekends'))
    await waitFor(() => {
      expect(putHours).toHaveBeenLastCalledWith(expect.objectContaining({ weekends: true }))
    })
    fireEvent.change(start, { target: { value: '600' } })
    await waitFor(() => {
      expect(putHours).toHaveBeenLastCalledWith(expect.objectContaining({ start_min: 600 }))
    })
    fireEvent.click(screen.getByTestId('work-hours-lunch'))
    await waitFor(() => {
      expect(putHours).toHaveBeenLastCalledWith(expect.objectContaining({ avoid_lunch: true }))
    })
  })

  it('老服务进程没有这一格：整行不出', async () => {
    state.hours = undefined
    const { container } = renderWithProviders(<WorkHoursSetting />, '/')
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector('[data-testid="settings-work-hours"]')).toBeNull()
  })
})
