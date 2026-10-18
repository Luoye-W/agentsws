/**
 * WP328「Reddit 巡查」快捷视图：一行状态（三块各自好了没有）+ 要回的清单（来源 · 作者 · 一行原文 · 理由）；
 * 「不回」把那条标掉；没配版块 / 关键词照实说一句。
 */
import type { RedditWatchView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedditWatch } from '@/components/social/reddit-watch'
import { renderWithProviders } from './helpers'

const view = (over: Partial<RedditWatchView> = {}): RedditWatchView => ({
  settings: {
    own_subreddits: ['ivraxr'],
    keywords: ['IVRA'],
    every_hours: 24,
    day_start_hour: 9,
    keyword_limit: 10,
    enabled: true,
  },
  configured: true,
  extension: { seen_at: '2026-10-14T01:00:00.000Z', reddit_connected: true },
  last_run: {
    id: 'rwr_1',
    workspace_id: 'ws_1' as never,
    started_at: '2026-10-14T01:00:00.000Z',
    finished_at: '2026-10-14T01:02:00.000Z',
    final: false,
    trigger: 'schedule',
    parts: [
      { part: 'inbox', status: 'ok', fetched: 2, fresh: 1 },
      { part: 'external', status: 'needs_connection', fetched: 0, fresh: 0, message: '没开通' },
    ],
    pending: 1,
  },
  pending: [
    {
      id: 'rw_1',
      workspace_id: 'ws_1' as never,
      source: 'inbox',
      kind: 'comment',
      fullname: 't1_c9',
      subreddit: 'ivraxr',
      author: 'alice',
      text: 'does it work with iPhone?',
      url: 'https://www.reddit.com/r/ivraxr/comments/p1/x/c9/',
      created_at: '2026-10-14T00:00:00.000Z',
      fetched_at: '2026-10-14T01:00:00.000Z',
      run_id: 'rwr_1',
      status: 'open',
      judgement: { verdict: 'follow_up', reply: true, reason: '在问兼容性', by: 'model' },
    },
  ],
  ...over,
})

const state = {
  view: view(),
  status: vi.fn(async (..._a: unknown[]) => ({})),
  run: vi.fn(async (..._a: unknown[]) => ({})),
}

vi.mock('@/lib/reddit-watch-api', () => ({
  REDDIT_WATCH_KEY: ['reddit-watch'],
  getRedditWatch: async () => state.view,
  runRedditWatch: (...a: unknown[]) => state.run(...a),
  setRedditWatchStatus: (...a: unknown[]) => state.status(...a),
}))

beforeEach(() => {
  state.view = view()
  state.status.mockClear()
  state.run.mockClear()
})

describe('WP328 Reddit 巡查', () => {
  it('三块状态 + 要回的那一条（来源、作者、原文、理由）；不回 / 现在巡查', async () => {
    renderWithProviders(<RedditWatch assignment="asg_reddit" />)
    const list = await screen.findByTestId('reddit-watch-pending')
    expect(list.textContent).toContain('u/alice')
    expect(list.textContent).toContain('does it work with iPhone?')
    expect(list.textContent).toContain('在问兼容性')
    expect(screen.getByTestId('reddit-watch').textContent).toContain('外部社区 · 缺连接')
    fireEvent.click(screen.getByTestId('reddit-watch-dismiss'))
    await waitFor(() =>
      expect(state.status).toHaveBeenCalledWith('asg_reddit', 'rw_1', 'dismissed'),
    )
    fireEvent.click(screen.getByTestId('reddit-watch-run'))
    await waitFor(() => expect(state.run).toHaveBeenCalledWith('asg_reddit'))
  })
  it('没配版块和关键词、没有要回的：照实说', async () => {
    state.view = view({ configured: false, pending: [] })
    renderWithProviders(<RedditWatch assignment="asg_reddit" />)
    expect(await screen.findByTestId('reddit-watch-empty')).toBeTruthy()
    expect(screen.getByTestId('reddit-watch').textContent).toContain('还没配自家版块和关键词')
  })
})
