/**
 * WP495（1717）：ego 里「点过发送、没确认发出去」（和在 ego 里发到一半重启了）的那一条，
 * 点「再填一次」先问「确认上次没发出去？」——确认才再发、取消就不发；别的失败不问、点了直接发。
 */
import type { RedditWriteView } from '@agentsws/contracts'
import { redditWriteMaybeSent } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditWriteNotice } from '@/components/social/reddit-write-notice'
import { renderWithProviders } from './helpers'

const at = (): string => new Date(Date.now() - 60_000).toISOString()

const row = (over: Partial<RedditWriteView> = {}): RedditWriteView =>
  ({
    approval_item_id: 'ap_1',
    job_id: 'rdw_1',
    kind: 'reply',
    subreddit: 'ivraxr',
    state: 'failed',
    message:
      '工坊在 ego 里点了发送，但没确认发出去——可能已经发出去了，所以没换路重发，去页面上看一眼',
    outcome: 'ego_unconfirmed',
    route: 'ego',
    can_refill: true,
    label: '回复 alice（Reddit · r/ivraxr）',
    queued_at: at(),
    finished_at: at(),
    ...over,
  }) as RedditWriteView

const state = {
  rows: [] as RedditWriteView[],
  refill: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
}

vi.mock('@/lib/reddit-write-api', () => ({
  REDDIT_WRITES_KEY: ['reddit-writes'],
  listRedditWrites: async () => ({ rows: state.rows }),
  refillRedditWrite: (...a: unknown[]) => state.refill(...a),
  reviseRedditWrite: async () => ({ approval_item_id: 'ap_9' }),
  dismissRedditWrite: async () => ({}),
}))

vi.mock('@/components/reports/position-bridge', () => ({ requestCardJump: () => {} }))

const duties = [{ role_id: 'social.reddit', assignment_id: 'asg_reddit' }]

beforeEach(() => {
  state.rows = []
  state.refill.mockReset()
  state.refill.mockImplementation(async () => ({}))
})

describe('WP495 1717 再填一次前先问', () => {
  it('哪几种要问：点过发送没确认 / 发到一半重启；别的失败、没失败的不问', () => {
    expect(redditWriteMaybeSent({ state: 'failed', outcome: 'ego_unconfirmed' })).toBe(true)
    expect(redditWriteMaybeSent({ state: 'failed', outcome: 'interrupted' })).toBe(true)
    for (const outcome of ['blocked', 'ego_failed', 'stopped', 'dropped', 'expired', undefined])
      expect(redditWriteMaybeSent({ state: 'failed', outcome })).toBe(false)
    expect(redditWriteMaybeSent({ state: 'sent', outcome: 'ego_unconfirmed' })).toBe(false)
  })

  it('点过发送没确认：先问；取消 = 不发、按钮回来', async () => {
    state.rows = [row()]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    const ask = screen.getByTestId('reddit-write-refill-confirm')
    expect(ask.textContent).toContain('确认上次没发出去？')
    expect(screen.queryByTestId('reddit-write-refill')).toBeNull()
    fireEvent.click(screen.getByTestId('reddit-write-refill-confirm-no'))
    expect(screen.queryByTestId('reddit-write-refill-confirm')).toBeNull()
    expect(screen.getByTestId('reddit-write-refill')).toBeTruthy()
    expect(state.refill).not.toHaveBeenCalled()
  })

  it('点过发送没确认：确认了才按选路再发（同一条）', async () => {
    state.rows = [row()]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    expect(state.refill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('reddit-write-refill-confirm-yes'))
    await waitFor(() => expect(state.refill).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
    expect(state.refill).toHaveBeenCalledTimes(1)
  })

  it('在 ego 里发到一半重启了（interrupted）：同样先问', async () => {
    state.rows = [row({ outcome: 'interrupted' })]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    expect(screen.getByTestId('reddit-write-refill-confirm')).toBeTruthy()
    expect(state.refill).not.toHaveBeenCalled()
  })

  it('平台拦了（确定没发出去）：不问，点了直接发', async () => {
    state.rows = [row({ outcome: 'blocked', message: 'Reddit 弹了验证，没发出去' })]
    renderWithProviders(<RedditWriteNotice duties={duties} />)
    fireEvent.click(await screen.findByTestId('reddit-write-refill'))
    expect(screen.queryByTestId('reddit-write-refill-confirm')).toBeNull()
    await waitFor(() => expect(state.refill).toHaveBeenCalledWith('asg_reddit', 'rdw_1'))
  })
})
