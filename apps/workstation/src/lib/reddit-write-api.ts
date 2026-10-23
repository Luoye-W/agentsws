/**
 * WP329 / WP332：Reddit 写的进度与「再填一次」（`/v1/social/reddit/writes*`）。单独一个文件（`api.ts` 那张大表好几单同时在加）。
 * 带一条社媒职责的分配（服务端按它判读写社群线程的权限）。
 */
import type { RedditWritesList } from '@agentsws/contracts'
import { api } from './api'

export type { RedditWriteView } from '@agentsws/contracts'

export const REDDIT_WRITES_KEY = ['reddit-writes'] as const

/** WP445：回包里 `in_plugin` = 插件里等你发的几条（看板上那一行）。 */
export const listRedditWrites = (assignment: string): Promise<RedditWritesList> =>
  api('/v1/social/reddit/writes', { assignment })

/**
 * 决策 762：同一份已批的草稿再发一次（不用重批）。WP491：按出卡同一个选路（ego 能用走 ego，不能用交给插件）。
 * `text`（WP478）岗位页不再用（「修改」改成还原原卡），接口仍收。
 */
export const refillRedditWrite = (
  assignment: string,
  job_id: string,
  text?: string,
): Promise<import('@agentsws/contracts').RedditWriteView> =>
  api(`/v1/social/reddit/writes/${encodeURIComponent(job_id)}/refill`, {
    method: 'POST',
    assignment,
    ...(text === undefined ? {} : { body: { text } }),
  })

export const dismissRedditWrite = (
  assignment: string,
  job_id: string,
): Promise<import('@agentsws/contracts').RedditWriteView> =>
  api(`/v1/social/reddit/writes/${encodeURIComponent(job_id)}/dismiss`, {
    method: 'POST',
    assignment,
  })

/** WP491：「修改」= 没发出去的那一条还原成当初那张审核卡（卡片流里改字、批）。 */
export const reviseRedditWrite = (
  assignment: string,
  job_id: string,
): Promise<import('@agentsws/contracts').RedditWriteRevised> =>
  api(`/v1/social/reddit/writes/${encodeURIComponent(job_id)}/revise`, {
    method: 'POST',
    assignment,
  })
