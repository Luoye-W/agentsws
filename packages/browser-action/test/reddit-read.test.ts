import { describe, expect, it, vi } from 'vitest'
import {
  checkRedditReadRequest,
  checkRedditReadUrl,
  normalizeSubreddit,
  Pace,
  parseRedditListing,
  REDDIT_PACE_LIMITS,
  REDDIT_READ_GAP_MS,
  type RedditReadJob,
  redditPaceKey,
  redditReadUrl,
  runRedditRead,
} from '../src/index.js'
import { fakeReddit, listing, t1, t3 } from './reddit-fakes.js'

const job = (over: Partial<RedditReadJob> = {}): RedditReadJob => ({
  id: 'rj_1',
  workspace_id: 'ws_1',
  title: '每日巡查',
  created_at: '2026-10-14T01:00:00.000Z',
  reads: [{ key: 'inbox', kind: 'inbox', max_pages: 2 }],
  ...over,
})
const deps = (f: { fetch: (u: string) => Promise<never> | Promise<unknown> }) => ({
  fetch: f.fetch as never,
  sleep: vi.fn(async () => {}),
  stopped: () => false,
})

describe('地址白名单（只读、不改已读）', () => {
  it('收件箱一律带 mark=false', () => {
    const url = redditReadUrl({ key: 'inbox', kind: 'inbox', max_pages: 1 })
    expect(new URL(url).searchParams.get('mark')).toBe('false')
    expect(checkRedditReadUrl(url)).toBeUndefined()
  })
  it('拒：不带 mark=false 的收件箱、别的站、写接口、不是 .json', () => {
    expect(checkRedditReadUrl('https://old.reddit.com/message/inbox/.json')).toContain('mark=false')
    expect(checkRedditReadUrl('https://evil.example/r/ivraxr/new/.json')).toBeDefined()
    expect(checkRedditReadUrl('https://old.reddit.com/api/comment')).toBeDefined()
    expect(checkRedditReadUrl('https://old.reddit.com/r/ivraxr/new/')).toBeDefined()
    expect(
      checkRedditReadUrl('https://old.reddit.com/message/unread/.json?mark=false'),
    ).toBeDefined()
  })
  it('版块名规范化；请求合不合法', () => {
    expect(normalizeSubreddit('r/ivraxr')).toBe('ivraxr')
    expect(normalizeSubreddit('https://www.reddit.com/r/IvraXR/new')).toBe('IvraXR')
    expect(normalizeSubreddit('r/a b')).toBeUndefined()
    expect(
      checkRedditReadRequest({ key: 's', kind: 'sub_new', subreddit: 'x', max_pages: 1 }),
    ).toBeDefined()
    expect(
      checkRedditReadRequest({ key: 's', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 9 }),
    ).toBeDefined()
    expect(
      checkRedditReadRequest({
        key: 's',
        kind: 'sub_new',
        subreddit: 'ivraxr',
        max_pages: 2,
        stop_at: 'bad',
      }),
    ).toBeDefined()
  })
})

describe('解析', () => {
  it('收件箱：评论回复 / 私信 / 被删的', () => {
    const page = parseRedditListing(
      listing([
        t1('c1', { type: 'comment_reply', context: '/r/ivraxr/comments/p1/x/c1/?context=3' }),
        {
          kind: 't4',
          data: {
            id: 'm1',
            name: 't4_m1',
            author: 'carol',
            subject: 'hi',
            body: 'yo',
            created_utc: 1,
          },
        },
        t1('c2', { type: 'username_mention', body: '[deleted]', author: '[deleted]' }),
        { kind: 'more', data: { children: [] } },
      ]),
      true,
    )
    expect(page?.items.map((i) => [i.name, i.kind, i.inbox_type])).toEqual([
      ['t1_c1', 'comment', 'comment_reply'],
      ['t4_m1', 'message', 'message'],
      ['t1_c2', 'comment', 'username_mention'],
    ])
    expect(page?.items[0]?.url).toBe('https://www.reddit.com/r/ivraxr/comments/p1/x/c1/?context=3')
    expect(page?.items[2]).toMatchObject({ deleted: true, text: '' })
    expect(page?.items[2]?.author).toBeUndefined()
  })
  it('某帖评论：两页数组、评论树平铺', () => {
    const reply = t1('c2')
    const parent = t1('c1', { replies: listing([reply]) })
    const page = parseRedditListing([listing([t3('p1')]), listing([parent])])
    expect(page?.items.map((i) => i.name)).toEqual(['t3_p1', 't1_c1', 't1_c2'])
  })
  it('认不出的回 undefined', () => {
    expect(parseRedditListing({ error: 403 })).toBeUndefined()
  })
})

