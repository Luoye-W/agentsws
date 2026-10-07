/**
 * WP257（决策 152 / 155 / 156）：自动进帖判类打标签的规则、Telegram 收件流与缺什么、Discord 频道名——
 * 假 API，一跳都不出去。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 关键词 / 渠道（邀请链接）/ 是否 @品牌 三样判据各自起作用，判不准落「其它」 | 152 先按规则判 |
 * | Telegram 一页：只留群里别人说的话、系统消息与机器人不进、`next_offset` 照样往前走、@ 了我们认得出 | 156 入库 / 续读 |
 * | Telegram 缺什么：隐私模式（管理员不算）、不在群里、设了 webhook；只读三跳 | 156 照实提示 |
 * | Telegram 只读：全程没有一跳 send / delete / setWebhook | 只读，不回复 |
 * | Discord 频道名：`GET /channels/{id}` → `#general`；读不到回失败（调用方退回 id 末四位） | 155 |
 */
import { describe, expect, it } from 'vitest'
import {
  createDiscordAdapter,
  createTelegramAdapter,
  discordFeedPage,
  looksLikeQuestion,
  parseTelegramGroup,
  readGapMessage,
  type SocialHttpResponse,
  type SocialTransport,
  tagThread,
  telegramUpdatesPage,
} from '../src/index.js'

const NOW = '2026-10-07T10:00:00.000Z'
const CHAT = -1001234567890
const BOT = { id: 4242, username: 'inmo_helper_bot', is_bot: true }

type Route = (url: string, body: Record<string, unknown>) => { status: number; body: unknown }

function fake(route: Route): SocialTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    connected: () => true,
    now: () => NOW,
    credential: async () => ({ bot_token: 'TG-TEST', token: 'TG-TEST' }),
    fetch: async (url, init): Promise<SocialHttpResponse> => {
      const method = url.split('/').at(-1) ?? ''
      calls.push(method)
      const body = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>
      const r = route(url, body)
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => JSON.stringify(r.body),
      }
    },
  }
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } })

const tgMsg = (id: number, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  date: Date.parse(NOW) / 1000,
  chat: { id: CHAT, type: 'supergroup', title: 'INMO 用户群' },
  from: { id: 100 + id, is_bot: false, username: `fan${id}` },
  text: `第 ${id} 条`,
  ...extra,
})

describe('WP257 判类打标签（规则）', () => {
  it('关键词：沿用六类词表；判不准落其它', () => {
    expect(
      tagThread({ text: '我的订单什么时候到', channel: 'discord', surface: 'thread' }).klass,
    ).toBe('customer_question')
    expect(
      tagThread({ text: 'love it, works great', channel: 'reddit', surface: 'thread' }).klass,
    ).toBe('praise')
    expect(
      tagThread({ text: '太差了，再也不买', channel: 'telegram_group', surface: 'thread' }).klass,
    ).toBe('complaint')
    expect(tagThread({ text: '加微信领福利', channel: 'discord', surface: 'thread' }).klass).toBe(
      'spam',
    )
    expect(
      tagThread({ text: '今天天气不错', channel: 'discord', surface: 'thread' }),
    ).toMatchObject({
      klass: 'other',
      mentions_us: false,
    })
  })

  it('渠道：聊天群里贴别的群的邀请链接 → 广告垃圾；Reddit 帖子里同一串不算', () => {
    const dc = tagThread({ text: 'join us discord.gg/abcd', channel: 'discord', surface: 'thread' })
    expect(dc).toMatchObject({ klass: 'spam', route: 'social' })
    expect(dc.signals).toContain('spam:invite_link')
    expect(
      tagThread({ text: 'join t.me/+abcdef', channel: 'telegram_group', surface: 'thread' }).klass,
    ).toBe('spam')
    expect(
      tagThread({ text: 'join us discord.gg/abcd', channel: 'reddit', surface: 'thread' }).klass,
    ).toBe('other')
    // 本身是在问东西的，不因为带了链接就当垃圾
    expect(
      tagThread({ text: '我的订单还没收到 discord.gg/x', channel: 'discord', surface: 'thread' })
        .klass,
    ).toBe('customer_question')
  })

  it('是否 @品牌：问到我们头上的问话 → 客户问题；没 @ 的闲聊问话仍是其它', () => {
    const q = '这个能连 iPhone 15 吗？'
    expect(tagThread({ text: q, channel: 'discord', surface: 'thread' }).klass).toBe('other')
    const mentioned = tagThread({
      text: q,
      channel: 'discord',
      surface: 'thread',
      mentions_us: true,
    })
    expect(mentioned).toMatchObject({
      klass: 'customer_question',
      route: 'support',
      mentions_us: true,
    })
    expect(mentioned.signals).toContain('customer_question:asked_us')
    // 正文里提到品牌名也算
    expect(
      tagThread({
        text: 'Does INMO Air3 support prescription lenses?',
        channel: 'telegram_group',
        surface: 'thread',
        brand_terms: ['INMO'],
      }).klass,
    ).toBe('customer_question')
    // 太短的品牌名不认（免得误中）
    expect(
      tagThread({
        text: 'is it a good day?',
        channel: 'discord',
        surface: 'thread',
        brand_terms: ['i'],
      }).mentions_us,
    ).toBe(false)
    // Reddit 自家版：发在我们自己的版里就算冲着我们来
    expect(
      tagThread({
        text: 'Anyone tried the new firmware?',
        channel: 'reddit',
        surface: 'thread',
        own_community: true,
      }).klass,
    ).toBe('customer_question')
    // 不是问话的 @ 不升级
    expect(
      tagThread({ text: '@bot 早上好', channel: 'discord', surface: 'thread', mentions_us: true })
        .klass,
    ).toBe('other')
    // 判据名进结论，原句不进
    expect(JSON.stringify(mentioned.signals)).not.toContain('iPhone')
  })

  it('问话的形状', () => {
    expect(looksLikeQuestion('支持吗')).toBe(true)
    expect(looksLikeQuestion('How long is the battery life')).toBe(true)
    expect(looksLikeQuestion('Great product')).toBe(false)
    expect(looksLikeQuestion('')).toBe(false)
  })
})

