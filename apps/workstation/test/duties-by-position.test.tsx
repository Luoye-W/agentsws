/**
 * WP70（54 §4）：人员页与 ⌘K 这两处「人在做什么 / 去哪儿」也一律先岗位、后职责。
 *
 * - 人员页：每人先出岗位徽章（"网站运营"），职责折在下面；只挂零散职责、不属于
 *   任何岗位的人（历史数据）归到「未归岗位 · N 条职责」一堆，点开照样看得到；
 * - ⌘K：岗位名排在前，职责名也搜得到，但那一行显示成「岗位 › 职责」。
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  OnboardingPositionView,
  PersonCard,
  PositionInstanceData,
  PositionSummary,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const CATALOG: OnboardingPositionView[] = [
  {
    id: 'web-ops',
    name: '网站运营',
    roles: [
      { id: 'dtc.store', name: '店铺管理', default: true, what_it_does: '' },
      { id: 'dtc.content', name: '内容与博客', default: true, what_it_does: '' },
    ],
  },
  {
    id: 'customer-care',
    name: '客服',
    roles: [{ id: 'dtc.support', name: '独立站售后客服', default: true, what_it_does: '' }],
  },
]

const PEOPLE: PersonCard[] = [
  {
    person_id: 'per_li',
    name: '李默',
    positions: [
      { role_id: 'dtc.store', role_name: '店铺管理' },
      { role_id: 'dtc.content', role_name: '内容与博客' },
    ],
  },
  {
    person_id: 'per_wang',
    name: '王岚',
    // 历史数据：一条零散职责，不属于任何岗位
    positions: [{ role_id: 'ads.meta', role_name: 'Meta 投放' }],
  },
]

const listPeople = vi.fn(async () => PEOPLE)
const listOnboardingPositions = vi.fn(async () => CATALOG)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listPeople: (...a: unknown[]) => listPeople(...(a as [])),
    listOnboardingPositions: (...a: unknown[]) => listOnboardingPositions(...(a as [])),
    listCatalog: async () => [],
  }
})

const { PeoplePage } = await import('@/pages/people')
const { CommandPalette } = await import('@/components/command-palette')

describe('人员页：先岗位、后职责（WP70）', () => {
  it('两条职责归一个岗位：岗位徽章在外，职责收着，点开才看得见', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PeoplePage />)
    const cards = await screen.findAllByTestId('person-card')
    const li = cards[0] as HTMLElement
    // 岗位与职责的对照表是另一条请求，等它回来再看
    expect(await within(li).findByText('网站运营')).toBeDefined()
    expect(within(li).getByTestId('person-card-duties-position').textContent).toContain('网站运营')
    expect(within(li).queryByText('店铺管理')).toBeNull()
    await user.click(within(li).getByTestId('person-card-duties-web-ops-toggle'))
    expect(within(li).getByText('店铺管理')).toBeDefined()
    expect(within(li).getByText('内容与博客')).toBeDefined()
  })

  it('归不进任何岗位的职责：一个「未归岗位 · N 条职责」徽章，那条照样在', async () => {
    renderWithProviders(<PeoplePage />)
    const cards = await screen.findAllByTestId('person-card')
    const wang = cards[1] as HTMLElement
    expect(await within(wang).findByText('未归岗位 · 1 条职责')).toBeDefined()
    expect(within(wang).getByTestId('person-card-duties-position').textContent).toContain(
      '未归岗位 · 1 条职责',
    )
    // 只有一条：不折叠，直接摆出来
    expect(within(wang).getByText('Meta 投放')).toBeDefined()
  })
})

const INSTANCES: PositionInstanceData[] = [
  {
    position_id: 'web-ops',
    workspace_id: 'ws_1',
    name: { zh: '网站运营', en: 'Web Operations' },
    template_version: '1.0.0',
    holders: ['per_li'],
    roles: [
      {
        role_id: 'dtc.store',
        role_name: '店铺管理',
        default: true,
        assignment_ids: ['asg_store'],
        my_assignment_id: 'asg_store',
      },
      {
        role_id: 'dtc.content',
        role_name: '内容与博客',
        default: true,
        assignment_ids: ['asg_content'],
        my_assignment_id: 'asg_content',
      },
    ],
    open_matters: 0,
    pending_cards: 0,
    memory_summary: '',
  },
]

const SUMMARIES: PositionSummary[] = [
  {
    position_id: 'asg_store',
    role_id: 'dtc.store',
    role_name: '店铺管理',
    ranges: [],
    ready: true,
    missing_connectors: [],
    tile_ids: [],
    range: 'yesterday',
    show_tiles: true,
  },
]

describe('⌘K：岗位在前，职责显示成「岗位 › 职责」（WP70）', () => {
  it('岗位一行、职责各一行，职责那行带着它归的岗位', async () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={SUMMARIES}
        instances={INSTANCES}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />,
    )
    const positions = await screen.findAllByTestId('command-position')
    expect(positions).toHaveLength(1)
    expect((positions[0] as HTMLElement).textContent).toBe('网站运营')
    const duties = screen.getAllByTestId('command-duty')
    expect(duties.map((d) => d.textContent)).toEqual([
      '网站运营 › 店铺管理',
      '网站运营 › 内容与博客',
    ])
    // 岗位排在职责前面
    const order = screen.getAllByTestId(/^command-(position|duty)$/)
    expect(order[0]?.getAttribute('data-testid')).toBe('command-position')
  })

  it('没装岗位面的服务进程退回按分配列（老样子）', async () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={SUMMARIES}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />,
    )
    const positions = await screen.findAllByTestId('command-position')
    expect((positions[0] as HTMLElement).textContent).toBe('店铺管理')
    expect(screen.queryAllByTestId('command-duty')).toHaveLength(0)
  })
})
