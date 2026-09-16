/**
 * 九条渠道的适配器（56 §3 末段）。
 *
 * WP72 做了四条**有真实现**的（Meta / YouTube / Discord / Telegram：真 HTTP 形状
 * 按各家公开文档写，`fetch` 注入），四条是接口 + 一句说清为什么还没有的人话
 * （TikTok 申请制、X 付费档、Reddit 要注册应用、WhatsApp 要商业验证），
 * 外加一条浏览器模式的 Facebook 群组（脚本描述有，执行器待 WP73 接）。
 *
 * **只有这一处按渠道分派**：宿主拿到的是一张表，多一条渠道只改这里一行。
 * 九条都建出来不花什么——适配器自己不打任何一跳，`connected()` 说没连就没连。
 */

import type { SocialChannel } from '@agentsws/contracts'
import { createDiscordAdapter } from './discord.js'
import { type BrowserExecutor, createFacebookGroupAdapter } from './facebook-group.js'
import { createMetaAdapter } from './meta.js'
import { createRedditAdapter } from './reddit.js'
import { createTelegramAdapter } from './telegram.js'
import { createTikTokAdapter } from './tiktok.js'
import type { SocialChannelAdapter, SocialTransport } from './types.js'
import { createWhatsAppAdapter } from './whatsapp.js'
import { createXAdapter } from './x.js'
import { createYouTubeSocialAdapter } from './youtube.js'

export * from './discord.js'
export * from './facebook-group.js'
export * from './meta.js'
export * from './reddit.js'
export * from './telegram.js'
export * from './tiktok.js'
export * from './types.js'
export * from './whatsapp.js'
export * from './x.js'
export * from './youtube.js'

/** 一个 transport → 九条渠道的适配器。 */
export function createSocialAdapters(
  transport: SocialTransport,
  /**
   * WP73：受控浏览器执行器（55 §3）。**只有 Facebook 群组用得上**——
   * 另外八条走 HTTP，给不给它都一样。不给 = 那条渠道还是"只出脚本描述"。
   */
  options: { browser?: BrowserExecutor } = {},
): Record<SocialChannel, SocialChannelAdapter> {
  return {
    meta: createMetaAdapter(transport),
    tiktok: createTikTokAdapter(transport),
    x: createXAdapter(transport),
    youtube: createYouTubeSocialAdapter(transport),
    facebook_group: createFacebookGroupAdapter(
      transport,
      options.browser === undefined ? {} : { browser: options.browser },
    ),
    reddit: createRedditAdapter(transport),
    discord: createDiscordAdapter(transport),
    telegram_group: createTelegramAdapter(transport),
    whatsapp: createWhatsAppAdapter(transport),
  }
}

/**
 * 这条渠道现在**真做得了**哪几件事。
 *
 * 界面上把做不了的按钮画成灰的靠它。判据是"适配器上有没有这个方法"
 * （缺席本身就是信息，见 `types.ts` 的 `SocialChannelAdapter` 注释），
 * 不是试着调一次看回什么。
 */
export function capabilitiesOf(adapter: SocialChannelAdapter): {
  read: string[]
  write: string[]
} {
  const read: string[] = []
  const write: string[] = []
  if (adapter.profile !== undefined) read.push('profile')
  if (adapter.posts !== undefined) read.push('posts')
  if (adapter.comments !== undefined) read.push('comments')
  if (adapter.members !== undefined) read.push('members')
  if (adapter.publish !== undefined) write.push('publish')
  if (adapter.reply !== undefined) write.push('reply')
  if (adapter.decideMember !== undefined) write.push('decideMember')
  if (adapter.broadcast !== undefined) write.push('broadcast')
  if (adapter.moderate !== undefined) write.push('moderate')
  return { read, write }
}
