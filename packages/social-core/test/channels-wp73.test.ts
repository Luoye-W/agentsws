/**
 * WP73（56 §6 那一行）：**其余四条渠道的真实现**。
 *
 * 这四条在 WP72 只有接口 + 一句"为什么还没有"。现在它们真拼 URL、真带头、
 * 真按各家的形状发 body——只有最后那一跳 `fetch` 是注入的，所以这一份测试
 * 一个真 key 都不用、一个包都不发出去，却能把这几件最容易写错的事钉死：
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | TikTok 发布回的是 `publish_id` 不是视频 id | 一跳发完这件事在 TikTok 上不存在 |
 * | TikTok 业务错误藏在 200 里 | 只看状态码会把"配额用完"当成功 |
 * | X 的回复与发推是同一个 endpoint | 去找 `/2/tweets/:id/reply` 会找一下午 |
 * | X 读提及的搜索词写死在自己账号上 | 这条渠道上没有"去 X 上搜点什么"这回事 |
 * | Reddit 带 UA、写口是 form、fullname 带前缀 | 这三样任一错了都是 429 或者静默失败 |
 * | Reddit 一分钟 60 跳自己先排队 | 与其被 429 之后猜"等多久"，不如打出去之前就说 |
 * | WhatsApp 24h 窗口 / 模板 / opt-in 三道闸 | 违了封的是这个品牌的号 |
 *
 * 凭据一次都没进过 URL、也没进过任何一句错误消息——每条都有断言看着。
 */
import type { SocialChannel } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createSocialAdapters,
  REDDIT_MAX_CALLS_PER_MINUTE,
  type SocialHttpResponse,
  type SocialTransport,
  tiktokPublishStatus,
  whatsappWindowOpen,
} from '../src/index.js'

const NOW = '2026-09-16T02:00:00.000Z'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fake(
  options: {
    now?: () => string
    reply?: (
      url: string,
      init?: { method?: string; body?: string },
    ) => { status: number; body: string }
  } = {},
): SocialTransport & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    connected: () => true,
    now: options.now ?? (() => NOW),
    credential: async (c: SocialChannel) =>
      c === 'x'
        ? { bearer_token: 'X-SECRET', handle: '@nordvolt' }
        : c === 'reddit'
          ? { access_token: 'REDDIT-SECRET', user_agent: 'macos:agentsws:1.0 (by /u/nordvolt)' }
          : c === 'whatsapp'
            ? { access_token: 'WA-SECRET', phone_number_id: '1065', template_language: 'zh_CN' }
            : { access_token: 'TT-SECRET' },
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

function must<T>(fn: T | undefined, name: string): T {
  if (fn === undefined) throw new Error(`这条渠道上没有 ${name} 这个口子`)
  return fn
}
function asError(r: { ok: boolean }): { reason: string; message: string } {
  if (r.ok) throw new Error('本该失败，却成功了')
  return r as unknown as { reason: string; message: string }
}
function asOk<T>(r: { ok: boolean }): { data: T } {
  if (!r.ok) throw new Error(`本该成功，却失败了：${JSON.stringify(r)}`)
  return r as unknown as { data: T }
}

