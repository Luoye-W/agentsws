/**
 * 认领与撞车的界面（40 §3，WP38）。
 *
 * 三件事：
 * - 建待办撞上了 → 出选择题卡（谁在做、几张卡等他定），三个出口都真的带上参数
 * - 「我这个不一样」不写区别按钮是灰的（服务端也拦，界面先拦一次）
 * - 待认领池：点「我来」就是认领；别人先认了，回来的是一句人话而不是错误码
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiClientError, type ClaimPoolItem, type InProgressItem } from '@/lib/api'
import { renderWithProviders } from './helpers'

const CANDIDATE = {
  kind: 'todo' as const,
  id: 'td_a',
  title: '核对昨天的退款单',
  owner: '李默',
  status: 'doing',
  keys: ['object', 'semantic'],
  cards: 2,
  started_at: '2026-09-09T01:00:00.000Z',
  last_activity: '2026-09-09T01:00:00.000Z',
}

const POOL: ClaimPoolItem[] = [
  {
    todo_id: 'td_pool',
    title: '把上周的退款汇总一下',
    source: 'meeting',
    pooled_at: '2026-09-09T01:00:00.000Z',
    recycled: 0,
    similar_to: [],
  },
]

const IN_PROGRESS: InProgressItem[] = [
  {
    kind: 'todo',
    id: 'td_a',
    title: '核对昨天的退款单',
    owner: 'p_li',
    owner_label: '李默',
    collaborators: [],
    status: 'doing',
    started_at: '2026-09-09T01:00:00.000Z',
    last_activity: '2026-09-09T01:00:00.000Z',
    cards: 2,
  },
]

const collisionError = (): ApiClientError =>
  new ApiClientError(409, {
    code: 'conflict',
    message: '已经有人在做这件事',
    details: { reason: 'similar_in_progress', candidates: [CANDIDATE] },
  })

const createTodo = vi.fn()
const listTodos = vi.fn(async () => ({ todos: [] }))
const listClaimPool = vi.fn(async () => ({ pool: POOL }))
const claimTodo = vi.fn(async () => ({ todo: {} }))
const listInProgress = vi.fn(async () => ({ items: IN_PROGRESS, scope: 'workspace' }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    createTodo: (...args: unknown[]) => createTodo(...(args as [])),
    listTodos: (...args: unknown[]) => listTodos(...(args as [])),
    listClaimPool: (...args: unknown[]) => listClaimPool(...(args as [])),
    claimTodo: (...args: unknown[]) => claimTodo(...(args as [])),
    listInProgress: (...args: unknown[]) => listInProgress(...(args as [])),
  }
})

// 动态 import 必须在 mock 之后
const { TodosPage } = await import('@/pages/todos')
const { ClaimPool } = await import('@/components/work/claim-pool')
const { InprogressTab, groupByOwner } = await import('@/components/org/inprogress-tab')

describe('撞车选择题卡（40 §3.1）', () => {
  it('撞上了出卡，说清谁在做、几张卡等他定', async () => {
    createTodo.mockRejectedValueOnce(collisionError())
    const user = userEvent.setup()
    renderWithProviders(<TodosPage />)
    await user.type(await screen.findByLabelText('记一条待办'), '把昨天的退款单核对一下')
    await user.click(screen.getByRole('button', { name: '记一条待办' }))

    const card = await screen.findByTestId('collision-card')
    expect(card.textContent).toContain('李默')
    expect(card.textContent).toContain('核对昨天的退款单')
    expect(card.textContent).toContain('2 张卡等他定')
  })

  it('「加入协作」带上 collision=join 与撞的那一条', async () => {
    createTodo.mockRejectedValueOnce(collisionError())
    const user = userEvent.setup()
    renderWithProviders(<TodosPage />)
    await user.type(await screen.findByLabelText('记一条待办'), '把昨天的退款单核对一下')
    await user.click(screen.getByRole('button', { name: '记一条待办' }))
    await screen.findByTestId('collision-card')

    createTodo.mockResolvedValueOnce({ todo: {} })
    await user.click(screen.getByRole('button', { name: '加入协作' }))
    await waitFor(() => {
      expect(createTodo).toHaveBeenLastCalledWith({
        title: '把昨天的退款单核对一下',
        collision: 'join',
        collision_target: 'td_a',
      })
    })
  })

  it('「仍新建」要先写一句区别，不写按钮是灰的', async () => {
    createTodo.mockRejectedValueOnce(collisionError())
    const user = userEvent.setup()
    renderWithProviders(<TodosPage />)
    await user.type(await screen.findByLabelText('记一条待办'), '把昨天的退款单核对一下')
    await user.click(screen.getByRole('button', { name: '记一条待办' }))
    await screen.findByTestId('collision-card')

    const force = screen.getByTestId('collision-force')
    expect(force.hasAttribute('disabled')).toBe(true)
    createTodo.mockResolvedValueOnce({ todo: {} })
    await user.type(screen.getByTestId('collision-reason'), '另一家店的同号订单')
    expect(force.hasAttribute('disabled')).toBe(false)
    await user.click(force)
    await waitFor(() => {
      expect(createTodo).toHaveBeenLastCalledWith({
        title: '把昨天的退款单核对一下',
        collision: 'force',
        collision_target: 'td_a',
        distinct_reason: '另一家店的同号订单',
      })
    })
  })
})

describe('待认领池（40 §3.2）', () => {
  it('点「我来」就是认领', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ClaimPool />)
    await screen.findByTestId('claim-pool')
    await user.click(screen.getByTestId('claim-take'))
    await waitFor(() => {
      expect(claimTodo).toHaveBeenCalledWith('td_pool')
    })
  })

  it('别人先认了：给一句人话，不是错误码', async () => {
    claimTodo.mockRejectedValueOnce(
      new ApiClientError(409, {
        code: 'conflict',
        message: '这条已经有人在做了',
        details: { reason: 'already_claimed', owner: '李默' },
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ClaimPool />)
    await screen.findByTestId('claim-pool')
    await user.click(screen.getByTestId('claim-take'))
    const err = await screen.findByTestId('claim-error')
    expect(err.textContent).toContain('李默')
    expect(err.textContent).not.toContain('conflict')
  })
})

describe('公司页「进行中」看板（40 §3.3）', () => {
  it('按主人分列，手上件数多的排前面', () => {
    const groups = groupByOwner([
      { ...IN_PROGRESS[0], id: 'a', owner: 'p_li', owner_label: '李默' },
      { ...IN_PROGRESS[0], id: 'b', owner: 'p_chen', owner_label: '陈晓' },
      { ...IN_PROGRESS[0], id: 'c', owner: 'p_chen', owner_label: '陈晓' },
    ] as InProgressItem[])
    expect(groups.map((g) => g.owner)).toEqual(['p_chen', 'p_li'])
    expect(groups[0]?.items).toHaveLength(2)
  })

  it('看板上是主人的名字，不是 person_id 裸串', async () => {
    renderWithProviders(<InprogressTab />)
    const board = await screen.findByTestId('org-inprogress')
    expect(board.textContent).toContain('李默')
    expect(board.textContent).not.toContain('p_li')
    expect(board.textContent).toContain('2 张卡等他定')
  })
})
