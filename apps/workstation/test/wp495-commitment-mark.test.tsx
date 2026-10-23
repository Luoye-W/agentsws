/**
 * WP495（1701）：「学到 N 条」卡与知识库「待确认」里，只有**真写了承诺**的条目挂小图标
 * （悬停出「含承诺，细看一眼」）；只有政策主题、没写答应什么的，和普通事实，一律不挂。假问答。
 */
import type { KnowledgeLearnedPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KnowledgeLearnedBody } from '@/components/deck/knowledge-learned-body'
import { KnowledgeRow } from '@/components/library/knowledge-groups'
import type { KnowledgeCardRow } from '@/lib/api'
import { renderWithProviders } from './helpers'

const item = (card_id: string, answer: string, extra: Record<string, unknown> = {}) => ({
  card_id,
  question: `Q ${card_id}`,
  answer,
  stage: 'both' as const,
  basis: '3 段往来',
  ...extra,
})

const payload: KnowledgeLearnedPayload = {
  form: 'knowledge_learned',
  job_id: 'klj_1',
  source: 'website',
  card_ids: ['fc_1', 'fc_2', 'fc_3', 'fc_4', 'fc_5'],
  items: [
    // 服务端判过：带 commitment
    item('fc_1', 'Returns are accepted within 30 days of delivery.', {
      hold: true,
      commitment: true,
    }),
    // 老卡没有 commitment 这一格：界面按答案现判
    item('fc_2', '保修期一年，坏了免费换新。', { hold: true }),
    // 政策主题、要人审（hold），但没写答应什么 → 不挂
    item('fc_3', 'For returns, please contact our support team first.', { hold: true }),
    // 普通事实（有数字，但不是承诺）→ 不挂
    item('fc_4', 'Orders usually ship in 2 business days.'),
    item('fc_5', 'Yes, we ship to Canada.'),
  ],
  before: null,
  after: '学到 5 条，待你确认',
}

const card = {
  id: 'ap_1',
  version: 1,
  position_id: 'asg_cs',
  layout: 'change',
  available_actions: ['approve', 'reject'],
  detail: { payload },
} as unknown as DeckCard

describe('WP495 1701 学到 N 条：只有真含承诺的挂小图标', () => {
  it('五条里只挂两条；悬停文案是「含承诺，细看一眼」；旧的整排小标不在了', () => {
    renderWithProviders(<KnowledgeLearnedBody card={card} payload={payload} />)
    const rows = screen.getAllByTestId('kl-card-item')
    const marked = rows.map((r) => within(r).queryByTestId('kl-commitment') !== null)
    expect(marked).toEqual([true, true, false, false, false])
    const mark = screen.getAllByTestId('kl-commitment')[0] as HTMLElement
    expect(mark.getAttribute('data-hint')).toBe('含承诺，细看一眼')
    expect(mark.getAttribute('aria-label')).toBe('含承诺，细看一眼')
    expect(screen.getByTestId('deck-knowledge-learned').textContent).not.toContain('政策，细看')
  })
})

describe('WP495 1701 知识库待确认', () => {
  const row = (statement: string, status: KnowledgeCardRow['status']): KnowledgeCardRow => ({
    id: `fc_${statement.length}`,
    layer: 'policy',
    subject: { type: 'policy', key: 'returns_refunds.x' },
    statement,
    status,
    updated_at: '2026-10-20T00:00:00.000Z',
  })

  it('待确认 + 真含承诺 → 挂；待确认没承诺 / 已生效 → 不挂', () => {
    const { unmount } = renderWithProviders(
      <ul>
        <KnowledgeRow card={row('We refund the full amount within 14 days.', 'proposed')} />
      </ul>,
    )
    expect(screen.getByTestId('kl-commitment')).toBeTruthy()
    unmount()
    const second = renderWithProviders(
      <ul>
        <KnowledgeRow card={row('Refund questions go to the support inbox.', 'proposed')} />
      </ul>,
    )
    expect(screen.queryByTestId('kl-commitment')).toBeNull()
    second.unmount()
    renderWithProviders(
      <ul>
        <KnowledgeRow card={row('We refund the full amount within 14 days.', 'active')} />
      </ul>,
    )
    expect(screen.queryByTestId('kl-commitment')).toBeNull()
  })
})
