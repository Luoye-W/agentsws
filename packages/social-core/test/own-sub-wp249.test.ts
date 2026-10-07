/**
 * WP249（决策 81 / 89）：自家版待处理——social-core 这一半。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 版务 listing 两条通道同一个解析 | OAuth 与浏览器读 `.json` 回的是同一个形状 |
 * | 入群申请照实说读不到 | 不当「0 条」 |
 * | 每分钟 60 跳的计数版务读口也算 | 与发帖共用同一本账 |
 * | 批准 / 移除 + 理由的 HTTP 形状 | 移除理由是 JSON 口，先移除再留话 |
 * | 建议引用的是这个版自己的版规 | 版规里没写就说没写 |
 * | 浏览器白名单按动作种类算 | 步骤被改了也绕不过去 |
 * | 接口优先、浏览器兜底 | 有 OAuth 走接口，没有走官方号，都没有照实说 |
 */
import type { SocialChannel } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createRedditAdapter,
  createRedditHybridAdapter,
  landedPostFullname,
  type ModQueueEntry,
  OLD_REDDIT_SELECTORS,
  ownSubKindOf,
  planRedditWrite,
  postAllowed,
  REDDIT_MAX_CALLS_PER_MINUTE,
  type RedditBrowserWrite,
  type RedditOfficialBrowserPort,
  redditModListing,
  type SocialTransport,
  stepAllowed,
  suggestOwnSubAction,
} from '../src/index.js'

const NOW = '2026-10-07T02:00:00.000Z'
const ORIGIN = 'https://old.reddit.com'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fake(
  reply: (url: string, init?: { method?: string; body?: string }) => unknown = () => ({}),
  connected = true,
): SocialTransport & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    connected: () => connected,
    now: () => NOW,
    credential: async (_c: SocialChannel) => ({
      access_token: 'REDDIT-SECRET',
      user_agent: 'macos:agentsws:1.0 (by /u/inmo)',
    }),
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        ...(init?.body === undefined ? {} : { body: init.body }),
      })
      const body = JSON.stringify(reply(url, init))
      return { ok: true, status: 200, text: async () => body }
    },
  }
}

const LISTING = {
  data: {
    children: [
      {
        kind: 't3',
        data: {
          name: 't3_p1',
          title: 'Cheap INMO glasses, DM me on telegram',
          selftext: 'wholesale price https://bit.ly/x',
          author: 'spammer1',
          permalink: '/r/inmoxr/comments/p1/cheap/',
          created_utc: 1_791_000_000,
          subreddit: 'inmoxr',
          num_reports: 2,
          user_reports: [['Spam', 2, false, false]],
          mod_reports: [],
        },
      },
      {
        kind: 't1',
        data: {
          name: 't1_c1',
          body: 'This is off topic I think',
          link_title: 'Air3 battery',
          author: 'alice',
          permalink: '/r/inmoxr/comments/p2/air3/c1/',
          subreddit: 'inmoxr',
          num_reports: 1,
          user_reports: [],
          mod_reports: [],
        },
      },
      {
        kind: 't3',
        data: {
          name: 't3_p3',
          title: 'Held by automod',
          selftext: 'Just my review',
          author: 'bob',
          permalink: '/r/inmoxr/comments/p3/held/',
          subreddit: 'inmoxr',
          num_reports: 0,
        },
      },
    ],
  },
}

describe('版务 listing 解析', () => {
  it('帖子 / 评论 / 举报原因 / 只有次数没原因', () => {
    const items = redditModListing(LISTING, 'modqueue')
    expect(items.map((i) => i.id)).toEqual(['t3_p1', 't1_c1', 't3_p3'])
    expect(items[0]).toMatchObject({
      thing: 'post',
      author: 'spammer1',
      report_reasons: ['Spam'],
      url: 'https://www.reddit.com/r/inmoxr/comments/p1/cheap/',
      source: 'modqueue',
    })
    expect(items[0]?.created_at).toBe(new Date(1_791_000_000 * 1000).toISOString())
    expect(items[1]).toMatchObject({ thing: 'comment', title: 'Air3 battery' })
    expect(items[1]?.report_reasons).toEqual(['有 1 个举报（没写原因）'])
    expect(items.map(ownSubKindOf)).toEqual(['reported', 'reported', 'held'])
    expect(ownSubKindOf({ ...(items[2] as ModQueueEntry), source: 'unmoderated' })).toBe('new_post')
  })
})

