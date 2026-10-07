/**
 * WP257：内存里的「Telegram Bot API」替身（**不访问 telegram.org**）。
 *
 * 只演「群里的帖子」自动进帖要的那几个口子，行为照文档：
 *
 * - `getUpdates`：一个机器人一条收件流；带 `offset` = 前面的都确认了、**从此不再给**；一页最多 `limit` 条。
 * - 隐私模式：开着、机器人又不是这个群的管理员时，群里只有 @它 / 回它的话进得了收件流（别的它根本收不到）。
 * - 设了 webhook：`getUpdates` 回 409。
 * - `getMe` / `getWebhookInfo` / `getChatMember` / `getChat`。
 *
 * 可以让接下来几次 `getUpdates` 回 429 / 500 / 409。**任何不是 get 开头的方法都记进 `writes`**——
 * 自动进帖一条都不该有。
 */
import type { SocialFetch } from '../src/social-channels.js'

export const TG_TOKEN = 'TG-TEST-TOKEN'

interface Chat {
  id: number
  title: string
  username?: string
  type: 'supergroup' | 'group' | 'private'
}

export interface FakeTelegram {
  bot: { id: number; username: string }
  /** 隐私模式开着（默认关：`can_read_all_group_messages` 为真）。 */
  privacy: boolean
  webhook: string
  chats: Map<number, Chat>
  /** 群 id → 机器人在里面的身份（不在里面 = 没有这一格）。 */
  botStatus: Map<number, 'member' | 'administrator' | 'left' | 'kicked'>
  /** 收件流里还没确认的那些。 */
  pending: { update_id: number; message?: Record<string, unknown> }[]
  /** 接下来几次 `getUpdates` 回这个状态码（用完就恢复）。 */
  failNext: number[]
  calls: string[]
  writes: string[]
  /** 往群里说一句；回消息 id。隐私模式挡住的那句根本不进收件流（回 `undefined`）。 */
  say(
    chat: number,
    text: string,
    opts?: {
      bot?: boolean
      at?: string
      mentionBot?: boolean
      replyTo?: { message_id: number; fromBot?: boolean }
      service?: boolean
      from?: string
    },
  ): number | undefined
  fetch: SocialFetch
}

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})
const ok = (result: unknown) => reply(200, { ok: true, result })
const fail = (code: number, description: string, extra: Record<string, unknown> = {}) =>
  reply(code, { ok: false, error_code: code, description, ...extra })

export function createFakeTelegram(options: { now: () => string }): FakeTelegram {
  let updateSeq = 500_000
  const messageSeq = new Map<number, number>()
  const site: FakeTelegram = {
    bot: { id: 4242, username: 'inmo_helper_bot' },
    privacy: false,
    webhook: '',
    chats: new Map(),
    botStatus: new Map(),
    pending: [],
    failNext: [],
    calls: [],
    writes: [],
    say(chat, text, opts = {}) {
      const c = site.chats.get(chat) ?? { id: chat, title: '', type: 'private' as const }
      const mid = (messageSeq.get(chat) ?? 0) + 1
      messageSeq.set(chat, mid)
      const admin = site.botStatus.get(chat) === 'administrator'
      const toBot = opts.mentionBot === true || opts.replyTo?.fromBot === true
      // 隐私模式：不是管理员的机器人只收得到冲着它来的
      if (site.privacy && !admin && !toBot && c.type !== 'private') return undefined
      if (site.botStatus.get(chat) === undefined && c.type !== 'private') return undefined
      const body = opts.mentionBot === true ? `@${site.bot.username} ${text}` : text
      updateSeq += 1
      site.pending.push({
        update_id: updateSeq,
        message: {
          message_id: mid,
          date: Math.floor(Date.parse(opts.at ?? options.now()) / 1000),
          chat: {
            id: c.id,
            type: c.type,
            title: c.title,
            ...(c.username === undefined ? {} : { username: c.username }),
          },
          from:
            opts.bot === true
              ? { id: site.bot.id, is_bot: true, username: site.bot.username }
              : { id: 100 + (mid % 3), is_bot: false, username: opts.from ?? `fan${mid % 3}` },
          ...(opts.service === true ? { new_chat_members: [{ id: 9 }] } : { text: body }),
          ...(opts.mentionBot === true
            ? { entities: [{ type: 'mention', offset: 0, length: site.bot.username.length + 1 }] }
            : {}),
          ...(opts.replyTo === undefined
            ? {}
            : {
                reply_to_message: {
                  message_id: opts.replyTo.message_id,
                  from:
                    opts.replyTo.fromBot === true
                      ? { id: site.bot.id, is_bot: true }
                      : { id: 101, is_bot: false },
                },
              }),
        },
      })
      return mid
    },
    fetch: async (input, init) => {
      const u = new URL(input)
      if (u.host !== 'api.telegram.org') throw new Error(`替身只认 api.telegram.org：${u.host}`)
      const m = u.pathname.match(/^\/bot([^/]*)\/(\w+)$/u)
      if (m === null) return fail(404, 'Not Found')
      if (m[1] !== TG_TOKEN) return fail(401, 'Unauthorized')
      const method = m[2] as string
      site.calls.push(method)
      if (!method.startsWith('get')) {
        site.writes.push(method)
        return fail(400, 'Bad Request: 替身不收写请求')
      }
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >
      const chatOf = (raw: unknown): Chat | undefined => {
        if (typeof raw === 'string' && raw.startsWith('@'))
          return [...site.chats.values()].find(
            (c) => c.username?.toLowerCase() === raw.slice(1).toLowerCase(),
          )
        return site.chats.get(Number(raw))
      }
      switch (method) {
        case 'getMe':
          return ok({ ...site.bot, is_bot: true, can_read_all_group_messages: !site.privacy })
        case 'getWebhookInfo':
          return ok({ url: site.webhook, pending_update_count: site.pending.length })
        case 'getChat': {
          const c = chatOf(body.chat_id)
          if (c === undefined || site.botStatus.get(c.id) === undefined)
            return fail(400, 'Bad Request: chat not found')
          return ok({
            id: c.id,
            type: c.type,
            title: c.title,
            ...(c.username === undefined ? {} : { username: c.username }),
          })
        }
        case 'getChatMember': {
          const c = chatOf(body.chat_id)
          const status = c === undefined ? undefined : site.botStatus.get(c.id)
          if (status === undefined) return fail(400, 'Bad Request: chat not found')
          if (status === 'kicked')
            return fail(403, 'Forbidden: bot was kicked from the supergroup chat')
          return ok({ status, user: { id: site.bot.id, is_bot: true } })
        }
        case 'getUpdates': {
          const code = site.failNext.shift()
          if (code === 429)
            return fail(429, 'Too Many Requests: retry after 5', { parameters: { retry_after: 5 } })
          if (code === 409)
            return fail(
              409,
              "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
            )
          if (code !== undefined) return fail(code, 'Internal Server Error')
          if (site.webhook !== '')
            return fail(
              409,
              "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
            )
          const offset = typeof body.offset === 'number' ? body.offset : undefined
          // 带了 offset：前面的都确认了，从此不再给
          if (offset !== undefined) site.pending = site.pending.filter((p) => p.update_id >= offset)
          const limit = typeof body.limit === 'number' ? body.limit : 100
          return ok(site.pending.slice(0, limit))
        }
        default:
          return fail(404, 'Not Found')
      }
    },
  }
  return site
}
