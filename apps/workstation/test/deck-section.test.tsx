/**
 * 37 §1 逐条对照表里**属于整副牌**的那几行：
 * 1 一次一张 + 景深 + 第 N / M 张 + 键盘、8 已处理飞出 300ms 换下一张、
 * 9 空态 = 今日战报四格、10 筛选行。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECK_EXIT_MS, DECK_MAX_WIDTH_CLASS } from '@/components/deck/deck-layout'
import type { CardsData, HomeData } from '@/lib/api'
import { draftCard, homeData, questionCard, REPORT, TILE_BAR } from './fixtures'
import { renderWithProviders } from './helpers'

let home: HomeData = homeData()
let cards: CardsData

const getHome = vi.fn(async () => home)
const getPositionCards = vi.fn(async () => cards)
const decide = vi.fn(async () => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...args: unknown[]) => getHome(...(args as [])),
    getPositionCards: (...args: unknown[]) => getPositionCards(...(args as [])),
    decide: (...args: unknown[]) => decide(...(args as [])),
  }
})

const { DeckSection } = await import('@/components/deck')

const P0 = draftCard({ id: 'ap_p0', priority_band: 'P0', title: '客户在等' })

beforeEach(() => {
  home = homeData()
  cards = {
    position: {
      position_id: 'asg_1',
      role_id: 'dtc.support',
      role_name: '独立站售后客服',
      ranges: [],
      ready: true,
      missing_connectors: [],
      tile_ids: [],
      range: 'yesterday',
      show_tiles: true,
    },
    cards: [draftCard()],
    filters: {},
    counts: { total: 1, customer_waiting: 0, nobody_waiting: 0, matched: 1 },
    pinned_p0: [],
  }
  getHome.mockClear()
  getPositionCards.mockClear()
  decide.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('37 §1 第 1 行：一次一张', () => {
  it('三张卡只渲染一张，背后两张歪斜的景深假卡，780px 居中', async () => {
    home = homeData({ queue: [draftCard(), questionCard(), draftCard({ id: 'ap_3' })] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    expect(screen.getAllByTestId('deck-card')).toHaveLength(1)
    expect(screen.getAllByTestId('deck-ghost')).toHaveLength(2)
    for (const cls of DECK_MAX_WIDTH_CLASS.split(' '))
      expect(screen.getByTestId('deck-section').className).toContain(cls)
  })

  it('「第 N / M 张」跟着游标走；最后一张背后没有假卡', async () => {
    home = homeData({ queue: [draftCard(), questionCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    expect((await screen.findByTestId('deck-progress')).textContent).toBe('第 1 / 2 张')
    expect(screen.getAllByTestId('deck-ghost')).toHaveLength(1)
  })

  it('键盘：→ 批准 / ← 拒绝 / ↑ 稍后 / ↓ 指导', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [draftCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const deck = await screen.findByTestId('deck-section')
    expect(deck.getAttribute('aria-keyshortcuts')).toBe('ArrowRight ArrowLeft ArrowUp ArrowDown')
    deck.focus()

    // ← 开拒绝理由框（卡还没走：人得先说句话）
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByTestId('deck-panel-reject')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '返回' }))

    // ↓ 开指导框
    deck.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByTestId('deck-panel-instruct')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '返回' }))

    // ↑ 直接稍后
    deck.focus()
    await user.keyboard('{ArrowUp}')
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'ap_1',
        expect.objectContaining({ action: 'snooze' }),
        'asg_1',
      )
    })
  })

  it('→ 批准；但选择题卡没选中时键盘也不是后门', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [questionCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const deck = await screen.findByTestId('deck-section')
    deck.focus()
    await user.keyboard('{ArrowRight}')
    expect(decide).not.toHaveBeenCalled()

    home = homeData({ queue: [draftCard()] })
    screen.getByTestId('deck-section')
  })

  it('正在打字时箭头键归输入框，卡不会飞走', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [draftCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await user.click(screen.getByText('改一下'))
    const box = screen.getByLabelText('一句话说清楚要怎么改')
    await user.click(box)
    await user.keyboard('改一句{ArrowLeft}{ArrowRight}')
    expect(decide).not.toHaveBeenCalled()
    expect(screen.getByTestId('deck-panel-instruct')).toBeDefined()
  })
})

describe('37 §1 第 8 行：已处理飞出 300ms → 下一张，不留队列', () => {
  it('批准后卡带飞出类，DECK_EXIT_MS 之后换成下一张', async () => {
    home = homeData({ queue: [draftCard(), questionCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    expect(screen.getByTestId('deck-progress').textContent).toBe('第 1 / 2 张')

    await userEvent.click(screen.getByText('发送'))
    // 决定已经发出去，卡正在飞
    expect(decide).toHaveBeenCalledWith(
      'ap_1',
      expect.objectContaining({ action: 'approve' }),
      'asg_1',
    )
    expect(screen.getByTestId('deck-card').className).toContain('translate-x-[130%]')

    await waitFor(
      () => {
        expect(screen.getByTestId('deck-progress').textContent).toBe('第 2 / 2 张')
      },
      { timeout: DECK_EXIT_MS * 6 },
    )
    expect(screen.getByText('超窗一周的退货，怎么办？')).toBeDefined()
    expect(screen.getByTestId('deck-card').className).not.toContain('translate-x-[130%]')
  })

  it('决定失败时卡不飞走，就地报错', async () => {
    decide.mockRejectedValueOnce(new Error('冲突了'))
    home = homeData({ queue: [draftCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await userEvent.click(screen.getByText('发送'))
    expect((await screen.findByRole('alert')).textContent).toContain('冲突了')
    expect(screen.getByTestId('deck-card').className).not.toContain('translate-x-[130%]')
  })
})

describe('37 §1 第 9 行：空态 = 今日战报四格', () => {
  it('队列清空时给四个数，不是「暂无卡片」', async () => {
    home = homeData({ queue: [] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const report = await screen.findByTestId('deck-battle-report')
    expect(within(report).getByText('AI 自主处理')).toBeDefined()
    expect(screen.getByTestId('recap-ai_handled').textContent).toBe(String(REPORT.ai_handled))
    expect(screen.getByTestId('recap-handled').textContent).toBe(String(REPORT.handled))
    expect(screen.getByTestId('recap-auto_sent').textContent).toBe(String(REPORT.auto_sent))
    expect(screen.getByTestId('recap-intercepted').textContent).toBe(String(REPORT.intercepted))
    expect(screen.queryByTestId('deck-card')).toBeNull()
    // 没筛选时不出「回到全部」
    expect(screen.queryByText('回到全部')).toBeNull()
  })
})

describe('37 §1 第 10 行：筛选行', () => {
  it('岗位 chip + 等待 chip + 卡型下拉 + 来源下拉；计数按张数', async () => {
    home = homeData({
      queue: [draftCard(), questionCard()],
      tiles: [
        { ...TILE_BAR, position_id: 'asg_1', role_name: '独立站售后客服' },
        { ...TILE_BAR, position_id: 'asg_2', role_name: '独立站运营' },
      ],
      counts: { total: 9, customer_waiting: 2, nobody_waiting: 3, matched: 2 },
    })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const row = await screen.findByTestId('deck-filters')
    // 计数是**张数**（合并前的 total），不是当前渲染出来的组数
    expect(within(row).getByText('全部 9')).toBeDefined()
    expect(within(row).getByText('客户在等 2')).toBeDefined()
    expect(within(row).getByText('无人等待 3')).toBeDefined()
    expect(within(row).getByText('独立站运营')).toBeDefined()
    expect(within(row).getByLabelText('卡型')).toBeDefined()
    expect(within(row).getByLabelText('来源')).toBeDefined()
  })

  it('点筛选 chip 只重取这副牌，不跳页', async () => {
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    expect(getHome).toHaveBeenLastCalledWith('yesterday', {})
    await userEvent.click(screen.getByText(/客户在等/))
    await waitFor(() => {
      expect(getHome).toHaveBeenLastCalledWith('yesterday', { waiting: 'customer_waiting' })
    })
    // 还在同一个 deck 上，没有换页面
    expect(screen.getByTestId('deck-section')).toBeDefined()
  })

  it('来源下拉发的是 source；再选回「所有来源」就把这个条件删掉', async () => {
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await userEvent.selectOptions(screen.getByLabelText('来源'), 'todo')
    await waitFor(() => {
      expect(getHome).toHaveBeenLastCalledWith('yesterday', { source: 'todo' })
    })
    await userEvent.selectOptions(screen.getByLabelText('来源'), '')
    await waitFor(() => {
      expect(getHome).toHaveBeenLastCalledWith('yesterday', {})
    })
  })

  it('P0 被筛掉时置顶提示，并给一条回到全部的路', async () => {
    home = homeData({ queue: [draftCard()], pinned_p0: [P0], filters: { source: 'todo' } })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await userEvent.selectOptions(screen.getByLabelText('来源'), 'todo')
    const note = await screen.findByTestId('deck-pinned-p0')
    expect(note.textContent).toContain('1')
    await userEvent.click(within(note).getByText('回到全部'))
    await waitFor(() => {
      expect(getHome).toHaveBeenLastCalledWith('yesterday', {})
    })
  })

  it('语言切换是队列级的：切一次整副牌都跟着换', async () => {
    home = homeData({ queue: [draftCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    expect(screen.getByTestId('deck-content').getAttribute('data-mode')).toBe('zh_summary')
    await userEvent.click(within(screen.getByTestId('deck-modes')).getByText('原文'))
    expect(screen.getByTestId('deck-content').getAttribute('data-mode')).toBe('original')
  })
})

describe('岗位页用同一副牌', () => {
  it('给了 positionId 就走岗位路由，并且不出岗位 chip（只有一个岗位）', async () => {
    renderWithProviders(<DeckSection positionId="asg_1" onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    expect(getPositionCards).toHaveBeenCalledWith('asg_1', {})
    expect(getHome).not.toHaveBeenCalled()
    expect(screen.queryByText(/^全部 /)).toBeNull()
  })
})

/**
 * WP141（docs/78 §1 #4）：牌堆能直接找到后面的卡。
 *
 * 走查里红人岗位的牌堆第一张是 campaign 名单卡、第二张是议价卡——想先批议价卡，
 * 卡型下拉只有「所有卡型」一项，名单卡又没有「稍后」，只能先把它批掉。
 */
