/**
 * WP329：Reddit「发出去」卡——卡上能改字，「发送」在卡身里（底下那排不再出一个），改过就带着改过的那一版批。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const decide = vi.fn(async () => ({}))
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  decide: (...args: unknown[]) => decide(...(args as [])),
}))

const noop = (): void => {}

function redditCard(kind: 'reply' | 'submit'): DeckCard {
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
        channel_label: 'Reddit · r/inmoxr',
        reddit:
          kind === 'reply'
            ? {
                kind: 'reply',
                subreddit: 'inmoxr',
                parent_fullname: 't1_c1',
                permalink: '/r/inmoxr/comments/abc/s/c1/',
                parent_author: 'alice',
              }
            : { kind: 'submit', subreddit: 'inmoxr' },
        body:
          kind === 'reply'
            ? { text: 'Hi Alice, INMO here.' }
            : { text: 'Ask us anything.', subject: 'Weekly Q&A' },
        author: 'alice',
        in_reply_to: 'Mine fogs up a bit',
        facts: [{ id: 'fc_1', text: 'Q: anti-fog? A: insert in the box' }],
        rules: ['No referral links'],
      },
    },
  })
}

describe('WP329 Reddit「发出去」卡', () => {
  it('卡面：版块、回复谁、原话、能改的正文、依据；「发送」在卡身里，底下那排没有', () => {
    renderWithProviders(
      <DeckCardView card={redditCard('reply')} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const body = screen.getByTestId('deck-reddit-write')
    expect(body.textContent).toContain('Reddit · r/inmoxr')
    expect(body.textContent).toContain('回复 alice')
    expect(screen.getByTestId('reddit-write-quote').textContent).toBe('Mine fogs up a bit')
    expect((screen.getByTestId('reddit-write-text') as HTMLTextAreaElement).value).toBe(
      'Hi Alice, INMO here.',
    )
    expect(screen.getByTestId('reddit-write-basis').textContent).toContain('1')
    expect(screen.getByTestId('reddit-write-send')).toBeTruthy()
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).queryByText('发送')).toBeNull()
  })

  it('改了字再点发送 → 带着改过的那一版批（approve_edited）', async () => {
    decide.mockClear()
    renderWithProviders(
      <DeckCardView card={redditCard('submit')} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    fireEvent.change(screen.getByTestId('reddit-write-title'), {
      target: { value: 'Weekly Q&A — Air3' },
    })
    fireEvent.change(screen.getByTestId('reddit-write-text'), {
      target: { value: 'Ask us anything about the Air3.' },
    })
    fireEvent.click(screen.getByTestId('reddit-write-send'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [id, input] = decide.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toBe('ap_rw')
    expect(input).toMatchObject({
      action: 'approve',
      edited_payload: {
        form: 'reddit_write',
        body: { text: 'Ask us anything about the Air3.', subject: 'Weekly Q&A — Air3' },
      },
    })
  })

  it('没改就点发送 → 原样批', async () => {
    decide.mockClear()
    renderWithProviders(
      <DeckCardView card={redditCard('reply')} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    fireEvent.click(screen.getByTestId('reddit-write-send'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const [, input] = decide.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(input.edited_payload).toBeUndefined()
  })
})
