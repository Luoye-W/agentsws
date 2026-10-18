/**
 * WP385：网站体检设置那张「我打算改成这样」卡——只列要改的那一格（现值空 → 新地址）；
 * 格子的字服务端给中文，界面是英文时换成英文（表里有那一格才换）。
 */
import type { SetupRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { AppProvider } from '@/lib/app-context'
import { draftCard } from './fixtures'

const noop = (): void => {}
const FEED = 'https://feeds.nordvolt.example/google.xml'

const payload: SetupRequestPayload = {
  form: 'setup_request',
  target: 'site.health',
  why: '按你说的记进体检设置。',
  mode: 'change',
  fields: [
    {
      key: 'feed_url',
      label: '商品 feed',
      kind: 'url',
      current: '',
      suggested: FEED,
      suggested_why: '你刚才说的',
      required: false,
    },
    {
      key: 'listings_add',
      label: '加上架页',
      kind: 'text',
      placeholder: '平台 | 商品 handle | 网址',
      current: '',
      required: false,
    },
  ],
}

function card(): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_health',
    kind: 'setup_request',
    layout: 'policy',
    title: '网站体检设置：我打算改成这样',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '就这样', reject: '先不设', snooze: '稍后' },
    detail: { ...base.detail, payload: payload as never },
  })
}

function renderIn(lang: 'zh' | 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <AppProvider initialTheme="light" initialLang={lang} initialPosition="asg_1">
        <MemoryRouter>
          <DeckCardView card={card()} mode="zh_summary" onDecide={noop} onOpen={noop} />
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
}

describe('WP385 体检设置卡', () => {
  it('中文：只列 feed 那一格（不设 → 新地址），其余不动', async () => {
    renderIn('zh')
    const rows = await screen.findAllByTestId('setup-plan-row')
    expect(rows).toHaveLength(1)
    const row = rows[0] as HTMLElement
    expect(row.textContent).toContain('商品 feed')
    expect(within(row).getByTestId('setup-plan-value').textContent).toBe(FEED)
    expect(screen.getByText('其余不动')).toBeTruthy()
  })
  it('英文：格子的字换成英文', async () => {
    renderIn('en')
    const row = (await screen.findAllByTestId('setup-plan-row'))[0] as HTMLElement
    expect(row.textContent).toContain('Product feed')
    expect(row.textContent).not.toContain('商品 feed')
  })
})
