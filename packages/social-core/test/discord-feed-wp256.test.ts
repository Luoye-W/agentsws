/**
 * WP256（决策 147）：Discord 读新消息（续读）与「还缺哪个权限」——假 Discord API，一跳都不出去。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | `after` 拼进地址、只读 GET、`Bot` 头 | 续读、只读 |
 * | 乱序回来的按 snowflake 从旧到新、`last_id` 含机器人那条 | 断点续读不漏不重 |
 * | 机器人自己的、系统消息、空正文不算；只发附件的照实写 | 「有人说了句话」才进帖 |
 * | 权限推算：@everyone、角色、覆写、成员覆写、管理员 | 照实说缺哪一样 |
 * | 不在服务器 / 看不到频道 / 没开正文开关 | 三种缺法各说各的 |
 */
import { describe, expect, it } from 'vitest'
import {
  compareSnowflake,
  createDiscordAdapter,
  DISCORD_PERMISSION,
  discordChannelPermissions,
  readGapMessage,
  type SocialHttpResponse,
  type SocialTransport,
} from '../src/index.js'

const NOW = '2026-10-07T10:00:00.000Z'
const G = '900000000000000001'
const C = '900000000000000002'
const BOT = '777'

type Route = (url: string) => { status: number; body: unknown } | undefined

function fake(route: Route): SocialTransport & { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  return {
    calls,
    connected: () => true,
    now: () => NOW,
    credential: async () => ({ bot_token: 'DISCORD-TEST' }),
    fetch: async (url, init): Promise<SocialHttpResponse> => {
      calls.push({ url, method: init?.method ?? 'GET' })
      expect(init?.headers?.Authorization).toBe('Bot DISCORD-TEST')
      const r = route(url) ?? { status: 404, body: { message: 'Unknown' } }
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => JSON.stringify(r.body),
      }
    },
  }
}

const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 0,
  content: `hello ${id}`,
  timestamp: NOW,
  author: { id: `u${id}`, username: `user${id}` },
  ...extra,
})

describe('WP256 Discord feed', () => {
  it('续读：after 进地址、乱序排好、last_id 含机器人那条、过滤系统消息与空正文', async () => {
    const t = fake(() => ({
      status: 200,
      body: [
        msg('1000000000000000012', { author: { id: BOT, username: 'ourbot', bot: true } }),
        msg('1000000000000000010'),
        msg('999999999999999999'), // 位数少一位：按字符串比会排错
        msg('1000000000000000011', { type: 7, content: '' }), // 入群提示
        msg('1000000000000000013', { content: '   ' }), // 空正文
        msg('1000000000000000014', { content: '', attachments: [{ id: 'a' }] }),
        msg('1000000000000000015', { message_reference: { message_id: '1000000000000000010' } }),
      ],
    }))
    const a = createDiscordAdapter(t)
    const res = await a.feed?.({
      account_external_id: `${G}/${C}`,
      after: '999999999999999990',
      limit: 100,
    })
    expect(res?.ok).toBe(true)
    if (res?.ok !== true) return
    expect(t.calls).toEqual([
      {
        url: `https://discord.com/api/v10/channels/${C}/messages?limit=100&after=999999999999999990`,
        method: 'GET',
      },
    ])
    expect(res.data.items.map((i) => i.external_id)).toEqual([
      '999999999999999999',
      '1000000000000000010',
      '1000000000000000014',
      '1000000000000000015',
    ])
    expect(res.data.items[2]?.text).toBe('（只发了附件）')
    expect(res.data.items[3]).toMatchObject({
      surface: 'comment',
      parent_external_id: '1000000000000000010',
    })
    expect(res.data.last_id).toBe('1000000000000000015')
    expect(res.data.fetched).toBe(7)
    expect(compareSnowflake('1000000000000000000', '999999999999999999')).toBe(1)
  })

  it('没给频道 → 照实说；429 → rate_limited', async () => {
    const a = createDiscordAdapter(fake(() => ({ status: 429, body: {} })))
    const noChannel = await a.feed?.({ account_external_id: G })
    expect(noChannel).toMatchObject({ ok: false, reason: 'not_implemented' })
    const limited = await a.feed?.({ account_external_id: `${G}/${C}` })
    expect(limited).toMatchObject({ ok: false, reason: 'rate_limited', status: 429 })
  })
})

