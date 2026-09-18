/**
 * 36 §5.2 / §5.5 的两条硬断言：
 * - 首页**无图表无表格**（数字块的迷你走势是一条内联 SVG 折线，不是图表组件）
 * - 全应用**没有全局聊天输入框**
 *
 * WP98（09-18 收口）再钉一条：**第一屏的顺序**——问候 → 岗位卡一排 → 目标那一行，
 * 「还没接模型」的黄条与整块目标网格都不在首页了。
 */

import type { GoalProgress } from '@agentsws/contracts'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import { homeData } from './fixtures'
import { renderWithProviders } from './helpers'

const home = homeData()

/** 两个岗位——只有一个的人首页直接跳岗位页（54 §4），那就看不到这一屏了。 */
const instance = (id: string, name: string, assignment: string): PositionInstanceData => ({
  position_id: id,
  workspace_id: 'ws_1',
  name: { zh: name, en: name },
  template_version: '1.0.0',
  holders: [],
  roles: [
    {
      role_id: `${id}.role`,
      role_name: name,
      default: true,
      assignment_ids: [assignment],
      my_assignment_id: assignment,
    },
  ],
  open_matters: 1,
  pending_cards: 2,
  memory_summary: '',
})

const GOALS: GoalProgress[] = [
  {
    goal_id: 'g_1',
    title: '九月销售额',
    level: 'company',
    format: 'money',
    target: 100,
    value: 40,
    progress_pct: 40,
    days_left: 12,
    elapsed_pct: 60,
    status: 'behind',
  },
  {
    goal_id: 'g_2',
    title: '回复率',
    level: 'position',
    format: 'percent',
    target: 90,
    value: 88,
    progress_pct: 97,
    days_left: 12,
    elapsed_pct: 60,
    status: 'ok',
  },
]

const getHome = vi.fn(async () => home)
const decide = vi.fn(async () => ({}))
const getPositions = vi.fn(async () => ({
  positions: [],
  instances: [instance('customer-care', '客服', 'asg_1'), instance('web-ops', '网站运营', 'asg_2')],
  tile_library: [],
  max_tiles: 4,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    getPositions: (...args: unknown[]) => getPositions(...(args as [])),
    decide: (...args: unknown[]) => decide(...(args as [])),
  }
})

// 动态 import 必须在 mock 之后
const { HomePage } = await import('@/pages/home')

describe('首页（36 §3 三区）', () => {
  beforeEach(() => {
    getHome.mockClear()
  })

  it('一副牌（一次一张）、数据条与「预计 X 分钟」都在', async () => {
    renderWithProviders(<HomePage />)
    expect(await screen.findByTestId('queue')).toBeDefined()
    // 37 §1 第 1 行：首页不再平铺卡片列表，只有一张
    expect(await screen.findByTestId('deck-card')).toBeDefined()
    expect(screen.getAllByTestId('deck-card')).toHaveLength(1)
    expect(screen.getByTestId('tile-bar')).toBeDefined()
    expect(screen.getByText('今天队列预计 6 分钟')).toBeDefined()
  })

  it('数字块只出值、环比、迷你走势；没接的出「去连接」', async () => {
    renderWithProviders(<HomePage />)
    await screen.findByTestId('tile-bar')
    const tiles = screen.getAllByTestId('stat-tile')
    expect(tiles).toHaveLength(2)
    expect(tiles[0]?.getAttribute('data-status')).toBe('ok')
    // WP98：岗位卡上也有"2 张待审"，所以这个 2 要在数字块里找，不能在整页里找
    expect(within(tiles[0] as HTMLElement).getByText('2')).toBeDefined()
    expect(tiles[1]?.getAttribute('data-status')).toBe('not_connected')
    expect(screen.getByText('去连接')).toBeDefined()
  })

  it('首页里没有图表，也没有表格（36 §5.2）', async () => {
    const { container } = renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    expect(container.querySelectorAll('table')).toHaveLength(0)
    expect(container.querySelectorAll('[data-testid="block-chart"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-block-component="chart_line"]')).toHaveLength(0)
    expect(container.querySelectorAll('.recharts-wrapper')).toHaveLength(0)
    // 迷你走势线是允许的（36 §3 数字块的三样之一）
    expect(container.querySelectorAll('[data-testid="sparkline"]').length).toBeGreaterThan(0)
  })

  it('首页没有全局聊天输入框（36 §3 A4；对话入口只有指导 / 问 AI / ⌘K）', async () => {
    const { container } = renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    // 收起状态下，页面上一个可用的自由文本输入都没有
    const inputs = [
      ...container.querySelectorAll('input[type="text"], input:not([type]), textarea'),
    ].filter((el) => !(el as HTMLInputElement).disabled)
    expect(inputs).toHaveLength(0)
    expect(screen.queryByPlaceholderText(/(问点什么|说点什么|Ask anything|Message)/)).toBeNull()
  })

  it('时间范围切到近 7 天会重新取数（数在服务端算）', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    renderWithProviders(<HomePage />)
    await screen.findByTestId('tile-bar')
    expect(getHome).toHaveBeenCalledWith('yesterday')
    await userEvent.click(screen.getByRole('button', { name: '近 7 天' }))
    expect(getHome).toHaveBeenCalledWith('last_7d')
    // 数据条与 deck 各取各的：deck 带筛选参数（37 §1 末段）
    expect(getHome).toHaveBeenCalledWith('yesterday', {})
  })
})

describe('WP98 收口：第一屏的顺序', () => {
  beforeEach(() => {
    getHome.mockClear()
  })

  it('问候 → 岗位卡一排 → 目标那一行，三段按这个次序出现在 DOM 里', async () => {
    getHome.mockImplementation(async () => homeData({ goals: GOALS }))
    const { container } = renderWithProviders(<HomePage />)
    await screen.findByTestId('position-cards')
    const order = [...container.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string =>
        ['home-header', 'position-cards', 'goals-line', 'queue'].includes(id ?? ''),
      )
    expect(order).toEqual(['home-header', 'position-cards', 'goals-line', 'queue'])
  })

  it('目标折成一行"目标 2 项 · 1 项落后"，不再是一块带进度条的网格', async () => {
    getHome.mockImplementation(async () => homeData({ goals: GOALS }))
    renderWithProviders(<HomePage />)
    const line = await screen.findByTestId('goals-line')
    expect(line.textContent).toContain('目标 2 项 · 1 项落后')
    expect(line.getAttribute('href')).toBe('/goals')
    // 整块网格连同每张卡上的进度条都没了
    expect(screen.queryByTestId('goal-row')).toBeNull()
  })

  it('没有目标时那一行整个不出（不留一个"目标 0 项"占位）', async () => {
    getHome.mockImplementation(async () => home)
    renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    expect(screen.queryByTestId('goals-line')).toBeNull()
  })

  it('「还没接模型」不在首页了——它搬去了顶栏（app-shell 那个胶囊）', async () => {
    getHome.mockImplementation(async () => home)
    renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    expect(screen.queryByTestId('no-model-banner')).toBeNull()
  })
})
