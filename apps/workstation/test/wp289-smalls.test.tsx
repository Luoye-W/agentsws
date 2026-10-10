/**
 * WP289（决策 293 / 307 / 313 / 318）几件小收尾的界面。
 *
 * - 293：「请他离开」先问一句（同一个框），列出他会一起断开的个人连接，确认了才移出；
 * - 307：没有花钱权限的人看得到余额 / 本月合计 / 充值档，但充值档不是按钮、不出增值服务卡；
 *   看不了用量明细的人不出「钱花在哪」三块与明细表；
 * - 313：素材库筛选多一个「遮罩」签（tag=mask），默认那几个签不带它；
 * - 318：聊天窗教 AI 旁边「以后都这样」——开着教走 global_rule，回执说出了一张卡。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ColleaguesTab } from '@/components/org/colleagues-tab'
import { CreditsPanel } from '@/components/settings/credits-panel'
import type { CloudCreditsView, OrgMemberView } from '@/lib/api'
import { BrandAssetsPage } from '@/pages/brand-assets'
import { ChatWindowPage } from '@/pages/chat-window'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-09T09:00:00.000Z'

const state: { personal: { id: string; label: string }[]; asked: string[] } = {
  personal: [],
  asked: [],
}

const BALANCE = {
  org_id: 'org_1',
  purchased: 800,
  granted: 120,
  available: 920,
  reserved: 0,
  expiring: [],
  low_balance_threshold: 50,
  low_balance: false,
  at: T0,
}

const api = {
  credits: { linked: true, month_credits: 37.5, balance: BALANCE } as CloudCreditsView,
  usageCalls: 0,
  assetQueries: [] as Record<string, unknown>[],
  teach: [] as { scope: string }[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => {
      throw new Error('测试里没有 /v1/me')
    },
    listOrganizations: async () => [{ id: 'org_1', name: '诺伏特', solo: true, mode: 'solo' }],
    getCloudCredits: async () => api.credits,
    getCloudPricing: async () => ({
      version: 1,
      as_of: '2026-10-09',
      credit_cny: 1,
      ai_multiplier: 3,
      fx: {},
      entries: [],
    }),
    getCloudUsage: async () => {
      api.usageCalls += 1
      return { group: 'capability', from: T0, to: T0, rows: [], total_credits: 0 }
    },
    getTopupTiers: async () => ({
      version: 1,
      as_of: '2026-10-09',
      credits_per_usd: 7,
      tiers: [{ id: 'usd20', usd: 20, credits: 140, label_zh: '入门', label_en: 'Starter' }],
    }),
    getKolCloudStatus: async () => ({ subscription: { status: 'none' }, conflicts: [] }),
    getMyCloudAllocation: async () => ({}),
    listBrandAssets: async (filter: Record<string, unknown>) => {
      api.assetQueries.push(filter)
      return { rows: [] }
    },
    getChatWidgetSettings: async () => ({ allowed_origins: [] }),
    getChatRelaySettings: async () => ({ configured: false }),
    getChatRelayStatus: async () => ({ state: 'offline', online: false }),
    getChatRelayHosted: async () => ({
      available: false,
      linked: false,
      subscription: { status: 'none' },
    }),
    listChatSessions: async () => [
      {
        id: 'cs_1',
        source: 'widget',
        external_session_id: 'ext_1',
        visitor_display: 'Anna',
        status: 'open',
        takeover: false,
        thread_external_id: 'thr_1',
        created_at: T0,
        updated_at: T0,
      },
    ],
    getChatMessages: async () => ({ session: {}, messages: [] }),
    teachChatSession: async (_id: string, input: { scope: string }) => {
      api.teach.push(input)
      return {
        outcome: 'sent',
        sediment: input.scope === 'global_rule' ? 'role_rule' : 'knowledge_candidate',
      }
    },
  }
})

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    listColleagues: async () => ({
      colleagues: [{ person_id: 'per_li', name: '李默', in_progress: 0, load: '空着' }],
    }),
    previewLeave: async () => ({ personal_connections: [] }),
    previewRemoveMember: async (_ws: string, person_id: string) => {
      state.asked.push(person_id)
      return { personal_connections: state.personal }
    },
  }
})

const member = (person_id: string, name: string): OrgMemberView => ({
  person_id,
  name,
  email: `${person_id}@ex.com`,
  role: person_id === 'per_wang' ? 'owner' : 'member',
  joined_at: T0,
  positions: [],
  assignments: [],
})

function tab(): ReturnType<typeof vi.fn> {
  const onRemove = vi.fn()
  renderWithProviders(
    <ColleaguesTab
      me="per_wang"
      initiator="per_wang"
      members={[member('per_wang', '王岚'), member('per_li', '李默')]}
      invites={[]}
      requests={[]}
      busy={false}
      onCreateInvite={() => undefined}
      onDecide={() => undefined}
      onRemove={onRemove}
      onLeave={() => undefined}
      onExport={() => undefined}
      workspaceId="ws_1"
    />,
  )
  return onRemove
}

beforeEach(() => {
  state.personal = []
  state.asked = []
  api.credits = { linked: true, month_credits: 37.5, balance: BALANCE }
  api.usageCalls = 0
  api.assetQueries = []
  api.teach = []
})

describe('WP289 请他离开先问一句（决策 293）', () => {
  it('框里是「请 李默 离开？」+ 他的个人连接；取消不移出，确认才移出', async () => {
    state.personal = [{ id: 'conn_1', label: 'lin@private.cn' }]
    const onRemove = tab()
    fireEvent.click(await screen.findByTestId('colleague-remove'))
    const dialog = await screen.findByTestId('leave-confirm')
    expect(dialog.textContent).toContain('请 李默 离开？')
    const items = await within(dialog).findAllByTestId('leave-personal-item')
    expect(items.map((x) => x.textContent)).toEqual(['lin@private.cn'])
    expect(dialog.textContent).toContain('他接的这几条个人连接会一起断开')
    expect(state.asked).toEqual(['per_li'])
    fireEvent.click(within(dialog).getByText('取消'))
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('colleague-remove'))
    const ok = (await screen.findByTestId('leave-confirm-ok')) as HTMLButtonElement
    expect(ok.textContent).toBe('请他离开')
    await waitFor(() => {
      expect(ok.disabled).toBe(false)
    })
    fireEvent.click(ok)
    expect(onRemove).toHaveBeenCalledWith('per_li', '李默')
  })

  it('他没有个人连接：框里不出那一段', async () => {
    tab()
    fireEvent.click(await screen.findByTestId('colleague-remove'))
    const dialog = await screen.findByTestId('leave-confirm')
    await waitFor(() => {
      expect((within(dialog).getByTestId('leave-confirm-ok') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    expect(within(dialog).queryByTestId('leave-personal')).toBeNull()
  })
})

describe('WP289 积分卡人人只读（决策 307）', () => {
  it('没有花钱 / 看明细权限：余额与本月合计在，充值档不是按钮，没有三块、明细与增值服务卡', async () => {
    api.credits = { ...api.credits, can_topup: false, can_view_usage: false }
    renderWithProviders(<CreditsPanel />)
    expect(await screen.findByTestId('credits-balance')).toBeTruthy()
    expect(screen.getByText(/37\.5/)).toBeTruthy()
    const tiers = await screen.findByTestId('credits-tiers')
    expect(tiers.getAttribute('data-readonly')).toBe('true')
    expect(tiers.textContent).not.toContain('选一档充值')
    await waitFor(() => {
      expect(within(tiers).getAllByTestId('credits-tier')).toHaveLength(1)
    })
    expect(within(tiers).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByTestId('credits-blocks')).toBeNull()
    expect(screen.queryByTestId('credits-usage')).toBeNull()
    expect(screen.queryByTestId('kol-cloud-card')).toBeNull()
    expect(api.usageCalls).toBe(0)
  })

  it('有权限（或老服务端不给这两格）：照旧能点充值、有明细', async () => {
    renderWithProviders(<CreditsPanel />)
    const tiers = await screen.findByTestId('credits-tiers')
    expect(tiers.getAttribute('data-readonly')).toBe('false')
    await waitFor(() => {
      expect(within(tiers).getAllByRole('button')).toHaveLength(1)
    })
    expect(screen.getByTestId('credits-usage')).toBeTruthy()
  })
})

describe('WP289 素材库「遮罩」签（决策 313）', () => {
  it('默认不带用途；点「遮罩」才问 tag=mask', async () => {
    renderWithProviders(<BrandAssetsPage />)
    const filters = await screen.findByTestId('brand-assets-filters')
    await waitFor(() => {
      expect(api.assetQueries.length).toBeGreaterThan(0)
    })
    expect(api.assetQueries.every((q) => q.tag === undefined)).toBe(true)
    fireEvent.click(within(filters).getByText('遮罩'))
    await waitFor(() => {
      expect(api.assetQueries.some((q) => q.tag === 'mask')).toBe(true)
    })
  })
})

describe('WP289 聊天窗教 AI「以后都这样」（决策 318）', () => {
  it('不开：照旧 similar_cases；开着教：global_rule，回执说出了一张卡', async () => {
    renderWithProviders(<ChatWindowPage />)
    fireEvent.click(await screen.findByTestId('chat-conversation'))
    const input = await screen.findByTestId('chat-teach-input')
    fireEvent.change(input, { target: { value: '巴西走 DHL' } })
    fireEvent.click(screen.getByTestId('chat-teach-send'))
    await waitFor(() => {
      expect(api.teach.map((x) => x.scope)).toEqual(['similar_cases'])
    })
    expect(screen.queryByTestId('chat-teach-rule-receipt')).toBeNull()

    const always = screen.getByTestId('chat-teach-always')
    expect(always.textContent).toBe('以后都这样')
    fireEvent.click(always)
    expect(always.getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(screen.getByTestId('chat-teach-input'), {
      target: { value: '退款超过 50 美元先问我' },
    })
    fireEvent.click(screen.getByTestId('chat-teach-send'))
    await waitFor(() => {
      expect(api.teach.map((x) => x.scope)).toEqual(['similar_cases', 'global_rule'])
    })
    expect((await screen.findByTestId('chat-teach-rule-receipt')).textContent).toContain('记进规矩')
    // 教完开关回到关着
    expect(screen.getByTestId('chat-teach-always').getAttribute('aria-pressed')).toBe('false')
  })
})
