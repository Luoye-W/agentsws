/**
 * WP489（决策 1709）：「没对上红人的往来 / 没找到往来的红人」那张卡——卡里就地选是谁、补邮箱，
 * 「记下」带着选过 / 填过的那几处批（approve + edited_payload）；不确定的留空不送。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const decide = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (...args: unknown[]) => decide(...args) }
})

const { KolMailMatchBody, isKolMailMatchPayload } = await import(
  '@/components/kol/kol-mail-match-body'
)

const payload = {
  form: 'kol_mail_match' as const,
  months: 12,
  threads: [
    {
      thread_id: 't_a',
      subject: 'Collab inquiry',
      from: 'stranger@studio.example',
      at: '2026-06-01T00:00:00Z',
      snippet: 'Could we discuss a sponsorship?',
      candidates: [],
    },
    {
      thread_id: 't_b',
      subject: 'Rates',
      from: 'team@desk.example',
      at: '2026-05-05T00:00:00Z',
      snippet: 'Rosa Desk asked me…',
      candidates: [{ creator_id: 'cre_rosa', name: 'Rosa Desk', signals: ['提到 Rosa Desk'] }],
    },
  ],
  creators: [{ creator_id: 'cre_leo', name: 'Leo Builds', has_email: false }],
  pool: [
    { creator_id: 'cre_rosa', name: 'Rosa Desk' },
    { creator_id: 'cre_leo', name: 'Leo Builds' },
  ],
}
const card = {
  id: 'ap_m',
  version: 1,
  position_id: 'asg_yt',
  layout: 'policy',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
  detail: { payload },
} as unknown as DeckCard

describe('WP489 对不上人的往来那张卡', () => {
  it('每段一个下拉（候选人排前面）、没往来的人一个邮箱框；「记下」只送选过 / 填过的', async () => {
    expect(isKolMailMatchPayload(payload)).toBe(true)
    expect(isKolMailMatchPayload({ form: 'faq_import' })).toBe(false)
    renderWithProviders(<KolMailMatchBody card={card} payload={payload} />)
    const selects = screen.getAllByTestId('kol-mail-match-select') as HTMLSelectElement[]
    expect(selects).toHaveLength(2)
    // 候选人排在「不确定」后面第一个
    expect(selects[1]?.options[1]?.textContent).toBe('Rosa Desk')
    fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: 'cre_leo' } })
    fireEvent.change(screen.getByTestId('kol-mail-match-email'), {
      target: { value: 'leo@leobuilds.example' },
    })
    fireEvent.click(screen.getByTestId('kol-mail-match-save'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    const body = decide.mock.calls[0]?.[1] as {
      action: string
      edited_payload: Record<string, unknown>
    }
    expect(body.action).toBe('approve')
    expect(body.edited_payload.assign).toEqual([{ thread_id: 't_a', creator_id: 'cre_leo' }])
    expect(body.edited_payload.emails).toEqual([
      { creator_id: 'cre_leo', email: 'leo@leobuilds.example' },
    ])
  })
})
