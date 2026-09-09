/**
 * 37 §1 逐条对照表里**属于卡面**的那几行：
 * 2 标签行顺序、3 标题、4 内容盒一种语言、5 证据 chip 无裸 id、6 动作行、
 * 7 折叠区点开前不在 DOM、11 卡面顶部的「属于：事项 X」。
 */
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_QUICK_ACTIONS, quickActions } from '@/components/deck/deck-action-bar'
import { DeckCardView } from '@/components/deck/deck-card'
import {
  DECK_CARD_BODY_SCROLL_CLASS,
  DECK_CARD_MIN_HEIGHT_CLASS,
} from '@/components/deck/deck-layout'
import { draftCard, questionCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

afterEach(() => {
  vi.useRealTimers()
})

describe('37 §1 第 2 行：标签行顺序 = 渠道 → 优先级 → 倒计时 → 卡型 → 合并 N 张', () => {
  it('顺序固定，且**客户名不进标签行**', () => {
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          expires_at: new Date(Date.now() + 90_000).toISOString(),
          merge_count: 3,
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const row = screen.getByTestId('deck-tag-row')
    const texts = [...row.children].map((el) => el.textContent ?? '')
    expect(texts[0]).toBe('邮件')
    expect(texts[1]).toBe('排队')
    expect(texts[2]).toMatch(/^剩 1:/)
    expect(texts[3]).toBe('回复草稿待审')
    expect(texts[4]).toBe('合并 3 张')
    // 客户名在别处（详情 / 筛选），不在这一行
    expect(row.textContent).not.toContain('Anna Meyer')
  })

  it('P0 是红的，其余是主色', () => {
    const p0 = renderWithProviders(
      <DeckCardView
        card={draftCard({ priority_band: 'P0' })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-band').className).toContain('bg-destructive')
    p0.unmount()
    renderWithProviders(
      <DeckCardView
        card={draftCard({ priority_band: 'P1' })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-band').className).toContain('bg-primary')
  })

  it('一小时以上换粗粒度：不印「剩 6789:08」这种没人读得懂的大数', () => {
    const now = Date.parse('2026-09-07T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const hours = renderWithProviders(
      <DeckCardView
        card={draftCard({ expires_at: new Date(now + 5 * 3600_000).toISOString() })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-countdown').textContent).toBe('剩 5 小时')
    hours.unmount()
    renderWithProviders(
      <DeckCardView
        card={draftCard({ expires_at: new Date(now + 4 * 86_400_000).toISOString() })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-countdown').textContent).toBe('剩 4 天')
  })

  it('没有 expires_at 就没有倒计时徽章；一小时以内 mm:ss 每秒滴答', async () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByTestId('deck-countdown')).toBeNull()

    vi.useFakeTimers()
    const now = Date.parse('2026-09-07T00:00:00.000Z')
    vi.setSystemTime(now)
    renderWithProviders(
      <DeckCardView
        card={draftCard({ id: 'ap_2', expires_at: new Date(now + 90_000).toISOString() })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getAllByTestId('deck-countdown')[0]?.textContent).toBe('剩 1:30')
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getAllByTestId('deck-countdown')[0]?.textContent).toBe('剩 1:28')
    // 过期后是「已过期」，不是 0:00
    await act(async () => {
      vi.advanceTimersByTime(100_000)
    })
    expect(screen.getAllByTestId('deck-countdown')[0]?.textContent).toBe('已过期')
  })
})

describe('37 §1 第 1 / 3 行：卡片几何与标题', () => {
  it('min-h 320、内容区 max-h 420 卡内滚', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByTestId('deck-card').className).toContain(DECK_CARD_MIN_HEIGHT_CLASS)
    for (const cls of DECK_CARD_BODY_SCROLL_CLASS.split(' '))
      expect(screen.getByTestId('deck-body').className).toContain(cls)
  })

  it('标题单行 15px 半粗', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const title = screen.getByText(draftCard().title)
    expect(title.className).toContain('text-[15px]')
    expect(title.className).toContain('font-semibold')
  })
})

describe('37 §1 第 4 行：内容盒一次只显示一种语言', () => {
  it('中文摘要 / 原文各显示一种，不堆叠', () => {
    const card = draftCard()
    const zh = renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const box = screen.getByTestId('deck-content')
    expect(box.textContent).toBe(card.content_variants.zh_summary)
    expect(box.textContent).not.toContain('jacket')
    zh.unmount()

    renderWithProviders(<DeckCardView card={card} mode="original" onDecide={noop} onOpen={noop} />)
    expect(screen.getByTestId('deck-content').textContent).toBe(card.content_variants.original)
    expect(screen.queryByTestId('deck-content-fallback')).toBeNull()
  })

  it('这张卡没有那种语言 → 回退中文摘要并出琥珀小字', () => {
    renderWithProviders(<DeckCardView card={draftCard()} mode="en" onDecide={noop} onOpen={noop} />)
    const box = screen.getByTestId('deck-content')
    expect(box.getAttribute('data-mode')).toBe('zh_summary')
    const hint = screen.getByTestId('deck-content-fallback')
    expect(hint.className).toContain('amber')
  })
})

describe('37 §1 第 5 行：证据 chip 走 i18n，实体 chip 另起一行，DOM 里没有裸 id', () => {
  it('证据 chip 是人话，不是 key 也不是 id', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByText('预检通过')).toBeDefined()
    expect(screen.getByText('引用了 1 条知识')).toBeDefined()
    expect(screen.getByText('订单：已查单 #1001')).toBeDefined()
    expect(screen.queryByText('evidence.precheck.ok')).toBeNull()
  })

  it('整张卡的 DOM 文本里不出现 fact_ / cus_ / run_ 前缀', async () => {
    const { container } = renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(container.textContent ?? '').not.toMatch(/fact_|cus_|run_|ord_/)
    // 展开详情后 run id 才露出来（37：run id 只进详情）
    await userEvent.click(screen.getByTestId('deck-body'))
    expect(screen.getByTestId('deck-detail').textContent).toContain('run_demo_42')
  })

  it('实体 chip 另起一行，只印展示名；无权看的留一行 note', () => {
    renderWithProviders(
      <DeckCardView
        card={draftCard({ detail: { ...draftCard().detail, enrichment: { dropped_refs: 2 } } })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const row = screen.getByTestId('entity-chips')
    expect(within(row).getByText('订单 #1001')).toBeDefined()
    expect(within(row).getByText('退货窗口 14 天')).toBeDefined()
    expect(row.textContent).not.toContain('fact_775c')
    expect(screen.getByTestId('enrichment-note').textContent).toContain('2')
  })
})

describe('37 §1 第 6 行：动作行 ≤ 3 快捷决定 + 安静区，没有「更多」也没有「详情 ▾」', () => {
  it('快捷行是三个决定，approve 是主按钮，动词来自服务端', () => {
    const card = draftCard()
    renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(quickActions(card)).toEqual(['approve', 'reject', 'instruct'])
    expect(quickActions(card).length).toBeLessThanOrEqual(MAX_QUICK_ACTIONS)
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).getByText('发送')).toBeDefined()
    expect(within(bar).queryByText('批准')).toBeNull()
    expect(within(bar).getByText('发送').closest('button')?.className.includes('bg-primary')).toBe(
      true,
    )
  })

  it('右侧安静区是「需要补素材」与「稍后」', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).getByText('需要补素材')).toBeDefined()
    expect(within(bar).getByText('稍后')).toBeDefined()
  })

  it('没有「更多」溢出菜单，也没有「详情 ▾」按钮', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByLabelText('更多动作')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    const bar = screen.getByTestId('deck-action-bar')
    expect(bar.textContent).not.toContain('详情')
  })

  it('点卡面展开详情（不是点一个「详情」按钮）', async () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByTestId('deck-detail')).toBeNull()
    await userEvent.click(screen.getByTestId('deck-body'))
    expect(screen.getByTestId('deck-detail')).toBeDefined()
    await userEvent.click(screen.getByTestId('deck-body'))
    expect(screen.queryByTestId('deck-detail')).toBeNull()
  })

  it('点「发送」带 version 走 decide；点动作行里的按钮不会顺手展开详情', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    await userEvent.click(screen.getByText('发送'))
    expect(onDecide).toHaveBeenCalledWith({ action: 'approve', version: 1 })
    expect(screen.queryByTestId('deck-detail')).toBeNull()
  })

  it('已决定的卡没有决定按钮', () => {
    const card = draftCard({
      status: 'applied',
      available_actions: ['open'],
      action_labels: { open: '打开' },
    })
    renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(quickActions(card)).toEqual([])
    expect(screen.getByText('已处理')).toBeDefined()
  })
})

