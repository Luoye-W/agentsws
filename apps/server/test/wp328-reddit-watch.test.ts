/**
 * WP328：Reddit 每日巡查（服务那一侧）。替身 Reddit（本地假 JSON，经 browser-action 的真执行器跑）、
 * 替身插件（直接调 next / result）、替身数据渠道；不打开真 Reddit、不联网。
 */
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { ConnectNeed, RedditWatchEntry, RedditWatchRun } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  createRedditWatch,
  createRedditWatchStore,
  keywordHit,
  type RedditWatchOptions,
  redditWatchSourceOf,
  topicKey,
} from '../src/reddit-watch/index.js'
import { JUDGE_BATCH, judgeItems, judgeMessages, judgePrompt } from '../src/reddit-watch/judge.js'

const t = (id: string, kind: 't1' | 't3', over: Record<string, unknown> = {}) => ({
  kind,
  data: {
    id,
    name: `${kind}_${id}`,
    author: 'alice',
    subreddit: 'ivraxr',
    created_utc: Date.parse('2026-10-14T00:00:00Z') / 1000,
    ...(kind === 't3' ? { title: `post ${id}`, selftext: 'love my Air3' } : { body: `c ${id}` }),
    permalink: `/r/ivraxr/comments/p1/x/${id}/`,
    ...over,
  },
})
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })

/** 替身 Reddit：地址（去掉 limit / raw_json，参数排序）→ JSON。 */
function fakeReddit(routes: Record<string, unknown>, user?: string) {
  const calls: string[] = []
  const fetch = async (url: string): Promise<RedditFetched> => {
    calls.push(url)
    const u = new URL(url)
    for (const k of ['limit', 'raw_json', 'after', 'sort']) u.searchParams.delete(k)
    u.searchParams.sort()
    const key = `${u.pathname}${u.search}`
    const body =
      u.pathname === '/api/me.json'
        ? user === undefined
          ? {}
          : { kind: 't2', data: { name: user } }
        : routes[key]
    return body === undefined
      ? { status: 404, url, content_type: 'application/json', body: '{}' }
      : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
  }
  return { fetch, calls }
}

const ACTOR = { person_id: 'p1', assignment_id: 'as1', role_id: 'social.reddit' } as never

function setup(over: Partial<RedditWatchOptions> = {}, start = '2026-10-14T02:00:00.000Z') {
  let now = start
  let n = 0
  const store = createRedditWatchStore()
  const connects: ConnectNeed[][] = []
  const setups: string[] = []
  const cards = {
    askConnect: vi.fn(async (i: { needs: ConnectNeed[] }) => {
      connects.push(i.needs)
      return undefined
    }),
    askSetup: vi.fn(async (i: { target: string }) => {
      setups.push(i.target)
      return undefined
    }),
  }
  const followUps: string[] = []
  const deleted: string[] = []
  const outbound = {
    addFollowUp: vi.fn((_ws: string, i: { parent_external_id: string }) => {
      followUps.push(i.parent_external_id)
      return i.parent_external_id === 't1_ours' ? ({ id: 'ob_1' } as never) : undefined
    }),
    counterpartDeleted: vi.fn((_ws: string, id: string) => {
      deleted.push(id)
      return 1
    }),
  }
  const watch = createRedditWatch({
    workspace_id: 'ws_1' as never,
    store,
    now: () => now,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'IVRA',
    setupCards: async () => cards as never,
    actor: () => ACTOR,
    outbound: () => outbound as never,
    ...over,
  })
  return {
    watch,
    store,
    connects,
    setups,
    followUps,
    deleted,
    setNow: (v: string) => {
      now = v
    },
  }
}

/** 替身插件：领活 → 用真执行器读替身 Reddit → 交回。 */
async function extensionRound(
  w: ReturnType<typeof setup>['watch'],
  reddit: ReturnType<typeof fakeReddit>,
): Promise<boolean> {
  const got = w.next({ connected: true })
  if (got.job === undefined) return false
  const res = await runRedditRead(got.job, {
    fetch: reddit.fetch,
    sleep: async () => {},
    stopped: () => false,
    gapMs: 0,
  })
  expect(await w.result(got.job.id, res)).toEqual({ accepted: true })
  return true
}

