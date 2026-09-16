/**
 * X 适配器（内容组，56 §2）——**接口在、实现待 WP73**。
 *
 * 事实来源：X API v2 文档（2026-09-16 读）。<https://docs.x.com/x-api>
 *
 * 为什么 WP72 只给接口：发推与读时间线在**付费档**上（Free 档一个月只给
 * 很少的写额度，读几乎没有）。写一个跑不起来的实现，等于把"要花钱"这件事
 * 藏成一个 403。所以这里照实回 `needs_paid_tier`——用户看到的是
 * "这个口子在付费档上"，而不是"连接失败"。
 *
 * 形状先钉死（WP73 接上时不改调用方）：
 *
 * - 基址 `https://api.x.com/2`，鉴权 `Authorization: Bearer <token>`；
 * - 发推 `POST /2/tweets`，body `{ text }`；回复是同一个口子加
 *   `{ reply: { in_reply_to_tweet_id } }`——**回复不是另一个接口**，
 *   这一点与 Meta / Discord 都不同，写在这里免得 WP73 去找一个不存在的 endpoint；
 * - 自己的推文列表 `GET /2/users/:id/tweets?tweet.fields=public_metrics`。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type ChannelPost,
  type ChannelProfile,
  guardConnected,
  needsPaidTier,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'x'
const LABEL = 'X'
export const X_API_BASE = 'https://api.x.com/2'

export function createXAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(_account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      return off() ?? needsPaidTier(LABEL, '账号资料与粉丝数')
    },

    async posts(_input: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      return off() ?? needsPaidTier(LABEL, '读自己的推文列表与互动数')
    },

    async publish(
      _input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      return off() ?? needsPaidTier(LABEL, '发推（POST /2/tweets）')
    },

    async reply(_input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      // 回复与发推是**同一个** endpoint 加一格 `reply`（见文件头）
      return (
        off() ?? needsPaidTier(LABEL, '回复（与发推同一个口子，加 reply.in_reply_to_tweet_id）')
      )
    },
  }
}

/** 给 WP73 留的锚。 */
export const X_TWEETS_PATH = '/tweets'