describe('WP256 Discord readAccess', () => {
  const base = (over: {
    roles?: unknown
    overwrites?: unknown
    member?: { status: number; body: unknown }
    channel?: { status: number; body: unknown }
    flags?: number
  }): Route => {
    return (url) => {
      if (url.endsWith('/users/@me')) return { status: 200, body: { id: BOT } }
      if (url.endsWith('/applications/@me'))
        return { status: 200, body: { flags: over.flags ?? 1 << 19 } }
      if (url.endsWith(`/guilds/${G}/members/${BOT}`))
        return over.member ?? { status: 200, body: { roles: ['r_bot'] } }
      if (url.endsWith(`/guilds/${G}/roles`))
        return {
          status: 200,
          body: over.roles ?? [
            { id: G, permissions: String(DISCORD_PERMISSION.VIEW_CHANNEL) },
            { id: 'r_bot', permissions: String(DISCORD_PERMISSION.READ_MESSAGE_HISTORY) },
          ],
        }
      if (url.endsWith(`/channels/${C}`))
        return (
          over.channel ?? { status: 200, body: { permission_overwrites: over.overwrites ?? [] } }
        )
      return undefined
    }
  }

  it('都齐了 → 空数组；五跳全是 GET', async () => {
    const t = fake(base({}))
    const res = await createDiscordAdapter(t).readAccess?.(`${G}/${C}`)
    expect(res).toMatchObject({ ok: true, data: { missing: [] } })
    expect(t.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(t.calls).toHaveLength(5)
  })

  it('频道覆写把机器人角色的「读取消息历史」关了 → 缺它', async () => {
    const res = await createDiscordAdapter(
      fake(
        base({
          overwrites: [
            {
              id: 'r_bot',
              type: 0,
              allow: '0',
              deny: String(DISCORD_PERMISSION.READ_MESSAGE_HISTORY),
            },
          ],
        }),
      ),
    ).readAccess?.(`${G}/${C}`)
    expect(res).toMatchObject({ ok: true, data: { missing: ['read_message_history'] } })
  })

  it('没开 Message Content Intent → 缺它；看不到频道 → 缺查看与历史', async () => {
    const noIntent = await createDiscordAdapter(fake(base({ flags: 0 }))).readAccess?.(`${G}/${C}`)
    expect(noIntent).toMatchObject({ ok: true, data: { missing: ['message_content'] } })
    const hidden = await createDiscordAdapter(
      fake(base({ channel: { status: 403, body: { code: 50001 } } })),
    ).readAccess?.(`${G}/${C}`)
    expect(hidden).toMatchObject({
      ok: true,
      data: { missing: ['view_channel', 'read_message_history'] },
    })
  })

  it('机器人不在服务器里 → bot_not_in_server，人话说怎么办', async () => {
    const res = await createDiscordAdapter(
      fake(base({ member: { status: 404, body: { code: 10007 } } })),
    ).readAccess?.(`${G}/${C}`)
    expect(res).toMatchObject({ ok: true, data: { missing: ['bot_not_in_server'] } })
    expect(readGapMessage('Discord', ['bot_not_in_server'])).toContain('不在这个服务器里')
    expect(readGapMessage('Discord', ['view_channel', 'message_content'])).toContain(
      '「查看频道」权限、开发者后台的「Message Content Intent」开关',
    )
  })

  it('权限推算：管理员全有；成员覆写最后算', () => {
    const roles = [
      { id: G, permissions: '0' },
      { id: 'r_admin', permissions: String(DISCORD_PERMISSION.ADMINISTRATOR) },
    ]
    const admin = discordChannelPermissions({
      guild_id: G,
      bot_id: BOT,
      member_roles: ['r_admin'],
      roles,
      overwrites: [{ id: G, type: 0, deny: String(DISCORD_PERMISSION.VIEW_CHANNEL) }],
    })
    expect(admin & DISCORD_PERMISSION.VIEW_CHANNEL).not.toBe(0n)
    const member = discordChannelPermissions({
      guild_id: G,
      bot_id: BOT,
      member_roles: [],
      roles: [{ id: G, permissions: String(DISCORD_PERMISSION.VIEW_CHANNEL) }],
      overwrites: [
        { id: G, type: 0, deny: String(DISCORD_PERMISSION.VIEW_CHANNEL) },
        { id: BOT, type: 1, allow: String(DISCORD_PERMISSION.VIEW_CHANNEL) },
      ],
    })
    expect(member & DISCORD_PERMISSION.VIEW_CHANNEL).not.toBe(0n)
  })
})
