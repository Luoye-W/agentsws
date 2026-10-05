/**
 * WP220：研究技能的取数层与产出。上游全用替身（不联网、不花钱）。
 *
 * 钉住 Luoye 10-05 的 Reddit 两路取数：①接口中台 → ②浏览器只读；按顺序回退、每品牌可调顺序与停用、
 * 浏览器那一路只读 + 限速 + 单独的只读会话（绝不用品牌发帖会话）、每次取数记来源、两路都不行照实说。
 */
import type {
  DataSourceRoute,
  RedditBrowserReadLimits,
  ResearchFetchRecord,
} from '@agentsws/contracts'
import {
  DATA_CAPABILITY_CATALOG,
  DEFAULT_REDDIT_BROWSER_READ_LIMITS,
  DEFAULT_REDDIT_READ_ORDER,
  RESEARCH_FETCH_ROUTES,
} from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type BrowserAction,
  buildResearchReport,
  coverageOf,
  createRedditReadRouter,
  pendingResearchCapabilities,
  primaryEntityHead,
  type RankedItem,
  RESEARCH_SOURCES,
  type ReadBrowserSessionKind,
  type RedditHubResult,
  type ResearchItem,
  rankTrendItems,
  readSessionKindOf,
  redditReadScript,
  renderResearchReport,
  researchCards,
  researchSourceAllowed,
  researchSourceReady,
  scoreOutliers,
} from '../src/index.js'

const NOW = '2026-10-05T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function hubStandIn(result: RedditHubResult) {
  const calls: { capability: string; input: Record<string, unknown> }[] = []
  return {
    calls,
    async call(capability: string, input: Record<string, unknown>) {
      calls.push({ capability, input })
      return result
    },
  }
}

function browserStandIn(kind: ReadBrowserSessionKind = 'readonly_isolated') {
  const opened: BrowserAction[] = []
  return {
    opened,
    session: () => ({ kind, id: `s-${kind}` }),
    async run(action: BrowserAction) {
      opened.push(action)
      return {
        status: 'ok' as const,
        items: [
          {
            url: '/r/augmentedreality/comments/abc/inmo_air3/',
            title: 'INMO Air3 after a week',
            subreddit: 'r/augmentedreality',
            score: 120,
            num_comments: 45,
            created_utc: NOW_MS / 1000 - 3600,
          },
        ],
      }
    },
  }
}

