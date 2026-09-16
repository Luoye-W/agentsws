/**
 * TikTok 适配器（内容组，56 §2）——**接口在、实现待 WP73**。
 *
 * 事实来源：TikTok for Developers, Content Posting API（2026-09-16 读）。
 * <https://developers.tiktok.com/doc/content-posting-api-get-started>
 *
 * 为什么 WP72 只给接口：Content Posting API 是**申请制**（与红人那条职责用的
 * Research API 不是同一个东西，也要分别申请）。没批下来之前，一个"能跑通"的
 * 实现是测不了的——写出来的只会是我们对文档的想象。所以这里照实回
 * `needs_approval` 那句人话，把"申请制"这件事说给用户听，而不是让他看到 401。
 *
 * 形状先钉死（WP73 接上时不改调用方）：
 *
 * - 基址 `https://open.tiktokapis.com/v2`，鉴权 `Authorization: Bearer <token>`；
 * - 发布是**两跳**：`POST /post/publish/video/init/` 拿一个 `publish_id` 与
 *   上传地址，把素材 PUT 上去之后轮询 `POST /post/publish/status/fetch/`。
 *   一跳发完这件事在 TikTok 上不存在——所以 `publish` 的返回形状里要留得下
 *   "还在处理中"，WP73 接的时候不会因为返回值不够而改接口。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type ChannelPost,
  type ChannelProfile,
  guardConnected,
  needsApproval,
  type PublishInput,
  type SocialChannelAdapter,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'tiktok'
const LABEL = 'TikTok'
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2'

export function createTikTokAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(_account_external_id: string): Promise<SocialResult<ChannelProfile>> {
      return off() ?? needsApproval(LABEL, '账号资料接口（Display API）')
    },

    async posts(_input: {
      account_external_id: string
      limit?: number
    }): Promise<SocialResult<ChannelPost[]>> {
      return off() ?? needsApproval(LABEL, '视频列表与表现数据接口')
    },

    async publish(
      _input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      return (
        off() ??
        needsApproval(
          LABEL,
          '发布接口（Content Posting API；而且它是两跳：init 拿 publish_id，上传之后轮询状态）',
        )
      )
    },

    // `comments` / `reply` 故意缺席：TikTok 没有开放的评论读写接口。
    // 缺席本身就是信息——调用方据此把"回评论"那个按钮画成灰的，
    // 而不是点下去之后拿到一句 `not_implemented`。
  }
}

/** 给 WP73 留的锚：`transport` 现在只用来判"连上了没有"。 */
export const TIKTOK_PUBLISH_INIT_PATH = '/post/publish/video/init/'
export const TIKTOK_PUBLISH_STATUS_PATH = '/post/publish/status/fetch/'
