/**
 * WP433（Luoye 10-20 反馈问题 5 / 6 / 7 / 8）：
 *
 * - 问题 6：面板顶上没有「岗位层 / 职责层」切换——岗位页是岗位层，职责页是职责层，事项页照旧岗位层；
 * - 问题 7：卡里「显示更多」只在多于 5 条时出；
 * - 问题 8：「报表」里只放报表——「工作」（进行中 / 卡住了…）挪去「计划」，数据看板先不挂（WP434 接）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MessageSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RailCardBodyProps } from '@/components/rail/registry'
import type { PositionInstanceData } from '@/lib/api'
import type { WorkRail } from '@/lib/work-archive'
import { renderWithProviders } from './helpers'

const INSTANCE: PositionInstanceData = {
  position_id: 'support',
  workspace_id: 'ws_1',
  name: { zh: '客服', en: 'Support' },
  template_version: '1.0.0',
  holders: ['per_li'],
  roles: [
    {
      role_id: 'dtc.support',
      role_name: '售后',
      default: true,
      assignment_ids: ['asg_sup'],
      my_assignment_id: 'asg_sup',
    },
  ],
  open_matters: 1,
  pending_cards: 0,
  memory_summary: '',
}

vi.mock('@/lib/work-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/work-archive')>('@/lib/work-archive')
  return {
    ...actual,
    getWorkRail: async () => ({ idle_days: 3, positions: [] }) as unknown as WorkRail,
  }
})

vi.mock('@/lib/outbound-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbound-api')>('@/lib/outbound-api')
  return { ...actual, listSinks: async () => [] }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [],
      instances: [INSTANCE],
      tile_library: [],
      max_tiles: 6,
    }),
    getPositionCards: async () => ({
      position: {},
      cards: [],
      counts: { total: 0, customer_waiting: 0, nobody_waiting: 0, matched: 0 },
      pinned_p0: [],
      filters: {},
      reports: [],
    }),
    getPositionConnections: async () => ({
      position_id: 'support',
      position_name: '客服',
      ready: true,
      missing_required: [],
      items: [],
    }),
    getMySchedules: async () => [],
    getPositionRecords: async () => ({ status: 'ok', payload: { rows: [] } }),
    getPositionWork: async () => ({
      position_id: 'support',
      generated_at: '2026-10-20T00:00:00.000Z',
      items: [],
      duties: [],
      counts: { doing: 2, queued: 0, waiting: 0, done: 0, stuck: 1, cards: 0, todos_today: 0 },
    }),
  }
})

const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')
const registry = await import('@/components/rail/registry')

function renderRail(route: string): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
    </RailStateProvider>,
    route,
    'asg_sup',
  )
}

beforeEach(() => {
  const box = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      box.set(k, v)
    },
    removeItem: (k: string) => {
      box.delete(k)
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  registry.resetPanelRegistry()
})

describe('问题 6：面板跟着页面走，不能切层', () => {
  it.each([
    ['/positions/asg_sup', 'position'],
    ['/positions/asg_sup/duties/dtc.support', 'role'],
    ['/matters/mat_1', 'position'],
  ])('%s → %s 层；没有「岗位层 / 职责层」切换', async (route, tier) => {
    renderRail(route)
    const panel = await screen.findByTestId('rail-panel-cards')
    expect(panel.getAttribute('data-tier')).toBe(tier)
    expect(screen.queryByTestId('rail-tier-switch')).toBeNull()
    expect(screen.queryByTestId('rail-tier-position')).toBeNull()
    expect(screen.queryByTestId('rail-tier-role')).toBeNull()
  })

  it('职责页「⋮」里第一项照旧叫「职责定义」（跟着页面的层走）', async () => {
    renderRail('/positions/asg_sup/duties/dtc.support')
    fireEvent.click(screen.getByTestId('rail-overflow'))
    expect((await screen.findByTestId('rail-menu-role')).textContent).toBe('职责定义')
  })
})

/** 一张假卡：报几条就是几条（「对话」那个 id，默认展开）。 */
function fakeCard(total: number): void {
  registry.resetPanelRegistry()
  registry.registerRailCard({
    id: 'conversations',
    label: 'rail.card.conversations',
    icon: MessageSquare,
    order: 1,
    panel: 'conversations',
  })
  registry.registerPanelType({
    id: 'conversations',
    label: 'rail.panel.conversations',
    icon: MessageSquare,
    priority: 'builtin',
    group: 'layer',
    card: 'conversations',
  })
  // 先占住「设定」，免得内置那一套又注册回来
  registry.registerPanelType({
    id: 'settings',
    label: 'rail.panel.settings',
    icon: MessageSquare,
    priority: 'builtin',
    group: 'layer',
    hidden: true,
  })
  registry.registerRailCardBody(
    'conversations',
    function Body({ limit, onTotal }: RailCardBodyProps): ReactNode {
      useEffect(() => {
        onTotal?.(total)
      }, [onTotal])
      return (
        <ul>
          {Array.from({ length: Math.min(total, limit) }, (_, i) => `row-${i}`).map((id) => (
            <li key={id} data-testid="fake-row">
              {id}
            </li>
          ))}
        </ul>
      )
    },
  )
}

