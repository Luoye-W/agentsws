/**
 * WP47 / 44：岗位页「面板」Tab 在**没挂范围**时要明说。
 *
 * 09-11 真店验收里，接口建出来的岗位 `ranges: []`，于是 19 §3 的过滤下推把整个
 * 「店铺后台」分块静默去掉了——页面上一片空白，也没有一个字解释为什么。
 * 这一组题钉住修好之后的样子：说人话 + owner 有一个"去分配"的按钮。
 */
import { screen, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionSummary } from '@/lib/api'
import { PositionPage } from '@/pages/position'
import { renderWithProviders } from './helpers'

const summary = (over: Partial<PositionSummary>): PositionSummary => ({
  position_id: 'asg_1',
  role_id: 'dtc.aftersales',
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
  }
})

beforeEach(() => {
  state.positions = [summary({})]
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
