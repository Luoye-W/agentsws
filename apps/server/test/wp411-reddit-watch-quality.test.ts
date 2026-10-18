/**
 * WP411（客户真机 10-18 #10 #11 #13）：巡查质量——外部关键词整词匹配丢噪音、第一次外部往回补 N 天、
 * 收件箱 / 自家版块同一条只算一次、外部帖闸、起草前读整串、按时间窗回补（在你浏览器里读）。
 * 样本按 客户真机那天的噪音仿写，品牌用假名 IVRA。替身 Reddit（本地假 JSON，经 browser-action 的真执行器跑）、
 * 替身插件、替身数据渠道、替身模型；不打开真 Reddit、不联网、不花钱。
 */
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { RedditWatchEntry } from '@agentsws/contracts'
import type { RedditItem } from '@agentsws/social-core'
import { describe, expect, it, vi } from 'vitest'
import {
  createRedditWatch,
  createRedditWatchStore,
  type RedditWatchOptions,
} from '../src/reddit-watch/index.js'

const WED_10 = '2026-10-14T02:00:00.000Z' // 东八区周三 10:00
const sec = (iso: string): number => Date.parse(iso) / 1000

const t = (id: string, kind: 't1' | 't3', over: Record<string, unknown> = {}) => ({
  kind,
  data: {
    id,
    name: `${kind}_${id}`,
    author: 'alice',
    subreddit: 'ivraxr',
    created_utc: sec('2026-10-13T00:00:00Z'),
    ...(kind === 't3'
      ? { title: `post ${id}`, selftext: 'hello' }
      : {
          body: `c ${id}`,
          link_id: 't3_post1',
          parent_id: 't3_post1',
          link_title: 'Air3 overheating?',
        }),
    permalink: `/r/ivraxr/comments/post1/x/${id}/`,
    ...over,
  },
})
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })

/** 替身 Reddit：认得的地址回给定的 JSON；版块 / 收件箱 / 搜索没登记的回空列表。 */
export function fakeReddit(routes: Record<string, unknown>, user = 'ivra_official') {
  const calls: string[] = []
  const fetch = async (url: string): Promise<RedditFetched> => {
    calls.push(url)
    const u = new URL(url)
    for (const k of ['limit', 'raw_json', 'after', 'sort']) u.searchParams.delete(k)
    u.searchParams.sort()
    const key = `${u.pathname}${u.search}`
    const body =
      u.pathname === '/api/me.json'
        ? { kind: 't2', data: { name: user } }
        : (routes[key] ??
          (/\/(new|comments)\/\.json$|\/message\/inbox|\/search\.json/u.test(u.pathname)
            ? listing([])
            : undefined))
    return body === undefined
      ? { status: 404, url, content_type: 'application/json', body: '{}' }
      : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
  }
  return { fetch, calls }
}

const ACTOR = { person_id: 'p1', assignment_id: 'as1', role_id: 'social.reddit' } as never

function setup(over: Partial<RedditWatchOptions> = {}, opts: { connect?: boolean } = {}) {
  let now = WED_10
  let n = 0
  const store = createRedditWatchStore()
  const cards = { askConnect: vi.fn(async () => undefined), askSetup: vi.fn(async () => undefined) }
  const watch = createRedditWatch({
    workspace_id: 'ws_1' as never,
    store,
    now: () => now,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'IVRA',
    setupCards: async () => cards as never,
    actor: () => ACTOR,
    ...over,
  })
  // 插件配好、连上 Reddit（来问一次；还没配巡查时先领「看登着哪个号」那一件，当场交回）
  if (opts.connect !== false) {
    const who = watch.next({ connected: true }).job
    if (who !== undefined)
      void watch.result(who.id, { outcome: 'done', message: '', user: 'ivra_official', parts: [] })
  }
  const pending: RedditWatchEntry[][] = []
  watch.onPending((x) => pending.push(x))
  return {
    watch,
    store,
    pending,
    setNow: (v: string) => {
      now = v
    },
  }
}

/** 替身插件：领一件 → 真执行器读替身 Reddit → 交回；回这件活读了哪几路。 */
async function round(
  w: ReturnType<typeof setup>['watch'],
  reddit: ReturnType<typeof fakeReddit>,
): Promise<string[] | undefined> {
  const got = w.next({ connected: true })
  if (got.job === undefined) return undefined
  const res = await runRedditRead(got.job, {
    fetch: reddit.fetch,
    sleep: async () => {},
    stopped: () => false,
    gapMs: 0,
  })
  expect(await w.result(got.job.id, res)).toEqual({ accepted: true })
  return got.job.reads.map((r) => r.key)
}

