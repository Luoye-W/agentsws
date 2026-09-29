/**
 * WP191（docs/86 §3.2 / §5）：**Facebook 主页**适配器。
 *
 * 与老的 `meta` 适配器是**同一份实现**（`createGraphPageAdapter`）：同一套 Pages API、
 * 同一把 `meta_graph` 令牌（FB 与 IG 连一次、批一次，Luoye 09-29）。
 * 这条渠道特有的规矩都已经在那份实现里：排期两格一起写（`published=false` +
 * `scheduled_publish_time`，官方要求在 10 分钟到 30 天之间）、互动数用
 * `summary(true)` 只取计数、评论挂在帖子下。
 *
 * 事实来源：<https://developers.facebook.com/docs/pages-api/posts>（2026-09-29 读）。
 */
import type { SocialChannel } from '@agentsws/contracts'
import { createGraphPageAdapter } from './meta.js'
import type { SocialChannelAdapter, SocialTransport } from './types.js'

const CHANNEL: SocialChannel = 'facebook'
const LABEL = 'Facebook 主页'

export function createFacebookPageAdapter(transport: SocialTransport): SocialChannelAdapter {
  return createGraphPageAdapter(transport, { channel: CHANNEL, label: LABEL })
}
