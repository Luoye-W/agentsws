/**
 * WP329 / WP332：Reddit 写的进度与「再填一次」（`/v1/social/reddit/writes*`）。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带一条社媒职责的分配（服务端按它判读写社群线程的权限）。
 */
import type { RedditWriteView } from '@agentsws/contracts'
import { api } from './api'

export type { RedditWriteView } from '@agentsws/contracts'

export const REDDIT_WRITES_KEY = ['reddit-writes'] as const

export const listRedditWrites = (assignment: string): Promise<{ rows: RedditWriteView[] }> =>
  api('/v1/social/reddit/writes', { assignment })

/** 决策 762：同一份已批的草稿再交给插件（不用重批）。 */
export const refillRedditWrite = (assignment: string, job_id: string): Promise<RedditWriteView> =>
  api(`/v1/social/reddit/writes/${encodeURIComponent(job_id)}/refill`, {
    method: 'POST',
    assignment,
  })

export const dismissRedditWrite = (assignment: string, job_id: string): Promise<RedditWriteView> =>
  api(`/v1/social/reddit/writes/${encodeURIComponent(job_id)}/dismiss`, {
    method: 'POST',
    assignment,
  })
