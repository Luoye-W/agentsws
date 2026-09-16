/**
 * Telegram 群组适配器（社群组，56 §2）。
 *
 * 事实来源：Telegram Bot API 文档（2026-09-16 读）。
 * <https://core.telegram.org/bots/api>
 *
 * 四件要留意的事：
 *
 * 1. **token 在 URL 的路径上**（`https://api.telegram.org/bot<token>/<method>`）。
 *    这是 Bot API 的规矩，改不了。后果是**任何一处把 URL 抄进日志 / 错误消息
 *    都等于泄露 token**——所以 `redactUrl` 专门为它把 `/bot<token>/` 那一段抹掉
 *    （见 `types.ts`）。这个文件里不许有第二个拼 URL 的地方。
 * 2. **所有方法都可以 POST JSON**，返回统一是 `{ ok, result }` 或
 *    `{ ok: false, description, error_code }`。HTTP 状态码不一定反映失败，
 *    所以每一跳都要看 `ok` 这一格（见 {@link unwrap}）。
 * 3. **列不出群成员**。Bot API 没有"给我这个群的成员名册"——只有
 *    `getChatMemberCount` 与逐个 `getChatMember`。所以 `members` 故意缺席；
 *    待审入群靠 `chat_join_request` **更新**推过来（那是渠道入站那一侧的事），
 *    这里只提供批 / 拒两个动作。
 * 4. **禁言是 `restrictChatMember` + 一组权限全关 + `until_date`**，
 *    不是一个 mute 方法。解除禁言要把权限**再传一遍**打开，传空对象等于全关着。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type BroadcastInput,
  type ChannelProfile,
  callJson,
  guardConnected,
  type MemberDecisionInput,
  type ModerateInput,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialError,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'telegram_group'
const LABEL = 'Telegram 群组'
export const TELEGRAM_API_BASE = 'https://api.telegram.org'

interface TelegramEnvelope<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
}

interface RawChat {
  id?: number
  title?: string
  username?: string
  description?: string
}

interface RawMessage {
  message_id?: number
  date?: number
}

/** 解封那一跳要传的权限（文件头第 4 条：传空对象等于继续全关着）。 */
const UNMUTED_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
} as const

/**
 * `{ ok, result }` → 我们的结果（文件头第 2 条）。
 *
 * Telegram 把业务错误也放在 200 里，所以 HTTP 层过了不等于这一跳成了。
 * `description` 是它给的人话（"Bad Request: chat not found"），原样带上——
 * 它比我们编一句有用。
 */
function unwrap<T>(label: string, env: TelegramEnvelope<T>): { ok: true; data: T } | SocialError {
  if (env.ok === true && env.result !== undefined) return { ok: true, data: env.result }
  const code = env.error_code
  if (code === 429)
    return {
      ok: false,
      reason: 'rate_limited',
      status: 429,
      message: `${label} 说太快了（429）。等一会儿再试；这一批先排着，不会丢。`,
    }
  if (code === 401 || code === 403)
    return {
      ok: false,
      reason: 'not_connected',
      status: code,
      message: `${label} 拒绝了这次调用（${code}：${env.description ?? '没说原因'}）。多半是机器人 token 不对，或者它还没被拉进这个群 / 还不是管理员。`,
    }
  return {
    ok: false,
    reason: 'upstream_error',
    ...(code === undefined ? {} : { status: code }),
    message: `${label}：${env.description ?? '那边没说为什么'}`,
  }
}

