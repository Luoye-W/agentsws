/** 36 §5.4：五动作矩阵、快捷行 ≤ 3、选择题卡裸 approve 被拒、指导抽屉先选作用域、证据芯片带出处。 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MAX_QUICK_ACTIONS, quickActions } from '@/components/deck/deck-action-bar'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard, questionCard } from './fixtures'
import { renderWithProviders } from './helpers'

describe('卡片的动作矩阵', () => {
  it('快捷行最多三个按钮，动词来自服务端', () => {
    const card = draftCard()
    renderWithProviders(<DeckCardView card={card} onDecide={() => {}} />)
    const bar = screen.getByTestId('deck-action-bar')
    const buttons = within(bar).getAllByRole('button')
    // 三个快捷键 + 一个「更多」
    expect(buttons.length).toBeLessThanOrEqual(MAX_QUICK_ACTIONS + 1)
    expect(quickActions(card)).toEqual(['approve', 'reject', 'instruct'])
    expect(within(bar).getByText('发送')).toBeDefined()
    expect(within(bar).getByText('不发')).toBeDefined()
    expect(within(bar).getByText('指导')).toBeDefined()
    // 「批准」这个词不该出现在回复草稿卡上
    expect(within(bar).queryByText('批准')).toBeNull()
  })

  it('点「发送」就带 version 走 decide', async () => {
    const onDecide = vi.fn()
    renderWithProviders(<DeckCardView card={draftCard()} onDecide={onDecide} />)
    await userEvent.click(screen.getByText('发送'))
    expect(onDecide).toHaveBeenCalledWith({ action: 'approve', version: 1 })
  })

  it('已决定的卡只剩「打开」，没有决定按钮', () => {
    const card = draftCard({
      status: 'applied',
      available_actions: ['open'],
      action_labels: { open: '打开' },
    })
    renderWithProviders(<DeckCardView card={card} onDecide={() => {}} />)
    expect(quickActions(card)).toEqual([])
    expect(screen.getByText('已处理')).toBeDefined()
  })
})

describe('选择题卡', () => {
  it('裸 approve 不发请求，界面先提示要选一个', async () => {
    const onDecide = vi.fn()
    renderWithProviders(<DeckCardView card={questionCard()} onDecide={onDecide} />)
    await userEvent.click(screen.getByText('就这么定'))
    expect(onDecide).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('选一个')
  })

  it('选了之后带 selected_option_id 走 decide', async () => {
    const onDecide = vi.fn()
    renderWithProviders(<DeckCardView card={questionCard()} onDecide={onDecide} />)
    await userEvent.click(screen.getByText('宽限 7 天，照退'))
    await userEvent.click(screen.getByText('就这么定'))
    expect(onDecide).toHaveBeenCalledWith({
      action: 'approve',
      selected_option_id: 'grace_7',
      version: 1,
    })
  })

  it('选项区是一组单选，不是自由输入框', () => {
    renderWithProviders(<DeckCardView card={questionCard()} onDecide={() => {}} />)
    const options = screen.getByTestId('deck-card-options')
    expect(within(options).getAllByRole('radio')).toHaveLength(2)
    expect(within(options).queryByRole('textbox')).toBeNull()
  })
})

describe('指导抽屉（36 §2.1：先选作用域，再一句话）', () => {
  it('没选作用域时提交是禁用的；选了并写了字才能发', async () => {
    const onDecide = vi.fn()
    renderWithProviders(<DeckCardView card={draftCard()} onDecide={onDecide} />)
    await userEvent.click(screen.getByText('指导'))

    const submit = screen.getByRole('button', { name: '发出指导' })
    expect(submit.hasAttribute('disabled')).toBe(true)

    await userEvent.click(screen.getByText('类似情况都这样'))
    expect(screen.getByRole('button', { name: '发出指导' }).hasAttribute('disabled')).toBe(true)

    await userEvent.type(screen.getByLabelText('一句话说清楚要怎么改'), '别提补偿')
    await userEvent.click(screen.getByRole('button', { name: '发出指导' }))

    expect(onDecide).toHaveBeenCalledWith({
      action: 'instruct',
      instruction: { scope: 'similar_cases', text: '别提补偿' },
      version: 1,
    })
  })
})

describe('证据与详情', () => {
  it('证据芯片出的是人话 + 出处，不是裸枚举', () => {
    renderWithProviders(<DeckCardView card={draftCard()} onDecide={() => {}} />)
    expect(screen.getByText('预检通过')).toBeDefined()
    expect(screen.getByText('引用了知识')).toBeDefined()
    expect(screen.getByText('fc_1')).toBeDefined()
    expect(screen.queryByText('evidence.precheck.ok')).toBeNull()
  })

  it('金额与订单号来自结构化字段', () => {
    renderWithProviders(<DeckCardView card={draftCard()} onDecide={() => {}} />)
    expect(screen.getByText('42 USD')).toBeDefined()
    expect(screen.getByText('#1001')).toBeDefined()
  })

  it('展开详情才有「问 AI」，而且是禁用的占位', async () => {
    renderWithProviders(<DeckCardView card={draftCard()} onDecide={() => {}} />)
    expect(screen.queryByTestId('ask-ai-panel')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /详情/ }))
    const panel = screen.getByTestId('ask-ai-panel')
    expect(within(panel).getByRole('textbox').hasAttribute('disabled')).toBe(true)
  })
})
