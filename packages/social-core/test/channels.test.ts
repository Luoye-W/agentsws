import type { SocialChannel } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  capabilitiesOf,
  createSocialAdapters,
  redactUrl,
  type SocialHttpResponse,
  type SocialTransport,
  whatsappBroadcastGate,
} from '../src/index.js'

const NOW = '2026-09-16T02:00:00.000Z'

/** 记下每一跳打到哪儿、带了什么头（真 fetch 一次都不出去）。 */
function fakeTransport(
  options: {
    connected?: (c: SocialChannel) => boolean
    reply?: (
      url: string,
      init?: { method?: string; body?: string },
    ) => { status: number; body: string }
  } = {},
): SocialTransport & {
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[]
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    []
  return {
    calls,
    connected: options.connected ?? (() => true),
    now: () => NOW,
    credential: async (c) =>
      c === 'discord'
        ? { bot_token: 'DISCORD-SECRET' }
        : c === 'telegram_group'
          ? { bot_token: '12345:TELEGRAM-SECRET' }
          : c === 'youtube'
            ? { api_key: 'YT-KEY', access_token: 'YT-OAUTH' }
            : { access_token: 'META-SECRET' },
    fetch: async (url, init): Promise<SocialHttpResponse> => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        ...(init?.body === undefined ? {} : { body: init.body }),
      })
      const r = options.reply?.(url, init) ?? { status: 200, body: '{}' }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body }
    },
  }
}

/**
 * 取一个**可选**的口子。缺席本身就是信息（`SocialChannelAdapter` 的注释），
 * 所以测试里也不许用 `as` 把它糊过去——缺了就在这一行炸，比一个诡异的断言好。
 */
function must<T>(fn: T | undefined, name: string): T {
  if (fn === undefined) throw new Error(`这条渠道上没有 ${name} 这个口子`)
  return fn
}

/** 失败那一支（测试里只关心 reason / message 两格）。 */
function asError(r: { ok: boolean }): { reason: string; message: string; status?: number } {
  if (r.ok) throw new Error('本该失败，却成功了')
  return r as unknown as { reason: string; message: string; status?: number }
}

/** 成功那一支。 */
function asOk<T>(r: { ok: boolean }): { data: T; observed_at: string } {
  if (!r.ok) throw new Error(`本该成功，却失败了：${JSON.stringify(r)}`)
  return r as unknown as { data: T; observed_at: string }
}

