/**
 * WP256：内存里的「Discord REST v10」替身（**不访问 discord.com**）。
 *
 * 只演「群里的帖子」自动进帖要的那几个口子：读频道消息（`limit` / `after`，回来的顺序与真接口一样是从新到旧，
 * 带 `after` 时回的是紧挨着那一条之后的最旧那几条）、我是谁、应用开关、机器人成员与角色、服务器角色、频道覆写。
 * 可以让下一次读消息回 429 / 500 / 403，可以关掉某样权限，测「照实说缺哪个」。
 * **任何写请求（POST / PUT / PATCH / DELETE）都记进 `writes`**——自动进帖一条都不该有。
 */
import { discordChannelPermissions, hasMessageContent } from '@agentsws/social-core'
import type { SocialFetch } from '../src/social-channels.js'

export const VIEW_CHANNEL = 1n << 10n
export const READ_MESSAGE_HISTORY = 1n << 16n

export interface FakeDiscordMessage {
  id: string
  content: string
  author: { id: string; username: string; bot?: boolean }
  timestamp: string
  type?: number
}

export interface FakeDiscord {
  guild: string
  bot: string
  /** 频道 id → 消息（按 id 从旧到新放）。 */
  channels: Map<string, FakeDiscordMessage[]>
  /** @everyone 的权限位。 */
  everyone: bigint
  /** 机器人角色的权限位。 */
  botRole: bigint
  /** 频道 id → 覆写。 */
  overwrites: Map<string, { id: string; type: number; allow: string; deny: string }[]>
  /** 应用 flags（默认开了 Message Content Intent 的那一档）。 */
  appFlags: number
  /** 机器人在不在服务器里。 */
  botInGuild: boolean
  /** 接下来几次读消息回这个状态码（用完就恢复）。 */
  failNext: number[]
  /** 从现在起第 n 次读消息回什么状态码（不回 = 照常）。 */
  failAt?: (n: number) => number | undefined
  /** 每一跳（方法 + 路径 + query）。 */
  calls: string[]
  /** 写请求（应当一直是空的）。 */
  writes: string[]
  /** 往频道里说一句（id 自增，越新越大）。 */
  say(
    channel: string,
    content: string,
    opts?: { bot?: boolean; at?: string; type?: number },
  ): string
  fetch: SocialFetch
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

export function createFakeDiscord(options: { guild: string; now: () => string }): FakeDiscord {
  let seq = 1_000_000_000_000_000_000n
  let reads = 0
  const site: FakeDiscord = {
    guild: options.guild,
    bot: '555000000000000001',
    channels: new Map(),
    everyone: VIEW_CHANNEL | READ_MESSAGE_HISTORY,
    botRole: 0n,
    overwrites: new Map(),
    appFlags: 1 << 19,
    botInGuild: true,
    failNext: [],
    calls: [],
    writes: [],
    say(channel, content, opts = {}) {
      seq += 1n
      const id = seq.toString()
      const list = site.channels.get(channel) ?? []
      list.push({
        id,
        content,
        author:
          opts.bot === true
            ? { id: site.bot, username: 'agentsws-bot', bot: true }
            : { id: `u_${(list.length % 3) + 1}`, username: `member${(list.length % 3) + 1}` },
        timestamp: opts.at ?? options.now(),
        ...(opts.type === undefined ? {} : { type: opts.type }),
      })
      site.channels.set(channel, list)
      return id
    },
    fetch: async (input, init) => {
      const method = init.method ?? 'GET'
      const u = new URL(input)
      if (u.host !== 'discord.com') throw new Error(`替身只认 discord.com：${u.host}`)
      if (init.headers?.Authorization !== 'Bot DISCORD-TEST-TOKEN') return json(401, {})
      const path = u.pathname.replace(/^\/api\/v10/u, '')
      site.calls.push(`${method} ${path}${u.search}`)
      if (method !== 'GET') {
        site.writes.push(`${method} ${path}`)
        return json(405, {})
      }
      if (path === '/users/@me') return json(200, { id: site.bot, username: 'agentsws-bot' })
      if (path === '/applications/@me') return json(200, { id: 'app_1', flags: site.appFlags })
      if (path === `/guilds/${site.guild}/members/${site.bot}`)
        return site.botInGuild ? json(200, { roles: ['role_bot'] }) : json(404, { code: 10007 })
      if (path === `/guilds/${site.guild}/roles`)
        return json(200, [
          { id: site.guild, permissions: site.everyone.toString() },
          { id: 'role_bot', permissions: site.botRole.toString() },
        ])
      const ch = path.match(/^\/channels\/(\d+)$/u)
      if (ch !== null) {
        const id = ch[1] as string
        if (!site.channels.has(id)) return json(404, { code: 10003 })
        return json(200, { id, permission_overwrites: site.overwrites.get(id) ?? [] })
      }
      const m = path.match(/^\/channels\/(\d+)\/messages$/u)
      if (m !== null) {
        reads += 1
        const fail = site.failNext.shift() ?? site.failAt?.(reads)
        if (fail !== undefined) return json(fail, { message: 'nope' })
        const list = site.channels.get(m[1] as string)
        if (list === undefined) return json(404, { code: 10003 })
        // 与真接口一样：看不到频道 403；读不了历史回空数组（不报错）；没开正文开关正文是空的
        const perms = discordChannelPermissions({
          guild_id: site.guild,
          bot_id: site.bot,
          member_roles: ['role_bot'],
          roles: [
            { id: site.guild, permissions: site.everyone.toString() },
            { id: 'role_bot', permissions: site.botRole.toString() },
          ],
          overwrites: site.overwrites.get(m[1] as string) ?? [],
        })
        if ((perms & VIEW_CHANNEL) === 0n) return json(403, { code: 50001 })
        if ((perms & READ_MESSAGE_HISTORY) === 0n) return json(200, [])
        const limit = Number(u.searchParams.get('limit') ?? 50)
        const after = u.searchParams.get('after')
        const picked =
          after === null
            ? list.slice(-limit)
            : list.filter((x) => BigInt(x.id) > BigInt(after)).slice(0, limit)
        const content = hasMessageContent(site.appFlags)
        // 真接口从新到旧回
        return json(
          200,
          [...picked]
            .reverse()
            .map((x) => (content || x.author.bot === true ? x : { ...x, content: '' })),
        )
      }
      return json(404, { code: 0 })
    },
  }
  return site
}