describe('选择题卡（36 §2.1：裸 approve 服务端会拒）', () => {
  it('没选中时 approve 是禁用的，并说清楚要先选一个', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={questionCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    expect(screen.getByText('就这么定').closest('button')?.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('deck-action-bar').textContent).toContain('先选一个')
  })

  it('选了之后带 selected_option_id 走 decide；选项是单选不是输入框', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={questionCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    const options = screen.getByTestId('deck-card-options')
    expect(within(options).getAllByRole('radio')).toHaveLength(2)
    expect(within(options).queryByRole('textbox')).toBeNull()
    await userEvent.click(screen.getByText('宽限 7 天，照退'))
    await userEvent.click(screen.getByText('就这么定'))
    expect(onDecide).toHaveBeenCalledWith({
      action: 'approve',
      selected_option_id: 'grace_7',
      version: 1,
    })
  })
})

describe('37 §1 第 7 行：折叠区点开前不在 DOM 里', () => {
  it('指导 / 拒绝理由 / 补素材 / 问 AI 四块，收起时一个都不在', () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByTestId('deck-panel-instruct')).toBeNull()
    expect(screen.queryByTestId('deck-panel-reject')).toBeNull()
    expect(screen.queryByTestId('deck-panel-supplement')).toBeNull()
    expect(screen.queryByTestId('ask-ai-panel')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('点「指导」才挂出 textarea + 作用域；写了字才提交，落成 instruct + scope', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    await userEvent.click(screen.getByText('指导'))
    const panel = screen.getByTestId('deck-panel-instruct')
    expect(within(panel).getByTestId('deck-scopes')).toBeDefined()
    // 问 AI 只在指导区里出现，且是禁用占位
    expect(within(panel).getByTestId('ask-ai-panel')).toBeDefined()

    const submit = within(panel).getByRole('button', { name: '提交' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    await userEvent.click(within(panel).getByText('类似情况都这样'))
    await userEvent.type(within(panel).getByLabelText('一句话说清楚要怎么改'), '别提补偿')
    await userEvent.click(within(panel).getByRole('button', { name: '提交' }))

    expect(onDecide).toHaveBeenCalledWith({
      action: 'instruct',
      version: 1,
      instruction: { scope: 'similar_cases', text: '别提补偿' },
      reason: '别提补偿',
    })
  })

  it('点「不发」开的是拒绝理由框（14 §4：原因必填），没有作用域选择', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    await userEvent.click(screen.getByText('不发'))
    const panel = screen.getByTestId('deck-panel-reject')
    expect(within(panel).queryByTestId('deck-scopes')).toBeNull()
    expect(within(panel).queryByTestId('ask-ai-panel')).toBeNull()
    expect(within(panel).getByRole('button', { name: '提交' }).hasAttribute('disabled')).toBe(true)
    await userEvent.type(within(panel).getByRole('textbox'), '客户没说要退')
    await userEvent.click(within(panel).getByRole('button', { name: '提交' }))
    expect(onDecide).toHaveBeenCalledWith({ action: 'reject', version: 1, reason: '客户没说要退' })
  })

  it('「需要补素材」开的是 ai_question 的反向入口占位，可以先放一放', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={noop} />,
    )
    await userEvent.click(screen.getByText('需要补素材'))
    const panel = screen.getByTestId('deck-panel-supplement')
    await userEvent.click(within(panel).getByText('先放一放'))
    expect(onDecide).toHaveBeenCalledWith({ action: 'snooze', version: 1 })
  })

  it('返回把折叠区收回 DOM 之外', async () => {
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    await userEvent.click(screen.getByText('指导'))
    await userEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByTestId('deck-panel-instruct')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('37 §1 第 11 行：卡面顶部的「属于：事项 X」', () => {
  it('有 matter_id 才出这一行，点它调 onOpen（事项页由 WP22 做）', async () => {
    const onOpen = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={noop} onOpen={onOpen} />,
    )
    expect(screen.queryByTestId('deck-matter-link')).toBeNull()

    const card = draftCard({ id: 'ap_m', matter_id: 'mat_7', matter_label: 'Anna 的退货' })
    renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={onOpen} />,
    )
    const link = screen.getByTestId('deck-matter-link')
    expect(link.textContent).toBe('属于：事项 Anna 的退货')
    await userEvent.click(link)
    expect(onOpen).toHaveBeenCalledWith(card)
  })

  it('没有展示名时退到 id，但那也是事项 id，不是证据里的裸 ref', () => {
    renderWithProviders(
      <DeckCardView
        card={draftCard({ matter_id: 'mat_7' })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-matter-link').textContent).toContain('mat_7')
  })
})