describe('TikTok（Content Posting API，WP73）', () => {
  it('发布是两跳：init 回的是 publish_id，视频 id 要等状态查询', async () => {
    const t = fake({
      reply: (url) =>
        url.includes('/post/publish/video/init/')
          ? {
              status: 200,
              body: JSON.stringify({ data: { publish_id: 'p_1' }, error: { code: 'ok' } }),
            }
          : {
              status: 200,
              body: JSON.stringify({
                data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['v_9'] },
                error: { code: 'ok' },
              }),
            },
    })
    const a = createSocialAdapters(t)
    const made = asOk<{ external_id: string }>(
      await must(
        a.tiktok.publish,
        'publish',
      )({
        account_external_id: 'me',
        kind: 'video',
        body: '开箱',
        media_urls: ['https://cdn.example.com/a.mp4'],
      }),
    )
    expect(made.data.external_id).toBe('p_1')
    const call = t.calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.headers.authorization).toBe('Bearer TT-SECRET')
    // 令牌走头，不走 query
    expect(call?.url).not.toContain('TT-SECRET')
    expect(call?.body).toContain('PULL_FROM_URL')

    const status = asOk<{ status: string; post_id?: string }>(await tiktokPublishStatus(t, 'p_1'))
    expect(status.data.status).toBe('PUBLISH_COMPLETE')
    // 上游这个字段名就是拼错的（`publicaly`）——照抄才读得到
    expect(status.data.post_id).toBe('v_9')
  })

  it('业务错误藏在 200 里：`error.code` 不是 ok 就是失败', async () => {
    const t = fake({
      reply: () => ({
        status: 200,
        body: JSON.stringify({ error: { code: 'spam_risk_too_many_posts', message: '太快了' } }),
      }),
    })
    const a = createSocialAdapters(t)
    const r = asError(
      await must(
        a.tiktok.publish,
        'publish',
      )({
        account_external_id: 'me',
        kind: 'video',
        body: 'hi',
        media_urls: ['https://cdn.example.com/a.mp4'],
      }),
    )
    expect(r.reason).toBe('rate_limited')
  })

  it('没有素材就不发：TikTok 只发视频，照实说而不是发一条空的', async () => {
    const t = fake()
    const a = createSocialAdapters(t)
    const r = asError(
      await must(
        a.tiktok.publish,
        'publish',
      )({ account_external_id: 'me', kind: 'video', body: 'hi' }),
    )
    expect(r.reason).toBe('not_implemented')
    expect(t.calls).toHaveLength(0)
  })

  it('视频列表：`create_time` 是**秒**（乘错的表现是所有视频都发在 1970 年）', async () => {
    const t = fake({
      reply: () => ({
        status: 200,
        body: JSON.stringify({
          data: {
            videos: [{ id: 'v1', title: '开箱', create_time: 1_757_000_000, view_count: 1200 }],
          },
          error: { code: 'ok' },
        }),
      }),
    })
    const a = createSocialAdapters(t)
    const r = asOk<{ published_at?: string; metrics?: { views?: number } }[]>(
      await must(a.tiktok.posts, 'posts')({ account_external_id: 'me' }),
    )
    expect(r.data[0]?.published_at?.startsWith('2025-')).toBe(true)
    expect(r.data[0]?.metrics?.views).toBe(1200)
  })
})

describe('X（API v2，WP73）', () => {
  it('回复与发推是**同一个** endpoint，只多一格 reply', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"data":{"id":"t_1"}}' }) })
    const a = createSocialAdapters(t)
    await must(a.x.publish, 'publish')({ account_external_id: '77', kind: 'post', body: '上新了' })
    await must(a.x.reply, 'reply')({ parent_external_id: 't_0', text: '谢谢' })
    expect(t.calls[0]?.url).toBe('https://api.x.com/2/tweets')
    expect(t.calls[1]?.url).toBe('https://api.x.com/2/tweets')
    expect(t.calls[0]?.body).not.toContain('reply')
    expect(JSON.parse(t.calls[1]?.body ?? '{}')).toEqual({
      text: '谢谢',
      reply: { in_reply_to_tweet_id: 't_0' },
    })
  })

  it('读提及：搜索词写死在自己账号上，别人的号搜不了', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"data":[]}' }) })
    const a = createSocialAdapters(t)
    await must(a.x.comments, 'comments')({ account_external_id: '77' })
    const url = decodeURIComponent(t.calls[0]?.url ?? '')
    expect(url).toContain('/tweets/search/recent')
    expect(url).toContain('(to:nordvolt OR @nordvolt) -from:nordvolt')
  })

  it('连接里没填我们自己的 @：照实说要补一格，不去搜一个空词', async () => {
    const t = {
      ...fake(),
      credential: async () => ({ bearer_token: 'X-SECRET' }),
    } as SocialTransport
    const a = createSocialAdapters(t)
    const r = asError(await must(a.x.comments, 'comments')({ account_external_id: '77' }))
    expect(r.reason).toBe('not_connected')
    expect(r.message).toContain('@handle')
  })

  it('403 = 要买档；401 还是"授权掉了"（两件事不混成一句）', async () => {
    const paid = createSocialAdapters(fake({ reply: () => ({ status: 403, body: '{}' }) }))
    expect(asError(await must(paid.x.profile, 'profile')('77')).reason).toBe('needs_paid_tier')
    const gone = createSocialAdapters(fake({ reply: () => ({ status: 401, body: '{}' }) }))
    expect(asError(await must(gone.x.profile, 'profile')('77')).reason).toBe('not_connected')
  })
})

