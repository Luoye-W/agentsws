/**
 * WP198b：公司 → 积分 tab 上的「在网页上查看」。
 *
 * 与设置 → 积分那一处同一个链接（`AccountWebLink`）：地址来自本机服务端
 * （`CloudCreditsView.account_url`），没关联也有，服务端没给就不画。
 */
import type { CloudAllocationView } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreditsTab } from '@/components/org/credits-tab'
import type { CloudCreditsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-15T09:00:00.000Z'
/** 故意不是默认云地址：证明链接用的是服务端给的那一个。 */
const ACCOUNT_URL = 'https://cloud.self-hosted.invalid/account'

const REPORT_VIEW: CloudAllocationView = {
  linked: true,
  role: 'owner',
  report: {
    month: '2026-09',
    timezone: 'UTC',
    from: '2026-09-01T00:00:00.000Z',
    to: T0,
    members: [],
    positions: [],
    buckets: [],
    cells: [],
    total_credits: 0,
    unattributed_credits: 0,
    notices: [],
  },
}

const state = {
  credits: { linked: true } as CloudCreditsView,
  allocation: REPORT_VIEW,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCloudCredits: async () => state.credits,
    getCloudAllocation: async () => state.allocation,
    getCloudAllocationAudit: async () => ({ entries: [] }),
    getTopupTiers: async () => {
      throw new Error('这一档不测充值')
    },
  }
})

beforeEach(() => {
  state.credits = { linked: true }
  state.allocation = REPORT_VIEW
})

describe('公司 → 积分：在网页上查看（WP198b）', () => {
  it('已关联：链接在，地址来自服务端，新窗口（系统浏览器）打开', async () => {
    state.credits = { linked: true, account_url: ACCOUNT_URL }
    renderWithProviders(<CreditsTab assignment="asg_owner" members={[]} positions={[]} />)
    await screen.findByTestId('alloc-tab')
    const link = await screen.findByTestId('credits-web-link')
    expect(link.textContent).toContain('在网页上查看')
    expect(link.getAttribute('href')).toBe(ACCOUNT_URL)
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('没关联也有：一句人话旁边照样给网页入口', async () => {
    state.credits = { linked: false, reason: '还没关联', account_url: ACCOUNT_URL }
    state.allocation = { linked: false, reason: '还没关联 Agents 工坊账号。' }
    renderWithProviders(<CreditsTab assignment="asg_owner" members={[]} positions={[]} />)
    await screen.findByTestId('alloc-not-linked')
    const link = await screen.findByTestId('credits-web-link')
    expect(link.getAttribute('href')).toBe(ACCOUNT_URL)
  })

  it('服务端没给地址：不画', async () => {
    renderWithProviders(<CreditsTab assignment="asg_owner" members={[]} positions={[]} />)
    await screen.findByTestId('alloc-tab')
    expect(screen.queryByTestId('credits-web-link')).toBeNull()
  })
})
