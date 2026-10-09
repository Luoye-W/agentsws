/**
 * WP287（Luoye 10-09 真机后的口径）：岗位里发一句 → 进会话线程；回答在线程里出现；
 * 问一句是会话（「按 X 做的」那行都不出），能「转成任务」；没跑成说人话 + 重试，不写「跑完了」。
 */
import type { MatterView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-09T02:00:00.000Z'
type Ev = MatterView['timeline'][number]

const ev = (over: Partial<Ev> & Pick<Ev, 'id' | 'kind' | 'text'>): Ev => ({
  matter_id: 'mat_q',
  at: T0,
  actor: { kind: 'agent', id: 'position_router' },
  ...over,
})

const view = (matter: Partial<MatterView['matter']>, timeline: Ev[], live?: unknown) => ({
  matter: {
    id: 'mat_q',
    schema_version: 1 as const,
    workspace_id: 'ws_1',
    kind: 'adhoc' as const,
    title: '现在店铺里有哪些产品',
    status: 'open' as const,
    entry: 'position' as const,
    role_id: 'dtc.store',
    position_id: 'asg_store',
    position_template_id: 'web-ops',
    context: { summary: '', pinned: [], participants: ['per_1'], last_activity: T0 },
    created_at: T0,
    updated_at: T0,
    ...matter,
  },
  timeline,
  has_more: false,
  todos: [],
  open_card_ids: [],
  pinned_labels: [],
  participant_labels: [],
  ...(live === undefined ? {} : { live }),
})

const ROUTE = ev({
  id: 'mev_route',
  kind: 'status',
  text: '看不太出更像哪条，先按「店铺管理」来做的',
  route: { picked: 'dtc.store', options: [{ role_id: 'dtc.content', role_name: '内容与博客' }] },
})
const ASKED = ev({
  id: 'mev_q',
  kind: 'human_message',
  text: '现在店铺里有哪些产品',
  actor: { kind: 'person', id: 'per_1' },
})

let current: ReturnType<typeof view> = view({}, [])
const getMatter = vi.fn(async () => current)
const retryMatterRun = vi.fn(async () => ({ run_id: 'run_2' }))
const promoteAskMatter = vi.fn(async () => ({ matter: { id: 'mat_q', title: 'x' } }))
const position = {
  position_id: 'web-ops',
  workspace_id: 'ws_1',
  name: { zh: '网站运营' },
  template_version: '1',
  holders: ['per_1'],
  roles: [
    {
      role_id: 'dtc.store',
      role_name: '店铺管理',
      default: true,
      assignment_ids: ['asg_store'],
      my_assignment_id: 'asg_store',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    retryMatterRun: (...a: unknown[]) => retryMatterRun(...(a as [])),
    promoteAskMatter: (...a: unknown[]) => promoteAskMatter(...(a as [])),
    getPosition: async () => position,
    getPositionByTemplate: async () => position,
  }
})

const { MatterPage } = await import('@/pages/matter')

const renderMatter = () =>
  renderWithProviders(
    <Routes>
      <Route path="/matters/:id" element={<MatterPage />} />
    </Routes>,
    '/matters/mat_q',
  )

beforeEach(() => {
  retryMatterRun.mockClear()
  promoteAskMatter.mockClear()
})

describe('WP287 会话线程', () => {
  it('问的那一句（会话）：不出「按 X 做的」那行；页头一行「会话 · 转成任务」，点了就转', async () => {
    current = view({ ask: { at: T0 } }, [
      ROUTE,
      ASKED,
      ev({ id: 'mev_a', kind: 'agent_message', text: '店里现在有 12 款在售商品。' }),
    ])
    renderMatter()
    await screen.findByText('店里现在有 12 款在售商品。')
    expect(screen.queryByText('按「店铺管理」做的')).toBeNull()
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(screen.getByTestId('matter-ask-promote'))
    await waitFor(() => {
      expect(promoteAskMatter).toHaveBeenCalledWith('mat_q')
    })
  })

  it('任务：线程里一行小字「按「店铺管理」做的 · 换一条」', async () => {
    current = view({}, [ROUTE, ASKED])
    renderMatter()
    await screen.findByText('按「店铺管理」做的')
    expect(screen.getByTestId('matter-route-switch').textContent).toContain('换一条')
    expect(screen.queryByTestId('matter-ask-bar')).toBeNull()
  })

  it('正在答：AI 边做边说的话流式出现在线程里', async () => {
    current = view({ ask: { at: T0 } }, [ASKED], {
      run_id: 'run_1',
      started_at: T0,
      steps: [{ text: '查商品列表', status: 'running' }],
      text: '我先查一下店里的商品……',
    })
    renderMatter()
    expect((await screen.findByTestId('matter-running-text')).textContent).toBe(
      '我先查一下店里的商品……',
    )
  })

  it('没跑成：一行「没跑成：<人话>」+「重试」，不写「跑完了」，也不再说一遍「这次没跑成」', async () => {
    current = view({}, [
      ROUTE,
      ASKED,
      ev({
        id: 'mev_digest',
        kind: 'status',
        text: '这次没跑成',
        run_id: 'run_1',
        run_digest: { seconds: 1, outcome: 'failed', steps: [] },
      }),
      ev({
        id: 'mev_fail',
        kind: 'status',
        text: '没跑成：工坊这边出错了，已记下，点重试或稍后再试',
        actor: { kind: 'system', id: 'runtime' },
        run_id: 'run_1',
        failed: { code: 'internal', retryable: false },
      }),
    ])
    renderMatter()
    await screen.findByText('没跑成：工坊这边出错了，已记下，点重试或稍后再试')
    expect(screen.queryByText(/跑完了/)).toBeNull()
    expect(screen.queryByText(/这次没跑成/)).toBeNull()
    fireEvent.click(screen.getByTestId('matter-retry'))
    await waitFor(() => {
      expect(retryMatterRun).toHaveBeenCalledWith('mat_q')
    })
  })
})
