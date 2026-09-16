/**
 * Reddit 适配器（社群组，56 §2）——**接口在、实现待 WP73**。
 *
 * 事实来源：Reddit API 文档（2026-09-16 读）。
 * <https://www.reddit.com/dev/api/>
 *
 * 为什么 WP72 只给接口：Reddit 2023 年之后对第三方读写收紧了（要注册应用、
 * 要声明用途、商用要谈；`User-Agent` 写得不对直接 429）。这些是**接一次要
 * 跑一遍的现实**，不是写几行代码的事——WP73 连着真账号一起做。
 *
 * 形状先钉死（WP73 接上时不改调用方）：
 *
 * - 基址 `https://oauth.reddit.com`，鉴权 `Authorization: Bearer <token>`，
 *   而且**必须**带一个能认出我们的 `User-Agent`（Reddit 明文要求，
 *   否则限流到不可用）——见 {@link REDDIT_USER_AGENT}；
 * - 发帖 `POST /api/submit`（form-urlencoded，`kind=self`）；
 * - 回帖 `POST /api/comment`（`thing_id` 是带类型前缀的 fullname，
 *   如 `t3_abc123` 是帖子、`t1_def456` 是评论——**不是**裸 id，
 *   这一条最容易写错，写在这里免得 WP73 再踩一遍）；
 * - 管理动作 `POST /api/remove` / `/api/friend`（ban 走 friend 加
 *   `type=banned`）——名字与它干的事对不上，也记在这里。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type BroadcastInput,
  type ChannelComment,
  type ChannelPost,
  type ChannelProfile,
  guardConnected,
  type ModerateInput,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'reddit'
const LABEL = 'Reddit'
export const REDDIT_API_BASE = 'https://oauth.reddit.com'
/** Reddit 明文要求带一个认得出来的 UA，否则限流到不可用。 */
export const REDDIT_USER_AGENT = 'agentsws/1.0 (社媒运营；https://github.com/agentsws)'

const PLAN = 'WP73 连着真账号一起做——Reddit 要注册应用、声明用途，UA 写错直接 429'

export function createRedditAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(_account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async posts(_input: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async comments(_input: {
      account_external_id: string
      post_external_id?: string
      limit?: number
    }): Promise<SocialResult<ChannelComment[]>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async publish(
      _input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async reply(_input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async moderate(_input: ModerateInput): Promise<SocialResult<{ ok: true }>> {
      return off() ?? notImplemented(LABEL, PLAN)
    },

    async broadcast(
      _input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      // Reddit 上"群发"= 发一条置顶帖。给每个订阅者发私信在 Reddit 是
      // 明令禁止的（会被当成垃圾信举报），所以这条渠道上永远不会有"发私信给全员"。
      return off() ?? notImplemented(LABEL, `${PLAN}（Reddit 的"群发"= 发一条置顶帖）`)
    },

    // `members` / `decideMember` 故意缺席：subreddit 没有"成员名册"与"入群审批"
    // 这回事（关注是单向的）。缺席本身就是信息。
  }
}