const SEARCH = vi.fn(async (i: { query: string }) => ({
  ok: true as const,
  items: [
    {
      kind: 'post' as const,
      url: 'https://www.reddit.com/r/smartglasses/comments/aa1/x/',
      id: 'aa1',
      title: `${i.query} vs Xreal?`,
      text: 'which one',
      subreddit: 'smartglasses',
      author: 'zed',
      created_at: '2026-10-13T10:00:00.000Z',
    },
    {
      kind: 'post' as const,
      url: 'https://www.reddit.com/r/realestate/comments/aa2/x/',
      id: 'aa2',
      title: 'ivrabiliaria tips',
      text: 'casa',
      subreddit: 'realestate',
      created_at: '2026-10-13T11:00:00.000Z',
    },
    {
      kind: 'post' as const,
      url: 'https://www.reddit.com/r/ivraxr/comments/aa3/x/',
      id: 'aa3',
      title: 'own sub',
      text: 'x',
      subreddit: 'ivraxr',
    },
  ],
}))

describe('关键词命中（拉丁字母按整词）', () => {
  it('IVRA 不撞 ivrabiliaria；中文按包含', () => {
    expect(keywordHit('IVRA Air3 is great', 'ivra')).toBe(true)
    expect(keywordHit('ivrabiliaria tips', 'IVRA')).toBe(false)
    expect(keywordHit('艾维眼镜', '艾维')).toBe(true)
  })
})

describe('缺设置 / 缺连接：出卡（一天最多一次）', () => {
  it('没配版块和关键词：出配置卡，不巡查', async () => {
    const s = setup()
    expect(await s.watch.tick()).toMatchObject({ ran: false, skipped: 'needs_setup' })
    await s.watch.tick()
    expect(s.setups).toEqual(['reddit.watch'])
  })
  it('插件没配对：收件箱 / 自家版块出连接卡；外部社区照搜', async () => {
    const s = setup({ search: SEARCH })
    s.watch.updateSettings({ own_subreddits: ['r/ivraxr'], keywords: ['IVRA'] })
    const run = await s.watch.runNow()
    expect(run.parts.map((p) => `${p.part}:${p.status}`)).toEqual([
      'inbox:needs_connection',
      'own_sub:needs_connection',
      'external:ok',
    ])
    expect(run.finished_at).toBeDefined()
    expect(s.connects[0]?.[0]).toMatchObject({ kind: 'extension', service: 'extension' })
    // 外部：自家版块那条不算外部；ivrabiliaria 只是撞字 → WP411 起入库前就按整词丢掉（不判、不计）
    const ext = s.watch.items({ source: 'external' })
    expect(ext.map((x) => x.fullname).sort()).toEqual(['t3_aa1'])
    expect(run.parts.find((p) => p.part === 'external')?.filtered).toBe(1)
  })
})

