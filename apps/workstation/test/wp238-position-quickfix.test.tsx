/**
 * WP238（Luoye 10-06 Windows 真机，岗位「Reddit 运营」）：岗位面板与职责页的空状态。
 *
 * 钉三件：
 * 1. 面板上没连、但取数已由接口中台满足的源（`via`）→ 一行灰字说数据从哪来，**不出「去连接」**；
 * 2. 真没连的源 → 一行灰字 + 一个去处按钮，不再是一张带标题的大卡；「还没做」的只有那句话；
 * 3. 社媒「还没登记号 / 群发没有去处」→ 一行灰字 + 去连接页那张卡，不再占大卡。
 */
import { screen, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { SocialCalendar } from '@/components/social/social-calendar'
import type { PositionSummary } from '@/lib/api'
import { PositionPage } from '@/pages/position'
import { renderWithProviders } from './helpers'

const summary = (over: Partial<PositionSummary>): PositionSummary => ({
  position_id: 'asg_1',
  role_id: 'social.reddit',
  role_name: 'Reddit 运营',
  ranges: [{ kind: 'brand', id: 'ws_1' }],
  ready: true,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday',
  show_tiles: false,
  ...over,
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({ positions: [summary({})], tile_library: [], max_tiles: 6 }),
    getPositionView: async () => ({
      position_id: 'asg_1',
      range: 'yesterday',
      sections: [
        { source: 'social_reddit', label: 'Reddit', connected: false, via: 'workshop', blocks: [] },
        { source: 'social_discord', label: 'Discord', connected: false, blocks: [] },
        {
          source: 'tracking',
          label: '物流追踪',
          connected: false,
          note: '这个连接器还没做。',
          blocks: [],
        },
      ],
    }),
    getPositionRecords: async () => ({ payload: { rows: [] } }),
    getPositionConnections: async () => ({
      position_id: 'social-media',
      position_name: 'Reddit 运营',
      ready: true,
      missing_required: [],
      items: [],
    }),
    getSocialAccounts: async () => ({ rows: [] }),
  }
})

function renderView() {
  return renderWithProviders(
    <Routes>
      <Route path="/positions/:id" element={<PositionPage />} />
    </Routes>,
    '/positions/asg_1?tab=view',
  )
}

describe('WP238 岗位面板：数据从哪来、空状态一行', () => {
  it('取数已由接口中台满足：一行灰字，不催「去连接」', async () => {
    renderView()
    const via = await screen.findByTestId('source-via')
    expect(via.getAttribute('data-via')).toBe('workshop')
    expect(via.textContent).toContain('数据经 Agents 工坊接口获取')
    const section = via.closest('[data-testid="view-section"]') as HTMLElement
    expect(within(section).queryByRole('link')).toBeNull()
    expect(within(section).queryByText(/还没连接/)).toBeNull()
  })

  it('真没连：一行灰字 + 一个去处按钮；还没做：只有那句话', async () => {
    renderView()
    await screen.findByTestId('source-via')
    const rows = screen.getAllByTestId('connect-card')
    expect(rows).toHaveLength(2)
    const discord = rows[0] as HTMLElement
    expect(discord.textContent).toContain('还没连接Discord')
    expect(within(discord).getAllByRole('link')).toHaveLength(1)
    // 不再是一张带标题的卡
    expect(discord.querySelector('[data-slot="card"], [data-slot="card-title"]')).toBeNull()
    const tracking = rows[1] as HTMLElement
    expect(tracking.textContent).toContain('这个连接器还没做')
    expect(within(tracking).queryByRole('link')).toBeNull()
  })

  it('什么都不缺：顶上那张「连上这 N 个就能开工」不出', async () => {
    renderView()
    await screen.findByTestId('source-via')
    expect(screen.queryByTestId('position-connections')).toBeNull()
  })
})

describe('WP238 社媒空状态：一行灰字 + 去处', () => {
  it('内容日历：没登记号就一行，按钮落到连接页那张 Reddit 卡', async () => {
    renderWithProviders(<SocialCalendar assignment="asg_1" channel="reddit" />)
    const line = await screen.findByTestId('social-calendar-no-account')
    expect(line.textContent).toContain('还没登记号')
    expect(screen.getByTestId('social-calendar-connect').getAttribute('href')).toBe(
      '/connections?service=reddit',
    )
    expect(screen.queryByTestId('social-calendar')).toBeNull()
  })

  it('群发：没登记号 / 群就一行，不画向导', async () => {
    renderWithProviders(<SocialBroadcast assignment="asg_1" channel="reddit" />)
    const line = await screen.findByTestId('social-broadcast-no-account')
    expect(line.textContent).toContain('群发')
    expect(screen.getByTestId('social-broadcast-connect').getAttribute('href')).toBe(
      '/connections?service=reddit',
    )
    expect(screen.queryByTestId('social-broadcast')).toBeNull()
  })
})
