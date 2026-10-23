/**
 * WP493（决策 1718）：ego 能做这个岗位要插件做的全部 → 岗位页顶上不出「先装好浏览器插件」，
 * 连接卡上先列 ego、插件那一行是「备用」（不亮红、不算要处理）；方案卡（Reddit 巡查设置）照样提醒。
 */
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionOnboardCard, onboardPhase } from '@/components/connections/extension-onboard-card'
import { ExtensionRows, extensionRowsOf } from '@/components/rail/cards/extension-rows'
import type { ExtensionNeedsView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const base = (over: Partial<ExtensionNeedsView> = {}): ExtensionNeedsView => ({
  needed: true,
  uses: [],
  roles: [{ role_id: 'social.reddit', name: { zh: '官方版块', en: 'Official Subreddit' } }],
  paired: false,
  steps: [],
  plans: [{ target: 'reddit.watch', name: 'Reddit 巡查', satisfied: true }],
  snoozed: false,
  ego_covers: ['reddit', 'social'],
  plugin_backup: true,
  ...over,
})

const state = { needs: base() }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getExtensionNeeds: async () => state.needs,
    getExtensionInstall: async () => {
      throw new Error('not_implemented')
    },
    listExtensionTokens: async () => ({ tokens: [] }),
  }
})

beforeEach(() => {
  state.needs = base()
})

describe('ego 能做全部：插件是备用', () => {
  it('阶段：岗位页不催装；方案卡没设时只提方案；首次设置不画', () => {
    expect(onboardPhase(base(), 'position')).toBe('hidden')
    expect(onboardPhase(base(), 'onboarding')).toBe('hidden')
    const unset = base({
      plans: [{ target: 'reddit.watch', name: 'Reddit 巡查', satisfied: false }],
    })
    expect(onboardPhase(unset, 'position')).toBe('plan')
    expect(onboardPhase(unset, 'position', ['reddit.watch'])).toBe('hidden')
    // ego 只做一部分（还要收红人）：照旧催
    expect(onboardPhase(base({ plugin_backup: false, uses: ['kol'] }), 'position')).toBe('install')
  })
  it('岗位页顶上：没有「先装好浏览器插件」', async () => {
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    await waitFor(() => expect(screen.queryByTestId('extension-onboard')).toBeNull())
    expect(screen.queryByText(/先装好浏览器插件/u)).toBeNull()
  })
  it('岗位页顶上：巡查还没设 → 只出「下一步」，不说插件已连上', async () => {
    state.needs = base({
      plans: [{ target: 'reddit.watch', name: 'Reddit 巡查', satisfied: false }],
    })
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    const card = await screen.findByTestId('extension-onboard')
    expect(card.getAttribute('data-phase')).toBe('plan')
    expect(screen.getByTestId('extension-onboard-plan').textContent).toContain('Reddit 巡查')
    expect(screen.queryByTestId('extension-onboard-paired-line')).toBeNull()
    expect(card.textContent).not.toContain('插件')
  })
  it('连接卡：先列 ego，插件那一行是「备用」、不亮红', () => {
    const rows = extensionRowsOf(base())
    expect(rows).toEqual([
      { key: 'ego', ok: true },
      { key: 'paired', ok: true, backup: true },
    ])
    renderWithProviders(<ExtensionRows rows={rows ?? []} />)
    const items = screen.getAllByTestId('connection-row')
    expect(items.map((r) => r.textContent)).toEqual([
      'ego 浏览器',
      '浏览器插件（Agents 工坊助手）备用',
    ])
    expect(items.some((r) => r.getAttribute('data-todo') === 'true')).toBe(false)
    expect(screen.queryByTestId('connection-go')).toBeNull()
  })
  it('ego 只做一部分：ego 一行 + 插件照旧（没配对亮红）', () => {
    expect(
      extensionRowsOf(base({ plugin_backup: false, uses: ['kol'], ego_covers: ['reddit'] })),
    ).toEqual([
      { key: 'ego', ok: true },
      { key: 'paired', ok: false },
    ])
  })
})