describe('插件读收件箱与自家版块（替身插件 × 替身 Reddit）', () => {
  const routes = {
    '/api/me.json': {},
    '/message/inbox/.json?mark=false': listing([
      t('c9', 't1', {
        type: 'comment_reply',
        parent_id: 't1_ours',
        body: 'does it work with iPhone?',
      }),
      t('c8', 't1', { type: 'username_mention', body: '[deleted]', author: '[deleted]' }),
    ]),
    '/r/ivraxr/new/.json': listing([t('p2', 't3'), t('p1', 't3', { author: 'IVRA_Official' })]),
    '/r/ivraxr/comments/.json': listing([t('c5', 't1', { body: 'nice' })]),
  }

  it('排活 → 插件领 → 交回：入库、挂后续、判断、待处理、读到哪', async () => {
    const s = setup()
    // 插件先配好、连上 Reddit（还没配版块时来问一次）
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    const onPending = vi.fn()
    s.watch.onPending(onPending)
    const run = await s.watch.runNow()
    expect(run.parts.every((p) => p.status === 'waiting')).toBe(true)
    const reddit = fakeReddit(routes, 'IVRA_Official')
    expect(await extensionRound(s.watch, reddit)).toBe(true)
    // 收件箱一律 mark=false
    expect(
      reddit.calls.filter((u) => u.includes('/message/')).every((u) => u.includes('mark=false')),
    ).toBe(true)
    const view = s.watch.view()
    expect(view.last_run?.parts.map((p) => `${p.part}:${p.status}`)).toEqual([
      'inbox:ok',
      'own_sub:ok',
    ])
    expect(view.last_run?.finished_at).toBeDefined()
    expect(view.extension.user).toBe('IVRA_Official')
    // 我们自己发的帖：记 ours，不判、不进待处理
    const p1 = s.watch.items({ source: 'own_sub' }).find((x) => x.fullname === 't3_p1')
    expect(p1?.ours).toBe(true)
    expect(p1?.judgement).toBeUndefined()
    // 回的是我们发过的 → 挂发出记录；被删的 → 清掉
    const c9 = s.watch.items({ source: 'inbox' }).find((x) => x.fullname === 't1_c9')
    expect(c9?.reply_to_ours).toBe(true)
    expect(s.followUps).toContain('t1_ours')
    expect(s.deleted).toContain('t1_c8')
    // 没有模型：收件箱的问题按规则「要回」
    expect(c9?.judgement).toMatchObject({ reply: true, verdict: 'follow_up', by: 'rule' })
    expect(view.pending.map((x) => x.fullname)).toContain('t1_c9')
    expect(onPending).toHaveBeenCalledTimes(1)

    // 第二轮：从上次读到的那一条往后（stop_at），旧的不再记一遍
    s.setNow('2026-10-15T02:00:00.000Z')
    await s.watch.runNow()
    const got = s.watch.next({ connected: true })
    expect(got.job?.reads.find((r) => r.key === 'inbox')?.stop_at).toBe('t1_c9')
    const res = await runRedditRead(got.job as never, {
      fetch: fakeReddit(routes, 'ivra_official').fetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    await s.watch.result(got.job?.id ?? '', res)
    expect(s.watch.items({ source: 'inbox' })).toHaveLength(2)
  })

  it('登着的不是品牌号：一条都不读，出「重新登录」连接卡', async () => {
    const s = setup()
    // 插件先配好、连上 Reddit（还没配版块时来问一次）
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    await s.watch.runNow()
    await extensionRound(s.watch, fakeReddit(routes, 'my_personal'))
    const run = s.watch.view().last_run as RedditWatchRun
    expect(run.parts.every((p) => p.status === 'needs_connection')).toBe(true)
    expect(s.watch.items()).toHaveLength(0)
    expect(s.connects.at(-1)?.[0]).toMatchObject({ kind: 'reddit_session', state: 'reauth' })
    expect(s.watch.sessionReady()).toBeUndefined()
  })

  it('插件 2 小时没来领：这一轮记失败、收尾；不重复出卡', async () => {
    const s = setup()
    // 插件先配好、连上 Reddit（还没配版块时来问一次）
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    await s.watch.runNow()
    s.setNow('2026-10-14T04:30:00.000Z')
    s.watch.sweep()
    const run = s.watch.view().last_run as RedditWatchRun
    expect(run.finished_at).toBeDefined()
    expect(run.parts.every((p) => p.status === 'failed')).toBe(true)
    expect(s.watch.next({ connected: true }).job).toBeUndefined()
  })

  it('AI 判断：话题、有效 VOC / UGC', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify([
        {
          i: 1,
          verdict: 'no_action',
          reply: false,
          reason: '分享体验',
          topic: '使用体验',
          voc: '',
          ugc: '用户晒 Air3 开箱',
          sentiment: 'positive',
        },
        {
          i: 2,
          verdict: 'follow_up',
          reply: true,
          reason: '在问兼容',
          topic: '兼容性',
          voc: '想知道能不能连 iPhone',
          ugc: '',
          sentiment: 'neutral',
        },
        {
          i: 3,
          verdict: 'no_action',
          reply: false,
          reason: '闲聊',
          topic: '闲聊',
          voc: '',
          ugc: '',
        },
      ]),
    )
    const s = setup({ complete: () => complete })
    // 插件先配好、连上 Reddit（还没配版块时来问一次）
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    await s.watch.runNow()
    await extensionRound(
      s.watch,
      fakeReddit(
        {
          '/message/inbox/.json?mark=false': listing([]),
          '/r/ivraxr/new/.json': listing([t('p2', 't3')]),
          '/r/ivraxr/comments/.json': listing([t('c1', 't1', { body: 'iPhone?' }), t('c2', 't1')]),
        },
        'ivra_official',
      ),
    )
    expect(complete).toHaveBeenCalledTimes(1)
    // 没配品牌号：第一次读到就记下登着的号（之后换号就一条都不读）
    expect(s.watch.settings().brand_username).toBe('ivra_official')
    const d = s.watch.digest({
      since: '2026-10-11T00:00:00.000Z',
      until: '2026-10-17T00:00:00.000Z',
    })
    expect(d.own_sub).toMatchObject({ posts: 1, comments: 2 })
    expect(d.ugc.map((x) => x.judgement?.ugc)).toEqual(['用户晒 Air3 开箱'])
    expect(d.voc.map((x) => x.judgement?.voc)).toEqual(['想知道能不能连 iPhone'])
  })
})

