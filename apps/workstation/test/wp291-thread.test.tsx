/**
 * WP291 线程那一侧：当场问答「接着聊」之后，线程里那段回答的 ```answer 组件按契约画（不露 JSON）；
 * 一开始就记成任务的，原话后面头一句「记成了任务，按「X」做」，还能换的跟「换一条」。
 */
import type { MatterView } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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

const ANSWER = [
  '店里现在有 2 件商品。',
  '',
  '```answer',
  '{"components":[{"kind":"table","columns":["商品","价格"],"rows":[["蓝牙耳机",129],["手机壳",29]]}]}',
  '```',
].join('\n')

describe('WP291 线程', () => {
  it('接着聊之后：那段回答画成一句话 + 表格，不露 ```answer', async () => {
    current = view({ ask: { at: T0 } }, [
      ASKED,
      ev({ id: 'mev_a', kind: 'agent_message', text: ANSWER, run_id: 'run_1' }),
    ])
    renderMatter()
    const reply = await screen.findByTestId('matter-reply')
    expect(reply.textContent).toContain('店里现在有 2 件商品。')
    expect(reply.textContent).not.toContain('```')
    expect(reply.textContent).not.toContain('components')
    expect((await screen.findByTestId('answer-table')).textContent).toContain('蓝牙耳机')
  })

  it('一开始就记成任务：原话后面头一句「记成了任务，按「店铺管理」做」，能换的跟「换一条」', async () => {
    current = view({}, [
      ASKED,
      ev({
        id: 'mev_task',
        kind: 'status',
        text: '记成了任务，按「店铺管理」做',
        route: {
          picked: 'dtc.store',
          options: [{ role_id: 'dtc.content', role_name: '内容与博客' }],
          task: true,
        },
      }),
    ])
    renderMatter()
    const row = await screen.findByText('记成了任务，按「店铺管理」做')
    expect(row).toBeDefined()
    expect(screen.getByTestId('matter-route-switch')).toBeDefined()
  })
})
