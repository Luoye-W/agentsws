/**
 * WP256（决策 147）：Discord「群里的帖子」自动进帖要的几样纯算法——续读、按 id 排序、权限推算。
 *
 * 事实来源：Discord API v10 文档（2026-10-07 按文档整理，没有连 discord.com）。
 *
 * 1. **消息 id 是 snowflake**（64 位整数的字符串），越新越大。比大小要按整数比（`BigInt`），
 *    按字符串比在位数不同时会错。`GET /channels/{id}/messages?after=<id>` 回的是那一条**之后**的消息，
 *    回来的顺序不保证从旧到新——这里一律自己排。
 * 2. **读消息要两样频道权限**：`VIEW_CHANNEL`（1 << 10，看得到这个频道）与 `READ_MESSAGE_HISTORY`
 *    （1 << 16，没有它接口回一个空数组，不报错——所以「读到 0 条」与「没权限」必须先查清楚）。
 * 3. **正文还要一样应用级开关**：Message Content Intent。没开的话别人发的消息 `content` 全是空字符串
 *    （接口照样 200）。开没开看 `GET /applications/@me` 的 `flags`：`GATEWAY_MESSAGE_CONTENT`（1 << 18，
 *    验证过的应用）或 `GATEWAY_MESSAGE_CONTENT_LIMITED`（1 << 19，没验证、在后台点开的那一档）。
 * 4. **频道权限怎么算**（文档「Permission Overwrites」那一段）：@everyone 角色（id = 服务器 id）的权限
 *    并上机器人各角色的权限；有管理员（1 << 3）就全有；再依次套频道上的覆写——@everyone 覆写、
 *    机器人各角色覆写（先合并 deny 再合并 allow）、机器人自己的成员覆写。
 */
import type { ChannelComment, ChannelReadGap } from './types.js'

export const DISCORD_PERMISSION = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const

