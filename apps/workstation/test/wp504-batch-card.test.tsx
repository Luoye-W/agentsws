/**
 * WP504（决策 1777 A）：批量开发信确认卡（F3）——名单头像、看名单、发件 / 信 / 节奏 / 跳过、样信；
 * 主按钮写「发出 N 封」。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import {
  KolOutreachBatchBody,
  type KolOutreachBatchPayload,
} from '@/components/kol/kol-card-bodies'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

const names = [
  'Gadget Jonas',
  'Desk Rosa',
  'Mira Builds',
  'Setup Lab',
  'Alpha',
  'Kilo',
  'Lima',
  'Papa',
  'Quinn',
  'Romeo',
]

const payload: KolOutreachBatchPayload = {
  form: 'kol_outreach_batch',
  count: names.length,
  creators: names.map((n, i) => ({ creator_id: `cr_${i}`, display_name: n, initial: n[0] ?? '?' })),
  skipped: [
    { creator_id: 'cr_x', display_name: 'Cable Kevin', reason: '没邮箱' },
    { creator_id: 'cr_y', display_name: 'Desk Fixture', reason: '没邮箱' },
    { creator_id: 'cr_z', display_name: 'Setup Two', reason: '30 天内联系过' },
  ],
  sample: {
    creator_name: 'Gadget Jonas',
    subject: 'NordVolt x Gadget Jonas',
    body: 'Hi Jonas — your 2026 desk setup guide was great.\nSecond line\nThird line',
  },
  letter: '首封合作邀请',
  cadence: '批了就发；今天这条职责还能发 28 封',
  mailbox: 'connected',
  heads_up: [],
}

describe('WP504 批量开发信卡', () => {
  it('名单露 8 个头像 + 「+N」，点「看名单」出全部；跳过按原因数；样信只露两行', () => {
    renderWithProviders(<KolOutreachBatchBody payload={payload} />)
    expect(screen.getByTestId('kol-batch-faces').children).toHaveLength(9)
    expect(screen.getByTestId('kol-batch-more').textContent).toBe('+2')
    fireEvent.click(screen.getByTestId('kol-batch-list-toggle'))
    expect(screen.getByTestId('kol-batch-list').textContent).toContain('Romeo')
    const facts = screen.getByTestId('kol-batch-facts').textContent ?? ''
    expect(facts).toContain('3 人（没邮箱 2 · 30 天内联系过 1）')
    expect(facts).toContain('首封合作邀请')
    const sample = screen.getByTestId('kol-batch-sample').textContent ?? ''
    expect(sample).toContain('样信 · Gadget Jonas')
    expect(sample).toContain('desk setup guide')
    expect(sample).not.toContain('Third line')
  })

  it('主按钮写「发出 N 封」', () => {
    const card = {
      kind: 'kol_outreach_batch',
      layout: 'outbound',
      available_actions: ['approve', 'instruct', 'reject', 'snooze'],
      detail: { payload },
    } as unknown as DeckCard
    expect(deckActionLabel(card, 'approve', (k) => translate('zh', k))).toBe('发出 10 封')
  })
})