describe('WP257 Telegram 收件流一页', () => {
  it('只留群里别人说的话；系统消息 / 机器人 / 私聊 / 频道不进；next_offset 照样往前走', () => {
    const page = telegramUpdatesPage(
      [
        { update_id: 12, message: tgMsg(3) },
        { update_id: 10, message: tgMsg(1) },
        { update_id: 11, message: tgMsg(2, { text: undefined, new_chat_members: [{ id: 9 }] }) },
        { update_id: 13, message: tgMsg(4, { from: BOT }) },
        { update_id: 14, message: tgMsg(5, { chat: { id: 77, type: 'private' } }) },
        { update_id: 15, message: tgMsg(6, { text: undefined, photo: [{}] }) },
        { update_id: 16, message: tgMsg(7, { reply_to_message: { message_id: 1, from: BOT } }) },
        { update_id: 17 }, // 别的更新类型（比如入群申请）：不进帖，但位置照样往前走
      ],
      NOW,
      BOT,
    )
    expect(page.next_offset).toBe('18')
    expect(page.fetched).toBe(8)
    expect(page.items.map((i) => i.comment.external_id)).toEqual(['1', '3', '6', '7'])
    expect(page.items[0]).toMatchObject({
      chat_id: String(CHAT),
      comment: {
        author_handle: 'fan1',
        author_external_id: '101',
        surface: 'thread',
        created_at: NOW,
      },
    })
    expect(page.items[2]?.comment.text).toBe('（只发了图片或文件）')
    expect(page.items[3]?.comment).toMatchObject({
      surface: 'comment',
      parent_external_id: '1',
      mentions_us: true,
    })
    expect(page.items[0]?.comment.mentions_us).toBe(false)
  })

  it('@ 了机器人的用户名认得出（大小写不敏感）；@ 了别人不算', () => {
    const page = telegramUpdatesPage(
      [
        {
          update_id: 1,
          message: tgMsg(1, {
            text: '@INMO_helper_bot 怎么连手机',
            entities: [{ type: 'mention', offset: 0, length: 16 }],
          }),
        },
        {
          update_id: 2,
          message: tgMsg(2, {
            text: '@someone hi',
            entities: [{ type: 'mention', offset: 0, length: 8 }],
          }),
        },
      ],
      NOW,
      BOT,
    )
    expect(page.items.map((i) => i.comment.mentions_us)).toEqual([true, false])
  })

  it('空页：没有 next_offset', () => {
    expect(telegramUpdatesPage([], NOW, BOT)).toEqual({ items: [], fetched: 0 })
  })

  it('认群地址：私有群消息链接 / 公开群 / 数字 id；邀请链接认不出', () => {
    expect(parseTelegramGroup('https://t.me/c/1234567890/55')).toBe('-1001234567890')
    expect(parseTelegramGroup('t.me/c/1234567890')).toBe('-1001234567890')
    expect(parseTelegramGroup('https://t.me/inmo_users')).toBe('@inmo_users')
    expect(parseTelegramGroup('@inmo_users')).toBe('@inmo_users')
    expect(parseTelegramGroup('-1001234567890')).toBe('-1001234567890')
    expect(parseTelegramGroup('https://t.me/+AbCdEf123')).toBeUndefined()
    expect(parseTelegramGroup('https://t.me/joinchat/AbCdEf')).toBeUndefined()
    expect(parseTelegramGroup('随便写的')).toBeUndefined()
  })
})

