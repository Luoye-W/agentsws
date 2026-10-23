/**
 * WP488（决策 1680–1682）：「学到 N 条」卡——每条一问一答 + 依据 + 范围下拉 +「不要这条」；
 * 主按钮「采纳 K 条」带着改过的范围与去掉的那几条批；卡底那排不再出一个点不对的「批准」。
 * 「这几条可能过期」卡：都没变 / 按网站重学。假问答，不放任何真实客户数据。
 */
import type { KnowledgeLearnedPayload, KnowledgeStalePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const decide = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (...args: unknown[]) => decide(...args) }
})

const { KnowledgeLearnedBody, KnowledgeStaleBody } = await import(
  '@/components/deck/knowledge-learned-body'
)
const { quickActions } = await import('@/components/deck/deck-action-bar')

const payload: KnowledgeLearnedPayload = {
  form: 'knowledge_learned',
  job_id: 'klj_1',
  source: 'email',
  card_ids: ['fc_1', 'fc_2', 'fc_3'],
  items: [
    {
      card_id: 'fc_1',
      question: 'How do refunds work?',
      answer: 'Back to the card in 5 days.',
      stage: 'postsales',
      basis: '4 段往来',
      hold: true,
    },
    {
      card_id: 'fc_2',
      question: 'Bundle discount?',
      answer: '10% off.',
      stage: 'presales',
      basis: '3 段往来',
    },
    {
      card_id: 'fc_3',
      question: 'Do you ship to Canada?',
      answer: 'Yes.',
      stage: 'both',
      basis: '3 段往来',
    },
  ],
  before: null,
  after: '学到 3 条，待你确认',
}
const card = (p: unknown) =>
  ({
    id: 'ap_1',
    version: 3,
    position_id: 'asg_cs',
    layout: 'change',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    detail: { payload: p },
  }) as unknown as DeckCard

describe('WP488 学到 N 条', () => {
  it('卡底不出「批准」；改一条范围、去掉一条再采纳 = 带着改动批', async () => {
    expect(quickActions(card(payload))).not.toContain('approve')
    decide.mockClear()
    renderWithProviders(<KnowledgeLearnedBody card={card(payload)} payload={payload} />)
    const box = screen.getByTestId('deck-knowledge-learned')
    expect(box.textContent).toContain('依据：4 段往来')
    expect(box.textContent).toContain('含承诺')
    expect(screen.getByTestId('kl-card-confirm').textContent).toBe('采纳 3 条')
    const selects = screen.getAllByTestId('kl-card-stage') as HTMLSelectElement[]
    expect(selects.map((s) => s.value)).toEqual(['postsales', 'presales', 'both'])
    fireEvent.change(selects[2] as HTMLSelectElement, { target: { value: 'presales' } })
    fireEvent.click(screen.getAllByTestId('kl-card-drop')[1] as HTMLElement)
    expect(screen.getByTestId('kl-card-confirm').textContent).toBe('采纳 2 条')
    fireEvent.click(screen.getByTestId('kl-card-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [id, body] = decide.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('ap_1')
    expect(body.action).toBe('approve')
    expect(body.edited_payload).toMatchObject({ stages: { fc_3: 'presales' }, drop: ['fc_2'] })
  })

  it('没改就原样批', async () => {
    decide.mockClear()
    renderWithProviders(<KnowledgeLearnedBody card={card(payload)} payload={payload} />)
    fireEvent.click(screen.getByTestId('kl-card-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [, body] = decide.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.edited_payload).toBeUndefined()
  })
})

describe('WP488 这几条可能过期', () => {
  const stale: KnowledgeStalePayload = {
    form: 'knowledge_stale',
    recheck_ids: ['rck_1'],
    items: [
      {
        recheck_id: 'rck_1',
        card_id: 'fc_1',
        statement: 'Q: Return window? A: 30 days.',
        url: 'https://shop.test/policies/refund-policy',
        change: '30 天 → 14 天',
      },
    ],
    before: null,
    after: '1 条可能过期',
  }
  it('「按网站重学」带 resolution', async () => {
    decide.mockClear()
    renderWithProviders(<KnowledgeStaleBody card={card(stale)} payload={stale} />)
    expect(screen.getByTestId('deck-knowledge-stale').textContent).toContain('30 天 → 14 天')
    fireEvent.click(screen.getByTestId('kl-stale-relearn'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [, body] = decide.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.edited_payload).toMatchObject({ resolution: 'relearn' })
  })
})
