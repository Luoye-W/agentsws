/**
 * WP237（Fable 10-06 真机）：「这件事该走哪条职责」——卡上与事项页上的按钮就是候选职责。
 *
 * - 卡：按钮是「走「Reddit 运营」」「走「Reddit 营销」」，不是「认领 / 不是客户问题」；
 *   点哪个就是带着那个选项批（服务端据此钉职责并开跑）。
 * - 事项页：还没定职责时，标题下与路由那一条下面都给这几个选项；点了 = 改派并开跑。
 * - 打平按分取的那一条下面是「换成「Reddit 营销」」。
 */
import type { MatterView } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-06T12:00:00.000Z'

const view = (
  over: Partial<MatterView['matter']> = {},
  route?: MatterView['timeline'][number]['route'],
) => ({
  matter: {
    id: 'mat_r',
    schema_version: 1 as const,
    workspace_id: 'ws_1',
    kind: 'adhoc' as const,
    title: '帮我做一份 Reddit 调研',
    status: 'open' as const,
    entry: 'position' as const,
    position_template_id: 'pos-reddit',
    context: { summary: '', pinned: [], participants: ['per_1'], last_activity: T0 },
    created_at: T0,
    updated_at: T0,
    ...over,
  },
  timeline: [
    {
      id: 'mev_route',
      matter_id: 'mat_r',
      at: T0,
      kind: 'status' as const,
      text: '这件事像「Reddit 运营」也像「Reddit 营销」',
      actor: { kind: 'agent' as const, id: 'position_router' },
      ...(route === undefined ? {} : { route }),
    },
  ],
  has_more: false,
  todos: [],
  open_card_ids: [],
  pinned_labels: [],
  participant_labels: [],
})

let current = view()
const getMatter = vi.fn(async () => current)
const rerouteMatter = vi.fn(async () => ({ matter: { id: 'mat_r' }, assignment_id: 'asg_s' }))
const position = {
  position_id: 'pos-reddit',
  workspace_id: 'ws_1',
  name: { zh: 'Reddit 运营' },
  template_version: '1',
  holders: ['per_1'],
  roles: [
    {
      role_id: 'social.reddit',
      role_name: 'Reddit 运营',
      default: true,
      assignment_ids: ['asg_s'],
      my_assignment_id: 'asg_s',
    },
    {
      role_id: 'pr.reddit',
      role_name: 'Reddit 营销',
      default: false,
      assignment_ids: ['asg_p'],
      my_assignment_id: 'asg_p',
    },
  ],
  open_matters: 1,
  pending_cards: 0,
  memory_summary: '',
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    rerouteMatter: (...a: unknown[]) => rerouteMatter(...(a as [])),
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
    '/matters/mat_r',
  )

beforeEach(() => {
  rerouteMatter.mockClear()
})

describe('WP237 卡上的按钮就是候选职责', () => {
  it('「走 X」两个按钮；点哪个就带着那个选项批', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          id: 'ap_route',
          kind: 'claim',
          layout: 'choice',
          title: '这件事该走哪条职责：帮我做一份 Reddit 调研',
          summary: '看不出这件事像这个岗位下的哪条职责，先问一句',
          content_variants: { zh_summary: '看不出这件事像这个岗位下的哪条职责，先问一句' },
          options: [
            { id: 'social.reddit', label: '走「Reddit 运营」' },
            { id: 'pr.reddit', label: '走「Reddit 营销」' },
          ],
          available_actions: ['approve', 'reject', 'snooze', 'open'],
          action_labels: { approve: '认领', reject: '不是客户问题' },
        })}
        mode="zh_summary"
        onDecide={onDecide}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('deck-band').textContent).toBe('走哪条职责')
    const bar = screen.getByTestId('deck-route-choice')
    expect(bar.textContent).not.toContain('认领')
    expect(bar.textContent).not.toContain('不是客户问题')
    expect(screen.queryByTestId('deck-card-options')).toBeNull()
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(within(bar).getByRole('button', { name: '走「Reddit 营销」' }))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'pr.reddit' }),
    )
  })
})

describe('WP237 事项页上同样给这几个选项', () => {
  it('还没定职责：标题下「走 X」，点了 = 钉到那条并开跑', async () => {
    current = view(
      {},
      {
        options: [
          { role_id: 'social.reddit', role_name: 'Reddit 运营' },
          { role_id: 'pr.reddit', role_name: 'Reddit 营销' },
        ],
      },
    )
    renderMatter()
    const go = await screen.findAllByTestId('matter-route-go')
    expect(go.map((b) => b.textContent)).toEqual(['走「Reddit 运营」', '走「Reddit 营销」'])
    // 路由那一条下面也有
    expect(within(screen.getByTestId('matter-route-options')).getAllByRole('button')).toHaveLength(
      2,
    )
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(go[1] as HTMLElement)
    await waitFor(() => {
      expect(rerouteMatter).toHaveBeenCalledWith('mat_r', 'pr.reddit', { run: true })
    })
  })

  it('打平按分取了「Reddit 运营」：那一条下面是「换成「Reddit 营销」」，点了改派并重跑', async () => {
    current = view(
      { role_id: 'social.reddit', position_id: 'asg_s' },
      { picked: 'social.reddit', options: [{ role_id: 'pr.reddit', role_name: 'Reddit 营销' }] },
    )
    renderMatter()
    const box = await screen.findByTestId('matter-route-options')
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 })
    await user.click(within(box).getByRole('button', { name: '换成「Reddit 营销」' }))
    await waitFor(() => {
      expect(rerouteMatter).toHaveBeenCalledWith('mat_r', 'pr.reddit', { run: true })
    })
  })

  it('已经换成那条了：不再出「换成」它', async () => {
    current = view(
      { role_id: 'pr.reddit', position_id: 'asg_p' },
      { picked: 'social.reddit', options: [{ role_id: 'pr.reddit', role_name: 'Reddit 营销' }] },
    )
    renderMatter()
    await screen.findByTestId('matter')
    expect(screen.queryByTestId('matter-route-options')).toBeNull()
  })
})
