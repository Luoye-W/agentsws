/**
 * X 适配器（内容组，56 §2；**真实现** WP73）。
 *
 * 事实来源：X API v2 文档（2026-09-16 读）。<https://docs.x.com/x-api>
 *
 * 四件这条渠道特有的事：
 *
 * 1. **回复不是另一个 endpoint。** 发推与回复都是 `POST /2/tweets`，回复只是
 *    多一格 `reply.in_reply_to_tweet_id`。去找一个 `/2/tweets/:id/reply` 会
 *    找一下午——它不存在。
 * 2. **403 在这条渠道上的意思是"你这个档买不到这个口子"**，不是"授权掉了"。
 *    共用的 `httpFailure` 把 403 翻成"去重新授权"，那句话会让人把一把好好的
 *    token 反复重填。所以这里**单独判 403**，说"要买档"。
 * 3. **"读自己的提及"只能靠搜。** v2 没有"我的通知"这个口子，能用的是
 *    `GET /2/tweets/search/recent`。所以 `comments` 拼的 query 是
 *    **写死限定在自己账号上**的（`to:<我> OR @<我>`，并且 `-from:<我>` 把自己
 *    刷的屏去掉）——调用方给不了任意搜索词，这条渠道上没有"去 X 上搜点什么"
 *    这回事（那是红人那条职责的事，走它自己那份适配器）。
 * 4. **拉自己的推文用 `account_external_id` 那个数字 id**，不替调用方多打一跳
 *    去 `/2/users/me` 换。多一跳就多一份配额，而 X 的配额是按月算的。
 *
 * 凭据：`bearer_token`（与红人那条 `x_api` 是同一张卡、同一把 token）。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type ChannelComment,
  type ChannelPost,
  type ChannelProfile,
  callJson,
  guardConnected,
  httpFailure,
  needsPaidTier,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'x'
const LABEL = 'X'
export const X_API_BASE = 'https://api.x.com/2'

export const X_TWEETS_PATH = '/tweets'
export const X_ME_PATH = '/users/me'
export const X_SEARCH_RECENT_PATH = '/tweets/search/recent'

/** 付费档那一句（文件头第 2 条）。 */
function xFailure(status: number, url: string, what: string): SocialError {
  if (status === 403) return needsPaidTier(LABEL, what)
  return httpFailure(LABEL, status, url)
}

interface RawUser {
  id?: string
  name?: string
  username?: string
  description?: string
  public_metrics?: { followers_count?: number; tweet_count?: number }
}

interface RawTweet {
  id?: string
  text?: string
  created_at?: string
  author_id?: string
  public_metrics?: {
    impression_count?: number
    like_count?: number
    reply_count?: number
    retweet_count?: number
  }
}

