/**
 * WP276（docs/95 §4 / §6.2，决策 237–243 / 256）：② 同事互联的界面。
 *
 * - 团队页（平级同事、不是发起人也进得去）：同事 / 品牌 / 岗位 / 进行中 / 工具箱；没有负责人卡、成员、
 *   范围、加入一家公司、并进来；不出「请人离开、删岗位、分岗位」这些家务；整页扫一遍不许出现
 *   「主管 / 老板 / 上级 / 审批 / 部门 / 范围 / 并进来 / 加入一家公司 / 成员额度」；
 * - 「同事」tab：发起人一个小字、谁同意的写名字、邀请链接、退出（发起人没有退出按钮）；
 * - ① 岗位与品牌「和同事一起用」：点了才打开局域网发现，出邀请那一块；
 * - 交给你的卡：按钮是自己的岗位 +「不接」（理由可选）；
 * - 交给同事对话框、事项页那一行、首页通知。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import type {
  InviteView,
  MembershipRequestView,
  OrganizationView,
  OrgMemberView,
  OrgPositionView,
  RoleSummaryView,
} from '@/lib/api'
import type { HandoffLists, HandoffView } from '@/lib/api-peers'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'
import { SOLO_ORG } from './mode-words'

/** ② 里不许出现的「公司」词（决策 256：第二个人进来时界面不能像公司）。 */
const PEER_BANNED = [
  '主管',
  '老板',
  '上级',
  '审批',
  '部门',
  '范围',
  '并进来',
  '加入一家公司',
  '成员额度',
] as const

function bannedIn(root: ParentNode): string[] {
  const attrs = [
    ...root.querySelectorAll('[placeholder],[aria-label],[data-hint],[title]'),
  ].flatMap((el) =>
    ['placeholder', 'aria-label', 'data-hint', 'title']
      .map((a) => el.getAttribute(a))
      .filter((v): v is string => v !== null && v !== ''),
  )
  const text = [root.textContent ?? '', ...attrs].join('\n')
  return PEER_BANNED.filter((w) => text.includes(w)).map(
    (w) => `${w}：…${text.slice(Math.max(0, text.indexOf(w) - 12), text.indexOf(w) + 14)}…`,
  )
}

const T0 = '2026-10-08T09:00:00.000Z'
const PEERS_ORG: OrganizationView = {
  ...SOLO_ORG,
  owner_id: 'per_wang',
  role: 'member',
  members: 2,
  solo: false,
  mode: 'peers',
}

const SUPPORT: RoleSummaryView = {
  id: 'dtc.support',
  name: '独立站售后客服',
  name_en: 'DTC After-sales Support',
  description: '订单状态与物流、退换货、退款、改地址',
  domain: 'dtc',
  version: '1.0.0',
  source: 'bundled',
  editable: false,
  holders: 2,
  home_blocks: [],
  actions: [
    {
      id: 'stage_refund',
      kind: 'staged_change',
      target: 'order',
      route_to: 'scope_manager',
      review_cannot_be_disabled: true,
      caps: [{ key: 'max_auto_refund_amount', value: '50' }],
    },
  ],
  automation: [{ action_id: 'stage_refund', ceiling: 'L2', initial: 'L1', hard_ceiling: false }],
  connectors: [],
}

const POSITIONS: OrgPositionView[] = [
  {
    id: 'customer-care',
    name: '售后客服',
    name_en: 'Customer care',
    version: '1.0.0',
    source: 'bundled',
    roles: [{ role_id: 'dtc.support', name: '独立站售后客服', default: true, loaded: true }],
    holders: [
      { person_id: 'per_wang', name: '王岚', ranges: [{ kind: 'brand', id: 'ws_1' }] },
      { person_id: 'per_li', name: '李默', ranges: [{ kind: 'brand', id: 'ws_1' }] },
    ],
  },
]

const member = (person_id: string, name: string): OrgMemberView => ({
  person_id,
  name,
  email: `${person_id}@ex.com`,
  role: person_id === 'per_wang' ? 'owner' : 'member',
  joined_at: T0,
  positions: [{ id: 'customer-care', name: '售后客服' }],
  assignments: [],
})

const INVITE: InviteView = {
  code: 'ABCD2345',
  expires_at: '2026-10-09T09:00:00.000Z',
  uses_left: 5,
  created_at: T0,
} as InviteView

const REQUEST: MembershipRequestView = {
  id: 'mrq_1',
  person: { name: '陈一', email: 'chen@ex.com' },
  via: 'invite',
  status: 'approved',
  created_at: T0,
  decided_at: T0,
  decided_by: 'per_wang',
}