describe('跑一件只读活', () => {
  it('没登录：一条都不读，回 not_logged_in', async () => {
    const f = fakeReddit({})
    const out = await runRedditRead(job(), deps(f))
    expect(out.outcome).toBe('not_logged_in')
    expect(f.calls).toHaveLength(1)
  })
  it('登着的不是品牌号：一条都不读', async () => {
    const f = fakeReddit({}, { user: 'my_personal' })
    const out = await runRedditRead(job({ expect_user: 'u/IVRA_Official' }), deps(f))
    expect(out.outcome).toBe('wrong_user')
    expect(f.calls).toHaveLength(1)
  })
  it('读到上次那一条就停；翻页；固定间隔、没有随机数', async () => {
    const rnd = vi.spyOn(Math, 'random')
    const f = fakeReddit(
      {
        '/message/inbox/.json?mark=false': listing([t1('c3'), t1('c2')], 't1_c2'),
        '/message/inbox/.json?after=t1_c2&mark=false': listing([t1('c1'), t1('c0')]),
      },
      { user: 'ivra_official' },
    )
    const d = deps(f)
    const out = await runRedditRead(
      job({
        expect_user: 'IVRA_Official',
        reads: [{ key: 'inbox', kind: 'inbox', stop_at: 't1_c1', max_pages: 3 }],
      }),
      d,
    )
    expect(out.outcome).toBe('done')
    expect(out.user).toBe('ivra_official')
    expect(out.parts[0]?.items.map((i) => i.name)).toEqual(['t1_c3', 't1_c2'])
    expect(out.parts[0]).toMatchObject({ ok: true, pages: 2, reached_stop: true })
    expect(d.sleep.mock.calls.every(([ms]) => ms === REDDIT_READ_GAP_MS)).toBe(true)
    expect(rnd).not.toHaveBeenCalled()
    rnd.mockRestore()
  })
  it('一个版块 404：这一路记失败，别的照读', async () => {
    const f = fakeReddit({ '/r/ivraxr/new/.json': listing([t3('p2')]) }, { user: 'ivra_official' })
    const out = await runRedditRead(
      job({
        reads: [
          { key: 'sub_new:gone', kind: 'sub_new', subreddit: 'gone_sub', max_pages: 1 },
          { key: 'sub_new:ivraxr', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 1 },
        ],
      }),
      deps(f),
    )
    expect(out.outcome).toBe('done')
    expect(out.parts[0]).toMatchObject({ ok: false })
    expect(out.parts[1]?.items.map((i) => i.name)).toEqual(['t3_p2'])
  })
  it('被限速：整件停下，已经读到的照样交回', async () => {
    const f = fakeReddit(
      {
        '/message/inbox/.json?mark=false': listing([t1('c9')]),
        '/r/ivraxr/new/.json': {
          status: 429,
          url: 'https://old.reddit.com/r/ivraxr/new/.json',
          content_type: 'text/html',
          body: 'Too Many Requests',
        },
      },
      { user: 'ivra_official' },
    )
    const out = await runRedditRead(
      job({
        reads: [
          { key: 'inbox', kind: 'inbox', max_pages: 1 },
          { key: 'sub_new:ivraxr', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 1 },
          { key: 'sub_comments:ivraxr', kind: 'sub_comments', subreddit: 'ivraxr', max_pages: 1 },
        ],
      }),
      deps(f),
    )
    expect(out.outcome).toBe('blocked')
    expect(out.parts).toHaveLength(2)
    expect(out.parts[0]?.items).toHaveLength(1)
    expect(f.calls.some((u) => u.includes('/comments/.json'))).toBe(false)
  })
  it('读到一半被跳到登录页：not_logged_in', async () => {
    const f = fakeReddit(
      {
        '/message/inbox/.json?mark=false': {
          status: 200,
          url: 'https://old.reddit.com/login/?dest=x',
          content_type: 'text/html',
          body: '<form>',
        },
      },
      { user: 'ivra_official' },
    )
    const out = await runRedditRead(job(), deps(f))
    expect(out.outcome).toBe('not_logged_in')
  })
  it('第一次读：比 since_utc 早的不要', async () => {
    const f = fakeReddit(
      {
        '/r/ivraxr/new/.json': listing(
          [t3('p3', { created_utc: 200 }), t3('p2', { created_utc: 50 })],
          't3_p2',
        ),
      },
      { user: 'ivra_official' },
    )
    const out = await runRedditRead(
      job({
        reads: [{ key: 'n', kind: 'sub_new', subreddit: 'ivraxr', since_utc: 100, max_pages: 3 }],
      }),
      deps(f),
    )
    expect(out.parts[0]?.items.map((i) => i.name)).toEqual(['t3_p3'])
    expect(f.calls).toHaveLength(2)
  })
})

describe('Reddit 号的节奏（与 WP329 写共用一本账）', () => {
  it('键；一次一件；读到上限', () => {
    expect(redditPaceKey('u/IVRA_Official', 'ws_1')).toBe('reddit:ivra_official')
    expect(redditPaceKey(undefined, 'ws_1')).toBe('reddit:ws:ws_1')
    const pace = new Pace({ limits: { ...REDDIT_PACE_LIMITS, reads_per_day: 1 } })
    const key = redditPaceKey('ivra', 'ws')
    expect(pace.beginKey(key, 'read', 'a', 0)).toEqual({ ok: true })
    expect(pace.checkKey(key, 'write', 0)).toMatchObject({ ok: false, reason: 'busy' })
    pace.endKey(key, 'a')
    const v = pace.checkKey(key, 'read', 0)
    expect(v).toMatchObject({ ok: false, reason: 'daily_cap' })
    expect(v.ok ? '' : v.why).toContain('Reddit 号')
    expect(pace.leftKey(key, 0)).toEqual({ writes: 20, reads: 0 })
  })
})
