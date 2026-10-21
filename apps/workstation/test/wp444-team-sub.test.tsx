/**
 * WP444：团队通道做成增值服务——界面。
 *
 * - 「和同事一起用」跨网那一行：没开通写「没开通」+「开通（7 天免费试用）」，点了就地弹小卡写清每月多少积分、含几人，
 *   确认才开；试用中写剩几天；宽限写到哪天、按钮是「续费」；被停用写「已停用」不给按钮；
 * - 账号与积分里那一张：和红人营销增值服务同一个样式（状态、价钱、一句话、开通 / 取消 / 续费）；没关联说先关联；
 * - 我申请加入的：对方的团队通道没开通 / 到期写清楚，不说成「连不上」。
 */
import { DEFAULT_TEAM_PRICING } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TeamJoins, TeamLinkLine } from '@/components/onboarding/team-link'
import { TeamChannelCard } from '@/components/settings/team-channel'
import type {
  TeamJoinView,
  TeamLinkView,
  TeamSubscriptionLocalView,
  TeamSubscriptionView,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

// 机器忙时几次点击加起来会超过默认 5 秒
vi.setConfig({ testTimeout: 30_000 })

const DAY = 86_400_000
const base: TeamSubscriptionView = {
  service_id: 'team.channel.monthly',
  status: 'none',
  usable: false,
  comped: false,
  trial_available: true,
  cancel_at_period_end: false,
  members: 4,
  tier: { members: 5, credits: 68, extra_members: 0 },
  pricing: DEFAULT_TEAM_PRICING,
}

const state: {
  link: TeamLinkView
  sub: TeamSubscriptionLocalView
  joins: TeamJoinView[]
  calls: string[]
} = {
  link: { open: true, lan: { on: true }, cloud: { state: 'needs_subscription' } },
  sub: { linked: true, subscription: base },
  joins: [],
  calls: [],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTeamLink: async () => state.link,
    listTeamJoins: async () => state.joins,
    getTeamSubscription: async () => state.sub,
    subscribeTeamChannel: async () => {
      state.calls.push('subscribe')
      state.sub = {
        linked: true,
        subscription: {
          ...base,
          status: 'trial',
          usable: true,
          trial_available: false,
          trial_ends_at: new Date(Date.now() + 7 * DAY).toISOString(),
        },
      }
      return state.sub
    },
    cancelTeamChannel: async () => {
      state.calls.push('cancel')
      return state.sub
    },
  }
})

describe('WP444 「和同事一起用」跨网那一行', () => {
  it('没开通：写「没开通」+「开通（7 天免费试用）」→ 就地弹小卡写清价钱 → 确认才开 → 试用剩 7 天', async () => {
    const user = userEvent.setup()
    state.calls = []
    renderWithProviders(<TeamLinkLine />, '/')
    const row = await screen.findByTestId('team-link-cloud')
    await waitFor(() => {
      expect(row.textContent).toContain('不在同一个网络：没开通')
    })
    await user.click(await screen.findByTestId('team-sub-open-button'))
    const card = await screen.findByTestId('team-sub-confirm')
    expect(card.textContent).toContain('68 积分 / 月 · 含 5 人')
    expect(state.calls).toEqual([])
    await user.click(screen.getByTestId('team-sub-confirm-yes'))
    await waitFor(() => {
      expect(state.calls).toEqual(['subscribe'])
    })
    state.link = { ...state.link, cloud: { state: 'online' } }
    await waitFor(() => {
      expect(screen.getByTestId('team-link-cloud').textContent).toContain('试用中，剩 7 天')
    })
  })

  it('宽限中写到哪天、按钮是「续费」；被停用写「已停用」不给按钮', async () => {
    state.link = { open: true, lan: { on: true }, cloud: { state: 'online' } }
    state.sub = {
      linked: true,
      subscription: {
        ...base,
        status: 'grace',
        usable: true,
        trial_available: false,
        grace_until: '2026-11-20T02:00:00.000Z',
      },
    }
    const first = renderWithProviders(<TeamLinkLine />, '/')
    await waitFor(() => {
      expect(screen.getByTestId('team-link-cloud').textContent).toContain('宽限中，到 11-20')
    })
    expect((await screen.findByTestId('team-sub-open-button')).textContent).toBe('续费')
    first.unmount()

    state.link = { open: true, lan: { on: true }, cloud: { state: 'blocked' } }
    renderWithProviders(<TeamLinkLine />, '/')
    await waitFor(() => {
      expect(screen.getByTestId('team-link-cloud').textContent).toContain('已停用')
    })
    expect(screen.queryByTestId('team-sub-open-button')).toBeNull()
  })
})

describe('WP444 账号与积分里那一张', () => {
  it('试用中：状态、价钱、剩几天、能取消', async () => {
    const user = userEvent.setup()
    state.calls = []
    state.sub = {
      linked: true,
      subscription: {
        ...base,
        status: 'trial',
        usable: true,
        trial_available: false,
        trial_ends_at: new Date(Date.now() + 3 * DAY - 1000).toISOString(),
      },
    }
    renderWithProviders(<TeamChannelCard />, '/')
    expect((await screen.findByTestId('team-channel-state')).textContent).toBe('试用中')
    expect(screen.getByTestId('team-channel-card').textContent).toContain('68 积分 / 月 · 含 5 人')
    expect(screen.getByTestId('team-channel-note').textContent).toContain('试用剩 3 天')
    await user.click(screen.getByTestId('team-channel-cancel'))
    await waitFor(() => {
      expect(state.calls).toEqual(['cancel'])
    })
  })

  it('已关：状态标黄、「续费」；长期免费：不扣积分、没有按钮；没关联：先关联', async () => {
    state.sub = {
      linked: true,
      subscription: { ...base, status: 'suspended', usable: false, trial_available: false },
    }
    const a = renderWithProviders(<TeamChannelCard />, '/')
    expect((await screen.findByTestId('team-channel-state')).getAttribute('data-state')).toBe(
      'suspended',
    )
    expect(screen.getByTestId('team-channel-subscribe').textContent).toBe('续费')
    a.unmount()

    state.sub = {
      linked: true,
      subscription: {
        ...base,
        status: 'active',
        usable: true,
        comped: true,
        trial_available: false,
      },
    }
    const b = renderWithProviders(<TeamChannelCard />, '/')
    expect((await screen.findByTestId('team-channel-state')).textContent).toBe('长期免费')
    expect(screen.getByTestId('team-channel-note').textContent).toContain('不扣积分')
    expect(screen.queryByTestId('team-channel-subscribe')).toBeNull()
    expect(screen.queryByTestId('team-channel-cancel')).toBeNull()
    b.unmount()

    state.sub = { linked: false, reason: '登录工坊账号后，才能开通不在同一个网络的团队通道。' }
    renderWithProviders(<TeamChannelCard onLinkFirst={() => undefined} />, '/')
    expect((await screen.findByTestId('team-channel-not-linked')).textContent).toContain(
      '登录工坊账号后才能开通',
    )
  })
})

describe('WP444 我申请加入的', () => {
  it('对方的团队通道没开通 / 到期：写清楚，不说成「连不上」', async () => {
    state.joins = [
      {
        id: 'mrq_a',
        workspace_label: '王岚的工作区 · 1 人',
        status: 'channel_off',
        via: 'cloud',
        created_at: '2026-10-21T02:00:00.000Z',
        can_enter: false,
      },
    ]
    renderWithProviders(<TeamJoins />, '/')
    expect((await screen.findByTestId('team-join-row')).textContent).toContain(
      '对方的团队通道未开通 / 已到期',
    )
  })
})
