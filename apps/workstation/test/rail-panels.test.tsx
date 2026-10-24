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
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerMemoryData, PositionInstanceData, RoleDetailView } from '@/lib/api'
import { openRailPanel, openSettingsTab, renderWithProviders } from './helpers'

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
// WP431：卡片堆只在岗位 / 职责 / 事项页上有（首页没有右侧面板，也没有开关），默认就在岗位页上测
function renderRail(route = '/positions/asg_store', position = 'asg_store'): void {
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
  it('首页（WP431）：没有右侧面板，也没有面板开关', () => {
    renderRail('/')
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
    expect(screen.getByTestId('right-rail')).toBeDefined()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })

  it('WP375 / WP412 / WP431 / WP433 / WP456-T3：岗位页面板一直开着卡片堆（默认展开对话、计划）；设定在清单卡里，点那一行 = 第三栏的完整一格，× 收起；没有开关', async () => {
    renderRail()
    expect(await screen.findByTestId('rail-panel-cards')).toBeDefined()
    expect(screen.getByTestId('rail-card-conversations').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('rail-card-plans').getAttribute('data-open')).toBe('true')
    // WP456-T3（决策 1448）：设定合进了清单卡——没有展开 / 收起，点那一行开第三栏
    expect(screen.queryByTestId('rail-card-toggle-settings')).toBeNull()
    fireEvent.click(screen.getByTestId('rail-list-row-settings'))
    expect(await screen.findByTestId('rail-panel-settings')).toBeDefined()
    // WP433：第三栏开在卡片列右边，卡片列还在；× 收起第三栏
    expect(screen.getByTestId('rail-panel-cards')).toBeDefined()
    fireEvent.click(screen.getByTestId('rail-panel-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    })
    expect(screen.queryByTestId('rail-toggle')).toBeNull()
    expect(screen.queryByTestId('rail-tier-switch')).toBeNull()
  })

  it('WP208：五个「这一层的设置」合成「设定」，旧的五个图标都不在了（WP375 起卡片也不占右上角）', () => {
    renderRail()
    expect(screen.queryByTestId('rail-icon-settings')).toBeNull()
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

  it('WP208：「设定」顶上五个标签（WP406 起岗位层多一个「岗位更新」），默认第一个（角色）；切一个标签换一份正文', async () => {
    renderRail()
    await openRailPanel('settings')
    const panel = await screen.findByTestId('settings-panel')
    expect(panel.getAttribute('data-tab')).toBe('role')
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((b) => b.textContent),
    ).toEqual(['角色', '记忆', '知识', '技能', '额度', '岗位更新'])
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

/**
 * WP504（决策 1779 A）：「设定 → 知识」改成跳到**知识库面板**；原来那一格（这一层管得着哪些知识 + 助理记下的几条）
 * 收在知识库 ⋯ 里「这个岗位看得见什么」，叠在库上。
 */
async function openScopeKnowledge(): Promise<void> {
  await openSettingsTab('knowledge')
  expect(await screen.findByTestId('rail-panel-knowledge-library')).toBeDefined()
  await userEvent.click(await screen.findByTestId('library-menu'))
  await userEvent.click(await screen.findByTestId('library-menu-scope'))
}

describe('知识面板（19）', () => {
  it('列这条职责的适用范围与在用的事实卡数，不做编辑器', async () => {
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openScopeKnowledge()
    expect(await screen.findByTestId('rail-knowledge-role')).toBeDefined()
    expect(screen.getByTestId('rail-knowledge-scope').textContent).toContain('store')
    expect(screen.getByTestId('rail-knowledge-cards').textContent).toContain('0')
    expect(screen.getByTestId('rail-knowledge-more').getAttribute('href')).toBe('/knowledge')
    expect(screen.queryByTestId('rail-knowledge-notes')).toBeNull()
    // 叠在库上：头上「← 知识库」
    expect(screen.getByTestId('library-back')).toBeDefined()
  })

  it('WP350 / WP357：助理扇出到这个岗位、还在用的几条列在最上面「助理记下的」，带改 / 删（别的岗位的、退役的不列）', async () => {
    const note = (id: string, position: string, status: string) => ({
      id,
      layer: 'fact',
      subject: { type: 'assistant_note', id: position, key: `fanout:fan_1:${id}` },
      statement: `第 ${id} 条口径`,
      status,
      updated_at: '2026-10-16T00:00:00.000Z',
      provenance: [{ source: 'meeting', ref: 'assistant:fan_1', locator: '10-16 周会' }],
    })
    listKnowledgeCards.mockResolvedValue([
      note('a', 'web-ops', 'active'),
      note('b', 'customer-care', 'active'),
      note('c', 'web-ops', 'retired'),
    ] as never)
    renderRail('/positions/asg_store/duties/dtc.store', 'asg_store')
    await openScopeKnowledge()
    const block = await screen.findByTestId('rail-knowledge-notes')
    expect(block.textContent).toContain('助理记下的 1 条')
    const rows = screen.getAllByTestId('rail-knowledge-note')
    expect(rows.map((li) => li.textContent)).toEqual(['第 a 条口径来自「10-16 周会」'])
    expect(within(rows[0] as HTMLElement).getByTestId('assistant-note-edit')).toBeDefined()
    expect(within(rows[0] as HTMLElement).getByTestId('assistant-note-remove')).toBeDefined()
  })
})

describe('WP288：「记录」在第三栏（岗位页 / 职责页不再有「记录」页签）', () => {
  it('岗位上：本人在这个岗位每条职责的记录合在一起，加上不出卡的复盘', async () => {
    renderRail('/positions/asg_store')
    await openRailPanel('records')
    const list = await screen.findByTestId('records')
    // 复盘那一份另外取，回来得晚一拍（WP372：记录已经被「产出」卡先取过了）
    await waitFor(() => {
      expect(screen.getByTestId('records').textContent).toContain('复盘：你处理 2 张，AI 5 张')
    })
    const text = list.textContent ?? ''
    expect(text).toContain('改价：MagSafe 车载支架')
    expect(text).toContain('博客：新品上架')
    expect(getPositionRecords).toHaveBeenCalledWith('asg_store')
    expect(getPositionRecords).toHaveBeenCalledWith('asg_content')
  })

  it('职责页上：只看那一条职责的记录（复盘按人，不在职责层列）', async () => {
    getPositionRecords.mockClear()
    listReviews.mockClear()
    renderRail('/positions/asg_store/duties/dtc.store')
    await openRailPanel('records')
    const list = await screen.findByTestId('records')
    expect(list.textContent).toContain('改价：MagSafe 车载支架')
    expect(list.textContent).not.toContain('博客：新品上架')
    expect(list.textContent).not.toContain('复盘')
    // 只取了这一条职责的（「产出」卡与完整列表各取一次，测试里缓存不留）
    expect(new Set(getPositionRecords.mock.calls.map((c) => c[0]))).toEqual(new Set(['asg_store']))
    expect(listReviews).not.toHaveBeenCalled()
  })
})
