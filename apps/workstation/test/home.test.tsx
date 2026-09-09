/**
 * 36 §5.2 / §5.5 的两条硬断言：
 * - 首页**无图表无表格**（数字块的迷你走势是一条内联 SVG 折线，不是图表组件）
 * - 全应用**没有全局聊天输入框**
 */
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homeData } from './fixtures'
import { renderWithProviders } from './helpers'

const home = homeData()

const getHome = vi.fn(async () => home)
const decide = vi.fn(async () => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
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
    expect(screen.getByText('2')).toBeDefined()
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
