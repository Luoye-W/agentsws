import type { SocialChannel } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  capabilitiesOf,
  checkPostText,
  createSocialAdapters,
  PLATFORM_LIMITS,
  SCHEDULE_RULES,
  type SocialHttpResponse,
  type SocialTransport,
  scheduleRulesFor,
} from '../src/index.js'

const NOW = '2026-09-29T02:00:00.000Z'

/** 替身：记下每一跳（真 fetch 一次都不出去，docs/86 纪律「测试不连真接口」）。 */
function fake(
  reply: (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    status: number
    body?: string
    headers?: Record<string, string>
  } = () => ({ status: 200, body: '{}' }),
  extra: { sleep?: boolean; connected?: (c: SocialChannel) => boolean } = {},
): SocialTransport & {
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[]
  slept: number[]
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    []
  const slept: number[] = []
  return {
    calls,
    slept,
    connected: extra.connected ?? (() => true),
    now: () => NOW,
    credential: async (c) =>
      c === 'linkedin'
        ? { access_token: 'LI-SECRET', author_urn: 'urn:li:organization:42' }
        : c === 'threads'
          ? { access_token: 'TH-SECRET' }
          : { access_token: 'META-SECRET', page_id: '100', ig_user_id: '178' },
    fetch: async (url, init): Promise<SocialHttpResponse> => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        ...(init?.body === undefined ? {} : { body: init.body }),
      })
      const r = reply(url, init)
      const h = r.headers ?? {}
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => r.body ?? '',
        headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      }
    },
    ...(extra.sleep === true
      ? {
          sleep: async (ms: number) => {
            slept.push(ms)
          },
        }
      : {}),
  }
}

function must<T>(fn: T | undefined, name: string): T {
  if (fn === undefined) throw new Error(`这条渠道上没有 ${name} 这个口子`)
  return fn
}