describe('OAuth 接口：版务读口与动作', () => {
  it('modqueue / unmoderated / rules 打对地址、带 UA 与 token；入群申请照实说读不到', async () => {
    const t = fake((url) =>
      url.includes('/about/rules') ? { rules: [{ short_name: 'No spam' }] } : LISTING,
    )
    const a = createRedditAdapter(t)
    const q = await a.modQueue?.({ account_external_id: 'r/inmoxr', source: 'modqueue', limit: 20 })
    expect(q?.ok).toBe(true)
    expect(t.calls[0]?.url).toBe(
      'https://oauth.reddit.com/r/inmoxr/about/modqueue?limit=20&raw_json=1',
    )
    expect(t.calls[0]?.headers.authorization).toBe('Bearer REDDIT-SECRET')
    expect(t.calls[0]?.headers['user-agent']).toContain('agentsws')
    await a.modQueue?.({ account_external_id: 'inmoxr', source: 'unmoderated' })
    expect(t.calls[1]?.url).toContain('/r/inmoxr/about/unmoderated?limit=50')
    const rules = await a.communityRules?.('inmoxr')
    expect(rules).toMatchObject({ ok: true, data: ['No spam'] })
    const join = await a.modQueue?.({ account_external_id: 'inmoxr', source: 'join_requests' })
    expect(join).toMatchObject({ ok: false, reason: 'not_implemented' })
    expect(t.calls).toHaveLength(3)
  })

  it('每分钟 60 跳：版务读口与别的口共用一本账', async () => {
    const t = fake(() => LISTING)
    const a = createRedditAdapter(t)
    for (let i = 0; i < REDDIT_MAX_CALLS_PER_MINUTE; i += 1)
      expect((await a.modQueue?.({ account_external_id: 'inmoxr', source: 'modqueue' }))?.ok).toBe(
        true,
      )
    const over = await a.modQueue?.({ account_external_id: 'inmoxr', source: 'modqueue' })
    expect(over).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect(t.calls).toHaveLength(REDDIT_MAX_CALLS_PER_MINUTE)
  })

  it('批准 = /api/approve；移除带理由 = 先 /api/remove 再 JSON 留话（评论走评论那一口）', async () => {
    const t = fake(() => ({ json: { errors: [] } }))
    const a = createRedditAdapter(t)
    await a.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 't1_c1',
      action: 'approve',
    })
    expect(t.calls[0]?.url).toBe('https://oauth.reddit.com/api/approve')
    expect(t.calls[0]?.body).toContain('id=t1_c1')
    const res = await a.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 'p1',
      action: 'delete_post',
      removal_message: 'Removed: No spam',
    })
    expect(res?.ok).toBe(true)
    expect(t.calls[1]?.url).toBe('https://oauth.reddit.com/api/remove')
    expect(t.calls[1]?.body).toContain('id=t3_p1')
    expect(t.calls[2]?.url).toBe('https://oauth.reddit.com/api/v1/modactions/removal_link_message')
    expect(t.calls[2]?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(t.calls[2]?.body ?? '{}')).toMatchObject({
      item_id: ['t3_p1'],
      message: 'Removed: No spam',
      type: 'public',
    })
    await a.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 't1_c1',
      action: 'delete_post',
      removal_message: 'x',
    })
    expect(t.calls[4]?.url).toContain('removal_comment_message')
    // 不带理由就只移除，不留话
    await a.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 't3_p9',
      action: 'delete_post',
    })
    expect(t.calls).toHaveLength(6)
  })
})