describe('什么时候巡查（一天一次起步）', () => {
  const empty = fakeReddit(
    {
      '/message/inbox/.json?mark=false': listing([]),
      '/r/ivraxr/new/.json': listing([]),
      '/r/ivraxr/comments/.json': listing([]),
    },
    'ivra_official',
  )
  it('刚连上插件：缺连接停着的那一块马上来一轮', async () => {
    const s = setup({}, '2026-10-14T02:00:00.000Z')
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    await s.watch.tick()
    expect(s.watch.view().last_run?.parts[0]?.status).toBe('needs_connection')
    // 插件第一次来问（连着 Reddit）：同一拍就把活领走了
    const got = s.watch.next({ connected: true })
    await Promise.resolve()
    expect(got.job ?? s.watch.next({ connected: true }).job).toBeDefined()
  })
  it('每天一次：本地 9 点前不跑、当天不跑第二次、第二天再跑', async () => {
    const s = setup({}, '2026-10-14T00:00:00.000Z') // 本地 08:00
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    expect(await s.watch.tick()).toMatchObject({ ran: false, skipped: 'not_due' })
    s.setNow('2026-10-14T02:00:00.000Z') // 10:00
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    await extensionRound(s.watch, empty)
    s.setNow('2026-10-14T07:00:00.000Z') // 15:00
    expect(await s.watch.tick()).toMatchObject({ ran: false, skipped: 'not_due' })
    s.setNow('2026-10-15T01:30:00.000Z') // 第二天 09:30
    expect(await s.watch.tick()).toMatchObject({ ran: true })
  })
  it('一天一次的定时里没有「周五最后一次」（要最新数据由 AI 调立即巡查）', async () => {
    const s = setup({}, '2026-10-16T09:05:00.000Z') // 周五 17:05（东八区）
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    expect(await s.watch.tick()).toMatchObject({ ran: true })
    await extensionRound(s.watch, empty)
    s.setNow('2026-10-16T10:30:00.000Z')
    expect(await s.watch.tick()).toMatchObject({ ran: false, skipped: 'not_due' })
  })
})

describe('给报告积木（WP331）：sweepNow 与 WatchSource', () => {
  const routes = {
    '/message/inbox/.json?mark=false': listing([
      t('c9', 't1', { type: 'comment_reply', body: 'iPhone?' }),
      t('m1', 't1', { type: 'comment_reply', subreddit: 'other_sub' }),
    ]),
    '/r/ivraxr/new/.json': listing([t('p2', 't3', { title: 'My Air3 unboxing' })]),
    '/r/ivraxr/comments/.json': listing([t('c9', 't1', { body: 'iPhone?' })]),
  }
  it('sweepNow：现在巡查一次，等插件交回再回（正在跑的那一轮直接等它）', async () => {
    // 替身插件：sweepNow 在「等」的时候（每次 sleep）来领活、读替身 Reddit、交回
    const reddit = fakeReddit(routes, 'ivra_official')
    let handed = false
    const ref: { w?: ReturnType<typeof setup>['watch'] } = {}
    const s = setup(
      {
        search: SEARCH,
        sleep: async () => {
          if (!handed && ref.w !== undefined) handed = await extensionRound(ref.w, reddit)
        },
      },
      '2026-10-16T09:05:00.000Z',
    )
    ref.w = s.watch
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], keywords: ['IVRA'] })
    s.watch.next({ connected: true })
    // 刚连上会马上补跑一轮；它还没做完时 AI 要「立即巡查」→ 直接等这一轮
    const run = await s.watch.sweepNow({ pollMs: 1, timeoutMs: 50 })
    expect(handed).toBe(true)
    expect(run).toMatchObject({ final: false })
    expect(run.finished_at).toBeDefined()

    const src = redditWatchSourceOf(s.watch)
    expect(src.platform).toBe('reddit')
    expect(await src.configured()).toBe(true)
    expect(await src.ownPlaces()).toEqual(['ivraxr'])
    const w = { since: '2026-10-10T16:00:00.000Z', until: '2026-10-16T10:00:00.000Z' }
    const items = await src.items(w)
    // 同一条评论在收件箱和版块里都有 → 只算一次；别处版块里回我们的不算
    expect(items.filter((x) => x.id === 't1_c9')).toHaveLength(1)
    expect(items.some((x) => x.id === 't1_m1')).toBe(false)
    expect(items.find((x) => x.id === 't3_p2')).toMatchObject({ scope: 'own', kind: 'post' })
    const ext = items.filter((x) => x.scope === 'external')
    // WP411：ivrabiliaria 只是撞字，入库前就丢了
    expect(ext.map((x) => x.id).sort()).toEqual(['t3_aa1'])
    expect(ext.every((x) => x.topic?.key.startsWith('t:') === true)).toBe(true)
    expect((await src.sweeps(w)).length).toBe(1)
  })
  it('插件一直没来交：sweepNow 到时抛一句人话（报告照样用已入库的出）', async () => {
    const s = setup({ sleep: async () => {} }, '2026-10-16T09:05:00.000Z')
    s.watch.next({ connected: true })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'] })
    s.watch.next({ connected: true }) // 把「刚连上补跑」那一件领走、不交
    await expect(s.watch.sweepNow({ pollMs: 1, timeoutMs: 3 })).rejects.toThrow('插件还没交回')
  })
  it('没配：sweepNow 直接说没配', async () => {
    const s = setup({ sleep: async () => {} })
    await expect(s.watch.sweepNow()).rejects.toThrow('没配')
  })
  it('话题键跨天一致（大小写 / 空白 / 标点不算不同）', () => {
    expect(topicKey(' Battery Life ')).toBe(topicKey('battery  life'))
    expect(topicKey('续航，问题')).toBe(topicKey('续航 问题'))
  })
})

