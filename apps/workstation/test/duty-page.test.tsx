/**
 * WP71（36 §10）**职责页**：`/positions/:assignment/duties/:role_id`。
 *
 * 钉住四条：
 *
 * - 面包屑「岗位 › 职责」，头部有版本与"内置只读 / 从内置模板复制"那个 pill；
 * - **只有两个 tab**（概览 / 记录）——记忆 / 技能 / 知识 / 额度在第三栏，
 *   这一页上只有"把右栏打开到那一格"的四个按钮，不是第二个入口；
 * - 「用这条职责开一件事」走的是**这条职责的分配**（职责入口，跳过岗位内路由）；
 * - 进这一页就把当前分配切到这条职责（31 §3.1 一次请求一个 Assignment）。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData, RoleDetailView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const INSTANCE: PositionInstanceData = {
  position_id: 'web-ops',
  workspace_id: 'ws_1',
  name: { zh: '网站运营', en: 'Web Operations' },
  template_version: '1.1.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.store',
      role_name: '店铺管理',
      default: true,
      assignment_ids: ['asg_store'],
      my_assignment_id: 'asg_store',
    },
  ],
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '',
}

const ROLE: RoleDetailView = {
  id: 'dtc.store',
  name: '店铺管理',
  name_en: 'Store ops',
  description: '管商品、价格、库存',
  domain: 'store',
  version: '2.1.0',
  source: 'custom',
  editable: true,
  holders: 2,
  home_blocks: [],
  actions: [
    {
      id: 'price_change',
      kind: 'price_change',
      target: 'product',
      route_to: 'owner',
      review_cannot_be_disabled: false,
      caps: [{ key: 'max_pct', value: '20' }],
    },
  ],
  automation: [],
  connectors: [{ kind: 'shopify_admin', required: true }],
  scopes: [
    { domain: 'store', ops: ['read', 'stage'], range: 'assigned', max_sensitivity: 'internal' },
  ],
  skills: [{ name: 'customer-care', tier: 'package', load: 'always' }],
}

const getPosition = vi.fn(async () => INSTANCE)
const getRoleDefinition = vi.fn(async () => ROLE)
const getPositionRecords = vi.fn(async () => ({ payload: { rows: [] } }))
// 断言要看参数，所以这几个桩带上真实签名（`...(a as [])` 那种写法拿不到参数类型）
const createMatterWithRole = vi.fn(
  async (_assignment: string, _input: { title: string; summary?: string }) => ({
    matter: { id: 'mat_9' },
  }),
)
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPosition: (...a: unknown[]) => getPosition(...(a as [])),
    getRoleDefinition: (...a: unknown[]) => getRoleDefinition(...(a as [])),
    getPositionRecords: (...a: unknown[]) => getPositionRecords(...(a as [])),
    createMatterWithRole: (...a: Parameters<typeof createMatterWithRole>) =>
      createMatterWithRole(...a),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ assignment: 'asg_store', role_id: 'dtc.store' }),
  }
})

const { DutyPage } = await import('@/pages/duty')

beforeEach(() => {
  for (const m of [getPosition, getRoleDefinition, getPositionRecords, createMatterWithRole]) {
    m.mockClear()
  }
  navigate.mockClear()
  getRoleDefinition.mockResolvedValue(ROLE)
})

describe('职责页（WP71 / 36 §10）', () => {
  it('面包屑「岗位 › 职责」；头部有版本与来源 pill', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    // 名字要等两条查询回来（在那之前先显示 role_id——不留空白，也不假装知道）
    await waitFor(() => {
      expect(screen.getByTestId('duty-name').textContent).toBe('店铺管理')
    })
    expect(screen.getByTestId('duty-breadcrumb').textContent).toBe('网站运营')
    expect(screen.getByTestId('duty-breadcrumb').getAttribute('href')).toBe('/positions/asg_store')
    expect(screen.getByTestId('duty-source').textContent).toBe('从内置模板复制')
    expect(screen.getByTestId('duty-holders').textContent).toContain('2')
  })

  it('只有两个 tab：概览 / 记录（四样设置在第三栏）', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['概览', '记录'])
    // 四个按钮是"把右栏打开到那一格"，不是四个 tab
    const links = screen.getByTestId('duty-rail-links')
    for (const panel of ['memory', 'skills', 'knowledge', 'caps']) {
      expect(links.querySelector(`[data-testid="duty-open-${panel}"]`)).not.toBeNull()
    }
  })

  it('概览列的是能看什么 / 能做什么 / 挂着的技能', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    expect(await screen.findByTestId('duty-scope')).toBeDefined()
    expect(screen.getByTestId('duty-action').textContent).toContain('price_change')
    expect(screen.getByTestId('duty-skill').textContent).toContain('customer-care')
    expect(screen.getByTestId('duty-connectors').textContent).toContain('shopify_admin')
  })

  it('「用这条职责开一件事」走这条职责的分配，然后进事项页', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    fireEvent.change(screen.getByTestId('duty-open-text'), {
      target: { value: '把 GB-12 降价 10%' },
    })
    fireEvent.click(screen.getByTestId('duty-open-submit'))
    await waitFor(() => {
      expect(createMatterWithRole).toHaveBeenCalledTimes(1)
    })
    // 用的是**这条职责**的分配：权限、额度、动作面全是它的（不是岗位的并集）
    expect(createMatterWithRole.mock.calls[0]?.[0]).toBe('asg_store')
    expect(navigate).toHaveBeenCalledWith('/matters/mat_9')
  })

  it('一句话都没写的时候按钮是灰的（不开一件没说要做什么的事）', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    expect(screen.getByTestId('duty-open-submit').hasAttribute('disabled')).toBe(true)
  })
})