const state: {
  me: string
  orgs: OrganizationView[]
  positions: { position_id: string; role_id: string }[]
  lists: HandoffLists
} = {
  me: 'per_li',
  orgs: [PEERS_ORG],
  positions: [],
  lists: { to_me: [], from_me: [] },
}
const calls: { fn: string; args: unknown[] }[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => ({
      person: {
        id: state.me,
        email: `${state.me}@ex.com`,
        name: state.me === 'per_li' ? '李默' : '王岚',
      },
      workspace: { id: 'ws_1', name: 'NordVolt' },
      assignments: [],
    }),
    getPositions: async () => ({
      positions: state.positions.map((p) => ({
        ...p,
        role_name: p.role_id,
        ranges: [],
        ready: true,
        missing_connectors: [],
        tile_ids: [],
        range: 'yesterday',
        show_tiles: false,
      })),
      instances: [
        {
          position_id: 'customer-care',
          workspace_id: 'ws_1',
          name: { zh: '售后客服', en: 'Customer care' },
          template_version: '1.0.0',
          holders: ['per_wang', 'per_li'],
          roles: [
            {
              role_id: 'dtc.support',
              role_name: '独立站售后客服',
              default: true,
              assignment_ids: ['asg_li'],
              my_assignment_id: 'asg_li',
            },
          ],
          open_matters: 0,
        },
      ],
      tile_library: [],
      max_tiles: 6,
    }),
    listOrganizations: async () => state.orgs,
    listOrgPositions: async () => POSITIONS,
    listRoleDefinitions: async () => [SUPPORT],
    listMembers: async () => [member('per_wang', '王岚'), member('per_li', '李默')],
    listInvitations: async () => [],
    listInvites: async () => [INVITE],
    listMembershipRequests: async () => [REQUEST],
    listDiscoveryPeers: async () => ({ available: true, enabled: true, peers: [] }),
    getOnboardingState: async () => ({
      needed: false,
      person: { name: '李默', email: 'li@ex.com' },
    }),
  }
})

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  const record =
    (fn: string, out: unknown = {}) =>
    async (...args: unknown[]) => {
      calls.push({ fn, args })
      return out
    }
  return {
    ...actual,
    listColleagues: async () => ({
      colleagues: [
        { person_id: 'per_wang', name: '王岚', in_progress: 2, load: '手上 2 件', initiator: true },
      ],
    }),
    listHandoffs: async () => state.lists,
    offerHandoff: record('offer', { handoff: {} }),
    acceptHandoff: record('accept', { handoff: {} }),
    declineHandoff: record('decline', { handoff: {} }),
    withdrawHandoff: record('withdraw', { handoff: {} }),
    seenHandoff: record('seen', { ok: true }),
    turnOnDiscovery: record('discovery'),
    leaveWorkspace: record('leave', { revoked_assignments: 1, returned: 0 }),
    exportMyWork: record('export', {}),
  }
})

const { OrgPage } = await import('@/pages/org')
const { HandoffDialog } = await import('@/components/peers/handoff-dialog')
const { HandoffNotices, MatterHandoffBar } = await import('@/components/peers/handoff-strip')

beforeEach(() => {
  state.me = 'per_li'
  state.orgs = [PEERS_ORG]
  state.positions = [{ position_id: 'asg_li', role_id: 'dtc.support' }]
  state.lists = { to_me: [], from_me: [] }
  calls.length = 0
})