export const DISCORD_APP_FLAG = {
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const

/** 普通消息（0）与回复（19）才是「有人说了句话」；入群提示、置顶提示、开帖提示等系统消息不算。 */
const SPOKEN_TYPES = new Set([0, 19])

/** snowflake 比大小（a > b → 正数）。认不出来的按 0 算，不抛。 */
export function compareSnowflake(a: string, b: string): number {
  const big = (v: string): bigint => {
    try {
      return /^\d+$/u.test(v) ? BigInt(v) : 0n
    } catch {
      return 0n
    }
  }
  const x = big(a)
  const y = big(b)
  return x === y ? 0 : x > y ? 1 : -1
}

export interface DiscordRawMessage {
  id?: string
  type?: number
  content?: string
  timestamp?: string
  channel_id?: string
  author?: { id?: string; username?: string; bot?: boolean }
  attachments?: unknown[]
  message_reference?: { message_id?: string }
}

/**
 * 一页原始消息 → 「群里的帖子」那一页：从旧到新、只留别人说的话、记下这一页最大的 id。
 *
 * 只发了附件没写字的那一条也算一条（正文写一句「只发了附件」，原话照实——不编内容）。
 */
export function discordFeedPage(
  raw: readonly DiscordRawMessage[],
  now: string,
): { items: ChannelComment[]; last_id?: string; fetched: number } {
  const sorted = raw
    .filter((m): m is DiscordRawMessage & { id: string } => typeof m.id === 'string' && m.id !== '')
    .sort((a, b) => compareSnowflake(a.id, b.id))
  const last = sorted.at(-1)?.id
  const items: ChannelComment[] = []
  for (const m of sorted) {
    if (m.author?.bot === true) continue
    if (m.type !== undefined && !SPOKEN_TYPES.has(m.type)) continue
    const text = (m.content ?? '').trim()
    const attached = (m.attachments ?? []).length > 0
    if (text === '' && !attached) continue
    items.push({
      external_id: m.id,
      ...(m.message_reference?.message_id === undefined
        ? {}
        : { parent_external_id: m.message_reference.message_id }),
      surface: m.message_reference?.message_id === undefined ? 'thread' : 'comment',
      author_external_id: m.author?.id ?? '',
      author_handle: m.author?.username ?? m.author?.id ?? '',
      text: text === '' ? '（只发了附件）' : (m.content ?? ''),
      created_at: m.timestamp ?? now,
    })
  }
  return { items, ...(last === undefined ? {} : { last_id: last }), fetched: raw.length }
}

export interface DiscordOverwrite {
  id?: string
  /** 0 = 角色，1 = 成员。 */
  type?: number | string
  allow?: string
  deny?: string
}

const bits = (v: string | undefined): bigint => {
  try {
    return v === undefined || v === '' ? 0n : BigInt(v)
  } catch {
    return 0n
  }
}

/** 文件头第 4 条：机器人在这个频道上的权限位。 */
export function discordChannelPermissions(input: {
  guild_id: string
  bot_id: string
  /** 机器人身上的角色 id（不含 @everyone）。 */
  member_roles: readonly string[]
  /** 服务器全部角色（含 @everyone，它的 id = 服务器 id）。 */
  roles: readonly { id?: string; permissions?: string }[]
  overwrites: readonly DiscordOverwrite[]
}): bigint {
  const roleBits = new Map(input.roles.map((r) => [r.id ?? '', bits(r.permissions)]))
  let perms = roleBits.get(input.guild_id) ?? 0n
  for (const id of input.member_roles) perms |= roleBits.get(id) ?? 0n
  if ((perms & DISCORD_PERMISSION.ADMINISTRATOR) !== 0n) return ~0n
  const kind = (o: DiscordOverwrite): number => Number(o.type ?? -1)
  const everyone = input.overwrites.find((o) => kind(o) === 0 && o.id === input.guild_id)
  if (everyone !== undefined) {
    perms &= ~bits(everyone.deny)
    perms |= bits(everyone.allow)
  }
  let allow = 0n
  let deny = 0n
  for (const o of input.overwrites)
    if (kind(o) === 0 && o.id !== undefined && input.member_roles.includes(o.id)) {
      allow |= bits(o.allow)
      deny |= bits(o.deny)
    }
  perms &= ~deny
  perms |= allow
  const mine = input.overwrites.find((o) => kind(o) === 1 && o.id === input.bot_id)
  if (mine !== undefined) {
    perms &= ~bits(mine.deny)
    perms |= bits(mine.allow)
  }
  return perms
}

/** 权限位 + 应用 flags → 缺哪几样（顺序固定：先频道两样，再正文那一样）。 */
export function discordReadGaps(perms: bigint, app_flags: number | undefined): ChannelReadGap[] {
  const out: ChannelReadGap[] = []
  if ((perms & DISCORD_PERMISSION.VIEW_CHANNEL) === 0n) out.push('view_channel')
  if ((perms & DISCORD_PERMISSION.READ_MESSAGE_HISTORY) === 0n) out.push('read_message_history')
  if (app_flags !== undefined && !hasMessageContent(app_flags)) out.push('message_content')
  return out
}

export function hasMessageContent(app_flags: number): boolean {
  return (
    (app_flags & DISCORD_APP_FLAG.GATEWAY_MESSAGE_CONTENT) !== 0 ||
    (app_flags & DISCORD_APP_FLAG.GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0
  )
}

/** 缺的那几样 → 一句人话（界面上那一行；具体去哪儿开在问号里）。 */
export const CHANNEL_READ_GAP_WORDS: Readonly<Record<ChannelReadGap, string>> = {
  bot_not_in_server: '机器人不在这个服务器里',
  view_channel: '「查看频道」权限',
  read_message_history: '「读取消息历史」权限',
  message_content: '开发者后台的「Message Content Intent」开关',
}

export function readGapMessage(label: string, missing: readonly ChannelReadGap[]): string {
  if (missing.includes('bot_not_in_server'))
    return `${label} 机器人不在这个服务器里：用连接页里的邀请链接把它拉进来，再回来看。`
  return `${label} 机器人还缺 ${missing.map((m) => CHANNEL_READ_GAP_WORDS[m]).join('、')}，所以读不到这个频道的新消息。`
}