describe('WP191 平台限制一张表（docs/86 §1.4）', () => {
  it('IG：2,200 字、30 个标签、20 个 @；超了逐条说', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    const problems = checkPostText('instagram', `新品 ${tags}`)
    expect(problems.map((p) => p.kind)).toEqual(['too_many_hashtags'])
    expect(problems[0]?.message).toContain('最多 30 个')
    expect(checkPostText('instagram', 'x'.repeat(2201))[0]?.kind).toBe('too_long')
  })

  it('Threads：500 字、5 个链接、1 个话题标签', () => {
    expect(checkPostText('threads', 'a'.repeat(500))).toEqual([])
    expect(checkPostText('threads', 'a'.repeat(501))[0]?.limit).toBe(500)
    const links = Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`).join(' ')
    expect(checkPostText('threads', links).map((p) => p.kind)).toContain('too_many_links')
  })

  it('X 280、LinkedIn 3,000；FB 官方没给上限 → 不拦（不拿编的数拦人）', () => {
    expect(checkPostText('x', 'a'.repeat(281))[0]?.limit).toBe(280)
    expect(checkPostText('linkedin', 'a'.repeat(3001))[0]?.limit).toBe(3000)
    expect(checkPostText('facebook', 'a'.repeat(70_000))).toEqual([])
    // 社群组不在这张表里
    expect(checkPostText('discord', 'a'.repeat(70_000))).toEqual([])
  })

  it('日历按渠道取每日上限；不在表里的按默认', () => {
    expect(scheduleRulesFor('linkedin').max_per_day).toBe(1)
    expect(scheduleRulesFor('x').max_per_day).toBe(5)
    expect(scheduleRulesFor('youtube').max_per_day).toBe(2)
    expect(scheduleRulesFor('discord')).toEqual(SCHEDULE_RULES)
    expect(scheduleRulesFor('instagram').min_gap_minutes).toBe(SCHEDULE_RULES.min_gap_minutes)
    expect(PLATFORM_LIMITS.meta?.max_posts_per_day).toBe(3)
  })
})

describe('WP191 Facebook 主页 = 老 meta 那份实现，换个渠道名', () => {
  it('打的是同一套 Pages API，排期两格一起写；没连时按 facebook 这条判', async () => {
    const t = fake(() => ({ status: 200, body: '{"id":"100_9"}' }))
    const a = createSocialAdapters(t)
    const r = await must(
      a.facebook.publish,
      'publish',
    )({
      account_external_id: '100',
      kind: 'post',
      body: '周四直播',
      scheduled_at: '2026-10-01T12:00:00.000Z',
    })
    expect(r.ok).toBe(true)
    expect(t.calls[0]?.url).toBe('https://graph.facebook.com/v21.0/100/feed')
    expect(t.calls[0]?.body).toContain('published=false')
    expect(t.calls[0]?.body).toContain('scheduled_publish_time=')
    expect(capabilitiesOf(a.facebook)).toEqual(capabilitiesOf(a.meta))

    const off = fake(undefined, { connected: (c) => c !== 'facebook' })
    const r2 = await must(createSocialAdapters(off).facebook.profile, 'profile')('100')
    expect(r2).toMatchObject({ ok: false, reason: 'not_connected' })
    expect(r2.ok ? '' : r2.message).toContain('Facebook 主页')
  })
})

describe('WP191 Instagram（两跳发布、先量再发）', () => {
  it('单图：建容器 → media_publish；不传排期（API 没有排期）', async () => {
    const t = fake((url) =>
      url.endsWith('/media_publish')
        ? { status: 200, body: '{"id":"IGM1"}' }
        : { status: 200, body: '{"id":"C1"}' },
    )
    const r = await must(
      createSocialAdapters(t).instagram.publish,
      'publish',
    )({
      account_external_id: '178',
      kind: 'image',
      body: '新桌垫 #desk',
      media_urls: ['https://cdn.example/a.jpg'],
      scheduled_at: '2026-10-01T12:00:00.000Z',
    })
    expect(r).toMatchObject({ ok: true, data: { external_id: 'IGM1' } })
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v21.0/178/media',
      'https://graph.facebook.com/v21.0/178/media_publish',
    ])
    expect(t.calls[0]?.body).toContain('image_url=')
    expect(t.calls[0]?.body).not.toContain('scheduled')
    expect(t.calls[1]?.body).toBe('creation_id=C1')
    // 凭据只在头里
    expect(t.calls[0]?.headers.Authorization).toBe('Bearer META-SECRET')
    expect(t.calls[0]?.url).not.toContain('SECRET')
  })

  it('纯文字、超过 10 张、31 个标签：一跳都不打，说清楚为什么', async () => {
    const a = createSocialAdapters(fake())
    const pub = must(a.instagram.publish, 'publish')
    const t1 = await pub({ account_external_id: '178', kind: 'post', body: '只有字' })
    expect(t1).toMatchObject({ ok: false, reason: 'content_rejected' })
    const eleven = Array.from({ length: 11 }, (_, i) => `https://cdn.example/${i}.jpg`)
    const t2 = await pub({
      account_external_id: '178',
      kind: 'carousel',
      body: 'x',
      media_urls: eleven,
    })
    expect(t2.ok ? '' : t2.message).toContain('最多 10 张')
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    const t3 = await pub({
      account_external_id: '178',
      kind: 'image',
      body: tags,
      media_urls: ['https://cdn.example/a.jpg'],
    })
    expect(t3).toMatchObject({ ok: false, reason: 'content_rejected' })
  })

  it('Reels：视频容器要等 FINISHED 才发；给了 sleep 就隔几秒问一次', async () => {
    let polls = 0
    const t = fake(
      (url) => {
        if (url.includes('fields=status_code')) {
          polls += 1
          return {
            status: 200,
            body: polls < 3 ? '{"status_code":"IN_PROGRESS"}' : '{"status_code":"FINISHED"}',
          }
        }
        return url.endsWith('/media_publish')
          ? { status: 200, body: '{"id":"R1"}' }
          : { status: 200, body: '{"id":"C9"}' }
      },
      { sleep: true },
    )
    const r = await must(
      createSocialAdapters(t).instagram.publish,
      'publish',
    )({
      account_external_id: '178',
      kind: 'reel',
      body: '三秒看懂',
      media_urls: ['https://cdn.example/r.mp4'],
    })
    expect(r).toMatchObject({ ok: true, data: { external_id: 'R1' } })
    expect(t.calls[0]?.body).toContain('media_type=REELS')
    expect(t.slept).toHaveLength(2)
  })

  it('不给 sleep、视频还没处理完：只问一次、照实说，不发', async () => {
    const t = fake((url) =>
      url.includes('fields=status_code')
        ? { status: 200, body: '{"status_code":"IN_PROGRESS"}' }
        : { status: 200, body: '{"id":"C9"}' },
    )
    const r = await must(
      createSocialAdapters(t).instagram.publish,
      'publish',
    )({
      account_external_id: '178',
      kind: 'reel',
      body: 'x',
      media_urls: ['https://cdn.example/r.mp4'],
    })
    expect(r.ok ? '' : r.message).toContain('还在处理')
    expect(t.calls.some((c) => c.url.endsWith('/media_publish'))).toBe(false)
  })

  it('回评论走 /replies；媒体类型翻成我们的形态', async () => {
    const t = fake((url) =>
      url.includes('/media?')
        ? {
            status: 200,
            body: JSON.stringify({
              data: [
                { id: '1', media_type: 'VIDEO', media_product_type: 'REELS', like_count: 5 },
                { id: '2', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED' },
              ],
            }),
          }
        : { status: 200, body: '{"id":"RP1"}' },
    )
    const a = createSocialAdapters(t)
    const posts = await must(a.instagram.posts, 'posts')({ account_external_id: '178' })
    expect(posts.ok && posts.data.map((p) => p.kind)).toEqual(['reel', 'carousel'])
    const rep = await must(a.instagram.reply, 'reply')({ parent_external_id: 'CM1', text: '谢谢' })
    expect(rep).toMatchObject({ ok: true, data: { external_id: 'RP1' } })
    expect(t.calls.at(-1)?.url).toBe('https://graph.facebook.com/v21.0/CM1/replies')
  })
})

