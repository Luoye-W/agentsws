/**
 * WP469（决策 1521）：收件箱一行「记成待办」、首页「今天 N 件待办」那一行、左栏「日历与待办」的灰色数字。
 *
 * - 「⋯」第一项「记成待办」：默认进「本周」、没日子；记完底部提示条「去看 · 撤销」，撤销 = 关掉那条待办；
 * - 那一行记过（待办上记着从哪一行来的）就收成一行「已记成待办「…」」，刷新也还收着；
 * - 一张一张里按 T 记成待办；
 * - 首页：收件箱那一行下面一行「今天 N 件待办 · 下一件 … · 还有 N 件没排期」。
 */
import type { Todo } from '@agentsws/contracts'
import type { InboxView } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInboxOpen } from '@/components/inbox/inbox-model'
import type { Me } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { inboxView } from './inbox-fixtures'

const state = vi.hoisted(() => ({
  view: undefined as InboxView | undefined,
  todos: [] as Todo[],
}))
const createTodo = vi.fn(async (input: { title: string; from_inbox?: string }) => {
  const made: Todo = {
    id: 'td_new',
    schema_version: 1,
    workspace_id: 'ws_1',
    title: input.title,
    owner: 'per_1',
    horizon: 'week',
    source: 'card',
    status: 'open',
    cards: [],
    runs: [],
    created_at: '2026-10-22T03:00:00.000Z',
    updated_at: '2026-10-22T03:00:00.000Z',
    ...(input.from_inbox === undefined ? {} : { origin: { inbox_item: input.from_inbox } }),
  }
  state.todos = [...state.todos, made]
  return { todo: made }
})
const dropTodo = vi.fn(async (id: string) => {
  state.todos = state.todos.filter((x) => x.id !== id)
  return { todo: { id } }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getInbox: async () => state.view,
    listTodos: async (q = '') => ({ todos: q.includes('done') ? [] : state.todos }),
    createTodo: (input: { title: string; from_inbox?: string }) => createTodo(input),
    dropTodo: (id: string) => dropTodo(id),
    getMessageOverview: async () => ({
      unclaimed: 0,
      notice: 0,
      handed: 0,
      handed_by_position: [],
      cards_waiting: 0,
      notice_groups: [],
      positions: [],
      taught: { rules: 0, saved: 0, recent: [] },
    }),
    listMessageFollowUps: async () => ({ rows: [] }),
    ensureSession: async () =>
      ({
        person: { id: 'per_1', email: 'w@example.com', name: '王岚' },
        workspace: { id: 'ws_1', name: 'NordVolt Gear' },
        assignments: [{ id: 'asg_1', role_id: 'dtc.support', ranges: [] }],
      }) as unknown as Me,
  }
})

const { InboxPage } = await import('@/pages/inbox')

beforeEach(() => {
  state.view = inboxView()
  state.todos = []
  resetInboxOpen()
  createTodo.mockClear()
  dropTodo.mockClear()
})

const row = (id: string): HTMLElement => {
  const hit = screen.queryAllByTestId('inbox-row').find((r) => r.getAttribute('data-id') === id)
  if (hit === undefined) throw new Error(`没有 ${id}`)
  return hit
}

describe('收件箱「记成待办」（WP469）', () => {
  it('「⋯」第一项就是它（快捷键 T）；记完进「本周」、提示条能去看能撤销、那一行收起来', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(within(row('mail:<t_shop@x>')).getByTestId('inbox-row-more'))
    const menu = await screen.findByTestId('inbox-row-menu')
    const first = within(menu).getAllByRole('menuitem')[0] as HTMLElement
    expect(first.textContent).toBe('记成待办T')
    fireEvent.click(first)
    await waitFor(() => {
      expect(createTodo).toHaveBeenCalled()
    })
    expect(createTodo.mock.calls[0]?.[0]).toMatchObject({
      title: 'Payouts paused',
      horizon: 'week',
      from_inbox: 'mail:<t_shop@x>',
    })
    const toast = await screen.findByTestId('inbox-notice')
    expect(toast.textContent).toContain('记进「日历与待办 · 本周」')
    expect(within(toast).getByTestId('inbox-notice-go').getAttribute('href')).toBe(
      '/planner?view=list&fresh=td_new',
    )
    // 那一行收成一行
    const recorded = await screen.findByTestId('inbox-row-recorded')
    expect(recorded.textContent).toContain('已记成待办「Payouts paused」· 本周')
    expect(
      screen.queryAllByTestId('inbox-row').map((r) => r.getAttribute('data-id')),
    ).not.toContain('mail:<t_shop@x>')
    // 撤销 = 关掉那条待办，那一行回来
    fireEvent.click(within(recorded).getByTestId('inbox-row-recorded-undo'))
    await waitFor(() => {
      expect(dropTodo).toHaveBeenCalledWith('td_new')
    })
    await waitFor(() => {
      expect(row('mail:<t_shop@x>')).toBeTruthy()
    })
  })

  it('记过的那一行一打开就是收着的（认的是待办上的 origin.inbox_item）', async () => {
    state.todos = [
      {
        id: 'td_old',
        schema_version: 1,
        workspace_id: 'ws_1',
        title: '回 Tom 的信',
        owner: 'per_1',
        horizon: 'week',
        source: 'card',
        status: 'open',
        cards: [],
        runs: [],
        created_at: '2026-10-21T03:00:00.000Z',
        updated_at: '2026-10-21T03:00:00.000Z',
        origin: { inbox_item: 'card:ap_reply', card_id: 'ap_reply' },
      },
    ]
    renderWithProviders(<InboxPage />, '/inbox')
    const recorded = await screen.findByTestId('inbox-row-recorded')
    expect(recorded.getAttribute('data-todo')).toBe('td_old')
  })

  it('一张一张里按 T 记成待办', async () => {
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const box = await screen.findByTestId('inbox-focus')
    expect(screen.getByTestId('inbox-focus-keys').textContent).toContain('记成待办')
    fireEvent.keyDown(box, { key: 't' })
    await waitFor(() => {
      expect(createTodo).toHaveBeenCalledTimes(1)
    })
  })
})
