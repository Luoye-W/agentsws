/**
 * Discord 适配器（社群组，56 §2）。
 *
 * 事实来源：Discord API v10 文档（2026-09-16 读）。
 * <https://discord.com/developers/docs/reference>
 *
 * 四件要留意的事：
 *
 * 1. **鉴权头是 `Bot <token>`，不是 `Bearer`**。写成 Bearer 的话每一跳都是 401，
 *    而 401 我们翻成"授权掉了，去重连"——用户会在连接页上反复重连一把
 *    根本没问题的 token。
 * 2. **账号 id 有两种**：服务器（guild）与频道（channel）。这里的
 *    `account_external_id` 一律是 **guild id**，要往某个频道发消息时用
 *    `guild_id/channel_id` 这种写法（见 {@link splitTarget}）——
 *    一个 Discord 社群有几十个频道，"发到这个服务器"不是一句完整的话。
 * 3. **Discord 没有"入群申请"**（除非开了会员筛选，而那个没有公开 API）。
 *    所以 `members` 只列真成员，`decideMember` 只做 `remove`——
 *    批准 / 拒绝在这条渠道上不存在，照实说，不假装有。
 * 4. **禁言是给成员设一个到期时刻**（`communication_disabled_until`，
 *    ISO 8601，最长 28 天），不是一个"mute" 动作。传 `null` 是解除。
 */

import type { SocialChannel } from '@agentsws/contracts'
import {
  type DiscordOverwrite,
  type DiscordRawMessage,
  discordChannelPermissions,
  discordFeedPage,
  discordNeedsBotId,
  discordReadGaps,
} from './discord-read.js'
import {
  type BroadcastInput,
  type ChannelComment,
  type ChannelFeedPage,
  type ChannelMember,
  type ChannelPost,
  type ChannelProfile,
  type ChannelReadGap,
  callJson,
  guardConnected,
  type MemberDecisionInput,
  type ModerateInput,
  notImplemented,
  type PublishInput,
  type ReplyInput,
  type SocialChannelAdapter,
  type SocialResult,
  type SocialTransport,
} from './types.js'

const CHANNEL: SocialChannel = 'discord'
const LABEL = 'Discord'
export const DISCORD_API_BASE = 'https://discord.com/api/v10'

/** 禁言最长 28 天（文档；超了 Discord 直接拒）。 */
export const DISCORD_MAX_TIMEOUT_MINUTES = 28 * 24 * 60

interface RawGuild {
  id?: string
  name?: string
  description?: string
  vanity_url_code?: string
  approximate_member_count?: number
}

interface RawMessage {
  id?: string
  content?: string
  timestamp?: string
  channel_id?: string
  author?: { id?: string; username?: string; bot?: boolean }
  reactions?: { count?: number }[]
}

interface RawMember {
  user?: { id?: string; username?: string; global_name?: string }
  nick?: string
  joined_at?: string
  communication_disabled_until?: string | null
}

/**
 * `guild_id/channel_id` → 两截；没写频道的回 `channel: undefined`。
 *
 * 为什么用斜杠而不是两个字段：这个字符串要原样存进 `SocialAccount.external_id`
 * 并在卡面上显示。两个字段意味着对象上多一格只有 Discord 用得上的东西。
 */
export function splitTarget(value: string): { guild: string; channel?: string } {
  const at = value.indexOf('/')
  if (at < 0) return { guild: value }
  return { guild: value.slice(0, at), channel: value.slice(at + 1) }
}

