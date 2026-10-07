/**
 * WP256（决策 147）：「群里的帖子」自动进帖的状态与设置，外加 Discord 登记要读的频道。
 * WP257（决策 152 / 156）：Telegram 群登记、判类模型复核开关。
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
  | 'privacy_mode'
  | 'webhook_active'

/** WP257：判类打标签的设置（与服务端 `SocialTagSettingsView` 同形）。 */
export interface SocialTagSettingsData {
  /** 规则判完再请模型复核（默认关）。 */
  model_review: boolean
  /** 这台接没接上真模型（没接上时开着也只按规则判）。 */
  model_ready: boolean
}

/**
 * 与 `@agentsws/api` 的 `SocialIngestView` 同形（工作台不依赖服务端那个包，照老规矩在这里再写一遍）。
 */
export interface SocialIngestData {
  channel: SocialChannelId
  /** 这条渠道会不会自动拉新帖（现在：Discord、Reddit 自家版、Telegram 群）。 */
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
  /** WP257：判类打标签的设置（老服务进程没有）。 */
  tags?: SocialTagSettingsData
}

/** 这条渠道的自动进帖读到什么样了（空态照实说用）。 */
export const getSocialIngest = (
  channel: SocialChannelId,
  assignment?: string,
): Promise<SocialIngestData> =>
  api(`/v1/social/ingest?channel=${encodeURIComponent(channel)}`, as(assignment))

/** 改多久读一次（Discord、Telegram 群：5 分钟到 24 小时）。 */
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

/** WP257：判类打标签要不要再请模型复核（默认关）。 */
export const setSocialTagReview = (
  model_review: boolean,
  assignment?: string,
): Promise<SocialTagSettingsData> =>
  api('/v1/social/ingest/tags', { method: 'PUT', body: { model_review }, ...as(assignment) })

/**
 * WP257（决策 156）：粘贴的 Telegram 群地址 → 登记用的 `chat_id`（与 `@agentsws/social-core` 的
 * `parseTelegramGroup` 同一套规则）：私有群消息链接 `t.me/c/<id>/<n>` → `-100<id>`；公开群 `t.me/<名>` /
 * `@名` → `@名`；数字 id 原样。邀请链接（`t.me/+…`）看不出是哪个群，认不出来回 `undefined`。
 */
export function parseTelegramGroup(raw: string): string | undefined {
  const s = raw.trim()
  if (/^-\d{5,20}$/u.test(s)) return s
  const priv = s.match(/(?:^|\/\/|\b)t\.me\/c\/(\d{5,20})(?:\/\d+)*\/?$/u)
  if (priv !== null) return `-100${priv[1]}`
  if (/t\.me\/(?:\+|joinchat\/)/u.test(s)) return undefined
  const pub = s.match(
    /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\d+\/?)?$/u,
  )
  if (pub !== null) return `@${pub[1]}`
  const at = s.match(/^@([A-Za-z][A-Za-z0-9_]{3,31})$/u)
  if (at !== null) return `@${at[1]}`
  return undefined
}

/**
 * 登记一个要读的 Telegram 群（成了社媒库里的一个号）。显示名先给默认名（公开群 `@名`、私有群「群 末四位」），
 * 服务端登记那一下读一次群名换上。
 */
export const registerTelegramGroup = (chat: string, assignment?: string): Promise<{ id: string }> =>
  api('/v1/social/accounts', {
    method: 'POST',
    body: {
      channel: 'telegram_group',
      handle: chat,
      display_name: chat.startsWith('@') ? chat : `群 ${chat.slice(-4)}`,
      url: chat.startsWith('@')
        ? `https://t.me/${chat.slice(1)}`
        : `https://t.me/c/${chat.replace(/^-100/u, '')}`,
      external_id: chat,
    },
    ...as(assignment),
  })