describe('WP191 Threads（自己一把令牌、两跳、回复也是发帖）', () => {
  it('纯文字：TEXT 容器 → threads_publish；打的是 graph.threads.net', async () => {
    const t = fake((url) =>
      url.endsWith('/threads_publish')
        ? { status: 200, body: '{"id":"T1"}' }
        : { status: 200, body: '{"id":"CT"}' },
    )
    const r = await must(
      createSocialAdapters(t).threads.publish,
      'publish',
    )({
      account_external_id: 'me1',
      kind: 'post',
      body: '今天聊聊线材收纳',
    })
    expect(r).toMatchObject({ ok: true, data: { external_id: 'T1' } })
    expect(t.calls[0]?.url).toBe('https://graph.threads.net/v1.0/me1/threads')
    expect(t.calls[0]?.body).toContain('media_type=TEXT')
    expect(t.calls[0]?.headers.Authorization).toBe('Bearer TH-SECRET')
  })

  it('501 字一跳都不打', async () => {
    const t = fake()
    const r = await must(
      createSocialAdapters(t).threads.publish,
      'publish',
    )({
      account_external_id: 'me1',
      kind: 'post',
      body: 'a'.repeat(501),
    })
    expect(r).toMatchObject({ ok: false, reason: 'content_rejected' })
    expect(t.calls).toHaveLength(0)
  })

  it('回复 = 带 reply_to_id 的容器再发布；没带我们自己的号 id 就不发', async () => {
    const t = fake(() => ({ status: 200, body: '{"id":"X"}' }))
    const a = createSocialAdapters(t)
    const r = await must(
      a.threads.reply,
      'reply',
    )({
      parent_external_id: 'P7',
      text: '谢谢喜欢',
      account_external_id: 'me1',
    })
    expect(r.ok).toBe(true)
    expect(t.calls[0]?.body).toContain('reply_to_id=P7')
    const no = await must(a.threads.reply, 'reply')({ parent_external_id: 'P7', text: 'x' })
    expect(no.ok).toBe(false)
  })
})

describe('WP191 LinkedIn（只代发文字；批不下来是常态；不加人不私信）', () => {
  it('发帖：带版本头与 Rest.li 头，作者用连接卡上的 URN，id 从响应头拿', async () => {
    const t = fake(() => ({ status: 201, body: '', headers: { 'x-restli-id': 'urn:li:share:77' } }))
    const r = await must(
      createSocialAdapters(t).linkedin.publish,
      'publish',
    )({
      account_external_id: 'company',
      kind: 'post',
      body: '我们为什么只做一种桌垫',
    })
    expect(r).toMatchObject({ ok: true, data: { external_id: 'urn:li:share:77' } })
    const call = t.calls[0]
    expect(call?.url).toBe('https://api.linkedin.com/rest/posts')
    expect(call?.headers['LinkedIn-Version']).toMatch(/^\d{6}$/)
    expect(call?.headers['X-Restli-Protocol-Version']).toBe('2.0.0')
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({
      author: 'urn:li:organization:42',
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
    })
  })

  it('公司主页 403 = 要先过 Community Management API 审核（不是"授权掉了"）', async () => {
    const t = fake(() => ({ status: 403 }))
    const r = await must(
      createSocialAdapters(t).linkedin.publish,
      'publish',
    )({
      account_external_id: 'urn:li:organization:42',
      kind: 'post',
      body: 'x',
    })
    expect(r).toMatchObject({ ok: false, reason: 'needs_approval' })
    expect(r.ok ? '' : r.message).toContain('Community Management API')
    expect(r.ok ? '' : r.message).toContain('复制文案去 LinkedIn 发')
  })

  it('带素材的还不能代发 → not_implemented（契约上这条渠道会转成待办）；超长先拦', async () => {
    const t = fake()
    const pub = must(createSocialAdapters(t).linkedin.publish, 'publish')
    const r = await pub({
      account_external_id: 'urn:li:person:abc',
      kind: 'document',
      body: 'x',
      media_urls: ['https://cdn.example/deck.pdf'],
    })
    expect(r).toMatchObject({ ok: false, reason: 'not_implemented' })
    const long = await pub({
      account_external_id: 'urn:li:person:abc',
      kind: 'post',
      body: 'a'.repeat(3001),
    })
    expect(long).toMatchObject({ ok: false, reason: 'content_rejected' })
    expect(t.calls).toHaveLength(0)
  })

  it('没有回评论、没有成员、没有群发：缺席本身就是信息（用户协议禁自动化）', () => {
    const a = createSocialAdapters(fake())
    expect(capabilitiesOf(a.linkedin)).toEqual({ read: ['posts'], write: ['publish'] })
    expect(a.linkedin.reply).toBeUndefined()
    expect(a.linkedin.members).toBeUndefined()
  })
})
