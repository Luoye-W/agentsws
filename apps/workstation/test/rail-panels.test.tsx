/**
 * WP71（36 §9 / §10）**第三栏**：骨架 + 四个面板 + 职责页。
 *
 * 钉住的几条：
 *
 * - 图标轨默认收着（44px），点一个图标开一个面板，再点同一个收起——**一次只开一个**；
 * - 面板内容跟着**当前岗位 / 当前职责**走：在职责页开的是那条职责那一份，
 *   在别处开的是当前岗位那一份（`railContextOf`）；
 * - 记忆面板：`can_edit` 为假时**一个改 / 删 / 加的按钮都不出**（判据在服务端）；
 *   为真时手动加一条走的是 `POST /v1/memory`；
 * - 额度面板：改一个数 → 走 `PUT /v1/roles/:id`（org 页职责编辑那条路），
 *   界面显示"已提交审批"——**不是直接改**（14 §1）；
 * - 内置模板只读：出的是"复制一份再改"，不是一个按下去会 403 的输入框（05 §0）。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerMemoryData, PositionInstanceData, RoleDetailView } from '@/lib/api'
import { openSettingsTab, renderWithProviders } from './helpers'

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
    {
      role_id: 'dtc.content',
      role_name: '内容与博客',
      default: true,
      assignment_ids: ['asg_content'],
      my_assignment_id: 'asg_content',
    },
  ],
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '岗位层：2 段',
}

const MEMORY: LayerMemoryData = {
  tier: 'role',
  scope_id: 'dtc.store',
  summary: '职责层：1 段（其中 0 段是学来的）',
  can_edit: true,
  entries: [
    {
      id: 'm:role:dtc.store:customer-care:sec_1',
      skill: 'customer-care',
      section_id: 'sec_1',
      heading: '改价',
      body: '改价先看竞品同款价。',
      origin: 'authored',
      source: 'manual',
      added_by: 'per_li',
      added_at: '2026-09-16T01:00:00.000Z',
    },
  ],
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
      window: { max_count: 5, per: 'day' },
    },
  ],
  automation: [{ action_id: 'price_change', ceiling: 'L2', initial: 'L1', hard_ceiling: false }],
  connectors: [{ kind: 'shopify_admin', required: true }],
  scopes: [
    { domain: 'store', ops: ['read', 'stage'], range: 'assigned', max_sensitivity: 'internal' },
  ],
  skills: [{ name: 'customer-care', tier: 'package', load: 'always' }],
}

const getPosition = vi.fn(async () => INSTANCE)
const getLayerMemory = vi.fn(async () => MEMORY)
// 断言要看参数，所以这两个桩带上真实签名（`...(a as [])` 那种写法拿不到参数类型）
const addMemoryEntry = vi.fn(
  async (_input: { tier: string; scope_id?: string; text: string; heading?: string }) =>
    MEMORY.entries[0],
)
const getRoleDefinition = vi.fn(async () => ROLE)
const proposeRoleChange = vi.fn(
  async (
    _id: string,
    _patch: {
      name?: string
      description?: string
      actions?: { id: string; caps?: Record<string, number>; window_max_count?: number }[]
    },
  ) => ({
    status: 'pending_approval' as const,
    approval_item_id: 'apr_1',
    summary: '改「店铺管理」的额度',
  }),
)
const copyRoleDefinition = vi.fn(async () => ({ ...ROLE, id: 'dtc.store.copy', source: 'custom' }))
const getSkills = vi.fn(async () => [])
const listKnowledgeCards = vi.fn(async () => [])
/** WP288：「记录」面板——每条分配各取一次；岗位层再加上不出卡的复盘。 */
const getPositionRecords = vi.fn(async (assignment: string) => ({
  status: 'ok',
  payload: {
    rows:
      assignment === 'asg_store'
        ? [
            {
              id: 'r_1',
              at: '2026-10-08T03:00:00.000Z',
              kind: 'price_change',
              title: '改价：MagSafe 车载支架',
              summary: '批了',
              state: 'approved',
            },
          ]
        : [
            {
              id: 'r_2',
              at: '2026-10-07T03:00:00.000Z',
              kind: 'staged_change',
              title: '博客：新品上架',
              summary: '发了',
              state: 'approved',
            },
          ],
  },
}))
const listReviews = vi.fn(async () => ({
  reviews: [
    {
      id: 'rv_1',
      created_at: '2026-10-08T12:00:00.000Z',
      cards: { you_handled: 2, ai_handled: 5 },
      todos: { done: 1, total: 3 },
      meetings: { count: 0 },
    },
  ],
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPosition: (...a: unknown[]) => getPosition(...(a as [])),
    getLayerMemory: (...a: unknown[]) => getLayerMemory(...(a as [])),
    addMemoryEntry: (...a: Parameters<typeof addMemoryEntry>) => addMemoryEntry(...a),
    getRoleDefinition: (...a: unknown[]) => getRoleDefinition(...(a as [])),
    proposeRoleChange: (...a: Parameters<typeof proposeRoleChange>) => proposeRoleChange(...a),
    copyRoleDefinition: (...a: unknown[]) => copyRoleDefinition(...(a as [])),
    getSkills: (...a: unknown[]) => getSkills(...(a as [])),
    listKnowledgeCards: (...a: unknown[]) => listKnowledgeCards(...(a as [])),
    getPositionRecords: (a: string) => getPositionRecords(a),
    listReviews: () => listReviews(),
  }
})

