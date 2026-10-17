/**
 * WP387（docs/103 v2 T1）：「在你的 Google 账号里建 N 条提醒」卡——列全部 N 条、每条可勾掉、一次确认。
 *
 * 钉：勾掉的那几条带着改过的那一版批（approve + edited_payload，只改 selected）；没勾掉就原样批；
 * 主按钮在卡身里，卡底那排不再出「批准」；四项设置进问号。
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

const { GoogleAlertChangeBody, isGoogleAlertChangePayload } = await import(
  '@/components/pr/google-alert-change-body'
)
const { quickActions } = await import('@/components/deck/deck-action-bar')

const line = (id: string, query: string, region = 'US') => ({
  id,
  op: 'create' as const,
  query,
  language: 'en',
  region,
  label: id,
  group: 'competitor' as const,
  selected: true,
})
const payload = {
  change_id: 'chg_1',
  kind: 'google_alert_change' as const,
  target: { type: 'google_alerts', id: 'ws_1' },
  before: null,
  after: {
    form: 'google_alert_change' as const,
    op: 'create' as const,
    lines: [
      line('ga_1', '"Aventon" -job'),
      line('ga_2', '"Rad Power Bikes"', 'any'),
      line('ga_3', '"Lectric eBikes"'),
    ],
  },
}
const card = {
  id: 'ap_1',
  version: 2,
  position_id: 'asg_pr',
  layout: 'change',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
  detail: { payload },
} as unknown as DeckCard

describe('WP387 建 Google 提醒卡', () => {
  it('认得出这张卡；卡底那排不出「批准」（主按钮在卡身里）', () => {
    expect(isGoogleAlertChangePayload(payload)).toBe(true)
    expect(isGoogleAlertChangePayload({ kind: 'listing_edit', after: {} })).toBe(false)
    expect(quickActions(card)).not.toContain('approve')
    expect(quickActions(card)).toContain('reject')
  })

  it('列出全部 3 条（查询语句 · 语言 · 地区，不限写「不限」）；勾掉一条再确认 = 带着改过的那一版批', async () => {
    decide.mockClear()
    renderWithProviders(<GoogleAlertChangeBody card={card} payload={payload} />)
    const box = screen.getByTestId('deck-google-alerts')
    expect(box.textContent).toContain('"Aventon" -job')
    expect(box.textContent).toContain('地区 不限')
    expect(screen.getByTestId('google-alerts-confirm').textContent).toBe('确认，去建 3 条')
    fireEvent.click(screen.getByTestId('google-alert-line-ga_2'))
    expect(screen.getByTestId('google-alerts-confirm').textContent).toBe('确认，去建 2 条')
    fireEvent.click(screen.getByTestId('google-alerts-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [id, body] = decide.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('ap_1')
    expect(body.action).toBe('approve')
    const edited = body.edited_payload as typeof payload
    expect(edited.after.lines.map((l) => [l.id, l.selected])).toEqual([
      ['ga_1', true],
      ['ga_2', false],
      ['ga_3', true],
    ])
    expect(edited.after.lines[0]?.query).toBe('"Aventon" -job')
  })

  it('一条没勾掉：原样批（不带改过的那一版）；全勾掉：按钮点不了', async () => {
    decide.mockClear()
    renderWithProviders(<GoogleAlertChangeBody card={card} payload={payload} />)
    fireEvent.click(screen.getByTestId('google-alerts-confirm'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [, body] = decide.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.edited_payload).toBeUndefined()
  })

  it('全勾掉：确认点不了', () => {
    renderWithProviders(<GoogleAlertChangeBody card={card} payload={payload} />)
    for (const id of ['ga_1', 'ga_2', 'ga_3'])
      fireEvent.click(screen.getByTestId(`google-alert-line-${id}`))
    expect((screen.getByTestId('google-alerts-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})