function router(opts: {
  route?: DataSourceRoute
  hub?: ReturnType<typeof hubStandIn>
  browser?: ReturnType<typeof browserStandIn>
  limits?: RedditBrowserReadLimits
  clock?: { ms: number }
}) {
  const records: ResearchFetchRecord[] = []
  const clock = opts.clock ?? { ms: NOW_MS }
  const r = createRedditReadRouter({
    route: () => opts.route ?? { order: [...DEFAULT_REDDIT_READ_ORDER], disabled: [] },
    limits: () => opts.limits ?? DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    ...(opts.hub === undefined ? {} : { hub: opts.hub }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    nowMs: () => clock.ms,
    onRecord: (rec) => records.push(rec),
  })
  return { r, records, clock }
}

const SEARCH = {
  capability: 'social.reddit.search' as const,
  input: { query: 'INMO', time_window: 'week' },
}

describe('研究取数白名单', () => {
  it('只有五种取数方式；表里每一行都在这五种里', () => {
    for (const s of RESEARCH_SOURCES) expect(RESEARCH_FETCH_ROUTES).toContain(s.route)
  })

  it('不在表里的取数方式不许（直接抓、第三方抓取服务都不在）', () => {
    expect(researchSourceAllowed('web_search', 'web.search')).toBe(true)
    expect(researchSourceAllowed('browser_readonly', 'reddit.read')).toBe(true)
    expect(researchSourceAllowed('workshop', 'social.reddit.search')).toBe(true)
    expect(researchSourceAllowed('web_fetch', 'reddit.json')).toBe(false)
    expect(researchSourceAllowed('browser_readonly', 'x.timeline')).toBe(false)
    expect(researchSourceAllowed('official_api', 'scrapecreators')).toBe(false)
    // 浏览器只读那一路只给 Reddit
    expect(
      RESEARCH_SOURCES.filter((s) => s.route === 'browser_readonly').map((s) => s.platform),
    ).toEqual(['reddit'])
  })

  it('待接清单：接口中台那几项里，除了 Reddit 三项（契约已加、云端待接），都还不在能力目录里', () => {
    const pending = pendingResearchCapabilities()
    expect(pending.length).toBeGreaterThan(5)
    const catalog = new Set(DATA_CAPABILITY_CATALOG.map((c) => c.id))
    for (const p of pending.filter((x) => x.route === 'workshop')) {
      if (p.capability.startsWith('social.reddit.')) expect(catalog.has(p.capability)).toBe(true)
      else expect(catalog.has(p.capability), p.capability).toBe(false)
    }
    expect(researchSourceReady('workshop', 'social.reddit.search')).toBe(false)
    expect(researchSourceReady('workshop', 'social.tiktok.posts')).toBe(true)
  })
})

describe('Reddit 两路取数', () => {
  it('默认先走接口中台；成了就不碰浏览器；记来源与是否命中缓存', async () => {
    const hub = hubStandIn({
      ok: true,
      items: [{ url: 'https://www.reddit.com/r/a/comments/1/x/', title: 'INMO', score: 3 }],
      cached: true,
      credits: 0.4,
      fetched_at: NOW,
    })
    const browser = browserStandIn()
    const { r, records } = router({ hub, browser })
    const got = await r.read(SEARCH)
    expect(got.ok).toBe(true)
    expect(browser.opened).toHaveLength(0)
    expect(hub.calls[0]?.capability).toBe('social.reddit.search')
    expect(got.record).toMatchObject({ route: 'workshop', cached: true, items: 1, credits: 0.4 })
    expect(records).toHaveLength(1)
  })

  it('接口中台没开通 → 自动落浏览器只读；记录里两路都写着', async () => {
    const hub = hubStandIn({
      ok: false,
      reason: 'not_configured',
      message: '这项能力现在没有开通。',
    })
    const browser = browserStandIn()
    const { r } = router({ hub, browser })
    const got = await r.read(SEARCH)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.record.route).toBe('browser_readonly')
    expect(got.record.cached).toBe(false)
    expect(got.record.attempts.map((a) => [a.route, a.outcome])).toEqual([
      ['workshop', 'not_configured'],
      ['browser_readonly', 'ok'],
    ])
    expect(got.items[0]).toMatchObject({
      kind: 'post',
      url: 'https://www.reddit.com/r/augmentedreality/comments/abc/inmo_air3/',
      subreddit: 'augmentedreality',
      score: 120,
      comments: 45,
    })
  })

  it('接口中台报错也回退（花钱 → 不花钱的方向）', async () => {
    const hub = hubStandIn({ ok: false, reason: 'failed', message: '上游超时' })
    const { r } = router({ hub, browser: browserStandIn() })
    const got = await r.read(SEARCH)
    expect(got.record.attempts[0]).toMatchObject({ outcome: 'failed', message: '上游超时' })
    expect(got.record.route).toBe('browser_readonly')
  })

  it('品牌可以调顺序：浏览器在前就先走浏览器，接口中台一次都不调', async () => {
    const hub = hubStandIn({ ok: true, items: [], cached: false, credits: 0, fetched_at: NOW })
    const { r } = router({
      hub,
      browser: browserStandIn(),
      route: { order: ['browser_readonly', 'workshop'], disabled: [] },
    })
    const got = await r.read(SEARCH)
    expect(got.record.route).toBe('browser_readonly')
    expect(hub.calls).toHaveLength(0)
  })

  it('品牌可以停用一路：停了浏览器，接口中台不行就照实说没取到——不抛、不当成 0 条', async () => {
    const hub = hubStandIn({ ok: false, reason: 'not_configured', message: '还没关联账号。' })
    const browser = browserStandIn()
    const { r, records } = router({
      hub,
      browser,
      route: { order: ['workshop', 'browser_readonly'], disabled: ['browser_readonly'] },
    })
    const got = await r.read(SEARCH)
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(browser.opened).toHaveLength(0)
    expect(got.record.route).toBe('none')
    expect(got.record.attempts.map((a) => a.outcome)).toEqual(['not_configured', 'disabled'])
    expect(got.message).toContain('这不等于没人在聊')
    expect(records[0]?.route).toBe('none')
  })

  it('两路都没配（没关联、没浏览器）：照实说，不抛', async () => {
    const { r } = router({})
    const got = await r.read(SEARCH)
    expect(got.ok).toBe(false)
    expect(got.record.attempts.map((a) => a.outcome)).toEqual(['not_configured', 'not_configured'])
  })

  it('绝不用品牌发帖账号的会话、也不用人自己的浏览器；只认单独的只读会话', async () => {
    for (const kind of ['brand_posting', 'user_attached'] as const) {
      const browser = browserStandIn(kind)
      const { r } = router({ browser })
      const got = await r.read(SEARCH)
      expect(got.ok).toBe(false)
      expect(browser.opened).toHaveLength(0)
      expect(got.record.attempts.at(-1)).toMatchObject({
        route: 'browser_readonly',
        outcome: 'session_refused',
      })
    }
    expect(readSessionKindOf({ mode: 'launch' })).toBe('readonly_isolated')
    expect(readSessionKindOf({ mode: 'attach', endpoint: 'http://127.0.0.1:9333' })).toBe(
      'user_attached',
    )
  })

  it('浏览器那一路只读、只开 Reddit 的页面', () => {
    for (const req of [
      SEARCH,
      { capability: 'social.reddit.search' as const, input: { query: 'INMO', subreddit: 'r/Foo' } },
      { capability: 'social.reddit.posts' as const, input: { subreddit: 'augmentedreality' } },
      {
        capability: 'social.reddit.comments' as const,
        input: { post_url: 'https://www.reddit.com/r/a/comments/1/x/' },
      },
    ]) {
      const s = redditReadScript(req)
      expect(s.writes).toBe(false)
      expect(new URL(s.url).hostname.endsWith('reddit.com')).toBe(true)
      expect(s.steps[0]).toContain('只读')
    }
  })

  it('不是 Reddit 的地址不开（评论那一项给了别的站）', async () => {
    const browser = browserStandIn()
    const { r } = router({ browser })
    const got = await r.read({
      capability: 'social.reddit.comments',
      input: { post_url: 'https://evil.example.com/r/a' },
    })
    expect(got.ok).toBe(false)
    expect(browser.opened).toHaveLength(0)
  })

  it('限速：两页之间不到设置的秒数就不开；一小时上限到了也不开；时间过了又能开', async () => {
    const browser = browserStandIn()
    const clock = { ms: NOW_MS }
    const { r } = router({
      browser,
      clock,
      limits: { min_interval_seconds: 20, max_pages_per_hour: 2, max_pages_per_day: 200 },
    })
    expect((await r.read(SEARCH)).ok).toBe(true)
    const tooSoon = await r.read(SEARCH)
    expect(tooSoon.ok).toBe(false)
    expect(tooSoon.record.attempts.at(-1)?.outcome).toBe('rate_limited')
    clock.ms += 21_000
    expect((await r.read(SEARCH)).ok).toBe(true)
    clock.ms += 21_000
    const hourly = await r.read(SEARCH)
    expect(hourly.record.attempts.at(-1)?.message).toContain('这一小时')
    clock.ms += 3_600_000
    expect((await r.read(SEARCH)).ok).toBe(true)
    expect(browser.opened).toHaveLength(3)
  })
})