describe('WP257 Telegram 适配器（只读）', () => {
  const site = (opts: {
    privacy?: boolean
    status?: string
    webhook?: string
    memberError?: number
    updates?: unknown[]
    failUpdates?: { code: number; description: string }
  }) =>
    fake((url, body) => {
      expect(url).toContain('/botTG-TEST/')
      const method = url.split('/').at(-1)
      if (method === 'getMe')
        return ok({ ...BOT, can_read_all_group_messages: opts.privacy === false })
      if (method === 'getWebhookInfo') return ok({ url: opts.webhook ?? '' })
      if (method === 'getChatMember') {
        if (opts.memberError !== undefined)
          return {
            status: opts.memberError,
            body: {
              ok: false,
              error_code: opts.memberError,
              description: 'Bad Request: chat not found',
            },
          }
        return ok({ status: opts.status ?? 'member' })
      }
      if (method === 'getChat')
        return ok({ id: CHAT, type: 'supergroup', title: 'INMO 用户群', username: 'inmo_users' })
      if (method === 'getUpdates') {
        if (opts.failUpdates !== undefined)
          return {
            status: opts.failUpdates.code,
            body: {
              ok: false,
              error_code: opts.failUpdates.code,
              description: opts.failUpdates.description,
            },
          }
        const offset = body.offset as number | undefined
        return ok(
          ((opts.updates ?? []) as { update_id: number }[]).filter(
            (u) => offset === undefined || u.update_id >= offset,
          ),
        )
      }
      return { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } }
    })

  it('隐私模式开着、又不是管理员 → privacy_mode；管理员不算；关了也不算', async () => {
    const t1 = site({ privacy: true, status: 'member' })
    const r1 = await createTelegramAdapter(t1).readAccess?.(String(CHAT))
    expect(r1).toMatchObject({ ok: true, data: { missing: ['privacy_mode'] } })
    expect(t1.calls).toEqual(['getMe', 'getWebhookInfo', 'getChatMember'])
    const r2 = await createTelegramAdapter(
      site({ privacy: true, status: 'administrator' }),
    ).readAccess?.(String(CHAT))
    expect(r2).toMatchObject({ ok: true, data: { missing: [] } })
    const r3 = await createTelegramAdapter(site({ privacy: false })).readAccess?.(String(CHAT))
    expect(r3).toMatchObject({ ok: true, data: { missing: [] } })
  })

  it('不在群里 / 被踢了 / 设了 webhook 各说各的', async () => {
    expect(
      await createTelegramAdapter(site({ privacy: false, memberError: 400 })).readAccess?.(
        String(CHAT),
      ),
    ).toMatchObject({ data: { missing: ['bot_not_in_server'] } })
    expect(
      await createTelegramAdapter(site({ privacy: false, status: 'kicked' })).readAccess?.(
        String(CHAT),
      ),
    ).toMatchObject({ data: { missing: ['bot_not_in_server'] } })
    expect(
      await createTelegramAdapter(
        site({ privacy: false, webhook: 'https://example.invalid/hook' }),
      ).readAccess?.(String(CHAT)),
    ).toMatchObject({ data: { missing: ['webhook_active'] } })
    expect(readGapMessage('Telegram 群组', ['privacy_mode'])).toContain('/setprivacy')
    expect(readGapMessage('Telegram 群组', ['privacy_mode'])).toContain('重新拉进来')
    expect(readGapMessage('Telegram 群组', ['bot_not_in_server'])).toContain('不在这个群里')
    expect(readGapMessage('Telegram 群组', ['webhook_active'])).toContain('webhook')
  })

  it('读一页：带 offset、timeout 0；409（webhook 开着）照实回；全程没有一跳写', async () => {
    const t = site({
      updates: [
        { update_id: 5, message: tgMsg(1) },
        { update_id: 6, message: tgMsg(2) },
      ],
    })
    const a = createTelegramAdapter(t)
    const r = await a.updates?.({ offset: '6', limit: 100 })
    expect(r).toMatchObject({ ok: true, data: { next_offset: '7', fetched: 1 } })
    const conflict = await createTelegramAdapter(
      site({
        failUpdates: {
          code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        },
      }),
    ).updates?.({})
    expect(conflict).toMatchObject({ ok: false, status: 409 })
    const limited = await createTelegramAdapter(
      site({ failUpdates: { code: 429, description: 'Too Many Requests: retry after 5' } }),
    ).updates?.({})
    expect(limited).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect(t.calls.every((m) => m.startsWith('get'))).toBe(true)
  })

  it('登记时读群名：@用户名换成数字 id', async () => {
    const r = await createTelegramAdapter(site({})).describeTarget?.('@inmo_users')
    expect(r).toMatchObject({ ok: true, data: { name: 'INMO 用户群', external_id: String(CHAT) } })
  })
})

