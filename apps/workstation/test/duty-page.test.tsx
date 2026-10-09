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
import { ApiClientError, type PositionInstanceData, type RoleDetailView } from '@/lib/api'
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
  async (_assignment: string, _input: { title: string; summary?: string; run?: boolean }) => ({
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

  it('WP288：没有「概览 / 记录」页签、没有四个「打开右栏」按钮——记录与设定都在第三栏', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByTestId('duty-body')).toBeDefined()
    for (const panel of ['memory', 'skills', 'knowledge', 'caps'])
      expect(screen.queryByTestId(`duty-open-${panel}`)).toBeNull()
    expect(screen.queryByTestId('duty-records')).toBeNull()
  })

  it('WP238：能看什么 / 能做什么 / 技能 / 连接收在默认折叠的「高级」里，翻成人话', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    const toggle = await screen.findByTestId('duty-advanced-toggle')
    // 默认收着：一行权限声明都不在页面上
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('duty-scope')).toBeNull()
    fireEvent.click(toggle)
    const scope = await screen.findByTestId('duty-scope')
    // 认不出的数据域退回原名，ops 翻成人话
    expect(scope.textContent).toContain('看store · 可提议改动')
    // 动作：没有译文的拼「对象」；没写自动化档位 = 要人批
    expect(screen.getByTestId('duty-action').textContent).toContain('商品 · 要人批')
    expect(screen.getByTestId('duty-skill').textContent).toContain('技能：')
    expect(screen.getByTestId('duty-skill').textContent).toContain('（常驻）')
    expect(screen.getByTestId('duty-connector').textContent).toContain('（必需）')
    // 原始声明只在 tooltip（data-raw / data-hint）里
    expect(scope.getAttribute('data-raw')).toBe('store · read / stage · assigned · internal')
    expect(screen.getByTestId('duty-action').getAttribute('data-raw')).toBe(
      'price_change · price_change → product',
    )
  })

  it('WP238：社群职责的权限翻成人话，内部 id 不上屏', async () => {
    getRoleDefinition.mockResolvedValue({
      ...ROLE,
      scopes: [
        {
          domain: 'community_member',
          ops: ['read', 'stage'],
          range: 'assigned',
          max_sensitivity: 'internal',
        },
      ],
      actions: [
        {
          id: 'reply_thread',
          kind: 'outbound_message',
          target: 'community_thread',
          route_to: 'role_holder',
          review_cannot_be_disabled: false,
          caps: [],
        },
      ],
      automation: [
        { action_id: 'reply_thread', ceiling: 'L3', initial: 'L2', hard_ceiling: false },
      ],
      skills: [{ name: 'brand-voice', tier: 'open', load: 'always' }],
      connectors: [{ kind: 'reddit', required: false }],
    })
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    fireEvent.click(await screen.findByTestId('duty-advanced-toggle'))
    const body = await screen.findByTestId('duty-advanced-body')
    expect(screen.getByTestId('duty-scope').textContent).toContain('看社群成员 · 可提议改动')
    expect(screen.getByTestId('duty-action').textContent).toContain('回帖子与私信 · 额度内自己做')
    expect(screen.getByTestId('duty-skill').textContent).toContain('技能：品牌话术（常驻）')
    expect(screen.getByTestId('duty-connector').textContent).toContain('Reddit API（可选）')
    // 可见文字里没有 yml 的 id（sr-only 的 tooltip 副本除外）
    const visible = [...body.querySelectorAll('li')]
      .map((li) => li.firstElementChild?.firstChild?.textContent ?? '')
      .join(' ')
    for (const id of ['community_member', 'outbound_message', 'brand-voice', 'staged_change'])
      expect(visible).not.toContain(id)
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

  it('WP259：一大段也照收——拆成「第一句…」+ 完整原文，开完立刻起首轮运行', async () => {
    const text = `把 GB-12 降价 10%。${'同时把同系列的另外几款也按竞品价对一下，'.repeat(6)}改完给我看。`
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    fireEvent.change(screen.getByTestId('duty-open-text'), { target: { value: text } })
    fireEvent.click(screen.getByTestId('duty-open-submit'))
    await waitFor(() => {
      expect(createMatterWithRole).toHaveBeenCalledWith('asg_store', {
        title: '把 GB-12 降价 10%…',
        summary: text,
        run: true,
      })
    })
  })

  it('WP259：没开成就说一句人话（含服务端那句），字还在', async () => {
    createMatterWithRole.mockRejectedValueOnce(
      new ApiClientError(403, { code: 'forbidden', message: '你名下没有这条职责，开不了' }),
    )
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    fireEvent.change(screen.getByTestId('duty-open-text'), { target: { value: '把 GB-12 降价' } })
    fireEvent.click(screen.getByTestId('duty-open-submit'))
    const alert = await screen.findByTestId('duty-open-error')
    expect(alert.textContent).toBe('没交出去：你名下没有这条职责，开不了')
    expect((screen.getByTestId('duty-open-text') as HTMLInputElement).value).toBe('把 GB-12 降价')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('一句话都没写的时候按钮是灰的（不开一件没说要做什么的事）', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    expect(screen.getByTestId('duty-open-submit').hasAttribute('disabled')).toBe(true)
  })
})
