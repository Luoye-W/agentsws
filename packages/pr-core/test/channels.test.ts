/**
 * WP78（60 §2 末段）：三条渠道口的三条形状。
 *
 * 1. Reddit：**社媒那份适配器原样复用** + 三口；在别人的版里发要带卡 id。
 * 2. 论坛：读走白名单、写先出卡、失效人接管（照 56 的 Facebook 群组）。
 * 3. Alerts：RSS 注入 fetch；**拉不到 ≠ 今天没人提我们**。
 */
import type { BrowserAction, BrowserExecutor, SocialTransport } from '@agentsws/social-core'
import { describe, expect, it } from 'vitest'
import {
  createForumAdapter,
  createPrRedditAdapter,
  executeApprovedForumAction,
  FORUM_HOSTS,
  fetchGoogleAlerts,
  parseAlertsFeed,
  postScript,
  searchRedditMentions,
  searchScript,
  stripHtml,
  submitApprovedPost,
  unwrapAlertLink,
} from '../src/index.js'

const NOW = '2026-09-17T09:00:00Z'

const transport = (
  handler: (
    url: string,
    init?: { method?: string; body?: string },
  ) => {
    ok: boolean
    status: number
    body: string
  },
  connected = true,
): SocialTransport & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    async fetch(url, init) {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const r = handler(url, init)
      return { ok: r.ok, status: r.status, text: async () => r.body }
    },
    connected: () => connected,
    credential: async () => ({ access_token: 'tok', user_agent: 'macos:agentsws:1.0 (by /u/x)' }),
    now: () => NOW,
  }
}

describe('Reddit：复用 + 三口', () => {
  it('`base` 就是社媒那份适配器（不是另写一个）', () => {
    const a = createPrRedditAdapter(transport(() => ({ ok: true, status: 200, body: '{}' })))
    expect(a.base.channel).toBe('reddit')
    expect(a.base.mode).toBe('api')
    // 社媒那份有的口子在这里一个不少
    expect(typeof a.base.posts).toBe('function')
  })

  it('搜版：把订阅数与简介带回来', async () => {
    const t = transport(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          children: [
            {
              data: {
                display_name: 'BuyItForLife',
                title: 'BIFL',
                subscribers: 2_000_000,
                public_description: '耐用的东西',
                url: '/r/BuyItForLife/',
              },
            },
          ],
        },
      }),
    }))
    const res = await createPrRedditAdapter(t).searchSubreddits({ query: '户外电源' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data[0]?.name).toBe('BuyItForLife')
    expect(res.data[0]?.subscribers).toBe(2_000_000)
    expect(t.calls[0]).toContain('/subreddits/search?q=')
  })

  it('读版规：三格合成一行再解析（禁推广认得出来）', async () => {
    const t = transport(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        rules: [
          { short_name: 'Rule 1', violation_reason: 'No self-promotion', description: '含外链' },
          { short_name: 'Flair required: Review, Discussion' },
        ],
      }),
    }))
    const res = await createPrRedditAdapter(t).subredditRules('r/BuyItForLife')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.no_self_promotion).toBe(true)
    expect(res.data.flair_required).toBe(true)
    expect(res.data.raw_rules).toHaveLength(2)
  })

  it('在别人的版里发：**没有卡 id 就不发**', async () => {
    const t = transport(() => ({ ok: true, status: 200, body: '{}' }))
    const res = await submitApprovedPost(
      createPrRedditAdapter(t),
      { subreddit: 'BuyItForLife', title: 't', body: 'b' },
      { approval_id: '  ' },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('needs_approval')
    // 一跳都没打出去
    expect(t.calls).toHaveLength(0)
  })

  it('带着卡 id 才真发，而且是 form-urlencoded', async () => {
    const t = transport(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ json: { data: { name: 't3_abc', url: 'https://r/x' } } }),
    }))
    const res = await submitApprovedPost(
      createPrRedditAdapter(t),
      { subreddit: 'r/BuyItForLife', title: '拆解', body: '正文' },
      { approval_id: 'ap_1' },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.external_id).toBe('t3_abc')
    expect(t.calls[0]).toBe('POST https://oauth.reddit.com/api/submit')
  })

  it('版规不让 → 说清是版规不让，别让人反复重试', async () => {
    const t = transport(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ json: { errors: [['SUBREDDIT_NOTALLOWED', '这个版不收广告']] } }),
    }))
    const res = await submitApprovedPost(
      createPrRedditAdapter(t),
      { subreddit: 'x', title: 't', body: 'b' },
      { approval_id: 'ap_1' },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('版规不让')
  })

  it('没连上就一跳都不打', async () => {
    const t = transport(() => ({ ok: true, status: 200, body: '{}' }), false)
    const res = await createPrRedditAdapter(t).searchSubreddits({ query: 'x' })
    expect(res.ok).toBe(false)
    expect(t.calls).toHaveLength(0)
  })
})

