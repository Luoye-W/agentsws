/**
 * WP375（决策 1035，Luoye 10-17）：右侧面板照 Claude 桌面版修整。
 *
 * - 卡片标题行：标题 → 紧贴的展开箭头 → 状态点，最右靠右是摘要；不带图标；
 * - 拖动手柄平时看不见，鼠标移到卡上（`group-hover`）才出现在最右，摘要同时让位；
 * - 默认展开「对话」「计划」，记住过的照记住的；
 * - 右上角没有卡片图标，只有工具 +「⋮」；「⋮」开 / 关面板，任何卡有红 / 黄点时上面亮一个汇总点（红压过黄）。
 *   WP412（决策 1035 更正）：开 / 关与汇总点挪到专门的面板开关（`rail-toggle`），「⋮」回到溢出菜单；职责页默认开着。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import type { WorkRail } from '@/lib/work-archive'
import { renderWithProviders } from './helpers'

const h = vi.hoisted(() => ({ connected: true, waiting: false }))

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
    getWorkRail: async () =>
      ({
        idle_days: 3,
        positions: [
          {
            position_id: 'support',
            awaiting: 0,
            duties: [
              {
                role_id: 'dtc.support',
                matters: [
                  {
                    id: 'm_1',
                    title: '退货那封信',
                    state: h.waiting ? 'awaiting' : 'idle',
                    last_activity: new Date().toISOString(),
                    cards: 0,
                  },
                ],
                more: 0,
                archived: 0,
              },
            ],
          },
        ],
      }) as WorkRail,
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
      ready: h.connected,
      missing_required: h.connected ? [] : ['shopify_admin'],
      items: [
        {
          kind: 'shopify_admin',
          name: { zh: 'Shopify 店铺', en: 'Shopify' },
          required: true,
          connected: h.connected,
          needed_by: ['售后'],
          status: 'available',
          connect_service: 'shopify',
        },
      ],
    }),
    getMySchedules: async () => [],
    getPositionRecords: async () => ({ status: 'ok', payload: { rows: [] } }),
  }
})

const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')

function stubStorage(): Map<string, string> {
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
  return box
}

function renderRail(): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
    </RailStateProvider>,
    '/positions/asg_sup/duties/dtc.support',
    'asg_sup',
  )
}

beforeEach(() => {
  h.connected = true
  h.waiting = false
  stubStorage()
})

describe('卡片标题行照 Claude（决策 1035）', () => {
  it('标题 → 紧贴的箭头 → 状态点，最右靠右是摘要；没有图标', async () => {
    h.connected = false
    renderRail()
    const toggle = await screen.findByTestId('rail-card-toggle-connections')
    // 连接那一份取回来，点与摘要才出
    await screen.findByTestId('rail-card-dot-connections')
    const kids = Array.from(toggle.children)
    expect(kids.map((k) => k.getAttribute('data-testid'))).toEqual([
      'rail-card-title',
      'rail-card-chevron-connections',
      'rail-card-dot-connections',
      'rail-card-summary-connections',
    ])
    expect(kids[0]?.textContent).toBe('连接')
    // 箭头紧贴标题：没有把它推到右边的 ml-auto；摘要才靠右
    expect(kids[1]?.getAttribute('class')).not.toContain('ml-auto')
    const summary = kids[3] as HTMLElement
    await waitFor(() => {
      expect(summary.textContent).toBe('1 个要处理')
    })
    expect(summary.className).toContain('ml-auto')
    // 不带图标：标题前面没有别的东西
    expect(toggle.firstElementChild?.getAttribute('data-testid')).toBe('rail-card-title')
  })

  it('收起的箭头朝右（›），展开的朝下（⌄）', async () => {
    renderRail()
    const open = await screen.findByTestId('rail-card-chevron-conversations')
    const closed = screen.getByTestId('rail-card-chevron-settings')
    expect(open.getAttribute('class')).toContain('chevron-down')
    expect(closed.getAttribute('class')).toContain('chevron-right')
  })

  it('拖动手柄平时透明，鼠标移到卡上才出现在最右，摘要同时让位；键盘落上来也看得见', async () => {
    renderRail()
    const handle = await screen.findByTestId('rail-card-handle-plans')
    expect(handle.className).toContain('opacity-0')
    expect(handle.className).toContain('group-hover/card:opacity-100')
    expect(handle.className).toContain('focus-visible:opacity-100')
    expect(handle.className).toContain('right-2')
    expect(screen.getByTestId('rail-card-plans').className).toContain('group/card')
    expect(screen.getByTestId('rail-card-summary-plans').className).toContain(
      'group-hover/card:opacity-0',
    )
  })
})

describe('默认展开「对话」「计划」（决策 1035）', () => {
  it('没记过：对话与计划展开，其余收起；记过的照记住的', async () => {
    const box = stubStorage()
    box.set(
      'agentsws.rightrail.cards',
      JSON.stringify({ 'role:dtc.support': { plans: false, settings: true } }),
    )
    renderRail()
    await screen.findByTestId('rail-cards')
    const open = (id: string) => screen.getByTestId(`rail-card-${id}`).getAttribute('data-open')
    expect(open('conversations')).toBe('true')
    expect(open('plans')).toBe('false')
    expect(open('settings')).toBe('true')
    expect(open('reports')).toBe('false')
  })
})

describe('右上角：没有卡片图标；面板开关开 / 关面板并亮汇总点（决策 1035 → WP412 更正）', () => {
  it('露出的工具 +「⋮」+ 最右的面板开关；职责页默认开着，点开关收起、再点打开', async () => {
    renderRail()
    const bar = screen.getByTestId('right-rail')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-testid')),
      // WP431（照 Claude）：面板开关挪到最左，后面一条细竖线
    ).toEqual(['rail-toggle', 'rail-icon-browser', 'rail-icon-changes', 'rail-overflow'])
    expect(await screen.findByTestId('rail-cards')).toBeTruthy()
    const toggle = screen.getByTestId('rail-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('收起右侧面板')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
    expect(screen.getByTestId('rail-toggle').getAttribute('aria-label')).toBe('打开右侧面板')
    fireEvent.click(screen.getByTestId('rail-toggle'))
    expect(await screen.findByTestId('rail-cards')).toBeTruthy()
  })

  it('没事的时候面板开关上不亮点', async () => {
    renderRail()
    await waitFor(() => {
      expect(screen.getByTestId('rail-toggle')).toBeTruthy()
    })
    expect(screen.queryByTestId('rail-toggle-dot')).toBeNull()
  })

  it('黄 + 红：两个点叠在同一个位置，红的在上', async () => {
    h.waiting = true
    h.connected = false
    renderRail()
    await waitFor(() => {
      expect(screen.getAllByTestId('rail-toggle-dot')).toHaveLength(2)
    })
    const dots = screen.getAllByTestId('rail-toggle-dot')
    const red = dots.find((d) => d.getAttribute('data-dot') === 'alert') as HTMLElement
    const yellow = dots.find((d) => d.getAttribute('data-dot') === 'attention') as HTMLElement
    expect(red.getAttribute('data-card')).toBe('connections')
    expect(yellow.getAttribute('data-card')).toBe('conversations')
    expect(red.className).toContain('z-10')
    expect(yellow.className).not.toContain('z-10')
    expect(red.parentElement).toBe(yellow.parentElement)
    expect(red.closest('[data-testid="rail-toggle"]')).toBeTruthy()
  })
})
