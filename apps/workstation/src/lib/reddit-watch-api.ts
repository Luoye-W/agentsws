/**
 * WP328：Reddit 每日巡查的接口（`/v1/reddit-watch*`）。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带「Reddit」那条职责的分配（服务端按它判读写社群线程的权限）。
 */
import type { RedditWatchEntry, RedditWatchRun, RedditWatchView } from '@agentsws/contracts'
import { api } from './api'

export type { RedditWatchEntry, RedditWatchRun, RedditWatchView } from '@agentsws/contracts'

export const REDDIT_WATCH_KEY = ['reddit-watch'] as const

export const getRedditWatch = (assignment: string): Promise<RedditWatchView> =>
  api('/v1/reddit-watch', { assignment })

export const runRedditWatch = (assignment: string): Promise<RedditWatchRun> =>
  api('/v1/reddit-watch/run', { method: 'POST', assignment })

export const setRedditWatchStatus = (
  assignment: string,
  id: string,
  status: RedditWatchEntry['status'],
): Promise<RedditWatchEntry> =>
  api(`/v1/reddit-watch/items/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: { status },
    assignment,
  })