const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')
const { railContextOf } = await import('@/components/rail/rail-scope')

/**
 * 第三栏的开合态住在 `RailStateProvider` 里（职责页头部那四个按钮也要用它），
 * 所以单测里也得把它套上——真应用里这一层由 `AppShell` 提供。
 */
function renderRail(route = '/', position = 'asg_store'): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
    </RailStateProvider>,
    route,
    position,
  )
}

beforeEach(() => {
  for (const m of [
    getPosition,
    getLayerMemory,
    addMemoryEntry,
    getRoleDefinition,
    proposeRoleChange,
    copyRoleDefinition,
    getSkills,
    listKnowledgeCards,
  ]) {
    m.mockClear()
  }
  getLayerMemory.mockResolvedValue(MEMORY)
  getRoleDefinition.mockResolvedValue(ROLE)
})

describe('第三栏骨架（36 §9）', () => {
  it('默认收着：只有图标轨，没有面板', () => {
    renderRail()
    expect(screen.getByTestId('right-rail')).toBeDefined()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })

  it('一次只开一个：点「设定」开设定，点定时任务就换成定时任务，再点同一个收起', async () => {
    renderRail()
    fireEvent.click(screen.getByTestId('rail-icon-settings'))
    expect(await screen.findByTestId('rail-panel-settings')).toBeDefined()

    fireEvent.click(screen.getByTestId('rail-icon-schedules'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-settings')).toBeNull()
    })
    expect(screen.getByTestId('rail-panel-schedules')).toBeDefined()

    fireEvent.click(screen.getByTestId('rail-icon-schedules'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
  })

  it('WP208：五个「这一层的设置」合成一个图标，旧的五个图标都不在了', () => {
    renderRail()
    expect(screen.getByTestId('rail-icon-settings').getAttribute('title')).toBe(
      '设定 · 这个岗位 / 职责的角色、记忆、知识、技能与额度',
    )
    for (const id of [
      'role',
      'memory',
      'knowledge',
      'skills',
      'caps',
      'design-md',
      'mail-assistant',
    ])
      expect(screen.queryByTestId(`rail-icon-${id}`)).toBeNull()
  })

  it('WP208：「设定」顶上五个标签，默认第一个（角色）；切一个标签换一份正文', async () => {
    renderRail()
    fireEvent.click(screen.getByTestId('rail-icon-settings'))
    const panel = await screen.findByTestId('settings-panel')
    expect(panel.getAttribute('data-tab')).toBe('role')
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((b) => b.textContent),
    ).toEqual(['角色', '记忆', '知识', '技能', '额度'])
    fireEvent.click(screen.getByTestId('settings-tab-skills'))
    await waitFor(() => {
      expect(screen.getByTestId('settings-panel').getAttribute('data-tab')).toBe('skills')
    })
    expect(screen.getByTestId('settings-tab-skills').getAttribute('aria-selected')).toBe('true')
  })

  it('WP140：还没做的那几个内测期间不上图标轨（开关放出来的那一路见 rail-registry）', () => {
    renderRail()
    for (const id of ['data', 'runs', 'files'])
      expect(screen.queryByTestId(`rail-icon-${id}`)).toBeNull()
  })
})

describe('面板跟着当前岗位 / 当前职责走（36 §9）', () => {
  it('职责页 → 职责层；别处 → 岗位层', () => {
    const duty = railContextOf('/positions/asg_store/duties/dtc.store', [INSTANCE], null, 'zh')
    expect(duty.preferred).toBe('role')
    expect(duty.role?.scope_id).toBe('dtc.store')
    expect(duty.role?.name).toBe('店铺管理')
    // 职责层知道自己挂在哪个岗位下（记忆面板的"上面继承的"要它）
    expect(duty.role?.parent?.scope_id).toBe('web-ops')

    const home = railContextOf('/', [INSTANCE], 'asg_content', 'zh')
    expect(home.preferred).toBe('position')
    expect(home.position?.scope_id).toBe('web-ops')
    expect(home.position?.name).toBe('网站运营')
    // 当前分配那一条职责也算得出来（面板头上可以手切）
    expect(home.role?.scope_id).toBe('dtc.content')
  })

  it('没装岗位面 / 还没进过任何岗位：两层都算不出来，面板照实说', () => {
    expect(railContextOf('/', undefined, null, 'zh').position).toBeUndefined()
    expect(railContextOf('/', [INSTANCE], 'asg_nope', 'zh').position).toBeUndefined()
  })

  it('英文界面用英文岗位名', () => {
    expect(railContextOf('/', [INSTANCE], 'asg_store', 'en').position?.name).toBe('Web Operations')
  })

  it('面板头写着看的是哪一层、哪一个', async () => {
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openSettingsTab('memory')
    const title = await screen.findByTestId('rail-panel-title')
    expect(title.textContent).toBe('设定 · 店铺管理')
  })
})

describe('记忆面板（36 §10）', () => {
  it('能改的时候：手动加一条走 POST /v1/memory', async () => {
    renderRail()
    await openSettingsTab('memory')
    fireEvent.click(await screen.findByTestId('memory-add'))
    fireEvent.change(screen.getByTestId('memory-add-text'), {
      target: { value: '上架新品先留草稿。' },
    })
    fireEvent.click(screen.getByTestId('memory-add-save'))
    await waitFor(() => {
      expect(addMemoryEntry).toHaveBeenCalledTimes(1)
    })
    expect(addMemoryEntry.mock.calls[0]?.[0]).toMatchObject({
      tier: 'position',
      scope_id: 'web-ops',
      text: '上架新品先留草稿。',
    })
  })

  it('改不动的时候：改 / 删 / 加一个按钮都不出（判据在服务端）', async () => {
    getLayerMemory.mockResolvedValue({ ...MEMORY, can_edit: false })
    renderRail()
    await openSettingsTab('memory')
    expect(await screen.findByTestId('memory-readonly')).toBeDefined()
    expect(screen.queryByTestId('memory-add')).toBeNull()
    expect(screen.queryByTestId('memory-edit')).toBeNull()
    expect(screen.queryByTestId('memory-delete')).toBeNull()
  })

  it('每条写着来源；右边那张"六层怎么叠"把本层高亮', async () => {
    renderRail()
    await openSettingsTab('memory')
    expect((await screen.findByTestId('memory-origin')).textContent).toBe('手动加')
    const card = screen.getByTestId('memory-tier-card')
    expect(within(card).getByTestId('memory-tier-position').getAttribute('aria-current')).toBe(
      'true',
    )
    expect(within(card).getByTestId('memory-tier-role').getAttribute('aria-current')).toBeNull()
  })
})

describe('额度面板：改额度走审批，不是直接改（14 §1 / 05 §0）', () => {
  it('职责层改一个数 → PUT /v1/roles/:id → "已提交审批"', async () => {
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openSettingsTab('caps')
    const input = await screen.findByTestId('caps-input')
    // 没改之前提交按钮是灰的——不让人提一张什么都没改的卡
    expect(screen.getByTestId('caps-submit').hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('caps-submit'))
    await waitFor(() => {
      expect(proposeRoleChange).toHaveBeenCalledTimes(1)
    })
    expect(proposeRoleChange.mock.calls[0]?.[0]).toBe('dtc.store')
    expect(proposeRoleChange.mock.calls[0]?.[1]).toEqual({
      actions: [{ id: 'price_change', caps: { max_pct: 15 } }],
    })
    expect((await screen.findByTestId('caps-submitted')).textContent).toBe('已提交审批')
  })

  it('内置模板只读：出的是"复制一份再改"，没有输入框', async () => {
    getRoleDefinition.mockResolvedValue({ ...ROLE, source: 'bundled', editable: false })
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openSettingsTab('caps')
    expect(await screen.findByTestId('caps-readonly')).toBeDefined()
    expect(screen.getByTestId('caps-copy')).toBeDefined()
    expect(screen.queryByTestId('caps-input')).toBeNull()
    expect(screen.queryByTestId('caps-submit')).toBeNull()
  })

  it('岗位层没有自己的额度：列的是这个岗位下的职责，点一条去改', async () => {
    renderRail()
    await openSettingsTab('caps')
    expect(await screen.findByTestId('caps-position-hint')).toBeDefined()
    const links = screen.getAllByTestId('caps-duty-link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/positions/asg_store/duties/dtc.store',
      '/positions/asg_content/duties/dtc.content',
    ])
  })
})