describe('WP141：不决定前一张也能去后面的卡', () => {
  const campaign = draftCard({
    id: 'ap_cmp',
    kind: 'kol_campaign',
    layout: 'person',
    title: '挑人清单：夏季快充（2 人）',
    available_actions: ['approve', 'reject', 'open'],
  })
  const quote = draftCard({
    id: 'ap_quote',
    kind: 'staged_change',
    layout: 'money',
    title: '议价：Urban Pike 005 报价 800 USD',
  })

  it('「下一张」直接翻到议价卡，一个决定都没发', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [campaign, quote] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByText('挑人清单：夏季快充（2 人）')
    expect(screen.getByTestId('deck-prev')).toHaveProperty('disabled', true)
    await user.click(screen.getByTestId('deck-next'))
    expect(await screen.findByText('议价：Urban Pike 005 报价 800 USD')).toBeDefined()
    expect(screen.getByTestId('deck-progress').textContent).toBe('第 2 / 2 张')
    expect(decide).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('deck-prev'))
    expect(await screen.findByText('挑人清单：夏季快充（2 人）')).toBeDefined()
  })

  it('紧凑列表：每张一行，点议价那一行就翻到它', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [campaign, draftCard({ id: 'ap_x' }), quote] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await user.click(screen.getByTestId('deck-list-toggle'))
    const rows = within(screen.getByTestId('deck-list')).getAllByTestId('deck-list-item')
    expect(rows).toHaveLength(3)
    // 列表里的类别是人话，不是 kind 枚举
    expect(screen.getByTestId('deck-list').textContent).not.toMatch(/kol_campaign|staged_change/)
    await user.click(rows[2] as HTMLElement)
    expect(await screen.findByText('议价：Urban Pike 005 报价 800 USD')).toBeDefined()
    expect(screen.queryByTestId('deck-list')).toBeNull()
    expect(decide).not.toHaveBeenCalled()
  })

  it('提示行按这张卡真有的动作生成：没有「稍后」就不写 ↑', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [campaign, draftCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const hint = await screen.findByTestId('deck-keyboard')
    expect(hint.textContent).toContain('→')
    expect(hint.textContent).not.toContain('↑')
    expect(hint.textContent).not.toContain('↓')
    await user.click(screen.getByTestId('deck-next'))
    await waitFor(() => {
      expect(screen.getByTestId('deck-keyboard').textContent).toContain('↑')
    })
    // 字与按钮上的一样（出站文案卡的主动词是「发送」）
    expect(screen.getByTestId('deck-keyboard').textContent).toContain('→ 发送')
  })

  it('卡型下拉从全部牌算：选了一种之后别的卡型还在', async () => {
    home = homeData({ queue: [campaign, quote, draftCard()] })
    getHome.mockImplementation(async (...args: unknown[]) => {
      const f = (args[1] ?? {}) as { kind?: string }
      return f.kind === undefined
        ? home
        : { ...home, queue: home.queue.filter((c) => c.kind === f.kind) }
    })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    const select = screen.getByLabelText('卡型') as HTMLSelectElement
    await userEvent.selectOptions(select, 'kol_campaign')
    await waitFor(() => {
      expect(getHome).toHaveBeenLastCalledWith('yesterday', { kind: 'kol_campaign' })
    })
    const values = [...select.options].map((o) => o.value)
    expect(values).toEqual(expect.arrayContaining(['', 'kol_campaign', 'staged_change', 'outbound_draft']))
    // 下拉里没有 i18n 键或裸 kind
    expect([...select.options].map((o) => o.textContent).join(' ')).not.toMatch(/kind\.|_/)
    getHome.mockImplementation(async () => home)
  })

  it('「第 x / N 张」按合并前的张数：合并卡写成一段', async () => {
    home = homeData({ queue: [draftCard({ id: 'ap_m', merge_count: 3 }), quote] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    expect((await screen.findByTestId('deck-progress')).textContent).toBe('第 1–3 / 4 张')
    await userEvent.click(screen.getByTestId('deck-next'))
    await waitFor(() => {
      expect(screen.getByTestId('deck-progress').textContent).toBe('第 4 / 4 张')
    })
  })

  it('「改一下」提交后给一句「记下了」', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [draftCard(), quote] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    await screen.findByTestId('deck-card')
    await user.click(screen.getByText('改一下'))
    await user.type(screen.getByLabelText('一句话说清楚要怎么改'), '先道歉')
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect((await screen.findByTestId('deck-receipt')).textContent).toContain('记下了')
  })

  it('筛空了不说「队列清空了」，说这个筛选下没有卡了', async () => {
    home = homeData({ queue: [], filters: { kind: 'kol_campaign' } })
    renderWithProviders(<DeckSection onOpen={() => {}} filters={{ kind: 'kol_campaign' }} />)
    expect((await screen.findByTestId('deck-empty-title')).textContent).toBe('这个筛选下没有卡了')
    expect(screen.getByText('回到全部')).toBeDefined()
  })
})

describe('WP141：岗位页把本人几条职责的牌合成一副', () => {
  it('每条职责各取一次，计数相加，顺序按同一个比较器排', async () => {
    getPositionCards.mockImplementation(async (...args: unknown[]) => {
      const id = args[0] as string
      return {
        ...cards,
        cards: [draftCard({ id: `ap_${id}`, position_id: id, title: `卡 ${id}` })],
        counts: { total: 1, customer_waiting: 0, nobody_waiting: 0, matched: 1 },
      }
    })
    renderWithProviders(
      <DeckSection positionId="asg_1" positionIds={['asg_1', 'asg_2']} onOpen={() => {}} />,
    )
    expect((await screen.findByTestId('deck-progress')).textContent).toBe('第 1 / 2 张')
    expect(getPositionCards).toHaveBeenCalledWith('asg_1', {})
    expect(getPositionCards).toHaveBeenCalledWith('asg_2', {})
    getPositionCards.mockImplementation(async () => cards)
  })
})