export function createTelegramAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  /** 唯一一处拼 URL（文件头第 1 条）。 */
  const endpoint = async (method: string): Promise<string> => {
    const cred = await transport.credential(CHANNEL)
    return `${TELEGRAM_API_BASE}/bot${cred.bot_token ?? cred.token ?? ''}/${method}`
  }
  const call = async <T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; data: T } | SocialError> => {
    const url = await endpoint(method)
    const res = await callJson<TelegramEnvelope<T>>(transport, LABEL, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!('data' in res)) return res
    return unwrap<T>(LABEL, res.data)
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const chat = await call<RawChat>('getChat', { chat_id: account_external_id })
      if (!('data' in chat)) return chat
      // 成员数是**另一跳**（`getChat` 不给），所以社群面板那个数要两次调用
      const count = await call<number>('getChatMemberCount', { chat_id: account_external_id })
      const raw = chat.data
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: account_external_id,
          handle: raw.username ?? String(raw.id ?? account_external_id),
          display_name: raw.title ?? '',
          url:
            raw.username === undefined
              ? `https://t.me/c/${String(raw.id ?? '').replace(/^-100/, '')}`
              : `https://t.me/${raw.username}`,
          ...('data' in count ? { member_count: count.data } : {}),
          ...(raw.description === undefined ? {} : { bio: raw.description }),
        },
      }
    },

    // `posts` / `comments` / `members` 故意缺席（文件头第 3 条）：
    // Bot API 没有"给我这个群的历史消息 / 成员名册"。群里说了什么是靠
    // 更新（webhook / long polling）推过来的，那是渠道入站那一侧的事。

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (input.scheduled_at !== undefined)
        return notImplemented(
          LABEL,
          'Bot API 没有排期发送；排期由我们自己的调度器管，到点之后再调这一跳',
        )
      const res = await call<RawMessage>('sendMessage', {
        chat_id: input.account_external_id,
        text: input.body,
        // 群里的链接预览会把一条公告撑成半屏，默认关掉
        link_preview_options: { is_disabled: true },
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: String(res.data.message_id ?? '') },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const res = await call<RawMessage>('sendMessage', {
        chat_id: input.account_external_id,
        text: input.text,
        // `reply_parameters` 是新写法（旧的 `reply_to_message_id` 仍在，但已标过时）
        reply_parameters: { message_id: Number(input.parent_external_id) },
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: { external_id: String(res.data.message_id ?? '') },
      }
    },

    async decideMember(input: MemberDecisionInput): Promise<SocialResult<{ ok: true }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const method =
        input.decision === 'approve'
          ? 'approveChatJoinRequest'
          : input.decision === 'reject'
            ? 'declineChatJoinRequest'
            : 'banChatMember'
      const res = await call<boolean>(method, {
        chat_id: input.account_external_id,
        user_id: Number(input.member_external_id),
        // `remove` = 踢出去但不封（封了他连群链接都点不开）
        ...(input.decision === 'remove' ? { revoke_messages: false } : {}),
      })
      if (!('data' in res)) return res
      if (input.decision === 'remove') {
        // 踢出去之后立刻解封，否则 `banChatMember` 等于永久封禁
        await call<boolean>('unbanChatMember', {
          chat_id: input.account_external_id,
          user_id: Number(input.member_external_id),
          only_if_banned: true,
        })
      }
      return { ok: true, observed_at: transport.now(), data: { ok: true } }
    },

    async broadcast(
      input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 群发 = 往群里发一条公告。挨个私信几千人在 Telegram 上会被限流到发不出去，
      // 而且那也不是"群发"，那是骚扰。
      const res = await call<RawMessage>('sendMessage', {
        chat_id: input.account_external_id,
        text: input.body,
        link_preview_options: { is_disabled: true },
      })
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { sent: 1, failed: 0 } }
    },

    async moderate(input: ModerateInput): Promise<SocialResult<{ ok: true }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const chat_id = input.account_external_id
      switch (input.action) {
        case 'delete_post': {
          const res = await call<boolean>('deleteMessage', {
            chat_id,
            message_id: Number(input.target_external_id),
          })
          if (!('data' in res)) return res
          break
        }
        case 'mute': {
          // 文件头第 4 条：禁言 = 权限全关 + 到期时刻（Unix **秒**）
          const minutes = input.duration_minutes ?? 60
          const res = await call<boolean>('restrictChatMember', {
            chat_id,
            user_id: Number(input.target_external_id),
            permissions: { can_send_messages: false },
            until_date: Math.floor((Date.parse(transport.now()) + minutes * 60_000) / 1000),
          })
          if (!('data' in res)) return res
          break
        }
        case 'unmute': {
          const res = await call<boolean>('restrictChatMember', {
            chat_id,
            user_id: Number(input.target_external_id),
            permissions: UNMUTED_PERMISSIONS,
          })
          if (!('data' in res)) return res
          break
        }
        case 'ban':
        case 'permanent_ban': {
          const res = await call<boolean>('banChatMember', {
            chat_id,
            user_id: Number(input.target_external_id),
          })
          if (!('data' in res)) return res
          break
        }
        case 'unban': {
          const res = await call<boolean>('unbanChatMember', {
            chat_id,
            user_id: Number(input.target_external_id),
            only_if_banned: true,
          })
          if (!('data' in res)) return res
          break
        }
      }
      return { ok: true, observed_at: transport.now(), data: { ok: true } }
    },
  }
}
