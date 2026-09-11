/**
 * 公司页（WP28 交付 C）。
 *
 * 四组断言：
 * 1. **岗位卡片**：名字、含哪些职责、分给了谁——三样都在卡上；
 * 2. **分配向导**：选成员 → 选岗位 → 选范围 → 确认，发出去的就是那三样；
 * 3. **邀请**：本地档把链接摆出来（token 只出现在这一处，不进别的地方）；
 * 4. **改职责必经审批**：提交之后界面说的是"已提交审批"，不是"已保存"。
 *
 * 另外一条贯穿的：**页面上不出现 role_id / assignment_id 裸串**（36 §3）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrgInvitationView,
  OrgMemberView,
  OrgPositionView,
  ProductLineView,
  RangeGroupView,
  RoleSummaryView,
} from '@/lib/api'
import { OrgPage } from '@/pages/org'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-10T09:00:00.000Z'
const OWNER_ASSIGNMENT = 'asg_owner'

const AFTERSALES: RoleSummaryView = {
  id: 'dtc.aftersales',
  name: '独立站售后客服',
  name_en: 'DTC After-sales Support',
  description: '订单状态与物流、退换货、退款、改地址',
  domain: 'dtc',
  version: '1.0.0',
  source: 'bundled',
  editable: false,
  holders: 1,
  home_blocks: [{ id: 'b1', placement: 'queue', component: 'approval_lane' }],
  actions: [
    {
      id: 'stage_refund',
      kind: 'staged_change',
      target: 'order',
      route_to: 'scope_manager',
      review_cannot_be_disabled: true,
      caps: [{ key: 'max_auto_refund_amount', value: '50' }],
      window: { max_count: 20, per: 'day' },
    },
  ],
  automation: [{ action_id: 'stage_refund', ceiling: 'L2', initial: 'L1', hard_ceiling: false }],
  connectors: [{ kind: 'email', required: true }],
}

const CUSTOM: RoleSummaryView = {
  ...AFTERSALES,
  id: 'dtc.aftersales-custom',
  name: '售后（本公司）',
  source: 'custom',
  editable: true,
  holders: 0,
}

const POSITIONS: OrgPositionView[] = [
  {
    id: 'dtc-support',
    name: '独立站售后客服',
    name_en: 'DTC After-sales Support',
    version: '1.0.0',
    source: 'bundled',
    roles: [{ role_id: 'dtc.aftersales', name: '独立站售后客服', default: true, loaded: true }],
    holders: [
      { person_id: 'per_wang', name: '王岚', ranges: [{ kind: 'store', id: 'store_main' }] },
    ],
  },
  {
    id: 'member',
    name: '普通成员',
    name_en: 'Member',
    version: '1.0.0',
    source: 'bundled',
    roles: [{ role_id: 'common.member', name: '工作区成员', default: true, loaded: true }],
    holders: [],
  },
]

const MEMBERS: OrgMemberView[] = [
  {
    person_id: 'per_wang',
    name: '王岚',
    email: 'wang@nordvolt.example',
    role: 'owner',
    joined_at: T0,
    positions: [{ id: 'dtc-support', name: '独立站售后客服' }],
    assignments: [
      {
        assignment_id: 'asg_1',
        person_id: 'per_wang',
        person_name: '王岚',
        role_id: 'dtc.aftersales',
        role_name: '独立站售后客服',
        role_version: '1.0.0',
        ranges: [{ kind: 'store', id: 'store_main' }],
        granted_at: T0,
        unassigned_range: false,
      },
    ],
  },
  {
    person_id: 'per_li',
    name: '李默',
    email: 'li@nordvolt.example',
    role: 'member',
    joined_at: T0,
    positions: [],
    // 31 §3.1 (c) 空范围：给了职责但没给范围——他能进来，但什么都查不到
    assignments: [
      {
        assignment_id: 'asg_2',
        person_id: 'per_li',
        person_name: '李默',
        role_id: 'dtc.aftersales',
        role_name: '独立站售后客服',
        role_version: '1.0.0',
        ranges: [],
        granted_at: T0,
        unassigned_range: true,
      },
    ],
  },
]

const INVITE: OrgInvitationView = {
  id: 'inv_1',
  email: 'chen@nordvolt.example',
  role: 'member',
  ranges: [],
  created_at: T0,
  expires_at: '2026-09-11T09:00:00.000Z',
  used: false,
  url: '/invite/inv_secret_token',
  delivered: 'link',
}

const state = {
  ownerPositions: [
    {
      position_id: OWNER_ASSIGNMENT,
      role_id: 'common.owner',
      role_name: '工作区所有者',
      ranges: [] as { kind: string; id: string }[],
      ready: true,
      missing_connectors: [] as string[],
      tile_ids: [] as string[],
      range: 'yesterday' as const,
      show_tiles: false,
    },
  ],
  roles: [AFTERSALES, CUSTOM] as RoleSummaryView[],
}

/** 44：两个品牌 + 一条切在别的品牌里的产品线（跨切法提示要用到）。 */
const BRANDS: RangeGroupView[] = [
  {
    id: 'rg_a',
    name: '品牌甲',
    members: [{ kind: 'store', id: 'store_main' }],
    created_at: T0,
    updated_at: T0,
    holders: 1,
  },
  {
    id: 'rg_b',
    name: '品牌乙',
    members: [{ kind: 'store', id: 'store_eu' }],
    created_at: T0,
    updated_at: T0,
    holders: 0,
  },
]

