/**
 * WP277（docs/95 §3.4–§3.6，决策 239–241）：③ 开公司模式的界面。
 *
 * - 入口：发起人看到「开公司模式…」，别人什么都看不到；③ 里老板看到「回到同事互联…」；
 * - 向导三步：全称（带出主体信息里填过的）→ 谁是老板（默认自己）→ 管理员（带出以前的），发出去的是这三样；
 * - 回到同事互联：说一遍会怎样；离职交接没做完时按钮不能点、写原因；
 * - 同事收的卡：「知道了 / 我要退出」两个按钮、类别「公司模式」、退之前能导出（老板那张只有「知道了」）；
 * - 降回 ② 之后同事首页一行通知（不是卡），点掉就没了；
 * - 上级派活：下属首页一行「X 派给你「…」」。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import type { OrganizationView } from '@/lib/api'
import type { CompanyModeView, SetCompanyModeInput } from '@/lib/api-company'
import type { HandoffLists } from '@/lib/api-peers'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'
import { SOLO_ORG } from './mode-words'

const T0 = '2026-10-08T09:00:00.000Z'
const PEERS_ORG: OrganizationView = {
  ...SOLO_ORG,
  legal_name: '深圳诺伏特科技有限公司',
  members: 3,
  solo: false,
  mode: 'peers',
}

const PEOPLE: CompanyModeView['people'] = [
  { person_id: 'per_wang', name: '王岚', role: 'owner' },
  { person_id: 'per_lin', name: '林峰', role: 'member' },
  { person_id: 'per_he', name: '何佳', role: 'admin' },
]

const state: {
  me: string
  orgs: OrganizationView[]
  setup: CompanyModeView
  lists: HandoffLists
} = {
  me: 'per_wang',
  orgs: [PEERS_ORG],
  setup: {
    mode: 'peers',
    can_open: true,
    can_close: false,
    legal_name: '深圳诺伏特科技有限公司',
    owner_id: 'per_wang',
    people: PEOPLE,
  },
  lists: { to_me: [], from_me: [] },
}
const sent: SetCompanyModeInput[] = []
const exported: unknown[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => ({
      person: { id: state.me, email: `${state.me}@ex.com`, name: state.me },
      workspace: { id: 'ws_1', name: 'NordVolt' },
      assignments: [],
    }),
    getPositions: async () => ({
      positions: [
        {
          position_id: 'asg_owner',
          role_id: 'common.owner',
          role_name: 'owner',
          ranges: [],
          ready: true,
          missing_connectors: [],
          tile_ids: [],
          range: 'yesterday',
          show_tiles: false,
        },
      ],
      instances: [],
      tile_library: [],
      max_tiles: 6,
    }),
    listOrganizations: async () => state.orgs,
  }
})

const seenCalls: string[] = []
vi.mock('@/lib/api-company', async () => ({
  markModeSeen: async (org: string) => {
    seenCalls.push(org)
    return { ok: true }
  },
  getCompanyMode: async () => state.setup,
  setCompanyMode: async (_org: string, input: SetCompanyModeInput) => {
    sent.push(input)
    return state.orgs[0]
  },
}))

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    listHandoffs: async () => state.lists,
    seenHandoff: async () => ({ ok: true }),
    exportMyWork: async () => {
      exported.push(1)
      return {}
    },
  }
})

const { CompanyModeEntry, ModeNotice } = await import('@/components/company/company-mode')
const { HandoffNotices } = await import('@/components/peers/handoff-strip')

beforeEach(() => {
  state.me = 'per_wang'
  state.orgs = [PEERS_ORG]
  state.setup = {
    mode: 'peers',
    can_open: true,
    can_close: false,
    legal_name: '深圳诺伏特科技有限公司',
    owner_id: 'per_wang',
    people: PEOPLE,
  }
  state.lists = { to_me: [], from_me: [] }
  sent.length = 0
  exported.length = 0
  seenCalls.length = 0
})

// 向导里一个字一个字地打，满并发时慢
describe('WP277 开公司模式向导', { timeout: 30_000 }, () => {
  it('发起人：三步——全称带出来、老板默认自己、管理员带出以前的；发出去的就是这三样', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CompanyModeEntry />)
    await user.click(await screen.findByTestId('company-open-entry'))
    const wizard = await screen.findByTestId('company-wizard')
    expect(wizard.textContent).toContain('1 / 3')
    const legal = screen.getByTestId('company-legal-name') as HTMLInputElement
    expect(legal.value).toBe('深圳诺伏特科技有限公司')
    await user.clear(legal)
    expect((screen.getByTestId('company-next') as HTMLButtonElement).disabled).toBe(true)
    await user.type(legal, '深圳诺伏特')
    await user.click(screen.getByTestId('company-next'))

    expect(screen.getByTestId('company-wizard').textContent).toContain('2 / 3')
    const bosses = screen.getAllByTestId('company-boss')
    expect(bosses.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    expect(bosses[0]?.textContent).toBe('王岚（你）')
    await user.click(screen.getByTestId('company-next'))

    expect(screen.getByTestId('company-wizard').textContent).toContain('3 / 3')
    const admins = screen.getAllByTestId('company-admin')
    // 老板不在管理员里；何佳以前是管理员，带出来
    expect(admins.map((a) => a.textContent)).toEqual(['林峰', '何佳'])
    expect(admins[1]?.getAttribute('aria-pressed')).toBe('true')
    await user.click(admins[0] as HTMLElement)
    await user.click(screen.getByTestId('company-open'))
    await waitFor(() => {
      expect(sent).toHaveLength(1)
    })
    expect(sent[0]).toEqual({
      mode: 'company',
      legal_name: '深圳诺伏特',
      boss: 'per_wang',
      admins: ['per_he', 'per_lin'],
    })
  })

  it('选别人当老板：管理员那一步不再列他', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CompanyModeEntry />)
    await user.click(await screen.findByTestId('company-open-entry'))
    await user.click(screen.getByTestId('company-next'))
    await user.click(screen.getAllByTestId('company-boss')[1] as HTMLElement)
    await user.click(screen.getByTestId('company-next'))
    expect(screen.getAllByTestId('company-admin').map((a) => a.textContent)).toEqual([
      '王岚（你）',
      '何佳',
    ])
    await user.click(screen.getByTestId('company-open'))
    await waitFor(() => {
      expect(sent[0]).toMatchObject({ boss: 'per_lin', admins: ['per_he'] })
    })
  })

  it('不是发起人：入口一个字都不出；入口那句问号里不说「主管 / 老板 / 审批」', async () => {
    state.me = 'per_lin'
    state.setup = { ...state.setup, can_open: false }
    const { container } = renderWithProviders(<CompanyModeEntry />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')

    state.me = 'per_wang'
    state.setup = { ...state.setup, can_open: true }
    renderWithProviders(<CompanyModeEntry />)
    const entry = await screen.findByTestId('company-entry')
    const hint = entry.querySelector('[data-hint]')?.getAttribute('data-hint') ?? ''
    expect(hint).not.toMatch(/主管|老板|审批/)
  })
})

describe('WP277 回到同事互联', () => {
  it('③ 里老板：确认框说一遍会怎样，点了发 peers', async () => {
    state.orgs = [{ ...PEERS_ORG, mode: 'company' }]
    state.setup = { ...state.setup, mode: 'company', can_open: false, can_close: true }
    const user = userEvent.setup()
    renderWithProviders(<CompanyModeEntry />)
    await user.click(await screen.findByTestId('company-close-entry'))
    const dialog = await screen.findByTestId('company-close-dialog')
    expect(dialog.textContent).toContain('再开时原样回来')
    expect(dialog.textContent).toContain('退回给本人')
    await user.click(screen.getByTestId('company-close-confirm'))
    await waitFor(() => {
      expect(sent).toEqual([{ mode: 'peers' }])
    })
  })

  it('离职交接没做完：写原因、按钮不能点', async () => {
    state.setup = {
      ...state.setup,
      mode: 'company',
      can_open: false,
      can_close: false,
      close_blocked: '还有 1 张离职交接没做完',
    }
    const user = userEvent.setup()
    renderWithProviders(<CompanyModeEntry />)
    await user.click(await screen.findByTestId('company-close-entry'))
    expect((await screen.findByTestId('company-close-blocked')).textContent).toContain('离职交接')
    expect((screen.getByTestId('company-close-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('③ 里不是老板：入口不出', async () => {
    state.me = 'per_lin'
    state.setup = { ...state.setup, mode: 'company', can_open: false, can_close: false }
    const { container } = renderWithProviders(<CompanyModeEntry />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })
})

function noticeCard(withLeave: boolean): DeckCard {
  const options = withLeave
    ? [
        { id: 'ack', label: '知道了' },
        { id: 'leave', label: '我要退出' },
      ]
    : [{ id: 'ack', label: '知道了' }]
  const base = draftCard()
  return draftCard({
    id: 'ap_notice',
    kind: 'policy_change',
    layout: 'policy',
    title: '王岚把这里改成了公司模式',
    summary: '以后报价超限这类事要主管或老板批。',
    content_variants: { zh_summary: '以后报价超限这类事要主管或老板批。' },
    options,
    detail: {
      ...base.detail,
      payload: { form: 'company_notice', target: 'organization_mode', options },
      proposer: { kind: 'person', id: 'per_wang' },
    },
  })
}

describe('WP277 同事收的卡（决策 239）', () => {
  it('「知道了 / 我要退出」是两个按钮；类别「公司模式」；那一句只说一遍；退之前能导出', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView
        card={noticeCard(true)}
        mode="zh_summary"
        onDecide={onDecide}
        onOpen={() => undefined}
      />,
    )
    const card = screen.getByTestId('deck-card')
    expect(card.textContent).toContain('公司模式')
    expect(card.textContent?.split('以后报价超限这类事').length).toBe(2)
    expect(screen.getByTestId('deck-layout-company-notice')).toBeDefined()
    fireEvent.click(screen.getByText('我要退出'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'leave' }),
    )
    fireEvent.click(screen.getByTestId('company-notice-export'))
    await waitFor(() => {
      expect(exported).toHaveLength(1)
    })
  })

  it('老板那张只有「知道了」，不出导出', () => {
    renderWithProviders(
      <DeckCardView
        card={noticeCard(false)}
        mode="zh_summary"
        onDecide={() => undefined}
        onOpen={() => undefined}
      />,
    )
    expect(screen.queryByText('我要退出')).toBeNull()
    expect(screen.queryByTestId('company-notice-export')).toBeNull()
  })
})

describe('WP277 通知（不是卡）', () => {
  it('降回 ② 之后别的同事首页一行「X 把这里改回了同事互联」，点掉就没了；改的人自己不出', async () => {
    state.me = 'per_lin'
    state.orgs = [
      {
        ...PEERS_ORG,
        mode_changed_at: T0,
        mode_changed_by: 'per_wang',
        mode_changed_by_name: '王岚',
      },
    ]
    const user = userEvent.setup()
    const { unmount } = renderWithProviders(<ModeNotice />)
    const line = await screen.findByTestId('mode-notice')
    expect(line.textContent).toBe('王岚 把这里改回了同事互联')
    await user.click(screen.getByTestId('mode-notice-ok'))
    await waitFor(() => {
      expect(screen.queryByTestId('mode-notice')).toBeNull()
    })
    // 记在组织上（换电脑也不再出），不记在浏览器里
    expect(seenCalls).toEqual(['org_1'])
    unmount()

    // 点掉过的（服务端回 mode_notice_seen）不出
    state.orgs = [{ ...(state.orgs[0] as OrganizationView), mode_notice_seen: true }]
    const again = renderWithProviders(<ModeNotice />)
    await new Promise((r) => setTimeout(r, 20))
    expect(again.container.textContent).toBe('')
    again.unmount()

    state.me = 'per_wang'
    const { container } = renderWithProviders(<ModeNotice />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('上级派活：下属首页一行「何佳 派给你「…」」', async () => {
    state.lists = {
      to_me: [],
      from_me: [],
      dispatched: [
        {
          kind: 'matter',
          id: 'mat_1',
          title: 'Volthaus 的报价跟进',
          handoff: {
            state: 'accepted',
            from: 'per_he',
            to: 'per_lin',
            at: T0,
            expires_at: T0,
            dispatched: true,
            seen: true,
          },
          from_label: '何佳',
          to_label: '林峰',
          status: 'open',
        },
      ],
    }
    renderWithProviders(<HandoffNotices />)
    const notices = await screen.findByTestId('handoff-notices')
    expect(notices.textContent).toBe('何佳 派给你「Volthaus 的报价跟进」')
  })
})
