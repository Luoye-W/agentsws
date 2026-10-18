/**
 * WP411（#11）：Reddit「发出去」卡上标出品牌号在这串里已经说过的（「你 10-12 已回：……」）
 * 和几道检查没过的（对不上 / 没依据已换掉 / 整串没现读成），一条一行。
 */
import type { DeckCard } from '@agentsws/deck'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}

function card(extra: Record<string, unknown>): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_rw',
    kind: 'outbound_draft',
    layout: 'outbound',
    available_actions: ['approve', 'reject', 'instruct', 'snooze', 'open'],
    detail: {
      ...base.detail,
      payload: {
        form: 'reddit_write',
        channel: 'reddit',
        channel_label: 'Reddit · r/ivraxr',
        reddit: {
          kind: 'reply',
          subreddit: 'ivraxr',
          parent_fullname: 't1_c9',
          permalink: '/r/ivraxr/comments/post1/x/c9/',
          parent_author: 'alice',
        },
        body: { text: "I can't speak to recall claims." },
        in_reply_to: 'Is the recall real?',
        ...extra,
      },
    },
  })
}

describe('WP411 Reddit「发出去」卡：已回过的与检查', () => {
  it('品牌号已说过的放在被回那句下面；检查一条一行、改过的写明已换掉', () => {
    renderWithProviders(
      <DeckCardView
        card={card({
          prior_replies: [
            {
              fullname: 't1_o1',
              text: 'It is true that some IVRA Air3 units were recalled.',
              created_at: '2026-10-12T03:00:00.000Z',
            },
          ],
          checks: [
            {
              kind: 'contradiction',
              message: '和品牌号 10-12 在这串里说的对不上',
              quote: "I can't speak to recall claims.",
              prior: 'It is true that some IVRA Air3 units were recalled.',
            },
            {
              kind: 'ungrounded',
              message: '这句没有依据（知识卡、品牌号说过的话里都没有）',
              quote: 'Switching the display language fixes it.',
              fixed: true,
            },
            { kind: 'thread', message: '这一串没现读成，只看了巡查库里已有的几条。' },
          ],
        })}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('reddit-write-prior').textContent).toBe(
      '你 10-12 已回：「It is true that some IVRA Air3 units were recalled.」',
    )
    const items = screen.getByTestId('reddit-write-checks').querySelectorAll('li')
    expect([...items].map((li) => li.getAttribute('data-check'))).toEqual([
      'contradiction',
      'ungrounded',
      'thread',
    ])
    expect(items[1]?.textContent).toContain(
      '这句没有依据（知识卡、品牌号说过的话里都没有），已换成「我去确认一下」',
    )
  })

  it('没有就不画', () => {
    renderWithProviders(
      <DeckCardView card={card({})} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByTestId('reddit-write-prior')).toBeNull()
    expect(screen.queryByTestId('reddit-write-checks')).toBeNull()
  })
})