describe('Reddit（OAuth，WP73）', () => {
  it('每一跳都带 User-Agent（写错一律 429，而且最难查）', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"data":{"subscribers":8200}}' }) })
    const a = createSocialAdapters(t)
    await must(a.reddit.profile, 'profile')('r/nordvolt')
    expect(t.calls[0]?.headers['user-agent']).toBe('macos:agentsws:1.0 (by /u/nordvolt)')
    expect(t.calls[0]?.headers.authorization).toBe('Bearer REDDIT-SECRET')
    expect(t.calls[0]?.url).toBe('https://oauth.reddit.com/r/nordvolt/about')
  })

  it('写口是 form-urlencoded，而且回帖的 thing_id 带 `t3_` 前缀（裸 id 会静默失败）', async () => {
    const t = fake({
      reply: () => ({
        status: 200,
        body: '{"json":{"data":{"things":[{"data":{"name":"t1_x"}}]}}}',
      }),
    })
    const a = createSocialAdapters(t)
    await must(a.reddit.reply, 'reply')({ parent_external_id: 'abc123', text: '收到' })
    const call = t.calls[0]
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(call?.body).toContain('thing_id=t3_abc123')
    expect(call?.body).toContain('api_type=json')
  })

  it('`api_type=json` 的业务错误在 200 里（HTTP 说成功、json.errors 里说没做成）', async () => {
    const t = fake({
      reply: () => ({ status: 200, body: '{"json":{"errors":[["RATELIMIT","再等 6 分钟"]]}}' }),
    })
    const a = createSocialAdapters(t)
    const r = asError(
      await must(
        a.reddit.publish,
        'publish',
      )({ account_external_id: 'nordvolt', kind: 'post', body: '公告' }),
    )
    expect(r.reason).toBe('rate_limited')
    expect(r.message).toContain('再等 6 分钟')
  })

  it('"群发"= 发一条置顶帖（两跳：submit + distinguish），**不是**挨个私信', async () => {
    const t = fake({
      reply: (url) =>
        url.endsWith('/api/submit')
          ? { status: 200, body: '{"json":{"data":{"name":"t3_new"}}}' }
          : { status: 200, body: '{"json":{}}' },
    })
    const a = createSocialAdapters(t)
    const r = asOk<{ sent: number }>(
      await must(
        a.reddit.broadcast,
        'broadcast',
      )({
        account_external_id: 'nordvolt',
        body: '【公告】周四直播',
        recipients: ['u1', 'u2', 'u3'],
      }),
    )
    expect(t.calls.map((c) => c.url.replace('https://oauth.reddit.com', ''))).toEqual([
      '/api/submit',
      '/api/distinguish',
    ])
    expect(t.calls[1]?.body).toContain('sticky=true')
    // 一条置顶帖 = 一次"发出去了"，不是三个人各收到一条
    expect(r.data.sent).toBe(1)
  })

  it('一分钟 60 跳：第 61 跳自己先拦下来，不等上游 429', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"data":{}}' }) })
    const a = createSocialAdapters(t)
    for (let i = 0; i < REDDIT_MAX_CALLS_PER_MINUTE; i += 1)
      await must(a.reddit.profile, 'profile')('nordvolt')
    expect(t.calls).toHaveLength(REDDIT_MAX_CALLS_PER_MINUTE)
    const r = asError(await must(a.reddit.profile, 'profile')('nordvolt'))
    expect(r.reason).toBe('rate_limited')
    // 拦下来 = **一跳都没打出去**
    expect(t.calls).toHaveLength(REDDIT_MAX_CALLS_PER_MINUTE)
  })

  it('subreddit 没有入群审批：照实说，不假装有', async () => {
    const a = createSocialAdapters(fake())
    const r = asError(
      await must(
        a.reddit.members,
        'members',
      )({ account_external_id: 'nordvolt', status: 'pending' }),
    )
    expect(r.reason).toBe('not_implemented')
    expect(r.message).toContain('关注是单向的')
  })
})

