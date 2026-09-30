/**
 * WP206：额度分配搬到网页版账号页之后，工作台「设置 → 积分」上那一句
 * 「给同事分额度 → 在网页上」——只有公司的 owner / admin 看得到，地址由本机服务端给。
 * 「我的本月额度」与额度用完那句人话照旧。
 */
import type { CloudMyAllocationView } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreditsPanel } from '@/components/settings/credits-panel'
import type { CloudCreditsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-30T09:00:00.000Z'
/** 故意不是默认云地址：证明链接用的是服务端给的那一个。 */
const ALLOCATION_URL = 'https://cloud.self-hosted.invalid/account/allocation'

const LINKED: CloudCreditsView = {
  linked: true,
  month_credits: 12,
  fetched_at: T0,
  balance: {
    org_id: 'org_1',
    purchased: 800,
    granted: 0,
    available: 800,
    reserved: 0,
    expiring: [],
    low_balance_threshold: 50,
    low_balance: false,
    at: T0,
  },
}

const MINE = {
  month: '2026-09',
  timezone: 'Asia/Shanghai',
  member_id: 'per_boss',
  used: 40,
  reserved: 0,
  monthly_limit: 40,
  percent: 100,
}

const state = { mine: { linked: true } as CloudMyAllocationView }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCloudCredits: async () => LINKED,
    getMyCloudAllocation: async () => state.mine,
    getCloudPricing: async () => {
      throw new Error('这一档不测价目')
    },
    getCloudUsage: async () => null,
    getTopupTiers: async () => {
      throw new Error('这一档不测充值')
    },
    getKolCloudStatus: async () => {
      throw new Error('没配')
    },
  }
})

beforeEach(() => {
  state.mine = { linked: true }
})

describe('设置 → 积分：给同事分额度 → 在网页上（WP206）', () => {
  it('owner：链接在，地址来自服务端，新窗口（系统浏览器）打开', async () => {
    state.mine = { linked: true, mine: MINE, role: 'owner', allocation_url: ALLOCATION_URL }
    renderWithProviders(<CreditsPanel assignment="asg_owner" />)
    const link = await screen.findByTestId('credits-alloc-web-link')
    expect(link.textContent).toContain('给同事分额度')
    expect(link.getAttribute('href')).toBe(ALLOCATION_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    // 额度用完的那句人话照旧
    expect((await screen.findByTestId('credits-mine-full')).textContent).toContain('本月额度用完了')
  })

  it('admin 也有', async () => {
    state.mine = { linked: true, role: 'admin', allocation_url: ALLOCATION_URL }
    renderWithProviders(<CreditsPanel assignment="asg_admin" />)
    expect(await screen.findByTestId('credits-alloc-web-link')).toBeDefined()
  })

  it('普通成员：看不到这一句，只看自己的额度', async () => {
    state.mine = { linked: true, mine: MINE }
    renderWithProviders(<CreditsPanel assignment="asg_member" />)
    await screen.findByTestId('credits-mine')
    expect(screen.queryByTestId('credits-alloc-web-link')).toBeNull()
  })
})