const hit = (id: string, sub: string, title: string, text: string, at = '2026-10-13T08:00:00Z') =>
  ({
    kind: 'post',
    url: `https://www.reddit.com/r/${sub}/comments/${id}/x/`,
    id,
    title,
    text,
    subreddit: sub,
    author: 'zed',
    created_at: at,
  }) satisfies RedditItem

/** 客户真机那天的样子：数据渠道宽松匹配，五六条相关、其余是 HFY / 炉石 / 背单词这类。 */
const NOISY: Record<string, RedditItem[]> = {
  IVRA: [
    hit('aa1', 'SmartGlasses', 'IVRA Air3 vs Xreal?', 'which one for travel'),
    hit('aa2', 'HFY', 'The Ivrakan Empire, ch. 12', 'the fleet jumped'),
    hit('aa3', 'hearthstone', 'Immortal combo deck', 'ivra-ish tempo'),
    hit('aa9', 'SmartGlasses', 'IVRA in 2025', 'old', '2026-09-01T00:00:00Z'),
  ],
  'translation glasses': [
    hit('bb1', 'SmartGlasses', 'Best translation glasses for Japan?', 'IVRA or Even?'),
    hit('bb2', 'vocabulary', 'Translation help', 'what do glasses mean here'),
  ],
}
const searchOf = (table: Record<string, RedditItem[]>) =>
  vi.fn(async (i: { query: string; time_window: string; limit: number }) => ({
    ok: true as const,
    items: table[i.query] ?? [],
  }))

describe('#10 外部关键词：入库前整词匹配，第一次往回补', () => {
  it('没整词出现的丢掉不判不计；插件不在线时第一次放宽到一周、更早的截掉，之后照常一天', async () => {
    const search = searchOf(NOISY)
    const s = setup({ search }, { connect: false })
    s.watch.updateSettings({
      own_subreddits: ['ivraxr'],
      keywords: ['IVRA', 'translation glasses'],
    })
    const run = await s.watch.runNow()
    const ext = run.parts.find((p) => p.part === 'external')
    expect(ext).toMatchObject({ status: 'ok', fresh: 2, filtered: 3 })
    expect(ext?.message).toContain('第一次往回补 7 天走的数据渠道')
    expect(search.mock.calls.map((c) => c[0].time_window)).toEqual(['week', 'week'])
    expect(
      s.watch
        .items({ source: 'external' })
        .map((x) => x.fullname)
        .sort(),
    ).toEqual(['t3_aa1', 't3_bb1'])
    // 第二天：照常只搜一天
    s.setNow('2026-10-15T02:00:00.000Z')
    await s.watch.runNow()
    expect(search.mock.calls.slice(2).map((c) => c[0].time_window)).toEqual(['day', 'day'])
  })

  it('插件在线：这一轮照常，读完在你浏览器里搜一周（不扣积分），噪音照样丢；只补一次', async () => {
    const search = searchOf({})
    const s = setup({ search })
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], keywords: ['IVRA'] })
    const reddit = fakeReddit({
      '/search.json?q=IVRA&t=week': listing([
        t('s1', 't3', { subreddit: 'SmartGlasses', title: 'IVRA Go2 worth it?', selftext: 'hm' }),
        t('s2', 't3', { subreddit: 'HFY', title: 'Ivrakan war', selftext: 'story' }),
        t('s3', 't3', { subreddit: 'ivraxr', title: 'IVRA own sub', selftext: 'mine' }),
      ]),
    })
    await s.watch.runNow()
    expect(search.mock.calls[0]?.[0].time_window).toBe('day')
    expect(await round(s.watch, reddit)).toContain('inbox')
    // 读完这一轮 → 插件来问时排的就是回补那一件
    expect(await round(s.watch, reddit)).toEqual(['bf:search:IVRA'])
    const last = s.watch.runs({ limit: 1 })[0]
    expect(last).toMatchObject({ trigger: 'backfill' })
    expect(last?.parts).toEqual([
      expect.objectContaining({ part: 'external', status: 'ok', fresh: 1, filtered: 1 }),
    ])
    const ext = s.watch.items({ source: 'external' })
    expect(ext.map((x) => [x.fullname, x.keyword])).toEqual([['t3_s1', 'IVRA']])
    expect(reddit.calls.some((u) => u.includes('/search.json'))).toBe(true)
    // 补过了：之后插件再来问不再补
    s.setNow('2026-10-15T02:00:00.000Z')
    await s.watch.runNow()
    await round(s.watch, reddit)
    expect(await round(s.watch, reddit)).toBeUndefined()
  })
})