export function createDiscordAdapter(transport: SocialTransport): SocialChannelAdapter {
  const off = () => guardConnected(transport, CHANNEL, LABEL)
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(CHANNEL)
    // 文件头第 1 条：`Bot <token>`，不是 Bearer
    return { Authorization: `Bot ${cred.bot_token ?? cred.token ?? ''}` }
  }
  const needChannel = (value: string) => {
    const { guild, channel } = splitTarget(value)
    if (channel === undefined)
      return {
        error: notImplemented(
          LABEL,
          `只给了服务器 id（${guild}），没说发到哪个频道。写成 <服务器id>/<频道id>`,
        ),
      }
    return { guild, channel }
  }
  /**
   * WP257：机器人自己的 id（判「这条是不是 @ 了我们」用）。查一次记住；`readAccess` 那一跳顺手记下，
   * 读消息时只有这一页里真有人 @ 了谁 / 回了谁才去问一次。
   */
  let botId: string | undefined
  const whoAmI = async (headers: Record<string, string>): Promise<string | undefined> => {
    if (botId !== undefined) return botId
    const me = await callJson<{ id?: string }>(transport, LABEL, `${DISCORD_API_BASE}/users/@me`, {
      headers,
    })
    if ('data' in me && typeof me.data.id === 'string' && me.data.id !== '') botId = me.data.id
    return botId
  }

  return {
    channel: CHANNEL,
    mode: 'api',

    async profile(account_external_id): Promise<SocialResult<ChannelProfile>> {
      const guard = off()
      if (guard !== undefined) return guard
      const { guild } = splitTarget(account_external_id)
      // `with_counts=true` 才给成员数（文档）——不带这一格，社群面板上那个数永远空着
      const url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}?with_counts=true`
      const res = await callJson<RawGuild>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      const raw = res.data
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          channel: CHANNEL,
          external_id: account_external_id,
          handle: raw.vanity_url_code ?? raw.id ?? guild,
          display_name: raw.name ?? '',
          url:
            raw.vanity_url_code === undefined
              ? `https://discord.com/channels/${raw.id ?? guild}`
              : `https://discord.gg/${raw.vanity_url_code}`,
          ...(raw.approximate_member_count === undefined
            ? {}
            : { member_count: raw.approximate_member_count }),
          ...(raw.description === undefined ? {} : { bio: raw.description }),
        },
      }
    },

    async posts({ account_external_id, limit }): Promise<SocialResult<ChannelPost[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(account_external_id)
      if ('error' in t) return t.error
      const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages?limit=${limit ?? 50}`
      const res = await callJson<RawMessage[]>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        // 我们**自己**发的那些才算"帖子"；别人说的话是 `comments` 那一边的事
        data: (res.data ?? [])
          .filter((m) => m.author?.bot === true)
          .map((m) => ({
            external_id: m.id ?? '',
            kind: 'post' as const,
            body: m.content ?? '',
            ...(m.timestamp === undefined ? {} : { published_at: m.timestamp }),
            url: `https://discord.com/channels/${t.guild}/${t.channel}/${m.id ?? ''}`,
            metrics: {
              likes: (m.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0),
            },
          })),
      }
    },

    async comments({ account_external_id, limit }): Promise<SocialResult<ChannelComment[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(account_external_id)
      if ('error' in t) return t.error
      const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages?limit=${limit ?? 50}`
      const res = await callJson<RawMessage[]>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        // 机器人自己说的话不算"群里有人说了句什么"——否则 triage 会把我们自己的
        // 公告判成一条客户问题，然后给客服开一张卡
        data: (res.data ?? [])
          .filter((m) => m.author?.bot !== true)
          .map((m) => ({
            external_id: m.id ?? '',
            surface: 'thread' as const,
            author_external_id: m.author?.id ?? '',
            author_handle: m.author?.username ?? m.author?.id ?? '',
            text: m.content ?? '',
            created_at: m.timestamp ?? transport.now(),
          })),
      }
    },

    /*
     * WP256（决策 147）：「群里的帖子」自动进帖——读 `after` 之后的新消息（只读：不回、不加反应）。
     * 没给 `after` = 最近一页（第一次读只取眼前这一页，不往回翻历史）。排序与过滤在 `discord-read.ts`。
     */
    async feed({ account_external_id, after, limit }): Promise<SocialResult<ChannelFeedPage>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(account_external_id)
      if ('error' in t) return t.error
      const n = Math.min(Math.max(limit ?? 50, 1), 100)
      const url =
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages?limit=${n}` +
        (after === undefined ? '' : `&after=${encodeURIComponent(after)}`)
      const headers = await auth()
      const res = await callJson<DiscordRawMessage[]>(transport, LABEL, url, { headers })
      if (!('data' in res)) return res
      const raw = Array.isArray(res.data) ? res.data : []
      // WP257：有人 @ 了谁 / 回了谁时才需要知道机器人是谁（判「冲着我们来的」）
      const me = discordNeedsBotId(raw) ? await whoAmI(headers) : botId
      return {
        ok: true,
        observed_at: transport.now(),
        data: discordFeedPage(raw, transport.now(), me),
      }
    },

    /*
     * WP257（决策 155）：登记频道时读一次频道名（`GET /channels/{id}`，只读），显示成「#general」。
     * 读不到由调用方退回「#频道 id 末四位」。
     */
    async describeTarget(account_external_id) {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(account_external_id)
      if ('error' in t) return t.error
      const res = await callJson<{ name?: string }>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}`,
        { headers: await auth() },
      )
      if (!('data' in res)) return res
      const name = (res.data.name ?? '').trim()
      if (name === '')
        return { ok: false, reason: 'upstream_error', message: 'Discord 没回这个频道的名字。' }
      return { ok: true, observed_at: transport.now(), data: { name: `#${name}` } }
    },

    /*
     * WP256：读这个频道还缺哪几样（`discord-read.ts` 文件头第 2–4 条）。五跳只读：我是谁、我在不在这个服务器、
     * 服务器角色、频道覆写、应用开关。只在第一次读、读不动、或隔一天时才查一次（调用方管频率）。
     */
    async readAccess(account_external_id): Promise<SocialResult<{ missing: ChannelReadGap[] }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(account_external_id)
      if ('error' in t) return t.error
      const headers = await auth()
      const ok = (missing: ChannelReadGap[]): SocialResult<{ missing: ChannelReadGap[] }> => ({
        ok: true,
        observed_at: transport.now(),
        data: { missing },
      })
      const me = await callJson<{ id?: string }>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/users/@me`,
        {
          headers,
        },
      )
      if (!('data' in me)) return me
      const selfId = me.data.id ?? ''
      if (selfId !== '') botId = selfId
      // 应用开关读不到（老令牌 / 那一跳失败）就不判这一样——不凭空说缺
      const app = await callJson<{ flags?: number }>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/applications/@me`,
        { headers },
      )
      const flags = 'data' in app ? (app.data.flags ?? 0) : undefined
      const member = await callJson<{ roles?: string[] }>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/guilds/${encodeURIComponent(t.guild)}/members/${encodeURIComponent(selfId)}`,
        { headers },
      )
      if (!('data' in member)) {
        if (member.status === 404 || member.status === 403) return ok(['bot_not_in_server'])
        return member
      }
      const channel = await callJson<{ permission_overwrites?: DiscordOverwrite[] }>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}`,
        { headers },
      )
      if (!('data' in channel)) {
        // 看不到这个频道时连频道本身都读不到（Missing Access）
        if (channel.status === 403 || channel.status === 404) return ok(discordReadGaps(0n, flags))
        return channel
      }
      const roles = await callJson<{ id?: string; permissions?: string }[]>(
        transport,
        LABEL,
        `${DISCORD_API_BASE}/guilds/${encodeURIComponent(t.guild)}/roles`,
        { headers },
      )
      if (!('data' in roles)) return roles
      const perms = discordChannelPermissions({
        guild_id: t.guild,
        bot_id: selfId,
        member_roles: member.data.roles ?? [],
        roles: Array.isArray(roles.data) ? roles.data : [],
        overwrites: channel.data.permission_overwrites ?? [],
      })
      return ok(discordReadGaps(perms, flags))
    },

    async publish(
      input: PublishInput,
    ): Promise<SocialResult<{ external_id: string; url?: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(input.account_external_id)
      if ('error' in t) return t.error
      // Discord 没有服务端排期。排期由**我们**的调度器管（到点了再调这一跳），
      // 所以这里收到一个未来时间就是调用方搞错了，照实说。
      if (input.scheduled_at !== undefined)
        return notImplemented(
          LABEL,
          'Discord 那边没有排期发布；排期由我们自己的调度器管，到点之后再调这一跳',
        )
      const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages`
      const res = await callJson<{ id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ content: input.body }),
      })
      if (!('data' in res)) return res
      return {
        ok: true,
        observed_at: transport.now(),
        data: {
          external_id: res.data.id ?? '',
          url: `https://discord.com/channels/${t.guild}/${t.channel}/${res.data.id ?? ''}`,
        },
      }
    },

    async reply(input: ReplyInput): Promise<SocialResult<{ external_id: string }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(input.account_external_id ?? '')
      if ('error' in t) return t.error
      const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages`
      const res = await callJson<{ id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        // `message_reference` 才是"回复那一条"；不带它就只是往频道里另说一句
        body: JSON.stringify({
          content: input.text,
          message_reference: { message_id: input.parent_external_id },
        }),
      })
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { external_id: res.data.id ?? '' } }
    },

    async members({ account_external_id, status, limit }): Promise<SocialResult<ChannelMember[]>> {
      const guard = off()
      if (guard !== undefined) return guard
      // 文件头第 3 条：Discord 上没有"入群申请"这回事
      if (status === 'pending')
        return notImplemented(
          LABEL,
          'Discord 没有公开的「入群申请」接口（会员筛选那一套不开放）——这条渠道上没有待审入群',
        )
      const { guild } = splitTarget(account_external_id)
      const url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}/members?limit=${limit ?? 100}`
      const res = await callJson<RawMember[]>(transport, LABEL, url, { headers: await auth() })
      if (!('data' in res)) return res
      const now = Date.parse(transport.now())
      return {
        ok: true,
        observed_at: transport.now(),
        data: (res.data ?? []).map((m) => {
          const until = m.communication_disabled_until
          const muted = typeof until === 'string' && Date.parse(until) > now
          return {
            external_id: m.user?.id ?? '',
            handle: m.user?.username ?? m.user?.id ?? '',
            ...((m.nick ?? m.user?.global_name)
              ? { display_name: (m.nick ?? m.user?.global_name) as string }
              : {}),
            status: muted ? ('muted' as const) : ('active' as const),
            ...(m.joined_at === undefined ? {} : { joined_at: m.joined_at }),
          }
        }),
      }
    },

    async decideMember(input: MemberDecisionInput): Promise<SocialResult<{ ok: true }>> {
      const guard = off()
      if (guard !== undefined) return guard
      if (input.decision !== 'remove')
        return notImplemented(
          LABEL,
          `Discord 上没有入群审批，所以"${input.decision}"这个动作不存在；能做的只有把人移出服务器`,
        )
      const { guild } = splitTarget(input.account_external_id)
      const url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}/members/${encodeURIComponent(input.member_external_id)}`
      const res = await callJson<unknown>(transport, LABEL, url, {
        method: 'DELETE',
        headers: await auth(),
      })
      // 204 没有 body，`callJson` 会在 JSON.parse 上失败——这是**成功**，不是错
      if (!('data' in res) && res.status !== undefined) return res
      return { ok: true, observed_at: transport.now(), data: { ok: true } }
    },

    async broadcast(
      input: BroadcastInput,
    ): Promise<SocialResult<{ sent: number; failed: number }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const t = needChannel(input.account_external_id)
      if ('error' in t) return t.error
      // Discord 的"群发" = 往公告频道发一条，**不是**给每个人发私信：
      // 用机器人挨个私信几千人是 Discord 明令禁止的（会封 bot）。
      const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(t.channel)}/messages`
      const res = await callJson<{ id?: string }>(transport, LABEL, url, {
        method: 'POST',
        headers: { ...(await auth()), 'content-type': 'application/json' },
        body: JSON.stringify({ content: input.body }),
      })
      if (!('data' in res)) return res
      return { ok: true, observed_at: transport.now(), data: { sent: 1, failed: 0 } }
    },

    async moderate(input: ModerateInput): Promise<SocialResult<{ ok: true }>> {
      const guard = off()
      if (guard !== undefined) return guard
      const { guild, channel } = splitTarget(input.account_external_id)
      const headers = await auth()
      const json = { ...headers, 'content-type': 'application/json' }
      const target = encodeURIComponent(input.target_external_id)

      let url: string
      let init: Parameters<typeof callJson>[3]
      switch (input.action) {
        case 'delete_post': {
          if (channel === undefined)
            return notImplemented(LABEL, '删一条消息要知道它在哪个频道：写成 <服务器id>/<频道id>')
          url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(channel)}/messages/${target}`
          init = { method: 'DELETE', headers }
          break
        }
        case 'mute':
        case 'unmute': {
          // 文件头第 4 条：禁言是给成员设一个到期时刻，不是一个动作
          const minutes = Math.min(input.duration_minutes ?? 60, DISCORD_MAX_TIMEOUT_MINUTES)
          const until =
            input.action === 'unmute'
              ? null
              : new Date(Date.parse(transport.now()) + minutes * 60_000).toISOString()
          url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}/members/${target}`
          init = {
            method: 'PATCH',
            headers: json,
            body: JSON.stringify({ communication_disabled_until: until }),
          }
          break
        }
        case 'ban':
        case 'permanent_ban': {
          url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}/bans/${target}`
          init = {
            method: 'PUT',
            headers: json,
            // 顺手删掉他最近一天的消息（刷广告的人多半刚刷完）
            body: JSON.stringify({ delete_message_seconds: 86_400 }),
          }
          break
        }
        case 'unban': {
          url = `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guild)}/bans/${target}`
          init = { method: 'DELETE', headers }
          break
        }
        // WP249：版务队列的「批准」只有 Reddit 有
        case 'approve':
          return notImplemented(LABEL, 'Discord 没有版务队列，「批准」这一口不适用')
      }
      const res = await callJson<unknown>(transport, LABEL, url, init)
      if (!('data' in res) && res.status !== undefined) return res
      return { ok: true, observed_at: transport.now(), data: { ok: true } }
    },
  }
}
