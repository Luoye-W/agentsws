/**
 * 五条渠道的适配器（48 §5.1 / §5.2）。
 *
 * WP67 只做了 YouTube 与 Instagram，其余三条是接口 + 一句 `not_implemented`；
 * WP68 把 Facebook / TikTok / X 也写完了——五条现在都是**同一个形状**：
 * 注入 transport、没连就说没连、拿不到就说为什么拿不到。
 */
import type { KolChannel } from '@agentsws/contracts'
import { createFacebookAdapter } from './facebook.js'
import { createInstagramAdapter } from './instagram.js'
import { createTikTokAdapter } from './tiktok.js'
import type { KolChannelAdapter, KolChannelTransport } from './types.js'
import { createXAdapter } from './x.js'
import { createYouTubeAdapter } from './youtube.js'

export * from './facebook.js'
export * from './instagram.js'
export * from './tiktok.js'
export * from './types.js'
export * from './x.js'
export * from './youtube.js'

/**
 * 一个 transport → 五条渠道的适配器。
 *
 * **只有这一处按渠道分派**：宿主拿到的是一张表，多一条渠道只改这里一行。
 * 五条都建出来不花什么——适配器自己不打任何一跳，`connected()` 说没连就没连。
 */
export function createChannelAdapters(
  transport: KolChannelTransport,
): Record<KolChannel, KolChannelAdapter> {
  return {
    youtube: createYouTubeAdapter(transport),
    facebook: createFacebookAdapter(transport),
    instagram: createInstagramAdapter(transport),
    tiktok: createTikTokAdapter(transport),
    x: createXAdapter(transport),
  }
}
