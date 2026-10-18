/**
 * WP418（审计 A3 / U7）：事项时间线里的选主题卡也是富卡——高级主题排第一（不能买也灰着、带原因），
 * 先选一个再点「就用这个」，带上选中的那一项。
 */
import type { MatterEvent, ThemeChoicePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InlineCard } from '@/components/matter/matter-timeline'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const payload: ThemeChoicePayload = {
  form: 'theme_choice',
  shop: 'rovella-gear.myshopify.com',
  premium: { status: 'needs_account', price_credits: 560, price_usd: 80 },
  store_themes: [
    { id: '1', name: 'Horizon', role: 'main', theme_name: 'Horizon', usable: true },
    { id: '3', name: 'Old shop', role: 'unpublished', usable: false },
  ],
  theme_store_url: 'https://themes.shopify.com/themes/horizon',
  options: [{ id: 'store:1', label: 'Horizon（线上）' }],
}

const card = (): DeckCard => {
  const base = draftCard()
  return draftCard({
    id: 'ap_theme_choice',
    kind: 'theme_choice',
    layout: 'choice',
    status: 'pending',
    options: payload.options,
    available_actions: ['approve', 'reject', 'open'],
    detail: { ...base.detail, payload: payload as unknown as Record<string, unknown> },
  })
}

const event = {
  id: 'ev_1',
  matter_id: 'm_1',
  at: '2026-10-19T00:00:00.000Z',
  kind: 'approval_requested',
  text: '选主题',
  actor: { kind: 'agent', id: 'site' },
  approval_item_id: 'ap_theme_choice',
} as unknown as MatterEvent

describe('事项里的选主题卡（WP418）', () => {
  it('画成富卡：高级主题灰着带原因，免费主题能选，选了才能「就用这个」', async () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <InlineCard
        event={event}
        card={card()}
        loading={false}
        roleName="建站"
        onDecide={onDecide}
        deciding={false}
      />,
    )
    const premium = screen.getByTestId('theme-choice-premium')
    expect(premium.textContent).toContain('登录工坊账号后可买')
    expect(within(premium).queryByRole('radio')).toBeNull()
    expect(screen.getByTestId('theme-choice-too-old')).toBeTruthy()
    const approve = screen.getByTestId('matter-card-approve')
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByText('Horizon'))
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(approve)
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ap_theme_choice' }),
      'approve',
      'store:1',
    )
  })
})
