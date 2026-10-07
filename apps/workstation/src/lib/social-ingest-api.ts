/**
 * WP256（决策 147）：「群里的帖子」自动进帖的状态与设置，外加 Discord 登记要读的频道。
 *
 * 单独一个文件（`api.ts` 那张大表好几单同时在加）。
 */
import { api, type SocialChannelId } from './api'

const as = (assignment: string | undefined) => (assignment === undefined ? {} : { assignment })

/** 缺哪几样（与服务端 `ChannelReadGap` 一字不差）。 */
export type IngestGap =
  | 'bot_not_in_server'
  | 'view_channel'
  | 'read_message_history'
  | 'message_content'

/**
 * 与 `@agentsws/api` 的 `SocialIngestView` 同形（工作台不依赖服务端那个包，照老规矩在这里再写一遍）。
 */
export interface SocialIngestData {
  channel: SocialChannelId
  /** 这条渠道会不会自动拉新帖（现在：Discord、Reddit 自家版）。 */
  auto: boolean
  connected: boolean
  every_minutes?: number
  accounts: {
    account_id: string
    name: string
    state:
      | 'ok'
      | 'waiting'
      | 'not_connected'
      | 'needs_channel'
      | 'missing_permissions'
      | 'limited'
      | 'failed'
    message?: string
    missing?: IngestGap[]
    last_read_at?: string
    next_read_at?: string
  }[]
}

/** 这条渠道的自动进帖读到什么样了（空态照实说用）。 */
export const getSocialIngest = (
  channel: SocialChannelId,
  assignment?: string,
): Promise<SocialIngestData> =>
  api(`/v1/social/ingest?channel=${encodeURIComponent(channel)}`, as(assignment))

/** 改多久读一次（现在只有 Discord：5 分钟到 24 小时）。 */
export const setSocialIngestInterval = (
  channel: SocialChannelId,
  every_minutes: number,
  assignment?: string,
): Promise<SocialIngestData> =>
  api('/v1/social/ingest', {
    method: 'PUT',
    body: { channel, every_minutes },
    ...as(assignment),
  })

/**
 * 粘贴的 Discord 频道链接 → 服务器 id / 频道 id。认 `https://discord.com/channels/<服务器>/<频道>`
 * （Discord 里右键频道「复制链接」拿到的就是它）与 `<服务器>/<频道>` 两种写法；认不出来回 `undefined`。
 */
export function parseDiscordChannel(raw: string): { guild: string; channel: string } | undefined {
  const m = raw.trim().match(/(?:channels\/)?(\d{15,25})\/(\d{15,25})(?:\/\d+)?\/?$/u)
  if (m === null) return undefined
  return { guild: m[1] as string, channel: m[2] as string }
}

/** 登记一个要读的 Discord 频道（成了社媒库里的一个号；之后按频率自动读它的新消息）。 */
export const registerDiscordChannel = (
  target: { guild: string; channel: string },
  assignment?: string,
): Promise<{ id: string }> =>
  api('/v1/social/accounts', {
    method: 'POST',
    body: {
      channel: 'discord',
      handle: target.channel,
      display_name: `#${target.channel.slice(-4)}`,
      url: `https://discord.com/channels/${target.guild}/${target.channel}`,
      external_id: `${target.guild}/${target.channel}`,
    },
    ...as(assignment),
  })
