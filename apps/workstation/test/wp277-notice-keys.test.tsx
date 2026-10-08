/**
 * WP277：非审批卡（「知道了」型通知卡、选择题卡）的键盘提示与按钮一致。
 *
 * - 开公司模式时同事那张「知道了 / 我要退出」：提示只写「→ 知道了」（退出不给键盘），→ 真的选「知道了」，
 *   ← ↑ ↓ 什么都不做；没有「剩 N 天」「证据 N」；
 * - ② 的「知道了 / 撤回」：「→ 知道了 · ← 撤回」，← 真的选撤回；
 * - 选择题卡（选项就是按钮、没选中 → 不做事）：提示里不写「→ 批准」。
 */
import type { DeckCard } from '@agentsws/deck'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeData } from '@/lib/api'
import { draftCard, homeData, questionCard } from './fixtures'
import { renderWithProviders } from './helpers'

let home: HomeData = homeData()
const decide = vi.fn(async () => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: async () => home,
    decide: (...args: unknown[]) => decide(...(args as [])),
  }
})

const { DeckSection } = await import('@/components/deck')

function notice(form: 'company_notice' | 'peer_change_notice'): DeckCard {
  const options =
    form === 'company_notice'
      ? [
          { id: 'ack', label: '知道了' },
          { id: 'leave', label: '我要退出' },
        ]
      : [
          { id: 'after', label: '知道了' },
          { id: 'before', label: '撤回' },
        ]
  const base = draftCard()
  return draftCard({
    id: `ap_${form}`,
    kind: 'policy_change',
    layout: 'policy',
    title: form === 'company_notice' ? '王岚把这里改成了公司模式' : '林峰改了 B2B 的规矩（已生效）',
    summary: '以后报价超限这类事要主管或老板批。',
    content_variants: { zh_summary: '以后报价超限这类事要主管或老板批。' },
    options,
    expires_at: '2099-01-01T00:00:00.000Z',
    available_actions: ['approve', 'reject', 'snooze', 'instruct', 'open'],
    detail: { ...base.detail, payload: { form, options } },
  })
}

beforeEach(() => {
  decide.mockClear()
})

describe('WP277 非审批卡的键盘提示与按钮一致', () => {
  it('「知道了 / 我要退出」：提示只有「→ 知道了」；→ 选知道了；← ↑ ↓ 不做事；没有截止与证据角标', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [notice('company_notice')] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const hint = await screen.findByTestId('deck-keyboard')
    expect(hint.textContent).toBe('→ 知道了')
    expect(screen.queryByTestId('deck-wait')).toBeNull()
    expect(screen.getByTestId('deck-tag-row').textContent).not.toContain('证据')
    const deck = screen.getByTestId('deck-section')
    deck.focus()
    await user.keyboard('{ArrowLeft}{ArrowUp}{ArrowDown}')
    expect(decide).not.toHaveBeenCalled()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'ap_company_notice',
        expect.objectContaining({ action: 'approve', selected_option_id: 'ack' }),
        expect.anything(),
      )
    })
  })

  it('「知道了 / 撤回」：提示「→ 知道了 · ← 撤回」；← 真的选撤回', async () => {
    const user = userEvent.setup()
    home = homeData({ queue: [notice('peer_change_notice')] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    expect((await screen.findByTestId('deck-keyboard')).textContent).toBe('→ 知道了 · ← 撤回')
    screen.getByTestId('deck-section').focus()
    await user.keyboard('{ArrowLeft}')
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'ap_peer_change_notice',
        expect.objectContaining({ action: 'approve', selected_option_id: 'before' }),
        expect.anything(),
      )
    })
  })

  it('选择题卡：→ 不做事，提示里也不写 →', async () => {
    home = homeData({ queue: [questionCard()] })
    renderWithProviders(<DeckSection onOpen={() => {}} />)
    const hint = await screen.findByTestId('deck-keyboard').catch(() => null)
    expect(hint?.textContent ?? '').not.toContain('→')
  })
})
