/**
 * WP96 交付 4：首页与左栏 / 顶栏按画布重排后的**新结构**。
 *
 * 钉的是"哪几块在哪儿"，不是像素：首页多了一句开头，岗位卡换成画布那张
 * （待审大数字 + 交给它一件事），下半屏分两栏（左 = 要你决定的，右 = 今天的数与今天）；
 * 顶栏那颗 ⌘K 变成一条长搜索框。老的段落一块都没少——testid 全在。
 */
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homeData } from './fixtures'
import { renderWithProviders } from './helpers'

const home = homeData({
  // 右栏那几块只有装了工作模型才有；这条题要看它们**排在右栏**，所以都给上
  today: { timeline: [], due: { todos: [], cards_waiting: 2 } },
  report: { ai_handled: 12, you_handled: 5, auto_sent: 3, blocked: 1 },
})

const getHome = vi.fn(async () => home)
const getPositions = vi.fn(async () => ({
  positions: [],
  instances: [
    {
      position_id: 'pos_store',
      name: { zh: '网站运营', en: 'Store ops' },
      pending_cards: 3,
      open_matters: 2,
      roles: [
        {
          role_id: 'dtc.store',
          role_name: '店铺管理',
          my_assignment_id: 'asg_1',
          task_examples: [],
        },
      ],
    },
    {
      position_id: 'pos_support',
      name: { zh: '客服', en: 'Support' },
      pending_cards: 0,
      open_matters: 1,
      roles: [
        {
          role_id: 'dtc.support',
          role_name: '售后',
          my_assignment_id: 'asg_2',
          task_examples: [],
        },
      ],
    },
  ],
  tile_library: [],
  max_tiles: 6,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    getPositions: (...args: unknown[]) => getPositions(...(args as [])),
    decide: async () => ({}),
  }
})

const { HomePage } = await import('@/pages/home')

describe('首页新结构（画布《首页 · 新风格》）', () => {
  beforeEach(() => {
    getHome.mockClear()
  })

  it('开头一句：大标题 + 今天还剩多少事', async () => {
    renderWithProviders(<HomePage />)
    const header = await screen.findByTestId('home-header')
    expect(within(header).getByRole('heading', { level: 1 }).className).toContain('ws-display')
    expect(header.textContent).toContain('张卡等你决定')
  })

  it('岗位卡换成画布那张：待审大数字 + 交给它一件事', async () => {
    renderWithProviders(<HomePage />)
    await screen.findByTestId('position-cards')
    const cards = screen.getAllByTestId('ws-position-card')
    expect(cards).toHaveLength(2)
    expect(screen.getAllByTestId('ws-position-pending').map((el) => el.textContent)).toEqual([
      '3',
      '0',
    ])
    expect(screen.getAllByTestId('ws-position-entry')[0]?.textContent).toBe('交给它一件事')
  })

  it('下半屏两栏：左边是要你决定的，右边是今天的数与今天', async () => {
    renderWithProviders(<HomePage />)
    const queue = await screen.findByTestId('queue')
    const tiles = screen.getByTestId('tile-bar')
    const left = queue.parentElement
    const right = tiles.parentElement
    expect(left).not.toBe(right)
    // 两栏是同一个 grid 的两个子块
    expect(left?.parentElement).toBe(right?.parentElement)
    expect(left?.parentElement?.className).toContain('lg:grid-cols-[2fr_1fr]')
  })

  it('老的段落一块都没少（只是换了位置）', async () => {
    renderWithProviders(<HomePage />)
    await screen.findByTestId('queue')
    for (const id of ['tile-bar', 'today', 'home-inprogress', 'home-claim-pool', 'review']) {
      expect(screen.getByTestId(id), `${id} 不见了`).toBeTruthy()
    }
  })

  it('卡还是一次一张，而且走 .ws-card（新皮）', async () => {
    renderWithProviders(<HomePage />)
    const card = await screen.findByTestId('deck-card')
    expect(screen.getAllByTestId('deck-card')).toHaveLength(1)
    expect(card.className).toContain('ws-card')
    expect(card.className).not.toContain('shadow-xl')
  })
})