describe('56 §3 九条适配器（WP72）', () => {
  it('九条都在，一处分派；能力表按"有没有这个方法"算，不靠试一次', () => {
    const a = createSocialAdapters(fakeTransport())
    expect(Object.keys(a)).toHaveLength(9)
    expect(a.facebook_group.mode).toBe('browser')
    expect(capabilitiesOf(a.meta).write).toEqual(['publish', 'reply'])
    // YouTube 发视频要 resumable upload，不是一次 JSON 调用 —— 故意缺席
    expect(capabilitiesOf(a.youtube).write).toEqual(['reply'])
    // Discord 是社群组：成员、群发、管理都有
    expect(capabilitiesOf(a.discord).write).toEqual([
      'publish',
      'reply',
      'decideMember',
      'broadcast',
      'moderate',
    ])
    // TikTok 没有评论读写接口
    expect(capabilitiesOf(a.tiktok).read).toEqual(['profile', 'posts'])
  })

  it('没连就一跳都不打（九条一个说法）', async () => {
    const t = fakeTransport({ connected: () => false })
    const a = createSocialAdapters(t)
    const r = await must(a.meta.profile, 'profile')('123')
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(t.calls).toHaveLength(0)
  })

  it('Meta：token 走 Authorization 头，不走 query', async () => {
    const t = fakeTransport({
      reply: () => ({
        status: 200,
        body: JSON.stringify({ id: '10', name: '北欧电', username: 'nordvolt', fan_count: 8200 }),
      }),
    })
    const a = createSocialAdapters(t)
    const r = await must(a.meta.profile, 'profile')('10')
    expect(r).toMatchObject({ ok: true, observed_at: NOW })
    const call = t.calls[0]
    expect(call?.url).not.toContain('META-SECRET')
    expect(call?.headers.Authorization).toBe('Bearer META-SECRET')
  })

  it('Meta 排期：`published: false` 与 `scheduled_publish_time` 必须一起写', async () => {
    const t = fakeTransport({ reply: () => ({ status: 200, body: '{"id":"10_99"}' }) })
    const a = createSocialAdapters(t)
    await must(
      a.meta.publish,
      'publish',
    )({
      account_external_id: '10',
      kind: 'post',
      body: '新品上架',
      scheduled_at: '2026-09-17T01:00:00.000Z',
    })
    const body = t.calls[0]?.body ?? ''
    expect(body).toContain('published=false')
    // Unix **秒**，不是毫秒
    expect(body).toContain(
      `scheduled_publish_time=${Math.floor(Date.parse('2026-09-17T01:00:00.000Z') / 1000)}`,
    )
  })

  it('YouTube：配额用完与"授权掉了"是两句话（都是 403）', async () => {
    const t = fakeTransport({ reply: () => ({ status: 403, body: '{}' }) })
    const a = createSocialAdapters(t)
    const r = asError(await must(a.youtube.profile, 'profile')('UC1'))
    expect(r.reason).toBe('quota_exhausted')
    expect(r.message).toContain('明天会重置')
  })

  it('YouTube 取视频是两跳：search 只给 id，播放数在 videos 里', async () => {
    const t = fakeTransport({
      reply: (url) =>
        url.includes('/search')
          ? { status: 200, body: JSON.stringify({ items: [{ id: { videoId: 'v1' } }] }) }
          : {
              status: 200,
              body: JSON.stringify({
                items: [
                  { id: 'v1', snippet: { title: '开箱' }, statistics: { viewCount: '1200' } },
                ],
              }),
            },
    })
    const a = createSocialAdapters(t)
    const r = asOk<{ metrics?: { views?: number } }[]>(
      await must(a.youtube.posts, 'posts')({ account_external_id: 'UC1' }),
    )
    expect(t.calls).toHaveLength(2)
    expect(r.data[0]?.metrics?.views).toBe(1200)
  })

  it('YouTube 回评论要 OAuth（读用 key 就够，写不行）——说清楚去重新授权', async () => {
    const t = {
      ...fakeTransport(),
      credential: async () => ({ api_key: 'YT-KEY' }),
    } as SocialTransport
    const a = createSocialAdapters(t)
    const r = asError(
      await must(a.youtube.reply, 'reply')({ parent_external_id: 'c1', text: '谢谢！' }),
    )
    expect(r.message).toContain('重新授权')
  })

  it('Discord：鉴权头是 `Bot`，不是 Bearer（写错的话每一跳都是 401）', async () => {
    const t = fakeTransport({ reply: () => ({ status: 200, body: '{"id":"g1","name":"桌面党"}' }) })
    const a = createSocialAdapters(t)
    await must(a.discord.profile, 'profile')('g1')
    expect(t.calls[0]?.headers.Authorization).toBe('Bot DISCORD-SECRET')
    expect(t.calls[0]?.url).toContain('with_counts=true')
  })

  it('Discord：只给服务器 id 没给频道，照实说要写成 <服务器id>/<频道id>', async () => {
    const a = createSocialAdapters(fakeTransport())
    const r = asError(
      await must(
        a.discord.publish,
        'publish',
      )({
        account_external_id: 'g1',
        kind: 'post',
        body: '公告',
      }),
    )
    expect(r.reason).toBe('not_implemented')
    expect(r.message).toContain('<服务器id>/<频道id>')
  })

  it('Discord 读评论时把机器人自己说的话滤掉（否则 triage 会给自己的公告开一张客服卡）', async () => {
    const t = fakeTransport({
      reply: () => ({
        status: 200,
        body: JSON.stringify([
          { id: 'm1', content: '本周上新', author: { id: 'bot', username: 'nordvolt', bot: true } },
          { id: 'm2', content: '我的单什么时候到', author: { id: 'u1', username: 'kai' } },
        ]),
      }),
    })
    const a = createSocialAdapters(t)
    const r = asOk<{ external_id: string }[]>(
      await must(a.discord.comments, 'comments')({ account_external_id: 'g1/c1' }),
    )
    expect(r.data.map((x) => x.external_id)).toEqual(['m2'])
  })

  it('Discord 禁言是给成员设一个到期时刻（最长 28 天），不是一个 mute 动作', async () => {
    const t = fakeTransport({ reply: () => ({ status: 200, body: '{}' }) })
    const a = createSocialAdapters(t)
    await must(
      a.discord.moderate,
      'moderate',
    )({
      account_external_id: 'g1/c1',
      target_external_id: 'u1',
      action: 'mute',
      duration_minutes: 60,
    })
    const call = t.calls[0]
    expect(call?.method).toBe('PATCH')
    expect(call?.body).toContain('communication_disabled_until')
    expect(call?.body).toContain('2026-09-16T03:00:00.000Z')
  })

  it('Discord 上没有入群审批 —— 照实说，不假装有', async () => {
    const a = createSocialAdapters(fakeTransport())
    const pending = asError(
      await must(a.discord.members, 'members')({ account_external_id: 'g1', status: 'pending' }),
    )
    expect(pending.reason).toBe('not_implemented')
    expect(pending.message).toContain('没有公开的「入群申请」接口')
  })

  it('Telegram：业务错误在 200 里，要看 ok 那一格；错误消息里**没有 token**', async () => {
    const t = fakeTransport({
      reply: () => ({
        status: 200,
        body: JSON.stringify({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        }),
      }),
    })
    const a = createSocialAdapters(t)
    const r = asError(await must(a.telegram_group.profile, 'profile')('-1001'))
    expect(r.reason).toBe('upstream_error')
    expect(r.message).toContain('chat not found')
    expect(r.message).not.toContain('TELEGRAM-SECRET')
  })

  it('Telegram 的 token 在路径上：抹 URL 那一手真的抹掉了', () => {
    expect(redactUrl('https://api.telegram.org/bot12345:SECRET/sendMessage')).toBe(
      'https://api.telegram.org/bot***/sendMessage',
    )
    expect(redactUrl('https://www.googleapis.com/youtube/v3/channels?key=YT-KEY')).toBe(
      'https://www.googleapis.com/youtube/v3/channels',
    )
  })

  it('Telegram 解除禁言要把权限**再传一遍**打开（传空对象等于全关着）', async () => {
    const t = fakeTransport({ reply: () => ({ status: 200, body: '{"ok":true,"result":true}' }) })
    const a = createSocialAdapters(t)
    await must(
      a.telegram_group.moderate,
      'moderate',
    )({
      account_external_id: '-1001',
      target_external_id: '42',
      action: 'unmute',
    })
    expect(t.calls[0]?.body).toContain('"can_send_messages":true')
  })

  it('TikTok 申请制、X 付费档：说的是这两句人话，不是 401', async () => {
    const a = createSocialAdapters(fakeTransport())
    const tt = asError(
      await must(
        a.tiktok.publish,
        'publish',
      )({
        account_external_id: 'x',
        kind: 'video',
        body: 'hi',
      }),
    )
    expect(tt.reason).toBe('needs_approval')
    const x = asError(
      await must(a.x.publish, 'publish')({ account_external_id: 'x', kind: 'post', body: 'hi' }),
    )
    expect(x.reason).toBe('needs_paid_tier')
    expect(x.message).toContain('付费档')
  })

  it('WhatsApp 的硬闸在适配器这一层再查一遍（执行器有可能被别的路径调到）', () => {
    expect(
      whatsappBroadcastGate({ account_external_id: 'p1', body: 'hi', recipients: ['+49'] })?.reason,
    ).toBe('needs_approval')
    expect(
      whatsappBroadcastGate({
        account_external_id: 'p1',
        body: 'hi',
        recipients: ['+49'],
        template_id: 'order_update_v3',
      }),
    ).toBeUndefined()
  })

  it('Facebook 群组：写动作回 browser_required + 一段脚本描述，**不假装发出去了**', async () => {
    const a = createSocialAdapters(fakeTransport())
    const r = asError(
      await must(
        a.facebook_group.publish,
        'publish',
      )({
        account_external_id: 'grp1',
        kind: 'post',
        body: '本周聚会',
      }),
    )
    expect(r.reason).toBe('browser_required')
    expect(r.message).toContain('受控浏览器')
  })
})
