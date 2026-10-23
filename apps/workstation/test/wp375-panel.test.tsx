/**
 * WP375（决策 1035，Luoye 10-17）：右侧面板照 Claude 桌面版修整。
 *
 * - 卡片标题行：标题 → 紧贴的展开箭头 → 状态点，最右靠右是摘要；不带图标；
 * - 拖动手柄平时看不见，鼠标移到卡上（`group-hover`）才出现在最右，摘要同时让位；
 * - 默认展开「对话」「计划」，记住过的照记住的；
 * - 右上角没有卡片图标，只有工具 +「⋮」；「⋮」开 / 关面板，任何卡有红 / 黄点时上面亮一个汇总点（红压过黄）。
 *   WP412（决策 1035 更正）：开 / 关与汇总点挪到专门的面板开关（`rail-toggle`），「⋮」回到溢出菜单；职责页默认开着。
 */
import { screen, waitFor, within } from '@testing-library/react'
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

describe('卡头（WP456-T3，规范 §2.6 第 14 条；原决策 1035 的标题行）', () => {
  it('卡头 = 标题 13/600 + 灰色计数 + 状态点；最右只有一颗图标钮（对话「+」、计划「›」）；标题后面不再跟箭头', async () => {
    h.waiting = true
    renderRail()
    const toggle = await screen.findByTestId('rail-card-toggle-conversations')
    await screen.findByTestId('rail-card-dot-conversations')
    const kids = Array.from(toggle.children).map((k) => k.getAttribute('data-testid'))
    expect(kids[0]).toBe('rail-card-title')
    expect(kids).toContain('rail-card-count-conversations')
    expect(screen.queryByTestId('rail-card-chevron-conversations')).toBeNull()
    expect(within(toggle).getByTestId('rail-card-title').className).toContain('font-semibold')
    // 对话卡头右边是「+」（新对话），计划卡头右边是「›」（第三栏开完整一格）
    expect(screen.getByTestId('rail-card-action-conversations')).toBeTruthy()
    expect(screen.getByTestId('rail-card-open-plans')).toBeTruthy()
    expect(screen.queryByTestId('rail-card-open-conversations')).toBeNull()
  })

  it('产出 / 连接 / 设定 / 工坊服务合成一张清单卡：每行名字 + 右边一句状态（红点在前）+ ›', async () => {
    h.connected = false
    renderRail()
    const list = await screen.findByTestId('rail-list-card')
    const rows = within(list)
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'))
    expect(rows).toEqual([
      'rail-list-row-outputs',
      'rail-list-row-connections',
      'rail-list-row-settings',
      'rail-list-row-workshop-services',
    ])
    await waitFor(() => {
      expect(screen.getByTestId('rail-card-summary-connections').textContent).toBe('1 个要处理')
    })
    const row = screen.getByTestId('rail-list-row-connections')
    const dot = within(row).getByTestId('rail-card-dot-connections')
    const summary = within(row).getByTestId('rail-card-summary-connections')
    // 红点在数字前面（挨着右边那一句，不挤在标题旁边）
    expect(dot.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.querySelector('.lucide-chevron-right')).not.toBeNull()
    // 清单卡的几行没有展开 / 收起
    expect(screen.queryByTestId('rail-card-toggle-connections')).toBeNull()
  })

  it('拖动手柄平时透明，鼠标移到卡上才出现在最右，那颗图标钮同时让位；键盘落上来也看得见', async () => {
    renderRail()
    const handle = await screen.findByTestId('rail-card-handle-plans')
    expect(handle.className).toContain('opacity-0')
    expect(handle.className).toContain('group-hover/card:opacity-100')
    expect(handle.className).toContain('focus-visible:opacity-100')
    expect(screen.getByTestId('rail-card-plans').className).toContain('group/card')
    expect(screen.getByTestId('rail-card-open-plans').className).toContain(
      'group-hover/card:opacity-0',
    )
  })
})

describe('默认展开「对话」「计划」（决策 1035）', () => {
  it('没记过：对话与计划展开，其余收起；记过的照记住的', async () => {
    const box = stubStorage()
    box.set(
      'agentsws.rightrail.cards',
      JSON.stringify({ 'role:dtc.support': { plans: false, reports: true } }),
    )
    renderRail()
    await screen.findByTestId('rail-cards')
    const open = (id: string) => screen.getByTestId(`rail-card-${id}`).getAttribute('data-open')
    expect(open('conversations')).toBe('true')
    expect(open('plans')).toBe('false')
    expect(open('reports')).toBe('true')
  })
})

describe('右上角：没有卡片图标（决策 1035）；WP433 起也没有面板开关', () => {
  it('露出的工具 +「⋮」；职责页面板一直开着', async () => {
    renderRail()
    const bar = screen.getByTestId('right-rail')
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('data-testid')),
    ).toEqual(['rail-icon-browser', 'rail-icon-changes', 'rail-overflow'])
    expect(await screen.findByTestId('rail-cards')).toBeTruthy()
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
  })

  it('黄 + 红：各亮在自己那张卡的标题行上（顶栏不再汇总）', async () => {
    h.waiting = true
    h.connected = false
    renderRail()
    await waitFor(() => {
      expect(screen.getByTestId('rail-card-dot-connections').getAttribute('data-dot')).toBe('alert')
    })
    expect(screen.getByTestId('rail-card-dot-conversations').getAttribute('data-dot')).toBe(
      'attention',
    )
    expect(screen.queryByTestId('rail-toggle-dot')).toBeNull()
  })
})
