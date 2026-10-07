/**
 * WP249（决策 81 / 89）：「自家版待处理」与「Reddit 官方号浏览器通道」的接口。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加），形状直接用契约里那几个类型。
 */
import type {
  OwnSubQueueView,
  OwnSubStageInput,
  RedditOfficialBrowserStatus,
} from '@agentsws/contracts'
import { api, type SocialStagedData } from './api'

export type {
  OwnSubQueueItem,
  OwnSubQueueView,
  RedditOfficialBrowserStatus,
} from '@agentsws/contracts'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

/** 自家版的版务队列（每条带 AI 建议）。 */
export const getOwnSubQueue = (assignment?: string): Promise<OwnSubQueueView> =>
  api('/v1/social/own-sub/queue', as(assignment))

/** 从队列里一条出一张版务卡（不直接执行）。 */
export const stageOwnSub = (
  input: OwnSubStageInput,
  assignment?: string,
): Promise<SocialStagedData> =>
  api('/v1/social/own-sub/stage', { method: 'POST', body: input, ...as(assignment) })

/** 登记一个自家版（Reddit，标成我们自己当版主的版）。 */
export const registerOwnSub = (name: string, assignment?: string): Promise<{ id: string }> => {
  const sub = name
    .trim()
    .replace(/^\/?r\//u, '')
    .replace(/\/$/u, '')
  return api('/v1/social/accounts', {
    method: 'POST',
    body: {
      channel: 'reddit',
      handle: `r/${sub}`,
      display_name: `r/${sub}`,
      url: `https://www.reddit.com/r/${sub}/`,
      external_id: sub,
      own_subreddit: true,
    },
    ...as(assignment),
  })
}

export const getRedditBrowser = (assignment?: string): Promise<RedditOfficialBrowserStatus> =>
  api('/v1/social/reddit-browser', as(assignment))

/** 「登录官方号」：开一个浏览器窗口到 Reddit 登录页，用户自己登录。 */
export const openRedditBrowserLogin = (assignment?: string): Promise<RedditOfficialBrowserStatus> =>
  api('/v1/social/reddit-browser/login', { method: 'POST', ...as(assignment) })

/** 「我登录好了」：体检现在登着谁。 */
export const checkRedditBrowserLogin = (
  assignment?: string,
): Promise<RedditOfficialBrowserStatus> =>
  api('/v1/social/reddit-browser/check', { method: 'POST', ...as(assignment) })
