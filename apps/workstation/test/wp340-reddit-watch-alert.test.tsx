/**
 * WP340：社媒岗位页「优先」提醒条——巡查抓到命中告警词的才出（命中的词 · 在哪 · 一行原话 + 打开原帖 + 收起）；
 * 没有就一个字都不画；最多三行；巡查快捷视图里的条目带「优先」与本地标签。
 */
import type { RedditWatchEntry, RedditWatchView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditWatch } from '@/components/social/reddit-watch'
import { RedditWatchAlertNotice } from '@/components/social/reddit-watch-alert'
import { renderWithProviders } from './helpers'

const entry = (over: Partial<RedditWatchEntry> = {}): RedditWatchEntry => ({
  id: 'rw_1',
  workspace_id: 'ws_1' as never,
  source: 'external',
  kind: 'post',
  fullname: 't3_aa1',
  subreddit: 'SmartGlasses',
  author: 'zed',
  title: 'Air 3 overheating?',
  text: 'gets hot',
  url: 'https://www.reddit.com/r/SmartGlasses/comments/aa1/x/',
  created_at: '2026-10-13T10:00:00.000Z',
  fetched_at: '2026-10-14T02:00:00.000Z',
  run_id: 'rwr_1',
  status: 'open',
  priority: true,
  alert_hits: ['overheat'],
  tags: ['Air3'],
  ...over,
})

const state = {
  view: {
    settings: {},
    configured: true,
    extension: {},
    pending: [],
  } as unknown as RedditWatchView,
  dismiss: vi.fn(async (..._a: unknown[]) => ({})),
}

vi.mock('@/lib/reddit-watch-api', () => ({
  REDDIT_WATCH_KEY: ['reddit-watch'],
  getRedditWatch: async () => state.view,
  runRedditWatch: async () => ({}),
  setRedditWatchStatus: async () => ({}),
  dismissRedditWatchAlert: (...a: unknown[]) => state.dismiss(...a),
}))

const duties = [{ role_id: 'social.reddit', assignment_id: 'asg_reddit' }]

beforeEach(() => {
  state.view = {
    settings: {},
    configured: true,
    extension: {},
    pending: [],
  } as unknown as RedditWatchView
  state.dismiss.mockClear()
})

describe('WP340 「优先」提醒条', () => {
  it('命中告警词：一行（词 · 版 · 人 · 原话）+ 打开原帖 + 收起', async () => {
    state.view = { ...state.view, alerts: [entry()] }
    renderWithProviders(<RedditWatchAlertNotice duties={duties} />)
    const row = await screen.findByTestId('reddit-watch-alert-row')
    expect(row.textContent).toContain('优先：overheat')
    expect(row.textContent).toContain('r/SmartGlasses · u/zed')
    expect(row.textContent).toContain('Air 3 overheating?')
    expect(screen.getByTestId('reddit-watch-alert-open').getAttribute('href')).toContain(
      '/comments/aa1/',
    )
    fireEvent.click(screen.getByTestId('reddit-watch-alert-dismiss'))
    await waitFor(() => expect(state.dismiss).toHaveBeenCalledWith('asg_reddit', 'rw_1'))
  })

  it('没有优先的、没有社媒职责：不画；多于三条只出三行 + 还有几条', async () => {
    const { container } = renderWithProviders(<RedditWatchAlertNotice duties={duties} />)
    await waitFor(() => expect(container.textContent).toBe(''))
    const none = renderWithProviders(<RedditWatchAlertNotice duties={[]} />)
    expect(none.container.textContent).toBe('')
    state.view = {
      ...state.view,
      alerts: [1, 2, 3, 4, 5].map((n) => entry({ id: `rw_${n}`, fullname: `t3_a${n}` })),
    }
    renderWithProviders(<RedditWatchAlertNotice duties={duties} />)
    expect(await screen.findAllByTestId('reddit-watch-alert-row')).toHaveLength(3)
    expect(screen.getByTestId('reddit-watch-alert').textContent).toContain('还有 2 条')
  })

  it('巡查快捷视图：要回的条目带「优先」与本地标签', async () => {
    state.view = { ...state.view, pending: [entry({ status: 'open' })] }
    renderWithProviders(<RedditWatch assignment="asg_reddit" />)
    expect(await screen.findByTestId('reddit-watch-priority')).toBeTruthy()
    expect(screen.getByTestId('reddit-watch-pending').textContent).toContain('Air3')
  })
})
