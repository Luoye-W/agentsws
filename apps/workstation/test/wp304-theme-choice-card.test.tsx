/**
 * WP304（决策 445）：选主题卡（「选一个」）与买高级主题卡（「花钱」）在卡片流里的样子。
 * 按钮字由服务端那张表给（就用这个 / 买下 · 先不买），键盘提示跟着实际按钮走。
 */
import type { ThemeChoicePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

const payload = (over: Partial<ThemeChoicePayload> = {}): ThemeChoicePayload => ({
  form: 'theme_choice',
  shop: 'rovella-gear.myshopify.com',
  premium: { status: 'buy', price_credits: 560, price_usd: 80 },
  store_themes: [
    { id: '1', name: 'Horizon', role: 'main', theme_name: 'Horizon', usable: true },
    { id: '2', name: 'Spring', role: 'unpublished', theme_name: 'Lumen', usable: true },
    { id: '3', name: 'Old shop', role: 'unpublished', usable: false },
  ],
  theme_store_url: 'https://themes.shopify.com/themes/horizon',
  options: [
    { id: 'premium', label: '高级主题 · $80 · 560 积分' },
    { id: 'store:1', label: 'Horizon（线上）' },
    { id: 'store:2', label: 'Spring · Lumen' },
  ],
  ...over,
})

function choiceCard(p: ThemeChoicePayload): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_theme_choice',
    kind: 'theme_choice',
    layout: 'choice',
    options: p.options,
    available_actions: ['approve', 'snooze', 'open'],
    action_labels: { approve: '就用这个', snooze: '稍后' },
    detail: { ...base.detail, payload: p as unknown as Record<string, unknown> },
  })
}

const render = (card: DeckCard): void => {
  renderWithProviders(<DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />)
}

describe('选主题卡（WP304）', () => {
  it('高级主题排第一（卖点 + 价格 + 预览占位）；免费主题能选，太老的只列不选；按钮「就用这个」', async () => {
    render(choiceCard(payload()))
    const box = screen.getByTestId('theme-choice')
    const radios = within(box).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    const premium = screen.getByTestId('theme-choice-premium')
    expect(premium.textContent).toContain('高级主题')
    expect(screen.getByTestId('theme-choice-price').textContent).toBe(
      '$80 · 560 积分 · 这家店一次买断',
    )
    expect(screen.getAllByTestId('theme-choice-store')).toHaveLength(2)
    expect(screen.getByTestId('theme-choice-too-old').textContent).toContain('太老，改不了')
    await userEvent.click(screen.getByText('Spring'))
    expect(radios[2]?.getAttribute('aria-checked')).toBe('true')
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).getByText('就用这个')).toBeTruthy()
    expect(within(bar).queryByText('都不是')).toBeNull()
  })

  it('WP418 U8：卡头不出「剩 N 天」，也不出「AI」角标', () => {
    const card = choiceCard(payload())
    render({
      ...card,
      expires_at: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
    })
    const row = screen.getByTestId('deck-tag-row')
    expect(within(row).queryByTestId('deck-wait')).toBeNull()
    expect(row.textContent).not.toContain('AI')
  })

  it('即将开放那一行只看不选；免费主题照常', () => {
    render(
      choiceCard(
        payload({
          premium: { status: 'soon', price_credits: 560, price_usd: 80 },
          options: [{ id: 'store:1', label: 'Horizon（线上）' }],
          store_themes: [
            { id: '1', name: 'Horizon', role: 'main', theme_name: 'Horizon', usable: true },
          ],
        }),
      ),
    )
    const premium = screen.getByTestId('theme-choice-premium')
    expect(premium.dataset.status).toBe('soon')
    expect(premium.textContent).toContain('即将开放')
    expect(within(premium).queryByRole('radio')).toBeNull()
    expect(within(screen.getByTestId('theme-choice')).getAllByRole('radio')).toHaveLength(1)
  })

  it('店里一份能改的都没有：给主题商店的链接', () => {
    render(
      choiceCard(
        payload({
          options: [{ id: 'premium', label: '高级主题' }],
          store_themes: [{ id: '3', name: 'Old shop', role: 'main', usable: false }],
        }),
      ),
    )
    const link = screen.getByTestId('theme-choice-store-link')
    expect(link.getAttribute('href')).toBe('https://themes.shopify.com/themes/horizon')
    expect(link.textContent).toContain('去主题商店装 Horizon')
  })
})

describe('买高级主题卡（WP304，「花钱」家族）', () => {
  it('按钮是「买下 / 先不买」', () => {
    const base = draftCard()
    render(
      draftCard({
        id: 'ap_theme_purchase',
        kind: 'theme_purchase',
        layout: 'policy',
        title: '买下高级主题？',
        available_actions: ['approve', 'reject', 'snooze', 'open'],
        action_labels: { approve: '买下', reject: '先不买', snooze: '稍后' },
        detail: { ...base.detail, payload: { form: 'theme_purchase', price_credits: 560 } },
      }),
    )
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).getByText('买下')).toBeTruthy()
    expect(within(bar).getByText('先不买')).toBeTruthy()
    expect(screen.getByTestId('deck-band').textContent).toContain('高级主题')
    // 「花钱」卡：一个大数，不出「点通过以后都这样做」那一行
    expect(screen.getByTestId('deck-layout-theme-purchase').textContent).toContain('560 积分')
    expect(screen.queryByText(/以后都这样做/)).toBeNull()
  })
})