function item(p: Partial<ResearchItem> & { url: string }): ResearchItem {
  return { platform: 'reddit', route: 'browser_readonly', ...p }
}

describe('最近 N 天在聊什么（排序）', () => {
  it('主体：去掉意图词取第一个词', () => {
    expect(primaryEntityHead('INMO reddit 这周')).toBe('inmo')
    expect(primaryEntityHead('review Xreal One')).toBe('xreal')
  })

  it('窗外丢掉、同一条合并并计「另见几处」、跑题的重罚、一个作者最多三条', () => {
    const items: ResearchItem[] = [
      item({
        url: 'https://www.reddit.com/r/a/comments/1/x/?utm_source=x',
        title: 'INMO Air3 review',
        published_at: '2026-10-04T12:00:00Z',
        engagement: { score: 50 },
      }),
      item({
        url: 'https://old.reddit.com/r/a/comments/1/x',
        title: 'INMO Air3 review',
        published_at: '2026-10-04T12:00:00Z',
        engagement: { score: 50, comments: 10 },
      }),
      item({
        url: 'https://www.reddit.com/r/a/comments/2/y/',
        title: 'Old INMO thread',
        published_at: '2026-06-01T00:00:00Z',
      }),
      item({
        url: 'https://www.reddit.com/r/a/comments/3/z/',
        title: 'Best smart glasses viral thread',
        published_at: '2026-10-04T00:00:00Z',
        engagement: { score: 5000 },
      }),
      ...[4, 5, 6, 7].map((n) =>
        item({
          url: `https://x.com/u/status/${n}`,
          platform: 'x',
          route: 'official_api',
          author: 'Spammy',
          title: `INMO post ${n}`,
          published_at: '2026-10-03T00:00:00Z',
        }),
      ),
    ]
    const res = rankTrendItems(items, { topic: 'INMO 这周', now: NOW, window_days: 30 })
    expect(res.out_of_window).toBe(1)
    expect(res.duplicates).toBe(1)
    const merged = res.ranked.find((r) => r.item.title === 'INMO Air3 review')
    expect(merged?.seen_count).toBe(2)
    expect(merged?.item.engagement?.comments).toBe(10)
    const viral = res.ranked.find((r) => r.item.title?.startsWith('Best'))
    expect(viral?.entity_miss).toBe(true)
    expect(res.ranked[0]?.item.title).toBe('INMO Air3 review')
    expect(res.ranked.filter((r) => r.item.author === 'Spammy')).toHaveLength(3)
  })
})