describe('WP276 ② 团队页（平级同事，不是发起人）', () => {
  it('进得去；tab 只有同事 / 品牌 / 岗位 / 进行中 / 工具箱；没有负责人卡与家务按钮；整页不像公司', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const cards = await screen.findAllByTestId('position-card')
    expect(screen.queryByTestId('org-not-owner')).toBeNull()
    expect(screen.getByRole('heading', { name: '团队' })).toBeDefined()
    const tabs = screen.getAllByRole('tab').map((x) => x.textContent)
    expect(tabs).toContain('同事')
    for (const gone of ['成员', '店铺组与产品线', '加入一家公司', '并进来'])
      expect(tabs).not.toContain(gone)
    expect(screen.queryByTestId('owner-card')).toBeNull()
    // 家务：删岗位、分岗位、上级——一个都不出
    const card = cards[0] as HTMLElement
    expect(within(card).queryByTestId('position-delete')).toBeNull()
    expect(within(card).queryByTestId('position-assign')).toBeNull()
    expect(within(card).queryByTestId('position-supervisor')).toBeNull()
    expect(bannedIn(document.body)).toEqual([])

    await user.click(screen.getByRole('tab', { name: '同事' }))
    const tab = await screen.findByTestId('colleagues-tab')
    const rows = within(tab).getAllByTestId('colleague-row')
    expect(rows).toHaveLength(2)
    const wang = rows.find((r) => r.textContent?.includes('王岚')) as HTMLElement
    expect(wang.textContent).toContain('发起人')
    await waitFor(() => {
      expect(wang.textContent).toContain('手上 2 件')
    })
    // 不是发起人：没有「请他离开」，有「退出」
    expect(within(tab).queryByTestId('colleague-remove')).toBeNull()
    expect(within(tab).getByTestId('team-leave')).toBeDefined()
    // 两套邀请合一：码旁边一个「复制邀请链接」；谁同意的写名字
    expect(await within(tab).findByTestId('invite-copy-link')).toBeDefined()
    expect(within(tab).getByTestId('request-row').textContent).toContain('王岚同意的')
    expect(within(tab).getByTestId('team-data').textContent).toContain('要开着同事才能用')
    // 只有发起人搬数据
    expect(within(tab).queryByText('搬到常开的机器')).toBeNull()
    expect(bannedIn(document.body)).toEqual([])
  })

  it('发起人：「请他离开」在别人那一行、自己没有「退出」、能搬数据', async () => {
    state.me = 'per_wang'
    state.positions = [
      { position_id: 'asg_owner', role_id: 'common.owner' },
      { position_id: 'asg_wang', role_id: 'dtc.support' },
    ]
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await screen.findAllByTestId('position-card')
    await user.click(screen.getByRole('tab', { name: '同事' }))
    const tab = await screen.findByTestId('colleagues-tab')
    expect(within(tab).getAllByTestId('colleague-remove')).toHaveLength(1)
    expect(within(tab).queryByTestId('team-leave')).toBeNull()
    expect(within(tab).getByText('搬到常开的机器')).toBeDefined()
    expect(bannedIn(document.body)).toEqual([])
  })
})

describe('WP276 ① 和同事一起用', () => {
  it('点了才打开局域网发现、出邀请那一块；说的是「一起用」不是「加入公司」', async () => {
    state.me = 'per_wang'
    state.orgs = [{ ...SOLO_ORG, owner_id: 'per_wang' }]
    state.positions = [{ position_id: 'asg_owner', role_id: 'common.owner' }]
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const entry = await screen.findByTestId('together-entry')
    expect(screen.queryByTestId('together-panel')).toBeNull()
    expect(calls.filter((c) => c.fn === 'discovery')).toHaveLength(0)
    await user.click(entry)
    const panel = await screen.findByTestId('together-panel')
    expect(calls.filter((c) => c.fn === 'discovery')).toHaveLength(1)
    expect(within(panel).getByTestId('invite-section').textContent).toContain('请同事一起用')
    expect(within(panel).getByTestId('join-toggle').textContent).toBe('同事已经在用？输入邀请码')
    expect(bannedIn(panel)).toEqual([])
  })
})

/** 一张「王岚想把『…』交给你」的卡（服务端出的那种：选项是自己的岗位）。 */
function offerCard(options: { id: string; label: string }[]): DeckCard {
  return draftCard({
    id: 'ap_offer',
    kind: 'claim',
    layout: 'handoff',
    title: '王岚想把「Acme 的报价」交给你',
    summary: '我这周出差',
    content_variants: { zh_summary: '我这周出差' },
    options,
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '接', reject: '不接', snooze: '稍后', open: '打开' },
    detail: {
      ...draftCard().detail,
      payload: {
        form: 'handoff',
        object: 'matter',
        id: 'mat_1',
        note: '我这周出差',
        matter_summary: '报价 V2 已发，等客户回',
        progress: '待办 1/3 做完',
        due: '2026-10-10T10:00:00.000Z',
        expires_at: '2026-10-11T09:00:00.000Z',
        options,
      },
      proposer: { kind: 'person', id: 'per_wang' },
    },
  })
}