describe('WP257 Discord：频道名与 @ 我们', () => {
  const G = '900000000000000001'
  const C = '900000000000000002'
  const dc = (route: (url: string) => { status: number; body: unknown }) => {
    const calls: string[] = []
    const t: SocialTransport = {
      connected: () => true,
      now: () => NOW,
      credential: async () => ({ bot_token: 'DC' }),
      fetch: async (url, init): Promise<SocialHttpResponse> => {
        calls.push(`${init?.method ?? 'GET'} ${url.replace('https://discord.com/api/v10', '')}`)
        const r = route(url)
        return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) }
      },
    }
    return { adapter: createDiscordAdapter(t), calls }
  }

  it('读到频道名 → #general；读不到（403）照实回失败', async () => {
    const ok1 = dc(() => ({ status: 200, body: { id: C, name: 'general' } }))
    expect(await ok1.adapter.describeTarget?.(`${G}/${C}`)).toMatchObject({
      ok: true,
      data: { name: '#general' },
    })
    expect(ok1.calls).toEqual([`GET /channels/${C}`])
    const no = dc(() => ({ status: 403, body: { code: 50001 } }))
    expect(await no.adapter.describeTarget?.(`${G}/${C}`)).toMatchObject({ ok: false })
    // 只登记了服务器：说不出哪个频道
    expect(await no.adapter.describeTarget?.(G)).toMatchObject({ ok: false })
  })

  it('有人 @ 了机器人 / 回了机器人：读消息时问一次「我是谁」并记住', async () => {
    const BOT_ID = '555'
    const { adapter, calls } = dc((url) => {
      if (url.endsWith('/users/@me')) return { status: 200, body: { id: BOT_ID } }
      return {
        status: 200,
        body: [
          {
            id: '3',
            type: 0,
            content: 'hi all',
            timestamp: NOW,
            author: { id: 'u1', username: 'a' },
          },
          {
            id: '2',
            type: 0,
            content: `<@${BOT_ID}> 怎么退货？`,
            timestamp: NOW,
            author: { id: 'u2', username: 'b' },
            mentions: [{ id: BOT_ID }],
          },
        ],
      }
    })
    const r = await adapter.feed?.({ account_external_id: `${G}/${C}` })
    expect(r).toMatchObject({ ok: true })
    const items = r !== undefined && r.ok ? r.data.items : []
    expect(items.map((i) => i.mentions_us)).toEqual([true, false])
    await adapter.feed?.({ account_external_id: `${G}/${C}` })
    expect(calls.filter((c) => c.endsWith('/users/@me'))).toHaveLength(1)
    // 没人 @ 谁的一页：不问
    expect(
      discordFeedPage([{ id: '1', content: 'x', author: { id: 'u' } }], NOW).items[0]?.mentions_us,
    ).toBeUndefined()
  })
})