describe('#10 第 3 条 / #11：同一条只算一次；起草前读整串', () => {
  const routes = {
    '/message/inbox/.json?mark=false': listing([
      t('c9', 't1', {
        type: 'comment_reply',
        parent_id: 't1_o0',
        body: 'Is the recall real? Mine got hot.',
      }),
    ]),
    '/r/ivraxr/comments/.json': listing([
      t('c9', 't1', { parent_id: 't1_o0', body: 'Is the recall real? Mine got hot.' }),
      t('o1', 't1', {
        author: 'ivra_official',
        body: 'It is true that some IVRA Air3 units were recalled due to overheating.',
        created_utc: sec('2026-10-12T03:00:00Z'),
      }),
    ]),
    '/comments/post1/.json': [
      listing([t('post1', 't3', { title: 'Air3 overheating?', selftext: 'anyone else?' })]),
      listing([
        t('c7', 't1', { author: 'bob', body: 'mine too, got warm on the nose pad' }),
        t('o1', 't1', {
          author: 'ivra_official',
          body: 'It is true that some IVRA Air3 units were recalled due to overheating.',
          created_utc: sec('2026-10-12T03:00:00Z'),
        }),
        t('c9', 't1', { parent_id: 't1_o0', body: 'Is the recall real? Mine got hot.' }),
      ]),
    ],
  }

  it('收件箱和自家版块都读到：只判一次、只交一次起草；插件在线时先读整串再交', async () => {
    const s = setup()
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    const reddit = fakeReddit(routes)
    await s.watch.runNow()
    await round(s.watch, reddit)
    const copies = s.store.byFullname('ws_1' as never, 't1_c9')
    expect(copies).toHaveLength(2)
    const [orig, dup] = [copies.find((x) => x.dup_of === undefined), copies.find((x) => x.dup_of)]
    expect(dup?.dup_of).toBe(orig?.id)
    expect(dup?.judgement?.reply).toBe(false)
    expect(s.watch.view().pending.map((x) => x.fullname)).toEqual(['t1_c9'])
    // 还没交给起草：先排一件「读整串」
    expect(s.pending).toHaveLength(0)
    expect(await round(s.watch, reddit)).toEqual(['thread:t3_post1'])
    expect(s.pending.flat().map((x) => x.id)).toEqual([orig?.id])
    const ctx = s.watch.thread(orig?.id ?? '')
    expect(ctx).toMatchObject({ read: 'plugin', post: { title: 'Air3 overheating?' } })
    expect(ctx?.ours.map((c) => c.text)).toEqual([
      'It is true that some IVRA Air3 units were recalled due to overheating.',
    ])
    expect(ctx?.comments.map((c) => c.author)).toEqual(['bob'])
  })

  it('插件不在线：直接交给起草，整串只看库里有的（照实说）', async () => {
    const s = setup()
    s.watch.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    await s.watch.runNow()
    await round(s.watch, fakeReddit(routes))
    // 七小时后插件没再来问（Chrome 关了）：「读整串」那一件作废，条目照样交给起草（不等插件）
    s.setNow('2026-10-14T09:00:00.000Z')
    s.watch.sweep()
    expect(s.pending.flat()).toHaveLength(1)
    // 还开着没起草的（比如等人设）可以再交一次：插件不在线也不等
    expect(s.watch.redispatch()).toBe(1)
    expect(s.pending.flat()).toHaveLength(2)
    const ctx = s.watch.thread(s.pending.flat()[0]?.id ?? '')
    expect(ctx?.read).toBe('store')
    expect(ctx?.note).toContain('没现读成')
    // 品牌号在自家版块里发过的那条照样在
    expect(ctx?.ours).toHaveLength(1)
  })
})

describe('#11 第 5 条：外部帖只在真相关时起草', () => {
  it('个人主页、竞品版、没提到我们的不起草（写明为什么）；提到我们的才起草', async () => {
    const search = searchOf({
      IVRA: [
        hit('u1', 'u_PositiveConnection20', 'IVRA Air3 unboxing', 'my new toy'),
        hit('e1', 'EvenRealities', 'G2 or IVRA?', 'thinking about the G2'),
        hit('g1', 'SmartGlasses', 'Is the IVRA Go2 good?', 'for reading subtitles'),
      ],
      'AI glasses': [hit('m1', 'Smartphones', 'AI glasses or a new phone?', 'budget 500')],
    })
    // 替身模型：每条都说要回（看外部帖闸是不是兜得住）
    const complete = () => async (prompt: string) => {
      const n = (prompt.match(/^#\d+/gmu) ?? []).length
      return JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          i: i + 1,
          verdict: 'follow_up',
          reply: true,
          reason: '有人在问',
          topic: '选购',
        })),
      )
    }
    const s = setup(
      { search, complete, brandTerms: () => ({ competitors: ['Even Realities'] }) },
      { connect: false },
    )
    s.watch.updateSettings({ keywords: ['IVRA', 'AI glasses'], tag_words: ['Go2', 'Air3'] })
    await s.watch.runNow()
    expect(s.pending.flat().map((x) => x.fullname)).toEqual(['t3_g1'])
    const notes = Object.fromEntries(
      s.watch.items({ source: 'external' }).map((x) => [x.subreddit, x.note]),
    )
    expect(notes).toEqual({
      u_PositiveConnection20: '别人的个人主页帖，品牌号不去回',
      EvenRealities: 'r/EvenRealities 是竞品（Even Realities）自己的版，不去回',
      Smartphones: '外部帖没提到我们（只说品类），不自动起草',
      SmartGlasses: undefined,
    })
  })
})

