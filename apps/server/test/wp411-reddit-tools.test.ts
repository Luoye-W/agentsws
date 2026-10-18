/**
 * WP411（#13）：工具层的时间窗——`read_reddit` 带 since / until 按发帖时间筛（筛完一条不剩照实说不是 0）；
 * `run_watch_now` 带 since / until 先说计划（preview）再照做、补不了说原因与能做的；
 * `query_watch_items` 那段时间某一块没采过 → `coverage` 照实说「没采到」。替身插件、替身中台，不联网。
 */
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { DataCallResult, RunRequest } from '@agentsws/contracts'
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  createRedditWatch,
  createRedditWatchStore,
  redditWatchSourceOf,
} from '../src/reddit-watch/index.js'
import { createReportToolExecutor } from '../src/report-tools.js'
import { createResearchToolExecutor } from '../src/research-tools.js'

const NOW = '2026-10-18T04:00:00.000Z' // 东八区周日 12:00
const WS = 'ws_1' as never
const REQ = {
  id: 'run_1',
  workspace_id: WS,
  actor: { assignment_id: 'asg_1', role_id: 'social.reddit', person_id: 'per_1' },
} as unknown as RunRequest

describe('read_reddit 带 since / until', () => {
  const asked: Record<string, unknown>[] = []
  const exec = createResearchToolExecutor({
    route: () => ({ order: ['workshop'], disabled: [] }),
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    callData: async (capability, input): Promise<DataCallResult> => {
      asked.push(input)
      return {
        capability,
        items: [
          { url: 'https://reddit.com/a', title: 'a', created_at: '2026-10-17T10:00:00.000Z' },
          { url: 'https://reddit.com/b', title: 'b', created_at: '2026-10-12T10:00:00.000Z' },
          { url: 'https://reddit.com/c', title: 'c', created_at: '2026-10-05T10:00:00.000Z' },
        ],
        quantity: 3,
        credits: 0.15,
        cached: false,
        fetched_at: NOW,
        source: 'official',
      }
    },
    nowMs: () => Date.parse(NOW),
    tzOffsetMinutes: () => 480,
  })
  const call = (input: Record<string, unknown>) =>
    exec({ name: 'read_reddit', input, request: REQ })

  it('按起点选最小的时间档、按最新排；按发帖时间筛（本地日期含那一天）', async () => {
    const r = await call({ query: 'IVRA', since: '2026-10-12', until: '2026-10-16' })
    expect(asked.at(-1)).toMatchObject({ query: 'IVRA', time_window: 'week', sort: 'new' })
    // since / until 不往中台传
    expect(asked.at(-1)).not.toHaveProperty('since')
    expect(r.data).toMatchObject({
      rows: 1,
      items: [{ title: 'b' }],
      window: { since: '2026-10-11T16:00:00.000Z', until: '2026-10-16T15:59:59.999Z', outside: 2 },
    })
  })
  it('筛完一条不剩：照实说不是 0，指路回补', async () => {
    const r = await call({ query: 'IVRA', since: '2026-09-01', until: '2026-09-30' })
    expect(asked.at(-1)).toMatchObject({ time_window: 'year' })
    expect((r.data as { missing?: string }).missing).toContain('不是「这段时间 0 条」')
    expect((r.data as { missing?: string }).missing).toContain('run_watch_now')
    expect((await call({ query: 'IVRA', since: 'last tuesday' })).status).toBe('error')
  })
})

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const fetchOf =
  (routes: Record<string, unknown>) =>
  async (url: string): Promise<RedditFetched> => {
    const u = new URL(url)
    const body =
      u.pathname === '/api/me.json'
        ? { kind: 't2', data: { name: 'ivra_official' } }
        : (routes[u.pathname] ?? listing([]))
    return { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
  }

function setup(connect = true) {
  let now = NOW
  const store = createRedditWatchStore()
  let n = 0
  const reddit = fetchOf({
    '/search.json': listing([
      {
        kind: 't3',
        data: {
          id: 'xx1',
          name: 't3_xx1',
          title: 'IVRA Air3 recall?',
          selftext: 'saw news',
          author: 'zed',
          subreddit: 'SmartGlasses',
          created_utc: Date.parse('2026-10-13T00:00:00Z') / 1000,
          permalink: '/r/SmartGlasses/comments/xx1/x/',
        },
      },
    ]),
  })
  const watch = createRedditWatch({
    workspace_id: WS,
    store,
    now: () => now,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'IVRA',
    search: async () => ({ ok: true, items: [] }),
    // 「等插件交回」的那一下：替身插件当场领活、读、交回
    sleep: async () => {
      const got = watch.next({ connected: true })
      if (got.job !== undefined)
        await watch.result(
          got.job.id,
          await runRedditRead(got.job, {
            fetch: reddit,
            sleep: async () => {},
            stopped: () => false,
            gapMs: 0,
          }),
        )
    },
  })
  watch.updateSettings({
    own_subreddits: ['ivraxr'],
    keywords: ['IVRA'],
    brand_username: 'ivra_official',
  })
  if (connect) watch.next({ connected: true })
  const exec = createReportToolExecutor({
    clock: { now: () => now },
    tzOffsetMinutes: () => 480,
    watch: () => redditWatchSourceOf(watch),
    watchRoles: new Set(['social.reddit']),
    outbound: () => undefined,
    approvals: () => ({ create: vi.fn() }) as never,
    publishedCount: () => 0,
  })
  const run = (name: string, input: Record<string, unknown>) => exec({ name, input, request: REQ })
  return {
    watch,
    run,
    setNow: (v: string) => {
      now = v
    },
  }
}

describe('run_watch_now 带 since / until：先说计划再照做', () => {
  it('preview 只回那一句；照做后各块补进几条、丢了几条噪音', async () => {
    const s = setup()
    const p = await s.run('run_watch_now', {
      since: '2026-10-11',
      until: '2026-10-16',
      preview: true,
    })
    expect(p.data).toMatchObject({
      ok: true,
      preview: true,
      days: 6,
      say: expect.stringMatching(/^要补 6 天（10\/11–10\/16），约 \d+ 页，在你浏览器里读/u),
    })
    const done = await s.run('run_watch_now', { since: '2026-10-11', until: '2026-10-16' })
    // （插件刚连上时那一轮读完，第一次外部回补已经先把这条补进来了：这里照样读到、只算一次）
    expect(done.data).toMatchObject({
      ok: true,
      parts: [
        { part: 'own_sub', status: 'ok' },
        { part: 'external', status: 'ok' },
      ],
    })
    expect(s.watch.items({ source: 'external' }).map((x) => x.fullname)).toEqual(['t3_xx1'])
    expect(s.watch.runs({ limit: 1 })[0]).toMatchObject({
      trigger: 'backfill',
      window: { since: '2026-10-10T16:00:00.000Z', until: '2026-10-16T15:59:59.999Z' },
    })
    // 补过之后查那一周的外部：数是数出来的，不再说「没采到」
    const q = await s.run('query_watch_items', {
      since: '2026-10-11',
      until: '2026-10-16',
      scope: 'external',
    })
    expect((q.data as { coverage?: string[] }).coverage).toBeUndefined()
  })

  it('插件不在线：补不了，说原因和能做的（不只回库里 0 条）', async () => {
    const s = setup(false)
    const r = await s.run('run_watch_now', { since: '2026-10-11', until: '2026-10-16' })
    expect(r.data).toEqual({
      ok: false,
      message: '补不了：插件还没配对（回补要插件在你浏览器里借品牌号读）。',
      can: expect.stringContaining('打开 Chrome'),
    })
  })
})

describe('query_watch_items：那段时间没采过照实说', () => {
  it('外部 10-17 才第一次跑：查 10-11 到 10-16 → coverage 写明「没采到，不是 0」', async () => {
    const s = setup(false)
    const before = await s.run('query_watch_items', { since: '2026-10-11', until: '2026-10-16' })
    expect((before.data as { coverage?: string[] }).coverage).toEqual([
      '自家版块还没采过：这段时间的是没采到，不是 0。要补用 run_watch_now 带 since / until。',
      '外部社区还没采过：这段时间的是没采到，不是 0。要补用 run_watch_now 带 since / until。',
    ])
    s.setNow('2026-10-17T05:00:00.000Z')
    await s.watch.runNow()
    s.setNow(NOW)
    const after = await s.run('query_watch_items', {
      since: '2026-10-11',
      until: '2026-10-16',
      scope: 'external',
    })
    // 第一次外部（插件不在线）往回补了 7 天：10-10 起有数据 → 不提醒；查更早的才提醒
    expect((after.data as { coverage?: string[] }).coverage).toBeUndefined()
    const older = await s.run('query_watch_items', {
      since: '2026-10-01',
      until: '2026-10-08',
      scope: 'external',
    })
    expect((older.data as { coverage?: string[] }).coverage).toEqual([
      '外部社区大约从 2026-10-10 起才有数据，之前的没采到（不是 0）；要补用 run_watch_now 带 since / until。',
    ])
  })
})