describe('论坛：浏览器模式三条', () => {
  const executor = (
    run: (a: BrowserAction) => ReturnType<BrowserExecutor['run']>,
    hosts?: string[],
  ): BrowserExecutor & { opened: string[] } => {
    const opened: string[] = []
    return {
      opened,
      ...(hosts === undefined ? {} : { allowedHosts: () => hosts }),
      run: async (a) => {
        opened.push(a.url)
        return run(a)
      },
    }
  }

  it('读走白名单：越界的地址一个字节都不开', async () => {
    const e = executor(async () => ({ status: 'ok', items: [] }))
    const a = createForumAdapter({ browser: e, now: () => NOW })
    const res = await a.search({ site: 'evil.example', query: 'x' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('不在这条职责能开的站里')
    expect(e.opened).toHaveLength(0)
  })

  it('白名单里的站读得回来', async () => {
    const e = executor(async () => ({
      status: 'ok',
      items: [{ url: 'https://www.quora.com/q/1', title: '哪个户外电源耐用', text: '求推荐' }],
    }))
    const res = await createForumAdapter({ browser: e, now: () => NOW }).search({
      site: 'www.quora.com',
      query: '户外电源',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data[0]?.title).toBe('哪个户外电源耐用')
  })

  it('写动作**永远**回 browser_required，一个字都不执行', async () => {
    const e = executor(async () => ({ status: 'ok', items: [] }))
    const a = createForumAdapter({ browser: e, now: () => NOW })
    for (const res of [
      await a.post({ site: 'www.quora.com', venue: 'topic', body: 'x' }),
      await a.answer({ url: 'https://www.quora.com/q/1', body: 'x' }),
    ]) {
      expect(res.ok).toBe(false)
      if (res.ok) continue
      expect(res.reason).toBe('browser_required')
    }
    expect(e.opened).toHaveLength(0)
  })

  it('批准之后才点，而且没有卡 id 还是不点', async () => {
    const e = executor(async () => ({ status: 'ok', verified: true }))
    const action = postScript({ site: 'www.quora.com', venue: 'topic', body: '正文' })
    const refused = await executeApprovedForumAction(e, action, { approval_id: '', now: NOW })
    expect(refused.ok).toBe(false)
    expect(e.opened).toHaveLength(0)
    const done = await executeApprovedForumAction(e, action, { approval_id: 'ap_1', now: NOW })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.data.verified).toBe(true)
  })

  it('执行器说不准做成没有 → 照实报 verified:false，不当成功', async () => {
    const e = executor(async () => ({ status: 'ok' }))
    const done = await executeApprovedForumAction(
      e,
      postScript({ site: 'www.quora.com', venue: 'topic', body: 'x' }),
      { approval_id: 'ap_1', now: NOW },
    )
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.data.verified).toBe(false)
  })

  it('失效即停：handover 说"请你接管"，而且明说没重试', async () => {
    const e = executor(async () => ({ status: 'handover', message: '登录态掉了' }))
    const res = await executeApprovedForumAction(
      e,
      postScript({ site: 'www.quora.com', venue: 'topic', body: 'x' }),
      { approval_id: 'ap_1', now: NOW },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('接一下')
    expect(res.message).toContain('没有重试')
    expect(e.opened).toHaveLength(1)
  })

  it('没有执行器 = 只出脚本描述，**不假装读到了**', async () => {
    const res = await createForumAdapter({ now: () => NOW }).search({
      site: 'www.quora.com',
      query: 'x',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('browser_required')
  })

  it('白名单默认值与职责 yml 那一份是同一批域名', () => {
    expect(FORUM_HOSTS).toContain('*.quora.com')
    expect(FORUM_HOSTS).toContain('*.zhihu.com')
    expect(searchScript({ site: 'www.quora.com', query: 'x', limit: 5 }).writes).toBe(false)
  })
})

describe('Alerts：RSS 与 Reddit 搜索', () => {
  const FEED = 'https://www.google.com/alerts/feeds/123/456'
  const atom = `<?xml version="1.0"?><feed>
    <entry>
      <title type="html">&lt;b&gt;Nordvolt&lt;/b&gt; 发布新品</title>
      <link href="https://www.google.com/url?rct=j&amp;url=https://techpress.example/a&amp;ct=ga"/>
      <published>2026-09-17T08:00:00Z</published>
      <content type="html">新机型 &lt;b&gt;续航&lt;/b&gt; 提升</content>
    </entry>
  </feed>`

  it('真实地址从 google.com/url 里拆出来', () => {
    expect(unwrapAlertLink('https://www.google.com/url?url=https://x.example/a&ct=ga')).toBe(
      'https://x.example/a',
    )
    expect(unwrapAlertLink('not a url')).toBe('not a url')
  })

  it('去标签解实体，一个字不改写', () => {
    expect(stripHtml('<b>Nordvolt</b> &amp; 朋友')).toBe('Nordvolt & 朋友')
  })

  it('解出来的条目带着来源、时刻与去重键', () => {
    const rows = parseAlertsFeed(atom, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.origin).toBe('techpress.example')
    expect(rows[0]?.source).toBe('news')
    expect(rows[0]?.title).toBe('Nordvolt 发布新品')
    expect(rows[0]?.dedupe_key.startsWith('url:')).toBe(true)
  })

  it('没填 feed 地址 → 说"还没连"，不是空数组', async () => {
    const res = await fetchGoogleAlerts(
      { fetch: async () => ({ ok: true, status: 200, text: async () => '' }), now: () => NOW },
      { feed_url: '' },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not_connected')
  })

  it('地址不像 Google Alerts 的 feed → 当场说清楚该去哪儿复制', async () => {
    const res = await fetchGoogleAlerts(
      { fetch: async () => ({ ok: true, status: 200, text: async () => '' }), now: () => NOW },
      { feed_url: 'https://example.com/rss' },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('Google Alerts')
  })

  it('404 → 说这条提醒不存在（不是"今天没人提我们"）', async () => {
    const res = await fetchGoogleAlerts(
      { fetch: async () => ({ ok: false, status: 404, text: async () => '' }), now: () => NOW },
      { feed_url: FEED },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(404)
  })

  it('回来的不是 feed → 照实说，**不当成 0 条**', async () => {
    const res = await fetchGoogleAlerts(
      {
        fetch: async () => ({ ok: true, status: 200, text: async () => '<html>登录</html>' }),
        now: () => NOW,
      },
      { feed_url: FEED },
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('一个 entry 都没有')
  })

  it('真 feed 拉得回来', async () => {
    const res = await fetchGoogleAlerts(
      { fetch: async () => ({ ok: true, status: 200, text: async () => atom }), now: () => NOW },
      { feed_url: FEED },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toHaveLength(1)
  })

  it('Reddit 全站搜：没连就说没连；连上了带回版名与时刻', async () => {
    const off = transport(() => ({ ok: true, status: 200, body: '{}' }), false)
    expect((await searchRedditMentions(off, { query: 'Nordvolt' })).ok).toBe(false)

    const on = transport(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({
        data: {
          children: [
            {
              data: {
                title: '有人用过 Nordvolt 吗',
                selftext: '求推荐',
                author: 'linaw',
                subreddit: 'gadgets',
                permalink: '/r/gadgets/comments/1/x/',
                created_utc: 1_758_096_000,
              },
            },
          ],
        },
      }),
    }))
    const res = await searchRedditMentions(on, { query: 'Nordvolt' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data[0]?.origin).toBe('r/gadgets')
    expect(on.calls[0]).toContain('https://oauth.reddit.com/search?q=Nordvolt')
  })

  it('Reddit 401 → 说授权掉了或 UA 写错了（这条渠道最常见的那两件事）', async () => {
    const t = transport(() => ({ ok: false, status: 401, body: '' }))
    const res = await searchRedditMentions(t, { query: 'x' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.message).toContain('User-Agent')
  })
})