describe('爆款帖（跟账号自己的中位数比）', () => {
  it('中位数做基线；5 倍大爆、2 倍明显、1.5 倍小爆；样本不到 10 条置信低', () => {
    const posts = [100, 100, 100, 120, 80, 900, 250, 160].map((views, i) => ({
      platform: 'tiktok',
      account: 'rival',
      url: `https://www.tiktok.com/@rival/video/${i}`,
      format: 'short_video',
      views,
    }))
    const [g] = scoreOutliers(posts)
    expect(g?.baseline).toBe(110)
    expect(g?.metric).toBe('views')
    expect(g?.confidence).toBe('low')
    expect(g?.posts.map((p) => p.tier ?? '-')).toEqual([
      'huge',
      'strong',
      'mild',
      '-',
      '-',
      '-',
      '-',
      '-',
    ])
  })

  it('不同账号、不同平台各算各的，不混在一起', () => {
    const groups = scoreOutliers([
      { platform: 'tiktok', account: 'big', url: 'a', views: 1_000_000 },
      { platform: 'tiktok', account: 'small', url: 'b', views: 1000 },
      { platform: 'instagram', account: 'small', url: 'c', likes: 10, comments: 2 },
    ])
    expect(groups).toHaveLength(3)
    expect(groups.find((g) => g.platform === 'instagram')?.metric).toBe('engagement')
  })
})

function ranked(
  p: Partial<ResearchItem> & { url: string },
  extra: Partial<RankedItem> = {},
): RankedItem {
  return { item: item(p), score: 50, entity_miss: false, seen_count: 1, ...extra }
}

