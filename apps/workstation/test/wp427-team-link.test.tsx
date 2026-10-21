/**
 * WP427：同事怎么连进来的那几块界面。
 *
 * - 「和同事一起用」打开之后：同一个网络 / 不在同一个网络两行小字；没登录工坊账号就地给登录；
 * - 我申请加入的：对方同意了有「打开」，点了在浏览器里打开对方那边（地址带一次性登录）；
 * - 邀请链接：用团队通道的地址开头；没有又是本机回环口就不给链接（只给码）；
 * - 经「团队门」从别的电脑打开的登录页：不出设置码那一栏。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { teamInviteLink } from '@/components/onboarding/join-panel'
import { TeamJoins, TeamLinkLine } from '@/components/onboarding/team-link'
import type { TeamJoinView, TeamLinkView } from '@/lib/api'
import { LoginPage } from '@/pages/login'
import { renderWithProviders } from './helpers'

const state: { link: TeamLinkView; joins: TeamJoinView[]; opened: string[]; entered: string[] } = {
  link: { open: true, lan: { on: true }, cloud: { state: 'needs_account' } },
  joins: [],
  opened: [],
  entered: [],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTeamLink: async () => state.link,
    listTeamJoins: async () => state.joins,
    enterTeamJoin: async (id: string) => {
      state.entered.push(id)
      return { url: 'https://tabc-team.agentsws.com/#agentsws-enter=ml_x' }
    },
    bootstrapHint: async () => ({ login: 'shared', team: true }),
  }
})

vi.mock('@/components/connections/bridge', async () => {
  const actual = await vi.importActual<typeof import('@/components/connections/bridge')>(
    '@/components/connections/bridge',
  )
  return {
    ...actual,
    openExternal: (url: string) => {
      state.opened.push(url)
    },
  }
})

describe('WP427 同事怎么连进来', () => {
  it('两行小字；没登录工坊账号就地给登录', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TeamLinkLine />, '/')
    expect((await screen.findByTestId('team-link-lan')).textContent).toContain('同一个网络：已开')
    expect(screen.getByTestId('team-link-cloud').textContent).toContain('要先登录工坊账号')
    await user.click(screen.getByTestId('team-link-login'))
    expect(await screen.findByText(/邮箱/)).toBeDefined()
  })

  it('连上云之后：不在同一个网络已开，没有登录按钮', async () => {
    state.link = {
      open: true,
      lan: { on: true },
      cloud: { state: 'online', url: 'https://tabc-team.agentsws.com' },
      invite_base: 'https://tabc-team.agentsws.com',
    }
    renderWithProviders(<TeamLinkLine />, '/')
    expect((await screen.findByTestId('team-link-cloud')).textContent).toContain(
      '不在同一个网络：已开',
    )
    expect(screen.queryByTestId('team-link-login')).toBeNull()
  })

  it('我申请加入的：同意了才有「打开」，点了在浏览器里打开对方那边', async () => {
    const user = userEvent.setup()
    state.joins = [
      {
        id: 'mrq_a',
        workspace_label: '王岚的工作区 · 1 人',
        status: 'approved',
        via: 'cloud',
        created_at: '2026-10-19T02:00:00.000Z',
        can_enter: true,
      },
      {
        id: 'mrq_b',
        workspace_label: '何佳的工作区 · 3 人',
        status: 'pending',
        via: 'lan',
        created_at: '2026-10-19T01:00:00.000Z',
        can_enter: false,
      },
    ]
    renderWithProviders(<TeamJoins />, '/')
    const rows = await screen.findAllByTestId('team-join-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('等对方同意')
    expect(screen.getAllByTestId('team-join-enter')).toHaveLength(1)
    await user.click(screen.getByTestId('team-join-enter'))
    await waitFor(() => {
      expect(state.opened).toEqual(['https://tabc-team.agentsws.com/#agentsws-enter=ml_x'])
    })
    expect(state.entered).toEqual(['mrq_a'])
  })

  it('邀请链接：团队通道的地址优先；本机回环口又没有通道就不给链接', () => {
    const fallback = (code: string) => `http://127.0.0.1:4317/join/${code}`
    expect(teamInviteLink(fallback, 'https://tabc-team.agentsws.com')?.('ABCD2345')).toBe(
      'https://tabc-team.agentsws.com/join/ABCD2345',
    )
    // jsdom 的页面地址是 localhost
    expect(teamInviteLink(fallback, undefined)).toBeUndefined()
    expect(teamInviteLink(undefined, 'https://x')).toBeUndefined()
  })

  it('经团队门打开的登录页：只有工坊账号，不出设置码', async () => {
    renderWithProviders(<LoginPage />, '/login')
    expect((await screen.findByTestId('login-team')).textContent).toContain('打开')
    expect(screen.queryByTestId('login-shared')).toBeNull()
  })
})