describe('建议：批准 / 移除 / 不用管 + 引用版规', () => {
  const RULES = ['No spam or self-promotion', 'Be civil', 'Stay on topic']
  const base: ModQueueEntry = {
    id: 't3_x',
    subreddit: 'inmoxr',
    thing: 'post',
    title: 'My review',
    excerpt: 'Love the display.',
    author: 'u1',
    report_reasons: [],
    url: '',
    source: 'modqueue',
  }

  it('广告：移除，引用这个版的「禁广告」那条', () => {
    const s = suggestOwnSubAction(redditModListing(LISTING, 'modqueue')[0] as ModQueueEntry, RULES)
    expect(s.verdict).toBe('remove')
    expect(s.rule).toBe('No spam or self-promotion')
    expect(s.reason).toContain('违反版规「No spam or self-promotion」')
  })

  it('骂人：移除，引用「Be civil」；版规里没写就照实说没写', () => {
    const e = { ...base, excerpt: 'you are an idiot' }
    expect(suggestOwnSubAction(e, RULES)).toMatchObject({ verdict: 'remove', rule: 'Be civil' })
    const none = suggestOwnSubAction(e, [])
    expect(none.rule).toBeUndefined()
    expect(none.reason).toContain('版规里没写这一条')
  })

  it('举报点名一条判不了的版规：先别动；举报无据：批准；被扣下：放出来；新帖：不用管', () => {
    expect(
      suggestOwnSubAction({ ...base, report_reasons: ['Stay on topic'] }, RULES),
    ).toMatchObject({
      verdict: 'ignore',
      rule: 'Stay on topic',
    })
    expect(suggestOwnSubAction({ ...base, report_reasons: ['meh'] }, RULES).verdict).toBe('approve')
    expect(suggestOwnSubAction(base, RULES).verdict).toBe('approve')
    expect(suggestOwnSubAction({ ...base, source: 'unmoderated' }, RULES).verdict).toBe('ignore')
  })
})

describe('浏览器通道：步骤与驱动层白名单', () => {
  const writes: RedditBrowserWrite[] = [
    { kind: 'approve', sub: 'inmoxr', fullname: 't3_p1', queue: 'modqueue' },
    {
      kind: 'remove',
      sub: 'inmoxr',
      fullname: 't3_p1',
      queue: 'unmoderated',
      removal_message: 'Rule 1',
    },
    { kind: 'ban', sub: 'inmoxr', username: 'spammer1', days: 7, note: 'spam' },
    { kind: 'submit', sub: 'inmoxr', title: 'Hello', text: 'Body', sticky: true },
    { kind: 'reply', post_fullname: 't3_p1', text: 'Thanks!' },
  ]

  it('每个动作自己的步骤都过得了自己的白名单', () => {
    for (const w of writes) {
      const plan = planRedditWrite(ORIGIN, w)
      for (const step of plan.steps) expect(stepAllowed(w, step)).toEqual({ ok: true })
    }
  })

  it('改了目标、改了要填的字、点别的按钮、开别的站：一律拦', () => {
    const approve = writes[0] as RedditBrowserWrite
    expect(
      stepAllowed(approve, {
        op: 'click',
        selector: OLD_REDDIT_SELECTORS.approveButton('t3_other'),
      }).ok,
    ).toBe(false)
    expect(
      stepAllowed(approve, { op: 'click', selector: OLD_REDDIT_SELECTORS.removeButton('t3_p1') })
        .ok,
    ).toBe(false)
    expect(stepAllowed(approve, { op: 'click', selector: 'a.arrow.up' }).ok).toBe(false)
    expect(stepAllowed(approve, { op: 'goto', url: 'https://evil.example.com/' }).ok).toBe(false)
    const reply = writes[4] as RedditBrowserWrite
    expect(
      stepAllowed(reply, {
        op: 'fill',
        selector: OLD_REDDIT_SELECTORS.replyText,
        value: 'something else',
      }),
    ).toMatchObject({ ok: false })
    expect(
      stepAllowed(reply, {
        op: 'fill',
        selector: OLD_REDDIT_SELECTORS.submitTitle,
        value: 'Thanks!',
      }).ok,
    ).toBe(false)
  })

  it('网络层只放这个动作要的写请求', () => {
    const plan = planRedditWrite(ORIGIN, writes[0] as RedditBrowserWrite)
    expect(postAllowed(plan, 'POST', `${ORIGIN}/api/approve`)).toBe(true)
    expect(postAllowed(plan, 'POST', `${ORIGIN}/api/remove`)).toBe(false)
    expect(postAllowed(plan, 'POST', `${ORIGIN}/api/vote`)).toBe(false)
    expect(postAllowed(plan, 'GET', `${ORIGIN}/r/inmoxr/`)).toBe(true)
    const remove = planRedditWrite(ORIGIN, writes[1] as RedditBrowserWrite)
    expect(remove.allowed_posts).toEqual(['/api/remove', '/api/comment'])
    // 评论的移除这一版不留话（楼中楼不做）→ 只放 /api/remove
    const removeComment = planRedditWrite(ORIGIN, {
      kind: 'remove',
      sub: 'inmoxr',
      fullname: 't1_c1',
      queue: 'modqueue',
      removal_message: 'x',
    })
    expect(removeComment.allowed_posts).toEqual(['/api/remove'])
    expect(planRedditWrite(ORIGIN, writes[3] as RedditBrowserWrite).allowed_posts).toEqual([
      '/api/submit',
      '/api/set_subreddit_sticky',
    ])
  })

  it('发帖之后落到的帖子页认得出新帖 id，别的版不认', () => {
    expect(landedPostFullname(`${ORIGIN}/r/inmoxr/comments/abc12/hello/`, 'r/inmoxr')).toBe(
      't3_abc12',
    )
    expect(landedPostFullname(`${ORIGIN}/r/other/comments/abc12/hello/`, 'inmoxr')).toBeUndefined()
    expect(landedPostFullname(`${ORIGIN}/r/inmoxr/submit`, 'inmoxr')).toBeUndefined()
  })
})