describe('配置卡的设置目标', () => {
  it('校验、写入；至少一样', async () => {
    const s = setup()
    const target = s.watch.setupTarget()
    expect(await target.satisfied()).toBe(false)
    await expect(target.apply({ own_subreddits: 'r/bad name' })).rejects.toThrow('版块名')
    await expect(target.apply({})).rejects.toThrow('至少')
    await target.apply({
      own_subreddits: 'r/ivraxr',
      keywords: 'IVRA, 艾维，Xreal',
      every_hours: '12',
    })
    expect(s.watch.settings()).toMatchObject({
      own_subreddits: ['ivraxr'],
      keywords: ['IVRA', '艾维', 'Xreal'],
      every_hours: 12,
    })
    expect(await target.satisfied()).toBe(true)
  })
})

describe('WP471（决策 1549）：巡查判断固定在前、待判内容在后', () => {
  const ctx = {
    brand: 'IVRA',
    own_subreddits: ['ivraxr'],
    watch_subreddits: ['vr'],
    keywords: ['IVRA'],
  }
  const item = (id: string, text: string): RedditWatchEntry =>
    ({
      id,
      fullname: `t3_${id}`,
      source: 'external',
      keyword: 'IVRA',
      subreddit: 'vr',
      kind: 'post',
      title: `post ${id}`,
      text,
    }) as RedditWatchEntry

  it('两批：系统提示逐字相同；话题清单在待判内容之前；前一批的用户消息开头与话题只往后加', async () => {
    const seen: { system?: string; user: string }[] = []
    const complete = async (user: string, system?: string) => {
      seen.push({ user, ...(system === undefined ? {} : { system }) })
      return '[]'
    }
    const items = Array.from({ length: JUDGE_BATCH + 1 }, (_, i) =>
      item(`p${i}`, `IVRA Air3 question number ${i}`),
    )
    await judgeItems(items, { ...ctx, topics: ['续航'] }, complete)
    expect(seen).toHaveLength(2)
    const [a, b] = seen
    expect(a?.system).toBeDefined()
    expect(b?.system).toBe(a?.system)
    expect(a?.system).toContain('每条判：')
    expect(a?.system).not.toContain('IVRA Air3 question')
    const u = a?.user ?? ''
    expect(u.indexOf('本周已有的话题：续航')).toBeLessThan(u.indexOf('<external_data>'))
    expect(u.trimEnd().endsWith('</external_data>')).toBe(true)
    // 拼起来的一整段 = 两段（字不改，只调位置）
    const m = judgeMessages([items[0] as RedditWatchEntry], { ...ctx, topics: [] })
    expect(judgePrompt([items[0] as RedditWatchEntry], { ...ctx, topics: [] })).toBe(
      `${m.system}\n${m.user}`,
    )
  })
})