describe('知识面板（19）', () => {
  it('列这条职责的适用范围与在用的事实卡数，不做编辑器', async () => {
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openSettingsTab('knowledge')
    expect(await screen.findByTestId('rail-knowledge-role')).toBeDefined()
    expect(screen.getByTestId('rail-knowledge-scope').textContent).toContain('store')
    expect(screen.getByTestId('rail-knowledge-cards').textContent).toContain('0')
    expect(screen.getByTestId('rail-knowledge-more').getAttribute('href')).toBe('/knowledge')
  })
})

describe('WP288：「记录」在第三栏（岗位页 / 职责页不再有「记录」页签）', () => {
  it('岗位上：本人在这个岗位每条职责的记录合在一起，加上不出卡的复盘', async () => {
    renderRail('/positions/asg_store')
    fireEvent.click(screen.getByTestId('rail-icon-records'))
    const list = await screen.findByTestId('records')
    const text = list.textContent ?? ''
    expect(text).toContain('改价：MagSafe 车载支架')
    expect(text).toContain('博客：新品上架')
    expect(text).toContain('复盘：你处理 2 张，AI 5 张')
    expect(getPositionRecords).toHaveBeenCalledWith('asg_store')
    expect(getPositionRecords).toHaveBeenCalledWith('asg_content')
  })

  it('职责页上：只看那一条职责的记录（复盘按人，不在职责层列）', async () => {
    getPositionRecords.mockClear()
    listReviews.mockClear()
    renderRail('/positions/asg_store/duties/dtc.store')
    fireEvent.click(screen.getByTestId('rail-icon-records'))
    const list = await screen.findByTestId('records')
    expect(list.textContent).toContain('改价：MagSafe 车载支架')
    expect(list.textContent).not.toContain('博客：新品上架')
    expect(list.textContent).not.toContain('复盘')
    expect(getPositionRecords).toHaveBeenCalledTimes(1)
    expect(listReviews).not.toHaveBeenCalled()
  })
})
