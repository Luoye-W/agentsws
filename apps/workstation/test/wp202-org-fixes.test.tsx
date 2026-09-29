/**
 * WP202：WP201 实测发现的三处界面小问题。
 *
 * 1. 「分给同事」点了像没反应：向导以前摆在页顶，按钮在下面时看不见。现在**就地展开**在
 *    被点的那张岗位卡下面；打开时焦点给向导里第一个选项；取消 / 完成后焦点回到那个按钮。
 * 2. 新建岗位 / 加减职责里不再列已拆分的「Meta 社媒运营」（`superseded_by`）；
 *    老岗位本来就含着它的，加减职责时照常列出。
 * 3. `/org?new=kol`（从「连接 → 浏览器插件」那句提示跳来）：打开新建岗位，预填
 *    「红人营销」+ YouTube / Instagram 红人两条。
 * 另外：连接页「浏览器插件」那一节在本机说「没有红人职责」时给一句话 + 去建岗位的入口。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import type { OrgMemberView, OrgPositionView, RoleSummaryView } from '@/lib/api'
import { OrgPage } from '@/pages/org'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-30T09:00:00.000Z'

const role = (id: string, name: string, over: Partial<RoleSummaryView> = {}): RoleSummaryView => ({
  id,
  name,
  name_en: name,
  description: '',
  domain: id.split('.')[0] ?? '',
  version: '1.0.0',
  source: 'bundled',
  editable: false,
  holders: 0,
  home_blocks: [],
  actions: [],
  automation: [],
  connectors: [],
  ...over,
})

const ROLES: RoleSummaryView[] = [
  role('dtc.support', '独立站售后客服'),
  role('social.meta', 'Meta 社媒运营', { superseded_by: ['social.facebook', 'social.instagram'] }),
  role('social.facebook', 'Facebook 主页运营'),
  role('social.instagram', 'Instagram 运营'),
  role('kol.youtube', 'YouTube 红人'),
  role('kol.instagram', 'Instagram 红人'),
  role('kol.tiktok', 'TikTok 红人'),
]

const position = (
  id: string,
  name: string,
  roles: [string, string][],
  holders: OrgPositionView['holders'] = [],
): OrgPositionView => ({
  id,
  name,
  name_en: name,
  version: '1.0.0',
  source: 'custom',
  roles: roles.map(([role_id, n]) => ({ role_id, name: n, default: true, loaded: true })),
  holders,
})

const state = {
  positions: [
    position('support', '售后客服', [['dtc.support', '独立站售后客服']]),
    position('social-old', '社媒（老）', [
      ['social.meta', 'Meta 社媒运营'],
      ['social.facebook', 'Facebook 主页运营'],
    ]),
    position('last', '最后一个岗位', [['dtc.support', '独立站售后客服']]),
  ] as OrgPositionView[],
  kolHeld: false as boolean | undefined,
}

const MEMBERS: OrgMemberView[] = [
  {
    person_id: 'per_li',
    name: '李默',
    email: 'li@nordvolt.example',
    role: 'member',
    joined_at: T0,
    positions: [],
    assignments: [],
  },
]

const created: unknown[] = []
const assigned: unknown[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => ({
      person: { id: 'per_wang', email: 'wang@nordvolt.example', name: '王岚' },
      workspace: { id: 'ws_1', name: 'NordVolt' },
      assignments: [],
    }),
    getPositions: async () => ({
      positions: [
        {
          position_id: 'asg_owner',
          role_id: 'common.owner',
          role_name: '公司设置与授权',
          ranges: [],
          ready: true,
          missing_connectors: [],
          tile_ids: [],
          range: 'yesterday',
          show_tiles: false,
        },
      ],
      tile_library: [],
      max_tiles: 6,
    }),
    listOrgPositions: async () => state.positions,
    listRoleDefinitions: async () => ROLES,
    listMembers: async () => MEMBERS,
    listInvitations: async () => [],
    listRangeOptions: async () => [{ kind: 'store', id: 'store_main', label: 'store_main' }],
    listRangeGroups: async () => [],
    listProductLines: async () => [],
    createOrgPosition: async (input: unknown) => {
      created.push(input)
      return state.positions[0]
    },
    createAssignments: async (input: unknown) => {
      assigned.push(input)
      return []
    },
    listExtensionTokens: async () => ({
      tokens: [],
      ...(state.kolHeld === undefined ? {} : { kol_role_held: state.kolHeld }),
    }),
  }
})

beforeEach(() => {
  created.length = 0
  assigned.length = 0
  state.kolHeld = false
})

const cardOf = async (id: string): Promise<HTMLElement> => {
  const cards = await screen.findAllByTestId('position-card')
  const card = cards.find((c) => c.getAttribute('data-position') === id)
  if (card === undefined) throw new Error(`no card ${id}`)
  return card
}

describe('WP202 ①「分给同事」就地展开', () => {
  it('向导长在被点的那张卡里（不在页顶）；焦点给第一个选项；取消后焦点回到按钮', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const last = await cardOf('last')
    const button = within(last).getByTestId('position-assign')
    await user.click(button)

    const wizard = await screen.findByTestId('assign-wizard')
    // 就在这张卡里，别的卡里没有
    expect(last.contains(wizard)).toBe(true)
    expect(within(await cardOf('support')).queryByTestId('assign-wizard')).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => {
      expect(document.activeElement).toBe(within(wizard).getByRole('button', { name: '李默' }))
    })

    await user.click(within(wizard).getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('assign-wizard')).toBeNull()
    await waitFor(() => {
      expect(document.activeElement).toBe(within(last).getByTestId('position-assign'))
    })
  })

  it('完成后：回执也在同一张卡里，焦点回到按钮；再点同一个按钮 = 收起', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const last = await cardOf('last')
    await user.click(within(last).getByTestId('position-assign'))
    const wizard = await within(last).findByTestId('assign-wizard')
    await user.click(within(wizard).getByRole('button', { name: '李默' }))
    await user.click(within(wizard).getByRole('button', { name: 'store_main' }))
    await user.click(within(wizard).getByTestId('assign-confirm'))
    await waitFor(() => {
      expect(assigned).toHaveLength(1)
    })
    const receipt = await within(last).findByTestId('assign-receipt')
    expect(receipt.textContent).toContain('李默')
    await waitFor(() => {
      expect(document.activeElement).toBe(within(last).getByTestId('position-assign'))
    })

    // 开了再点一次同一个按钮：收起
    await user.click(within(last).getByTestId('position-assign'))
    expect(within(last).getByTestId('assign-wizard')).toBeTruthy()
    await user.click(within(last).getByTestId('position-assign'))
    expect(within(last).queryByTestId('assign-wizard')).toBeNull()
  })
})

describe('WP202 ② 不再列已拆分的「Meta 社媒运营」', () => {
  it('新建岗位：勾选里没有它，接手的 FB / IG 在', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    await screen.findAllByTestId('position-card')
    await user.click(screen.getByTestId('position-new'))
    const names = screen.getAllByTestId('new-position-role').map((b) => b.textContent)
    expect(names).not.toContain('Meta 社媒运营')
    expect(names).toContain('Facebook 主页运营')
    expect(names).toContain('Instagram 运营')
  })

  it('加减职责：没含它的岗位不列；本来就含着它的老岗位照常列出', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />)
    const support = await cardOf('support')
    await user.click(within(support).getByRole('button', { name: '加减职责' }))
    const plain = within(support)
      .getAllByTestId('position-role-toggle')
      .map((b) => b.textContent)
    expect(plain).not.toContain('Meta 社媒运营')

    const old = await cardOf('social-old')
    await user.click(within(old).getByRole('button', { name: '加减职责' }))
    const held = within(old)
      .getAllByTestId('position-role-toggle')
      .map((b) => b.textContent)
    expect(held).toContain('Meta 社媒运营')
  })
})

describe('WP202 ③ /org?new=kol：打开新建岗位并预填红人营销', () => {
  it('名字是「红人营销」，勾好 YouTube / Instagram 红人两条，建出去就是这两条', async () => {
    const user = userEvent.setup()
    renderWithProviders(<OrgPage />, '/org?tab=positions&new=kol')
    const card = await screen.findByTestId('new-position-card')
    expect((within(card).getByLabelText('岗位叫什么') as HTMLInputElement).value).toBe('红人营销')
    const picked = within(card)
      .getAllByTestId('new-position-role')
      .filter((b) => b.className.includes('border-primary'))
      .map((b) => b.textContent)
    expect(picked).toEqual(['YouTube 红人', 'Instagram 红人'])
    await user.click(within(card).getByTestId('new-position-save'))
    await waitFor(() => {
      expect(created).toEqual([
        {
          name: '红人营销',
          roles: [
            { role_id: 'kol.youtube', default: true },
            { role_id: 'kol.instagram', default: true },
          ],
        },
      ])
    })
  })

  it('已经有含红人职责、但没人拿着的岗位：不另建，直接在那张卡下面打开「分给同事」', async () => {
    const before = state.positions
    state.positions = [...before, position('kol', '红人营销', [['kol.youtube', 'YouTube 红人']])]
    try {
      renderWithProviders(<OrgPage />, '/org?new=kol')
      const kol = await cardOf('kol')
      expect(await within(kol).findByTestId('assign-wizard')).toBeTruthy()
      expect(screen.queryByTestId('new-position-card')).toBeNull()
    } finally {
      state.positions = before
    }
  })
})

describe('WP202 连接页「浏览器插件」：还没有红人营销岗位', () => {
  it('本机说没有 → 一句话 + 去建岗位（跳 /org?new=kol）；说有 / 不说 → 不出', async () => {
    const { unmount } = renderWithProviders(<BrowserExtensionSection assignment="asg_owner" />)
    const line = await screen.findByTestId('extension-no-kol-role')
    expect(line.textContent).toContain('你还没有红人营销岗位，收进来的人暂时看不到')
    expect(screen.getByTestId('extension-no-kol-role-go').getAttribute('href')).toBe(
      '/org?tab=positions&new=kol',
    )
    unmount()

    state.kolHeld = true
    const second = renderWithProviders(<BrowserExtensionSection assignment="asg_owner" />)
    await screen.findByTestId('extension-empty')
    expect(screen.queryByTestId('extension-no-kol-role')).toBeNull()
    second.unmount()

    state.kolHeld = undefined
    renderWithProviders(<BrowserExtensionSection assignment="asg_owner" />)
    await screen.findByTestId('extension-empty')
    expect(screen.queryByTestId('extension-no-kol-role')).toBeNull()
  })
})