describe('报告与进卡片流的建议', () => {
  it('每个平台一行：取到的写哪一路、命中缓存没有；没取到写原因并说「不等于没人在聊」；0 条另说', () => {
    const lines = coverageOf([
      {
        platform: 'reddit',
        capability: 'social.reddit.search',
        route: 'workshop',
        cached: true,
        fetched_at: NOW,
        items: 12,
        attempts: [],
      },
      {
        platform: 'x',
        capability: 'x_api',
        route: 'none',
        cached: false,
        fetched_at: NOW,
        items: 0,
        attempts: [{ route: 'official_api', outcome: 'not_configured', message: '品牌没连 X' }],
      },
      {
        platform: 'youtube',
        capability: 'youtube_data',
        route: 'official_api',
        cached: false,
        fetched_at: NOW,
        items: 0,
        attempts: [],
      },
    ])
    expect(lines.map((l) => l.status)).toEqual(['ok', 'missing', 'empty'])
    expect(lines[0]?.line).toBe('Reddit：接口中台（命中缓存），12 条。')
    expect(lines[1]?.line).toContain('品牌没连 X')
    expect(lines[1]?.line).toContain('这不等于没人在聊')
  })

  it('卡：负面且有人在看 → 值得回应；跑得快 → 在扩散；正面不出；最多三张', () => {
    const rows: RankedItem[] = [
      ranked({
        url: 'u1',
        topic: '续航',
        sentiment: 'negative',
        platform: 'reddit',
        engagement: { score: 30 },
      }),
      ranked({
        url: 'u2',
        topic: '续航',
        sentiment: 'negative',
        platform: 'x',
        engagement: { likes: 4 },
      }),
      ranked(
        { url: 'u3', topic: '好评', sentiment: 'positive', engagement: { score: 900 } },
        { velocity: 400 },
      ),
      ranked(
        { url: 'u4', topic: '发热', sentiment: 'negative', engagement: { score: 300 } },
        { velocity: 120 },
      ),
      ranked({ url: 'u5', topic: '零星', sentiment: 'negative', engagement: { score: 2 } }),
      ...[1, 2, 3].map((n) =>
        ranked({ url: `v${n}`, sentiment: 'neutral', engagement: { score: 1 } }, { velocity: 1 }),
      ),
    ]
    const cards = researchCards(rows)
    expect(cards.length).toBeLessThanOrEqual(3)
    expect(cards.map((c) => c.kind).sort()).toEqual(['spreading', 'worth_responding'])
    expect(cards.some((c) => c.evidence.some((e) => e.url === 'u3'))).toBe(false)
    expect(cards.some((c) => c.evidence.some((e) => e.url === 'u5'))).toBe(false)
    const respond = cards.find((c) => c.kind === 'worth_responding')
    expect(respond?.evidence.map((e) => e.url)).toEqual(['u1', 'u2'])
  })

  it('按话题 / 情绪 / 平台分组；正文里每条带链接、平台、日期、来自哪一路', () => {
    const report = buildResearchReport({
      topic: 'INMO',
      window_days: 7,
      now: NOW,
      ranked: [
        ranked({
          url: 'https://www.reddit.com/r/a/1',
          title: '续航只有两小时',
          topic: '续航',
          sentiment: 'negative',
          published_at: '2026-10-03T00:00:00Z',
        }),
        ranked({
          url: 'https://example.com/news',
          platform: 'web',
          route: 'web_search',
          title: '新品发布',
          topic: '新品',
        }),
      ],
      records: [],
    })
    expect(report.by_sentiment.negative).toBe(1)
    expect(report.by_sentiment.unclear).toBe(1)
    expect(report.by_platform).toEqual({ reddit: 1, web: 1 })
    const md = renderResearchReport(report)
    expect(md).toContain(
      '[续航只有两小时](https://www.reddit.com/r/a/1) · Reddit · 2026-10-03 · 负面 · 来自浏览器只读',
    )
    expect(md).toContain('时间不明')
    expect(md).toContain('来自官方网页搜索')
  })
})