describe('WhatsApp（Cloud API，WP73）', () => {
  it('24 小时客服窗口：没记过入站时间 = 窗口关着（不是"还开着"）', () => {
    expect(whatsappWindowOpen({ last_inbound_at: undefined, now: NOW })).toBe(false)
    expect(whatsappWindowOpen({ last_inbound_at: '2026-09-15T20:00:00.000Z', now: NOW })).toBe(true)
    expect(whatsappWindowOpen({ last_inbound_at: '2026-09-14T20:00:00.000Z', now: NOW })).toBe(
      false,
    )
  })

  it('窗口关着的自由文本发不出去，而且**一跳都不打**', async () => {
    const t = fake()
    const a = createSocialAdapters(t)
    const r = asError(
      await must(a.whatsapp.reply, 'reply')({ parent_external_id: '+4915', text: '在的' }),
    )
    expect(r.reason).toBe('needs_approval')
    expect(r.message).toContain('模板')
    expect(t.calls).toHaveLength(0)
  })

  it('窗口开着才发自由文本（`type: text`）', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"messages":[{"id":"wamid.1"}]}' }) })
    const a = createSocialAdapters(t)
    await must(
      a.whatsapp.reply,
      'reply',
    )({
      parent_external_id: '+4915',
      text: '在的',
      last_inbound_at: '2026-09-15T20:00:00.000Z',
    })
    const sent = JSON.parse(t.calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(t.calls[0]?.url).toBe('https://graph.facebook.com/v21.0/1065/messages')
    expect(sent.messaging_product).toBe('whatsapp')
    expect(sent.type).toBe('text')
  })

  it('群发：模板名必填、opt-in 必须核过、一个一个发；变量按数字序填', async () => {
    const t = fake({ reply: () => ({ status: 200, body: '{"messages":[{"id":"wamid.1"}]}' }) })
    const a = createSocialAdapters(t)
    const r = asOk<{ sent: number; failed: number }>(
      await must(
        a.whatsapp.broadcast,
        'broadcast',
      )({
        account_external_id: '1065',
        body: '不看这一格：模板消息的正文在模板里',
        recipients: ['+4915', '+4916'],
        template_id: 'live_reminder_v2',
        template_variables: { '2': '八点', '1': '周四' },
        opt_in_verified: true,
      }),
    )
    expect(r.data).toEqual({ sent: 2, failed: 0 })
    const first = JSON.parse(t.calls[0]?.body ?? '{}') as {
      template?: { name?: string; language?: { code?: string }; components?: unknown[] }
    }
    expect(first.template?.name).toBe('live_reminder_v2')
    expect(first.template?.language?.code).toBe('zh_CN')
    expect(first.template?.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '周四' },
          { type: 'text', text: '八点' },
        ],
      },
    ])
  })

  it('被限流就**停下来**，不接着把同一个错重复几百遍', async () => {
    let n = 0
    const t = fake({
      reply: () => {
        n += 1
        return n === 1
          ? { status: 200, body: '{"messages":[{"id":"wamid.1"}]}' }
          : { status: 429, body: '{}' }
      },
    })
    const a = createSocialAdapters(t)
    const r = asOk<{ sent: number; failed: number }>(
      await must(
        a.whatsapp.broadcast,
        'broadcast',
      )({
        account_external_id: '1065',
        body: 'x',
        recipients: ['+1', '+2', '+3', '+4'],
        template_id: 'tpl',
        opt_in_verified: true,
      }),
    )
    expect(r.data).toEqual({ sent: 1, failed: 1 })
    expect(t.calls).toHaveLength(2)
  })
})