export function createXAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    return { authorization: `Bearer ${cred.bearer_token ?? cred.access_token ?? cred.token ?? ''}` }
  }
  /** 一跳；403 改说成"要买档"。 */
  const call = async <T>(
    url: string,
    what: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: true; data: T } | SocialError> => {
    const res = await callJson<T>(transport, LABEL, url, init)
    if (!('data' in res) && res.status !== undefined) return xFailure(res.status, url, what)
    return res
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${X_API_BASE}${X_ME_PATH}?user.fields=${encodeURIComponent('public_metrics,description,username,name')}`
      const res = await call<{ data?: RawUser }>(url, '账号资料与粉丝数', {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      const raw = res.data.data ?? {}
      const handle = raw.username ?? account_external_id
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          // **回的是 `me` 的 id**：连接页上那一格就是这么填出来的
          external_id: raw.id ?? account_external_id,
          handle,
          display_name: raw.name ?? handle,
          url: `https://x.com/${handle.replace(/^@/, '')}`,
          ...(raw.public_metrics?.followers_count === undefined
            ? {}
            : { followers: raw.public_metrics.followers_count }),
          ...(raw.description === undefined ? {} : { bio: raw.description }),
        },
      }
    },

    async posts({
      account_external_id,
      limit,
    }: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      // v2 的 `max_results` 下限是 5，上限 100；给小了 X 直接 400
      const max = Math.min(Math.max(limit ?? 25, 5), 100)
      const url = `${X_API_BASE}/users/${encodeURIComponent(account_external_id)}/tweets?max_results=${max}&tweet.fields=${encodeURIComponent('public_metrics,created_at')}`
      const res = await call<{ data?: RawTweet[] }>(url, '读自己的推文列表与互动数', {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((t) => ({
          external_id: t.id ?? '',
          kind: 'post' as const,
          body: t.text ?? '',
          ...(t.created_at === undefined ? {} : { published_at: t.created_at }),
          url: `https://x.com/i/web/status/${t.id ?? ''}`,
          metrics: {
            ...(t.public_metrics?.impression_count === undefined
              ? {}
              : { impressions: t.public_metrics.impression_count }),
            ...(t.public_metrics?.like_count === undefined
              ? {}
              : { likes: t.public_metrics.like_count }),
            ...(t.public_metrics?.reply_count === undefined
              ? {}
              : { comments: t.public_metrics.reply_count }),
            ...(t.public_metrics?.retweet_count === undefined
              ? {}
              : { shares: t.public_metrics.retweet_count }),
          },
        })),
      }
    },

    async comments({
      account_external_id,
      limit,
    }: {
      account_external_id: string
      post_external_id?: string
      limit?: number
    }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const cred = await transport.credential(CHANNEL)
      /*
       * 文件头第 3 条：**搜索词是写死的**，只搜自己账号的提及。
       * `handle` 从连接那一条记录里来（连接页上填的那个 @）；没有它就
       * 搜不出"提到我们的话"，那时照实说，而不是去搜一个空词把全站拉回来。
       */
      const handle = (cred.handle ?? '').replace(/^@/, '')
      if (handle === '')
        return {
          ok: false,
          reason: 'not_connected',
          message: `${LABEL} 这条连接里没有填我们自己的账号名（@handle）。没有它就不知道该搜谁的提及——去连接页补一格。`,
        }
      const query = `(to:${handle} OR @${handle}) -from:${handle}`
      const max = Math.min(Math.max(limit ?? 25, 10), 100)
      const url = `${X_API_BASE}${X_SEARCH_RECENT_PATH}?max_results=${max}&query=${encodeURIComponent(query)}&tweet.fields=${encodeURIComponent('created_at,author_id')}`
      const res = await call<{ data?: RawTweet[] }>(url, '读提到我们的推文（search/recent）', {
        headers: await auth(),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data.data ?? []).map((t) => ({
          external_id: t.id ?? '',
          surface: 'comment' as const,
          author_external_id: t.author_id ?? '',
          // v2 不带 `expansions` 就只给 author_id；不去多打一跳换名字（配额按月算）
          author_handle: t.author_id ?? '',
          text: t.text ?? '',
          created_at: t.created_at ?? transport.now(),
          parent_external_id: account_external_id,
        })),
      }
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // X 没有服务端排期（那是后台里的功能，不在 API 上）
      if (input.scheduled_at !== undefined)
        return {
          ok: false,
          reason: 'not_implemented',
          message: `${LABEL} 的接口上没有排期发布；排期由我们自己的调度器管，到点之后再调这一跳。`,
        }
      const url = `${X_API_BASE}${X_TWEETS_PATH}`
      const res = await call<{ data?: { id?: string } }>(url, '发推（POST /2/tweets）', {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ text: input.body }),
      })
      if (!('data' in res)) return res
      const id = res.data.data?.id ?? ''
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: id, url: `https://x.com/i/web/status/${id}` },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const url = `${X_API_BASE}${X_TWEETS_PATH}`
      // 文件头第 1 条：与发推**同一个** endpoint，多一格 `reply`
      const res = await call<{ data?: { id?: string } }>(url, '回复（同一个口子加 reply）', {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          reply: { in_reply_to_tweet_id: input.parent_external_id },
        }),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: res.data.data?.id ?? '' },
      }
    },
  }
}