describe('接口优先、浏览器兜底', () => {
  function browser(ready = true): RedditOfficialBrowserPort & { runs: RedditBrowserWrite[] } {
    const runs: RedditBrowserWrite[] = []
    return {
      runs,
      ready: () => ready,
      readModQueue: async (sub, source) => ({
        ok: true,
        data: redditModListing(LISTING, source).map((e) => ({ ...e, subreddit: sub })),
      }),
      readRules: async () => ({ ok: true, data: ['No spam'] }),
      run: async (w) => {
        runs.push(w)
        return w.kind === 'ban'
          ? { status: 'handover', message: '页面要做人机验证。' }
          : { status: 'ok', fullname: 't3_new' }
      },
    }
  }

  it('有 OAuth 走接口，浏览器一下都不碰', async () => {
    const t = fake(() => ({ json: { errors: [] } }))
    const b = browser()
    const h = createRedditHybridAdapter({
      api: createRedditAdapter(t),
      apiConnected: () => true,
      browser: b,
      transport: t,
    })
    await h.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 't3_p1',
      action: 'approve',
    })
    expect(t.calls).toHaveLength(1)
    expect(b.runs).toHaveLength(0)
  })

  it('没有 OAuth 走官方号：批准 / 移除带队列与理由 / 群发 = 置顶帖 / 回帖', async () => {
    const t = fake(undefined, false)
    const b = browser()
    const h = createRedditHybridAdapter({
      api: createRedditAdapter(t),
      apiConnected: () => false,
      browser: b,
      transport: t,
    })
    const q = await h.modQueue?.({ account_external_id: 'r/inmoxr', source: 'unmoderated' })
    expect(q?.ok && q.data[0]?.source).toBe('unmoderated')
    await h.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 't3_p1',
      action: 'delete_post',
      queue: 'unmoderated',
      removal_message: 'No spam',
    })
    await h.broadcast?.({ account_external_id: 'inmoxr', body: 'Weekend AMA\nJoin us' })
    const r = await h.reply?.({ parent_external_id: 'p1', text: 'Thanks' })
    expect(r).toMatchObject({ ok: true, data: { external_id: 't3_new' } })
    expect(b.runs).toEqual([
      {
        kind: 'remove',
        sub: 'inmoxr',
        fullname: 't3_p1',
        queue: 'unmoderated',
        removal_message: 'No spam',
      },
      { kind: 'submit', sub: 'inmoxr', title: 'Weekend AMA', text: 'Join us', sticky: true },
      { kind: 'reply', post_fullname: 't3_p1', text: 'Thanks' },
    ])
    expect(t.calls).toHaveLength(0)
  })

  it('被拦（验证码）照实报、提示去登录窗口；禁言这类浏览器不做；两条都不通照实说', async () => {
    const t = fake(undefined, false)
    const h = createRedditHybridAdapter({
      api: createRedditAdapter(t),
      apiConnected: () => false,
      browser: browser(),
      transport: t,
    })
    const ban = await h.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 'spammer1',
      action: 'ban',
    })
    expect(ban).toMatchObject({ ok: false, reason: 'upstream_error' })
    expect(ban?.ok === false && ban.message).toContain('登录官方号')
    const mute = await h.moderate?.({
      account_external_id: 'inmoxr',
      target_external_id: 'x',
      action: 'mute',
    })
    expect(mute).toMatchObject({ ok: false, reason: 'not_implemented' })
    const off = createRedditHybridAdapter({
      api: createRedditAdapter(t),
      apiConnected: () => false,
      browser: browser(false),
      transport: t,
    })
    expect(
      await off.modQueue?.({ account_external_id: 'inmoxr', source: 'modqueue' }),
    ).toMatchObject({
      ok: false,
      reason: 'not_connected',
    })
  })
})
