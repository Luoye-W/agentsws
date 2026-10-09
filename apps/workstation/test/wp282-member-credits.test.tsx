/**
 * WP282（决策 281 / 286–290）：按人看积分的那一块。
 *
 * - 关联了云：每人三块（AI / 数据 / 服务）+ 次数 + 积分，「没标注」单独一行、问号里说「上线前的用量没按人记」；
 *   名册补的 0 行也在；
 * - 只看自己（③ 普通成员 / ①）：标题是「我这个月的积分」，只有自己一行，没有「没标注」；
 * - 没关联：② 照旧看本机记的次数 / token；别的模式什么都不出。
 */
import type { CloudMemberUsageView, MemberUsageReport } from '@agentsws/contracts'
import { emptyMemberUsageBlocks } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationView } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { SOLO_ORG } from './mode-words'

const PEERS_ORG: OrganizationView = {
  ...SOLO_ORG,
  owner_id: 'per_wang',
  role: 'member',
  members: 3,
  solo: false,
  mode: 'peers',
}

const REPORT: MemberUsageReport = {
  group: 'member',
  from: '2026-09-30T16:00:00.000Z',
  to: '2026-10-09T08:00:00.000Z',
  timezone: 'Asia/Shanghai',
  rows: [
    {
      key: 'per_li',
      name: '李默',
      credits: 44,
      quantity: 6,
      calls: 3,
      blocks: {
        ai: { credits: 10, calls: 1 },
        data: { credits: 4, calls: 1 },
        service: { credits: 30, calls: 1 },
      },
    },
    {
      key: 'per_chen',
      name: '陈一',
      credits: 0,
      quantity: 0,
      calls: 0,
      blocks: emptyMemberUsageBlocks(),
    },
  ],
  unattributed: {
    credits: 2.5,
    quantity: 2,
    calls: 1,
    blocks: { ...emptyMemberUsageBlocks(), data: { credits: 2.5, calls: 1 } },
  },
  total_credits: 46.5,
}

const state: { cloud: CloudMemberUsageView; local: { people: unknown[] } } = {
  cloud: { linked: true, scope: 'all', report: REPORT },
  local: { people: [] },
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, listOrganizations: async () => [PEERS_ORG] }
})

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    getCloudMemberUsage: async () => state.cloud,
    listPeopleUsage: async () => state.local,
  }
})

const { PeopleUsage } = await import('@/components/settings/people-usage')

beforeEach(() => {
  state.cloud = { linked: true, scope: 'all', report: REPORT }
  state.local = { people: [] }
})

describe('WP282 按人看积分', () => {
  it('全员：三块 + 次数 + 积分，名册补的 0 行在，「没标注」单独一行带问号', async () => {
    renderWithProviders(<PeopleUsage localFallback />)
    const box = await screen.findByTestId('member-credits')
    expect(box.dataset.scope).toBe('all')
    expect(box.textContent).toContain('每个人这个月的积分')
    const head = [...box.querySelectorAll('th')].map((th) => th.textContent)
    expect(head).toEqual(['谁', 'AI 使用', '数据接口', '增值服务', '次数', '积分'])
    const rows = within(box).getAllByTestId('member-credits-row')
    expect(rows.map((r) => r.dataset.person)).toEqual(['per_li', 'per_chen'])
    expect(
      [...(rows[0] as HTMLElement).querySelectorAll('td')].map((td) => td.textContent),
    ).toEqual(['李默', '10', '4', '30', '3', '44'])
    // 每块的次数在悬停里
    expect((rows[0] as HTMLElement).querySelectorAll('td')[1]?.getAttribute('title')).toBe('1 次')
    const rest = within(box).getByTestId('member-credits-unattributed')
    expect(rest.textContent).toContain('没标注')
    expect(rest.textContent).toContain('2.5')
    expect(rest.querySelector('[data-hint]')?.getAttribute('data-hint')).toBe(
      '上线前的用量没按人记',
    )
  })

  it('只看自己：标题换成「我这个月的积分」，一行，没有「没标注」', async () => {
    state.cloud = {
      linked: true,
      scope: 'self',
      report: {
        ...REPORT,
        rows: [REPORT.rows[1] as MemberUsageReport['rows'][number]],
        unattributed: { credits: 0, quantity: 0, calls: 0, blocks: emptyMemberUsageBlocks() },
        total_credits: 0,
      },
    }
    renderWithProviders(<PeopleUsage />)
    const box = await screen.findByTestId('member-credits')
    expect(box.dataset.scope).toBe('self')
    expect(box.textContent).toContain('我这个月的积分')
    expect(within(box).getAllByTestId('member-credits-row')).toHaveLength(1)
    expect(within(box).queryByTestId('member-credits-unattributed')).toBeNull()
  })

  it('没关联：② 看本机记的次数 / token；不给兜底就什么都不出', async () => {
    state.cloud = { linked: false, scope: 'all', reason: '还没关联' }
    state.local = { people: [{ person_id: 'per_li', name: '李默', calls: 12, tokens: 34_000 }] }
    const { unmount } = renderWithProviders(<PeopleUsage localFallback />)
    const local = await screen.findByTestId('people-usage')
    expect(local.textContent).toContain('3.4 万')
    expect(screen.queryByTestId('member-credits')).toBeNull()
    unmount()
    renderWithProviders(<PeopleUsage />)
    await waitFor(() => {
      expect(screen.queryByTestId('people-usage')).toBeNull()
    })
    expect(screen.queryByTestId('member-credits')).toBeNull()
  })
})
