/**
 * WP47 / 44：岗位页「面板」Tab 在**没挂范围**时要明说。
 *
 * 09-11 真店验收里，接口建出来的岗位 `ranges: []`，于是 19 §3 的过滤下推把整个
 * 「店铺后台」分块静默去掉了——页面上一片空白，也没有一个字解释为什么。
 * 这一组题钉住修好之后的样子：说人话 + owner 有一个"去分配"的按钮。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionSummary } from '@/lib/api'
import { PositionPage } from '@/pages/position'
import { renderWithProviders } from './helpers'

const summary = (over: Partial<PositionSummary>): PositionSummary => ({
  position_id: 'asg_1',
  role_id: 'dtc.support',
  role_name: '独立站售后客服',
  ranges: [],
  ready: true,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday',
  show_tiles: false,
  ...over,
})

const state = { positions: [summary({})] }
const updateAssignmentRanges = vi.fn(async () => ({}))

/** 红人工作台自己会打一串接口；这里只关心"它在不在"，换成一块占位。 */
vi.mock('@/components/kol/kol-panel', async () => {
  const actual = await vi.importActual<typeof import('@/components/kol/kol-panel')>(
    '@/components/kol/kol-panel',
  )
  return {
    ...actual,
    KolPanel: ({ channel }: { channel: string }) => <div data-testid="kol-panel">{channel}</div>,
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({ positions: state.positions, tile_library: [], max_tiles: 6 }),
    getPositionView: async () => ({
      position_id: 'asg_1',
      range: 'yesterday',
      sections: [
        {
          source: 'shop',
          label: '店铺后台',
          connected: true,
          blocks: [],
        },
      ],
    }),
    getPositionRecords: async () => ({ payload: { rows: [] } }),
    getPositionCards: async () => ({ position: state.positions[0], cards: [], counts: {} }),
    currentSession: async () => ({
      person: { id: 'p_owner', email: 'owner@example.com', name: '店主' },
      workspace: { id: 'ws_1', name: 'default' },
      assignments: [],
    }),
    updateAssignmentRanges: (...args: unknown[]) =>
      (updateAssignmentRanges as (...a: unknown[]) => Promise<unknown>)(...args),
  }
})

beforeEach(() => {
  state.positions = [summary({})]
  updateAssignmentRanges.mockClear()
})

/** 岗位页从路由参数拿 assignment_id，所以得真挂一条 `/positions/:id`。 */
const openPosition = (): void => {
  renderWithProviders(
    <Routes>
      <Route path="/positions/:id" element={<PositionPage />} />
    </Routes>,
    '/positions/asg_1?tab=view',
  )
}

describe('岗位页：还没分配范围', () => {
  it('范围为空 → 说人话，不是一片空白', async () => {
    openPosition()
    const card = await screen.findByTestId('no-range-card')
    expect(card.textContent).toContain('还没分配店铺 / 品牌 / 产品线')
    // 分块与数字块一个都不出（不给人"数据是 0"的错觉）
    expect(screen.queryByTestId('view-section')).toBeNull()
  })

  it('是所有者 → 给一个「去分配」的按钮，落到公司页', async () => {
    state.positions = [summary({}), summary({ position_id: 'asg_owner', role_id: 'common.owner' })]
    openPosition()
    const card = await screen.findByTestId('no-range-card')
    const link = within(card).getByTestId('no-range-assign')
    expect(link.getAttribute('href')).toBe('/org?tab=positions')
  })

  it('不是所有者 → 只告诉他去找谁，不给一个点了会 403 的按钮', async () => {
    openPosition()
    const card = await screen.findByTestId('no-range-card')
    expect(within(card).queryByTestId('no-range-assign')).toBeNull()
    expect(within(card).getByTestId('no-range-ask-owner').textContent).toContain('所有者')
  })

  it('挂了产品线的岗位不算"没范围"——面板照常出（44 G2）', async () => {
    state.positions = [summary({ ranges: [{ kind: 'product_line', id: 'pl_kitchen' }] })]
    openPosition()
    expect(await screen.findByTestId('view-section')).toBeTruthy()
    expect(screen.queryByTestId('no-range-card')).toBeNull()
  })
})

describe('WP138：范围为空只挡店铺数字，不挡红人工作台与聊天入口', () => {
  it('红人职责范围为空：提示卡在，红人工作台照样出', async () => {
    state.positions = [summary({ role_id: 'kol.instagram', role_name: 'Instagram 红人' })]
    openPosition()
    expect(await screen.findByTestId('no-range-card')).toBeTruthy()
    expect((await screen.findByTestId('kol-panel')).textContent).toBe('instagram')
    expect(screen.queryByTestId('view-section')).toBeNull()
  })

  it('在线客服范围为空：聊天窗与试聊两个入口照样出', async () => {
    state.positions = [summary({ role_id: 'dtc.live-chat', role_name: '网站在线客服' })]
    openPosition()
    expect(await screen.findByTestId('no-range-card')).toBeTruthy()
    expect(screen.getByTestId('chat-window-entry')).toBeTruthy()
    expect(screen.getByTestId('chat-sandbox-entry')).toBeTruthy()
  })

  it('店主本人看：一键「给我自己挂上这个品牌」，用店主那条分配改这条职责的范围', async () => {
    state.positions = [summary({}), summary({ position_id: 'asg_owner', role_id: 'common.owner' })]
    openPosition()
    const card = await screen.findByTestId('no-range-card')
    const button = within(card).getByTestId('no-range-self-assign')
    expect(button.textContent).toContain('给我自己挂上这个品牌')
    fireEvent.click(button)
    await waitFor(() => {
      expect(updateAssignmentRanges).toHaveBeenCalledWith(
        'asg_1',
        [{ kind: 'brand', id: 'ws_1' }],
        'asg_owner',
      )
    })
  })

  it('不是店主：没有一键挂品牌（点了也会 403）', async () => {
    openPosition()
    const card = await screen.findByTestId('no-range-card')
    expect(within(card).queryByTestId('no-range-self-assign')).toBeNull()
  })

  it('挂了整个品牌的职责不算"没范围"', async () => {
    state.positions = [summary({ ranges: [{ kind: 'brand', id: 'ws_1' }] })]
    openPosition()
    expect(await screen.findByTestId('view-section')).toBeTruthy()
    expect(screen.queryByTestId('no-range-card')).toBeNull()
  })
})