const LINES: ProductLineView[] = [
  {
    id: 'pl_kitchen',
    name: '厨房线',
    parent: { kind: 'store', id: 'store_eu' },
    rule: { platform: 'shopify', tags: ['kitchen'] },
    created_at: T0,
    updated_at: T0,
    holders: 0,
    pushdown: true,
  },
]

const assigned: unknown[] = []
const brandWrites: unknown[] = []
const lineWrites: unknown[] = []
const invited: unknown[] = []
const proposed: unknown[] = []
const revoked: string[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => ({
      person: { id: 'per_wang', email: 'wang@nordvolt.example', name: '王岚' },
      workspace: { id: 'ws_dtc3c', name: 'NordVolt Gear' },
      assignments: [],
    }),
    getPositions: async () => ({
      positions: state.ownerPositions,
      tile_library: [],
      max_tiles: 6,
    }),
    listOrgPositions: async () => POSITIONS,
    listRoleDefinitions: async () => state.roles,
    listMembers: async () => MEMBERS,
    listInvitations: async () => [],
    listRangeOptions: async () => [
      { kind: 'store', id: 'store_main', label: 'store_main' },
      { kind: 'store', id: 'store_eu', label: 'store_eu' },
    ],
    listRangeGroups: async () => BRANDS,
    listProductLines: async () => LINES,
    createRangeGroup: async (input: unknown) => {
      brandWrites.push({ op: 'create', input })
      return BRANDS[0]
    },
    updateRangeGroup: async (id: string, input: unknown) => {
      brandWrites.push({ op: 'update', id, input })
      return BRANDS[0]
    },
    deleteRangeGroup: async (id: string) => {
      brandWrites.push({ op: 'delete', id })
      return { deleted: true }
    },
    createProductLine: async (input: unknown) => {
      lineWrites.push({ op: 'create', input })
      return LINES[0]
    },
    deleteProductLine: async (id: string) => {
      lineWrites.push({ op: 'delete', id })
      return { deleted: true }
    },
    createAssignments: async (input: unknown) => {
      assigned.push(input)
      return []
    },
    inviteMember: async (_ws: string, input: unknown) => {
      invited.push(input)
      return INVITE
    },
    proposeRoleChange: async (id: string, patch: unknown) => {
      proposed.push({ id, patch })
      return { status: 'pending_approval', approval_item_id: 'ap_1', summary: '等你定' }
    },
    copyRoleDefinition: async () => CUSTOM,
    revokeAssignment: async (id: string) => {
      revoked.push(id)
      return MEMBERS[0]?.assignments[0]
    },
    removeMember: async () => ({ revoked_assignments: 1 }),
    createOrgPosition: async () => POSITIONS[0],
    updateOrgPosition: async () => POSITIONS[0],
    deleteOrgPosition: async () => ({ deleted: true }),
  }
})