describe('#13 按时间窗回补（在你浏览器里读）', () => {
  const WATCH = [
    'SmartGlasses',
    'augmentedreality',
    'Xreal',
    'RayNeo',
    'EvenRealities',
    'AR_MR_XR',
    'VirtualReality',
    'Smartphones',
    'gadgets',
  ]
  const cfg = {
    own_subreddits: ['ivraxr'],
    keywords: ['IVRA', 'AI glasses'],
    watch_subreddits: WATCH,
  }

  it('先说一句「要补 X 天，约 N 页，在你浏览器里读」；补不了照实说原因与能做的', async () => {
    const s = setup()
    s.watch.updateSettings(cfg)
    const { plan } = await s.watch.backfill({
      since: '2026-10-08',
      until: '2026-10-13',
      preview: true,
    })
    expect(plan).toMatchObject({ ok: true, days: 6, via: 'browser', pages: 4 + 7 + 9 })
    if (!plan.ok) throw new Error('should plan')
    expect(plan.message).toBe(
      '要补 6 天（10/8–10/13），约 20 页，在你浏览器里读（插件借品牌号只读，不扣积分）。',
    )
    expect(plan.limits[0]).toContain('评论里提到的搜不到')
    // 只是计划：一页都没读、没排活
    expect(s.watch.next({ connected: true }).job).toBeUndefined()
    const old = await s.watch.backfill({ since: '2026-06-01' })
    expect(old.plan).toMatchObject({ ok: false })
    expect(old.plan.ok ? '' : old.plan.message).toContain('90 天以前')

    const off = setup({}, { connect: false })
    off.watch.updateSettings(cfg)
    const r = await off.watch.backfill({ since: '2026-10-08' })
    expect(r.plan).toEqual({
      ok: false,
      message: '补不了：插件还没配对（回补要插件在你浏览器里借品牌号读）。',
      can: expect.stringContaining('read_reddit'),
    })
    expect(r.run).toBeUndefined()
  })

  it('照做：13 路拆两件按顺序读；不动日常的「读到哪」和版块的钟', async () => {
    const reddit = fakeReddit({
      '/r/ivraxr/new/.json': listing([
        t('n1', 't3', { created_utc: sec('2026-10-09T00:00:00Z') }),
        t('n0', 't3', { created_utc: sec('2026-10-01T00:00:00Z') }),
      ]),
    })
    let s: ReturnType<typeof setup> | undefined
    s = setup({
      sleep: async () => {
        if (s !== undefined) await round(s.watch, reddit)
      },
    })
    s.watch.updateSettings(cfg)
    const { plan, run } = await s.watch.backfill({
      since: '2026-10-08',
      until: '2026-10-13',
      pollMs: 1,
    })
    expect(plan.ok).toBe(true)
    expect(run).toMatchObject({
      trigger: 'backfill',
      window: { since: '2026-10-07T16:00:00.000Z', until: '2026-10-13T15:59:59.999Z' },
    })
    expect(run?.parts.map((p) => `${p.part}:${p.status}`)).toEqual([
      'own_sub:ok',
      'watch_sub:ok',
      'external:ok',
    ])
    // 补到的帖按起点截：10-01 那条没进来
    expect(s.watch.items({ source: 'own_sub' }).map((x) => x.fullname)).toEqual(['t3_n1'])
    expect(s.store.kv('ws_1' as never, 'cursor:bf:sub_new:ivraxr')).toBeUndefined()
    expect(s.store.kv('ws_1' as never, 'cursor:sub_new:ivraxr')).toBeUndefined()
    expect(reddit.calls.filter((u) => u.includes('/search.json')).length).toBe(2)
    expect(reddit.calls.some((u) => u.includes('q=%22AI+glasses%22'))).toBe(true)
  })
})