describe('问题 7：「显示更多」多于 5 条才出', () => {
  it.each([0, 3, 5])('%s 条：不出「显示更多」', async (n) => {
    fakeCard(n)
    renderRail('/positions/asg_sup')
    const card = await screen.findByTestId('rail-card-conversations')
    await waitFor(() => {
      expect(within(card).queryAllByTestId('fake-row')).toHaveLength(n)
    })
    expect(screen.queryByTestId('rail-card-more-conversations')).toBeNull()
  })

  it('6 条：卡上列 5 条，出「显示更多」', async () => {
    fakeCard(6)
    renderRail('/positions/asg_sup')
    expect(await screen.findByTestId('rail-card-more-conversations')).toBeDefined()
    expect(screen.getAllByTestId('fake-row')).toHaveLength(5)
    expect(registry.CARD_LIMIT).toBe(5)
  })
})

describe('问题 8：报表里只放报表', () => {
  it('「计划」卡最上面一行「进度」带进行中 / 卡住了，点了开「计划」那一格，里面是「工作」', async () => {
    renderRail('/positions/asg_sup')
    const row = await screen.findByTestId('plan-row-progress', {}, { timeout: 5000 })
    await waitFor(() => {
      expect(row.textContent).toContain('进行中 2 · 卡住了 1')
    })
    expect(row.getAttribute('data-stuck')).toBe('true')
    fireEvent.click(row)
    expect(await screen.findByTestId('plans-panel')).toBeDefined()
    expect(await screen.findByTestId('work-section', {}, { timeout: 5000 })).toBeDefined()
  })

  it('「报表」那一格：没有「工作」、没有数据看板；没有看数的看板时连「看板」小标题都不出', async () => {
    renderRail('/positions/asg_sup')
    const card = await screen.findByTestId('rail-card-reports')
    fireEvent.click(within(card).getByTestId('rail-card-toggle-reports'))
    // 一份报表都没有：不出「显示更多」；从「⋮」那条路也开不到（报表归卡），这里直接看完整一格的身体
    await waitFor(() => {
      expect(screen.queryByTestId('rail-card-more-reports')).toBeNull()
    })
    const { ReportsPanel } = await import('@/components/reports/reports-panel')
    renderWithProviders(
      <ReportsPanel
        tier="position"
        pathname="/positions/asg_sup"
        scope={{
          tier: 'position',
          scope_id: 'support',
          name: '客服',
          assignment: 'asg_sup',
          roles: [{ role_id: 'dtc.support', assignment: 'asg_sup' }],
        }}
      />,
      '/positions/asg_sup',
      'asg_sup',
    )
    const panel = await screen.findByTestId('reports-panel')
    expect(within(panel).queryByTestId('reports-boards')).toBeNull()
    expect(within(panel).queryByTestId('work-section')).toBeNull()
    expect(within(panel).queryByTestId('data-board')).toBeNull()
  })

  it('两份名单对得上（卡身体 / 报表面板不 import 看板那一大串）', async () => {
    const { dutyMayHaveWorkBoards } = await import('@/components/rail/cards/card-bodies')
    const { dutyMayHaveBoards, scopeMayHaveReportBoards } = await import(
      '@/components/reports/reports-panel'
    )
    const { dutyHasWorkBoards, dutyHasReportBoards } = await import(
      '@/components/reports/scope-boards'
    )
    for (const r of [
      'ads.meta',
      'ads.google',
      'amz.store',
      'b2b.outbound',
      'b2b.sales',
      'dtc.content',
      'dtc.seo',
      'social.reddit',
      'social.facebook_group',
      'dtc.support',
      'dtc.store',
    ]) {
      expect(dutyMayHaveWorkBoards(r), r).toBe(dutyHasWorkBoards(r))
      expect(dutyMayHaveBoards(r), r).toBe(dutyHasReportBoards(r))
    }
    // Reddit 运营：排期与群发是「进度」，不是报表
    expect(dutyHasWorkBoards('social.reddit')).toBe(true)
    expect(dutyHasReportBoards('social.reddit')).toBe(false)
    const scope = (role_id: string) => ({
      tier: 'position' as const,
      scope_id: 'p',
      name: 'p',
      assignment: 'asg_1',
      roles: [{ role_id, assignment: 'asg_1' }],
    })
    expect(scopeMayHaveReportBoards(scope('social.reddit'))).toBe(false)
    expect(scopeMayHaveReportBoards(scope('ads.meta'))).toBe(true)
    expect(scopeMayHaveReportBoards(scope('amz.store'))).toBe(true)
  })
})
