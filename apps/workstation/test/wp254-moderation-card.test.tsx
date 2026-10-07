/**
 * WP254（决策 117）：别的社群的版务卡是「做之前」的改动卡——按钮「批准执行 / 不做」（不再是「解除禁言」），
 * 类别「版务」，卡面写清将执行什么（经哪条渠道）、原话、违反的群规与依据。
 */
import type { DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

function moderationCard(after: Record<string, unknown>): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_mod',
    kind: 'staged_change',
    layout: 'change',
    change_kind: 'community_moderation',
    available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
    detail: {
      ...base.detail,
      payload: { kind: 'community_moderation', before: { status: 'open' }, after },
    },
  })
}

describe('WP254 版务卡（改动卡）', () => {
  it('按钮「批准执行 / 不做」，类别「版务」；卡面：将执行、原话、群规、依据', () => {
    renderWithProviders(
      <DeckCardView
        card={moderationCard({
          action: 'delete_post',
          action_label: '删掉这条',
          channel: 'discord',
          will_do: '删掉这条：这条（经 Discord · Nordvolt 桌面党）',
          excerpt: '低价线材批发，加我私聊 →',
          author: 'cheap_cables_24h',
          rule_texts: ['群里不发外部推广链接与广告'],
          reason: '违反「群里不发外部推广链接与广告」，删掉这条。',
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const bar = screen.getByTestId('deck-action-bar')
    const primary = within(bar).getByText('批准执行').closest('button')
    expect(primary?.dataset.action).toBe('approve')
    expect(primary?.dataset.rank).toBe('primary')
    expect(within(bar).getByText('不做').closest('button')?.dataset.action).toBe('reject')
    expect(within(bar).queryByText('解除禁言')).toBeNull()
    expect(screen.getByTestId('deck-band').textContent).toBe('版务')
    expect(screen.getByTestId('deck-moderation-will-do').textContent).toContain('经 Discord')
    expect(screen.getByTestId('deck-moderation-original').textContent).toContain('低价线材批发')
    expect(screen.getByTestId('deck-moderation').textContent).toContain(
      '群里不发外部推广链接与广告',
    )
    expect(screen.getByTestId('deck-moderation-reason').textContent).toContain('删掉这条')
    // 不再是 before / after 那两格裸 JSON
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
  })

  it('自家版的版务卡照旧画 WP249 那张卡面，按钮同样是「批准执行」', () => {
    renderWithProviders(
      <DeckCardView
        card={moderationCard({
          source: 'own_sub_queue',
          action: 'approve',
          will_do: '批准 u/bob 的这条帖子（经官方号浏览器）',
          excerpt: 'Display is sharp.',
          author: 'bob',
          suggestion: { verdict: 'approve', reason: '举报无据' },
          report_reasons: [],
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('deck-own-sub')).toBeTruthy()
    expect(within(screen.getByTestId('deck-action-bar')).getByText('批准执行')).toBeTruthy()
  })
})