beforeEach(() => {
  assigned.length = 0
  brandWrites.length = 0
  lineWrites.length = 0
  invited.length = 0
  proposed.length = 0
  revoked.length = 0
  state.ownerPositions = [
    {
      position_id: OWNER_ASSIGNMENT,
      role_id: 'common.owner',
      role_name: '工作区所有者',
      ranges: [],
      ready: true,
      missing_connectors: [],
      tile_ids: [],
      range: 'yesterday',
      show_tiles: false,
    },
  ]
})

describe('公司页：岗位', () => {
  it('一个岗位一张卡：名字、含哪些职责、分给了谁', async () => {
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    expect(cards).toHaveLength(2)
    const support = cards[0] as HTMLElement
    expect(within(support).getAllByText('独立站售后客服').length).toBeGreaterThan(0)
    expect(within(support).getByTestId('position-holders').textContent).toContain('王岚')
    expect(within(support).getByTestId('position-holders').textContent).toContain('store_main')
  })

  it('页面上没有 role_id / assignment_id 裸串', async () => {
    renderWithProviders(<OrgPage />)
    await screen.findAllByTestId('position-card')
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('dtc.aftersales')
    expect(text).not.toContain('asg_')
    expect(text).not.toContain('common.member')
  })
})

describe('公司页：分配向导', () => {
  it('选成员 → 选岗位 → 选范围 → 确认，发出去的就是这三样', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    await user.click(within(cards[0] as HTMLElement).getByTestId('position-assign'))

    const wizard = await screen.findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    await user.click(within(wizard).getByRole('button', { name: 'store_main' }))

    expect(within(wizard).getByTestId('assign-summary').textContent).toContain('李默')
    await user.click(within(wizard).getByTestId('assign-confirm'))

    await waitFor(() => {
      expect(assigned).toHaveLength(1)
    })
    expect(assigned[0]).toEqual({
      person_id: 'per_li',
      position_id: 'dtc-support',
      ranges: [{ kind: 'store', id: 'store_main' }],
      range_groups: [],
    })
  })

  // ── WP47 / 44 G3 三种入口 ────────────────────────────────────────
  it('挑品牌：发出去的是 range_groups，不是摊平的店铺清单', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    await user.click(within(cards[0] as HTMLElement).getByTestId('position-assign'))
    const wizard = await screen.findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    await user.click(within(wizard).getByTestId('assign-entry-brand'))
    await user.click(await within(wizard).findByRole('button', { name: /品牌乙/ }))
    // 确认那一句用的是品牌的名字，不是它展开出来的 id
    expect(within(wizard).getByTestId('assign-summary').textContent).toContain('品牌乙')
    await user.click(within(wizard).getByTestId('assign-confirm'))
    await waitFor(() => {
      expect(assigned).toHaveLength(1)
    })
    expect(assigned[0]).toEqual({
      person_id: 'per_li',
      position_id: 'dtc-support',
      ranges: [],
      range_groups: ['rg_b'],
    })
  })

  it('挑产品线：产品线也是一条范围', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    await user.click(within(cards[0] as HTMLElement).getByTestId('position-assign'))
    const wizard = await screen.findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    await user.click(within(wizard).getByTestId('assign-entry-line'))
    await user.click(await within(wizard).findByRole('button', { name: '厨房线' }))
    await user.click(within(wizard).getByTestId('assign-confirm'))
    await waitFor(() => {
      expect(assigned).toHaveLength(1)
    })
    expect(assigned[0]).toEqual({
      person_id: 'per_li',
      position_id: 'dtc-support',
      ranges: [{ kind: 'product_line', id: 'pl_kitchen' }],
      range_groups: [],
    })
  })

  it('整品牌 + 另一个品牌里的一条产品线 → 提示"建两个岗位"（44 G3）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    await user.click(within(cards[0] as HTMLElement).getByTestId('position-assign'))
    const wizard = await screen.findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    expect(within(wizard).queryByTestId('assign-cross-cut')).toBeNull()

    await user.click(within(wizard).getByTestId('assign-entry-brand'))
    await user.click(await within(wizard).findByRole('button', { name: /品牌甲/ }))
    // 厨房线归品牌乙，挑的却是品牌甲——两种切法
    await user.click(within(wizard).getByTestId('assign-entry-line'))
    await user.click(await within(wizard).findByRole('button', { name: '厨房线' }))
    expect(within(wizard).getByTestId('assign-cross-cut').textContent).toContain('两个岗位')
  })

  it('同一个品牌里再切一条线不提示（那只是看得更细）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    await user.click(within(cards[0] as HTMLElement).getByTestId('position-assign'))
    const wizard = await screen.findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    await user.click(within(wizard).getByTestId('assign-entry-brand'))
    await user.click(await within(wizard).findByRole('button', { name: /品牌乙/ }))
    await user.click(within(wizard).getByTestId('assign-entry-line'))
    await user.click(await within(wizard).findByRole('button', { name: '厨房线' }))
    expect(within(wizard).queryByTestId('assign-cross-cut')).toBeNull()
  })
})

