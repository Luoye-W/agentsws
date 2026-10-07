/**
 * WP257（决策 156）：Telegram 群「群里的帖子」自动进帖要的几样纯算法——收件流一页怎么拆、谁 @ 了我们、
 * 缺什么。
 *
 * 事实来源：Telegram Bot API 文档（2026-10-07 按文档整理，没有连 telegram.org）。
 *
 * 1. **一个机器人只有一条收件流**（`getUpdates`），不分群；每条 update 带 `update_id`（递增）。下一次带上
 *    `offset = 最后一条 + 1`，前面那些就算确认了，Telegram 不再给第二遍；没确认的最多留 24 小时。
 * 2. **隐私模式**（privacy mode，默认开）：开着的机器人在群里只收得到命令、@它的话、回它的话。
 *    `getMe` 的 `can_read_all_group_messages` 为真 = 关了。**群管理员机器人不受隐私模式限制**（收得到全部）。
 *    关掉的办法在 @BotFather（`/setprivacy` → Disable），改完要把机器人移出群再拉回来才生效。
 * 3. **设了 webhook 就不能 `getUpdates`**（回 409 Conflict）。`getWebhookInfo` 的 `url` 不空 = 设了。
 * 4. **系统消息**（谁进群了、谁走了、置顶了、改群名了……）不是「有人说了句话」，不进帖。只发图片 / 文件
 *    没写字的那一条也算一条，正文照实写「（只发了图片或文件）」，不编内容。
 */
import type { ChannelComment, ChannelUpdatesPage } from './types.js'

export interface TelegramRawUser {
  id?: number
  is_bot?: boolean
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramRawChat {
  id?: number
  type?: string
  title?: string
  username?: string
}

export interface TelegramRawEntity {
  type?: string
  offset?: number
  length?: number
  user?: TelegramRawUser
}

export interface TelegramRawMessage {
  message_id?: number
  date?: number
  chat?: TelegramRawChat
  from?: TelegramRawUser
  /** 匿名管理员 / 频道身份发的话：作者是这个「聊天」，不是一个人。 */
  sender_chat?: TelegramRawChat
  text?: string
  caption?: string
  entities?: TelegramRawEntity[]
  caption_entities?: TelegramRawEntity[]
  reply_to_message?: { message_id?: number; from?: TelegramRawUser }
  photo?: unknown
  video?: unknown
  document?: unknown
  audio?: unknown
  voice?: unknown
  sticker?: unknown
  animation?: unknown
  video_note?: unknown
}

export interface TelegramRawUpdate {
  update_id?: number
  message?: TelegramRawMessage
}

/** 机器人自己（`getMe`）。 */
export interface TelegramBotSelf {
  id: number
  username?: string
  can_read_all_group_messages?: boolean
}

const MEDIA_KEYS = [
  'photo',
  'video',
  'document',
  'audio',
  'voice',
  'sticker',
  'animation',
  'video_note',
] as const

const GROUP_TYPES = new Set(['group', 'supergroup'])

/** 这条是不是冲着我们的机器人来的：@ 了它的用户名、点名 @ 了它、或回的是它说的那句。 */
export function telegramMentionsBot(
  m: TelegramRawMessage,
  me: TelegramBotSelf | undefined,
): boolean {
  if (me === undefined) return false
  if (m.reply_to_message?.from?.id === me.id) return true
  const body = m.text ?? m.caption ?? ''
  const handle = me.username === undefined ? undefined : `@${me.username}`.toLowerCase()
  for (const e of [...(m.entities ?? []), ...(m.caption_entities ?? [])]) {
    if (e.type === 'text_mention' && e.user?.id === me.id) return true
    if (e.type === 'mention' && handle !== undefined) {
      // offset / length 按 UTF-16 算，JS 字符串本来就是 UTF-16
      const said = body.slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? 0)).toLowerCase()
      if (said === handle) return true
    }
  }
  return false
}

const nameOf = (u: TelegramRawUser | undefined): string => {
  if (u === undefined) return ''
  if (u.username !== undefined && u.username !== '') return u.username
  return [u.first_name, u.last_name].filter((x) => x !== undefined && x !== '').join(' ')
}

/**
 * 一页 update → 「群里的帖子」那一页：只留群里别人说的话，记下下一次从哪儿接着读。
 * 私聊、频道、机器人说的、系统消息都不进；`next_offset` 照样往前走（文件头第 1 条：读过的不会再给）。
 */
export function telegramUpdatesPage(
  raw: readonly TelegramRawUpdate[],
  now: string,
  me?: TelegramBotSelf,
): ChannelUpdatesPage {
  let max: number | undefined
  const items: ChannelUpdatesPage['items'] = []
  const sorted = raw
    .filter((u): u is TelegramRawUpdate & { update_id: number } => typeof u.update_id === 'number')
    .sort((a, b) => a.update_id - b.update_id)
  for (const u of sorted) {
    max = max === undefined || u.update_id > max ? u.update_id : max
    const m = u.message
    if (m === undefined || typeof m.message_id !== 'number') continue
    if (m.chat?.id === undefined || !GROUP_TYPES.has(m.chat.type ?? '')) continue
    if (m.from?.is_bot === true) continue
    const said = (m.text ?? m.caption ?? '').trim()
    const media = MEDIA_KEYS.some((k) => m[k] !== undefined)
    if (said === '' && !media) continue
    const author =
      m.from === undefined && m.sender_chat !== undefined
        ? {
            id: String(m.sender_chat.id ?? ''),
            handle: m.sender_chat.title ?? m.sender_chat.username ?? '',
          }
        : { id: String(m.from?.id ?? ''), handle: nameOf(m.from) }
    const parent = m.reply_to_message?.message_id
    const comment: ChannelComment = {
      external_id: String(m.message_id),
      ...(parent === undefined ? {} : { parent_external_id: String(parent) }),
      surface: parent === undefined ? 'thread' : 'comment',
      author_external_id: author.id,
      author_handle: author.handle === '' ? author.id : author.handle,
      text: said === '' ? '（只发了图片或文件）' : (m.text ?? m.caption ?? ''),
      created_at: typeof m.date === 'number' ? new Date(m.date * 1000).toISOString() : now,
      ...(me === undefined ? {} : { mentions_us: telegramMentionsBot(m, me) }),
    }
    items.push({
      chat_id: String(m.chat.id),
      ...(m.chat.username === undefined ? {} : { chat_username: m.chat.username }),
      comment,
    })
  }
  return {
    items,
    ...(max === undefined ? {} : { next_offset: String(max + 1) }),
    fetched: raw.length,
  }
}

/**
 * 粘贴进来的 Telegram 群地址 → 登记用的 `chat_id`。
 *
 * - `https://t.me/c/1234567890/55`（私有超级群里某条消息的链接）→ `-1001234567890`
 * - `https://t.me/inmo_users` / `@inmo_users`（公开群）→ `@inmo_users`（登记时再换成数字 id）
 * - `-1001234567890` / `-12345`（数字 id）→ 原样
 *
 * 邀请链接（`t.me/+…` / `t.me/joinchat/…`）看不出是哪个群，认不出来回 `undefined`。
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