describe('WP276 交给你的卡', () => {
  it('只有一个岗位：一个「接下」；按下去带着那条分配', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView
        card={offerCard([{ id: 'asg_li', label: '接下' }])}
        mode="zh_summary"
        onDecide={onDecide}
        onOpen={() => undefined}
      />,
    )
    const body = screen.getByTestId('deck-layout-handoff-offer')
    // 留言出一次，到哪了 / 进度 / 截止 / 几号退回各一行
    expect(screen.getByTestId('deck-card').textContent?.split('我这周出差').length).toBe(2)
    expect(body.textContent).toContain('到哪了：报价 V2 已发')
    expect(body.textContent).toContain('截止 10-10')
    expect(body.textContent).toContain('10-11 前不接就退回')
    fireEvent.click(screen.getByText('接下'))
    expect(onDecide).toHaveBeenCalledWith({
      action: 'approve',
      selected_option_id: 'asg_li',
      version: offerCard([]).version,
    })
    expect(bannedIn(document.body)).toEqual([])
  })

  it('几个岗位：每个一个按钮；「不接」理由可选（点「太忙」或不写直接不接）', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView
        card={offerCard([
          { id: 'asg_li', label: '用「售后客服」接下' },
          { id: 'asg_li_b2b', label: '用「B2B」接下' },
        ])}
        mode="zh_summary"
        onDecide={onDecide}
        onOpen={() => undefined}
      />,
    )
    expect(screen.getByText('用「B2B」接下')).toBeDefined()
    fireEvent.click(screen.getByTestId('handoff-decline'))
    fireEvent.click(screen.getByText('太忙'))
    expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ action: 'reject', reason: '太忙' })
    fireEvent.click(screen.getByTestId('handoff-decline'))
    fireEvent.click(screen.getByTestId('handoff-decline-send'))
    expect(onDecide.mock.calls[1]?.[0]).toEqual({
      action: 'reject',
      version: offerCard([]).version,
    })
  })
})

describe('WP276 交给同事', () => {
  it('对话框：同事带忙闲，选一个、写一句、交出去', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <HandoffDialog
        kind="matter"
        id="mat_1"
        title="Acme 的报价"
        open
        onOpenChange={() => undefined}
      />,
    )
    const person = await screen.findByTestId('handoff-person')
    expect(person.textContent).toContain('手上 2 件')
    expect((screen.getByTestId('handoff-send') as HTMLButtonElement).disabled).toBe(true)
    await user.click(person)
    await user.type(screen.getByTestId('handoff-note'), '我这周出差')
    await user.click(screen.getByTestId('handoff-send'))
    await waitFor(() => {
      expect(calls.find((c) => c.fn === 'offer')?.args).toEqual([
        'matter',
        'mat_1',
        { to: 'per_wang', note: '我这周出差' },
      ])
    })
  })

  const view = (over: Partial<HandoffView>): HandoffView => ({
    kind: 'matter',
    id: 'mat_1',
    title: 'Acme 的报价',
    from_label: '李默',
    to_label: '王岚',
    status: 'open',
    handoff: {
      state: 'offered',
      from: 'per_li',
      to: 'per_wang',
      at: T0,
      expires_at: '2026-10-11T09:00:00.000Z',
    },
    ...over,
  })

  it('事项页：发起人看到「等 王岚 接 · 撤回」；接手人看到「李默 想把这件事交给你 · 接下 / 不接」', async () => {
    state.lists = { to_me: [], from_me: [view({})] }
    const { unmount } = renderWithProviders(<MatterHandoffBar matterId="mat_1" me="per_li" />)
    const waiting = await screen.findByTestId('matter-handoff-waiting')
    expect(waiting.textContent).toContain('等 王岚 接')
    fireEvent.click(screen.getByTestId('matter-handoff-withdraw'))
    await waitFor(() => {
      expect(calls.some((c) => c.fn === 'withdraw')).toBe(true)
    })
    unmount()

    state.lists = { to_me: [view({})], from_me: [] }
    renderWithProviders(<MatterHandoffBar matterId="mat_1" me="per_wang" />)
    const offered = await screen.findByTestId('matter-handoff-offered')
    expect(offered.textContent).toContain('李默 想把这件事交给你')
    fireEvent.click(within(offered).getByTestId('matter-handoff-accept'))
    await waitFor(() => {
      expect(calls.some((c) => c.fn === 'accept')).toBe(true)
    })
  })

  it('首页：接下 / 没接 / 退回各一行，点掉就不再出（不是卡）', async () => {
    state.lists = {
      to_me: [],
      from_me: [
        view({ handoff: { ...view({}).handoff, state: 'accepted' } }),
        view({
          id: 'mat_2',
          title: '寄样',
          handoff: { ...view({}).handoff, state: 'declined', reason: '太忙' },
        }),
      ],
    }
    renderWithProviders(<HandoffNotices />)
    const list = await screen.findByTestId('handoff-notices')
    expect(list.textContent).toContain('王岚 接下了「Acme 的报价」')
    expect(list.textContent).toContain('王岚 没接「寄样」：太忙')
    fireEvent.click(within(list).getAllByRole('button')[0] as HTMLElement)
    await waitFor(() => {
      expect(calls.find((c) => c.fn === 'seen')?.args).toEqual(['matter', 'mat_1'])
    })
  })
})