describe('公司页：品牌与产品线（44）', () => {
  const openTab = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
    renderWithProviders(<OrgPage />)
    await screen.findAllByTestId('position-card')
    await user.click(screen.getByRole('tab', { name: '品牌与产品线' }))
    return screen.findByTestId('ranges-tab')
  }

  it('品牌与产品线各一张清单，说得出几个岗位挂着、判据是什么、能不能下推', async () => {
    const user = userEvent.setup()
    const tab = await openTab(user)
    const brands = within(tab).getAllByTestId('brand-card')
    expect(brands).toHaveLength(2)
    expect((brands[0] as HTMLElement).textContent).toContain('品牌甲')
    expect((brands[0] as HTMLElement).textContent).toContain('1 个岗位挂着')
    const line = within(tab).getByTestId('line-card')
    expect(line.textContent).toContain('厨房线')
    expect(line.textContent).toContain('标签 kitchen')
    expect(line.textContent).toContain('上游先切一刀')
  })

  it('建一个品牌：名字 + 勾几个店', async () => {
    const user = userEvent.setup()
    const tab = await openTab(user)
    await user.type(within(tab).getByLabelText('品牌叫什么'), '品牌丙')
    const options = within(tab).getAllByTestId('brand-new-member')
    await user.click(options[1] as HTMLElement)
    await user.click(within(tab).getByTestId('brand-create'))
    await waitFor(() => {
      expect(brandWrites).toHaveLength(1)
    })
    expect(brandWrites[0]).toEqual({
      op: 'create',
      input: { name: '品牌丙', members: [{ kind: 'store', id: 'store_eu' }] },
    })
  })

  it('改品牌成员：发的是整份成员表（组变了岗位范围会跟着变）', async () => {
    const user = userEvent.setup()
    const tab = await openTab(user)
    const card = within(tab).getAllByTestId('brand-card')[1] as HTMLElement
    await user.click(within(card).getByTestId('brand-edit'))
    const options = within(card).getAllByTestId('brand-member-option')
    await user.click(options[0] as HTMLElement)
    await user.click(within(card).getByTestId('brand-save'))
    await waitFor(() => {
      expect(brandWrites).toHaveLength(1)
    })
    expect(brandWrites[0]).toEqual({
      op: 'update',
      id: 'rg_b',
      input: {
        name: '品牌乙',
        members: [
          { kind: 'store', id: 'store_eu' },
          { kind: 'store', id: 'store_main' },
        ],
      },
    })
  })

  it('建一条产品线：切在哪里 + 按什么切', async () => {
    const user = userEvent.setup()
    const tab = await openTab(user)
    await user.type(within(tab).getByLabelText('产品线叫什么'), '户外线')
    await user.click(within(tab).getAllByTestId('line-parent-option')[0] as HTMLElement)
    await user.type(within(tab).getByPlaceholderText('kitchen, home'), 'outdoor, camping')
    await user.click(within(tab).getByTestId('line-create'))
    await waitFor(() => {
      expect(lineWrites).toHaveLength(1)
    })
    expect(lineWrites[0]).toEqual({
      op: 'create',
      input: {
        name: '户外线',
        parent: { kind: 'store', id: 'store_main' },
        rule: { platform: 'shopify', tags: ['outdoor', 'camping'] },
      },
    })
  })

  it('删一条产品线', async () => {
    const user = userEvent.setup()
    const tab = await openTab(user)
    await user.click(within(tab).getByTestId('line-delete'))
    await waitFor(() => {
      expect(lineWrites).toEqual([{ op: 'delete', id: 'pl_kitchen' }])
    })
  })
})

describe('公司页：成员与邀请', () => {
  it('邀请同事 → 本地档把一次性链接摆出来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await user.click(await screen.findByRole('tab', { name: '成员' }))
    await user.type(await screen.findByLabelText('同事的邮箱'), 'chen@nordvolt.example')
    await user.click(screen.getByTestId('invite-submit'))
    const link = await screen.findByTestId('invite-link')
    expect(link.textContent).toBe('/invite/inv_secret_token')
    expect(invited[0]).toEqual({ email: 'chen@nordvolt.example' })
  })

  it('空范围的分配标出「没给范围，现在什么都查不到」（31 §3.1 c / 39 待办 M）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await user.click(await screen.findByRole('tab', { name: '成员' }))
    const rows = await screen.findAllByTestId('member-row')
    // 有范围的那一行不出这句话
    expect(
      within(rows[0] as HTMLElement).getByTestId('member-assignment').textContent,
    ).not.toContain('没给范围')
    // 没范围的那一行：范围位写「还没给范围」，另外挂一条醒目的提示
    const li = within(rows[1] as HTMLElement).getByTestId('member-assignment')
    expect(li.textContent).toContain('还没给范围')
    expect(li.textContent).toContain('没给范围，现在什么都查不到')
  })

  it('每个人名下的岗位与范围都看得见，撤销打的是那条分配', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await user.click(await screen.findByRole('tab', { name: '成员' }))
    const rows = await screen.findAllByTestId('member-row')
    expect(rows).toHaveLength(2)
    const wang = rows[0] as HTMLElement
    expect(within(wang).getByTestId('member-assignment').textContent).toContain('独立站售后客服')
    await user.click(within(wang).getByTestId('assignment-revoke'))
    await waitFor(() => {
      expect(revoked).toEqual(['asg_1'])
    })
  })
})

describe('公司页：职责', () => {
  it('内置模板只给"复制一份"；自定义副本改完显示「已提交审批」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await user.click(await screen.findByRole('tab', { name: '职责' }))

    // 默认选中第一条（内置）：只有复制，没有提交
    expect(await screen.findByTestId('role-copy')).toBeTruthy()
    expect(screen.queryByTestId('role-submit')).toBeNull()

    // 换到自定义那一条：可以改名字与额度，提交之后是"已提交审批"
    const rows = await screen.findAllByTestId('role-row')
    await user.click(rows[1] as HTMLElement)
    const name = await screen.findByLabelText('这个职责在你们公司叫什么')
    await user.clear(name)
    await user.type(name, '售后（我们家的口径）')
    await user.click(screen.getByTestId('role-submit'))

    expect(await screen.findByTestId('role-submitted')).toBeTruthy()
    expect(proposed).toEqual([
      { id: 'dtc.aftersales-custom', patch: { name: '售后（我们家的口径）' } },
    ])
  })

  it('额度是可以改的数字，改完随提交一起走审批', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await user.click(await screen.findByRole('tab', { name: '职责' }))
    const rows = await screen.findAllByTestId('role-row')
    await user.click(rows[1] as HTMLElement)
    const cap = await screen.findByLabelText('max_auto_refund_amount')
    await user.clear(cap)
    await user.type(cap, '30')
    await user.click(screen.getByTestId('role-submit'))
    await waitFor(() => {
      expect(proposed).toHaveLength(1)
    })
    expect(proposed[0]).toEqual({
      id: 'dtc.aftersales-custom',
      patch: { actions: [{ id: 'stage_refund', caps: { max_auto_refund_amount: 30 } }] },
    })
  })
})

describe('不是所有者', () => {
  it('没有所有者岗位时给一句人话，不是一片 403', async () => {
    state.ownerPositions = []
    renderWithProviders(<OrgPage />)
    expect(await screen.findByTestId('org-not-owner')).toBeTruthy()
  })
})
