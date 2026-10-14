/**
 * WP328 端到端（真服务进程 + 替身插件 + 替身 Reddit JSON；不打开真 Reddit、不起端口）：
 *
 * - 新配的插件令牌带 `reddit.read`；插件来问（connected=1）→ 本机记下「插件在、连着 Reddit」；
 * - 品牌里有人担「Reddit」那条社媒职责 → 建了每日巡查的定时任务；
 * - 现在巡查一次 → 排一件只读活 → 插件领走、用真执行器读替身 Reddit、交回 → 入库、判断、待处理；
 * - 工作台用「Reddit」那条职责看得到待处理、能标「不回」、拿得到一周汇总；
 * - 巡查数据 → 报告积木「查巡查数据」读得到（WP331：数据源兜底就是这个品牌的巡查库）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type RedditFetched,
  type RedditReadNextResponse,
  runRedditRead,
} from '@agentsws/browser-action'
import type { RedditWatchDigest, RedditWatchView } from '@agentsws/contracts'
import { queryWatchItems } from '@agentsws/social-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { redditWatchSourceOf } from '../src/reddit-watch/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'
let server: Server
let dir: string

const data = async <T>(res: Response): Promise<T> => {
  const body = (await res.json()) as { data?: T; error?: unknown }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.error)}`)
  return body.data as T
}
const call = (method: string, path: string, body?: unknown, assignment?: string) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': assignment ?? server.bootstrap.ownerAssignment.id,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const plugin = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Origin: EXT_ORIGIN,
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  )

const NOW_S = Math.floor(Date.now() / 1000)
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'inmo_official' } },
  '/message/inbox/.json': listing([
    {
      kind: 't1',
      data: {
        id: 'c9',
        name: 't1_c9',
        type: 'comment_reply',
        author: 'alice',
        body: 'does it work with iPhone?',
        subreddit: 'inmoxr',
        parent_id: 't1_ours',
        context: '/r/inmoxr/comments/p1/x/c9/?context=3',
        created_utc: NOW_S - 600,
      },
    },
  ]),
  '/r/inmoxr/new/.json': listing([
    {
      kind: 't3',
      data: {
        id: 'p2',
        name: 't3_p2',
        author: 'bob',
        title: 'My Air3 unboxing',
        selftext: 'pics inside',
        subreddit: 'inmoxr',
        permalink: '/r/inmoxr/comments/p2/x/',
        created_utc: NOW_S - 900,
      },
    },
  ]),
  '/r/inmoxr/comments/.json': listing([]),
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const body = ROUTES[new URL(url).pathname]
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp328-reddit-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})
afterAll(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP328 Reddit 每日巡查（服务进程）', () => {
  it('配对 → 插件来问 → 现在巡查 → 插件读替身 Reddit 交回 → 待处理 / 周汇总', async () => {
    const pairing = await data<{ code: string }>(await call('POST', '/v1/extension/pairings', {}))
    const redeemed = await data<{ token: string; scopes: string[] }>(
      await server.gateway.fetch(
        new Request('http://127.0.0.1/v1/extension/pair', {
          method: 'POST',
          headers: { Origin: EXT_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ code: pairing.code }),
        }),
      ),
    )
    expect(redeemed.scopes).toContain('reddit.read')

    // 担「Reddit」那条社媒职责的岗位
    const position = await data<{ id: string }>(
      await call('POST', '/v1/org/positions', {
        name: '社媒运营',
        roles: [{ role_id: 'social.reddit', default: true }],
      }),
    )
    const asg = await data<{ id: string } | { assignment: { id: string } }>(
      await call('POST', '/v1/assignments', {
        person_id: server.bootstrap.ownerAssignment.person_id,
        position_id: position.id,
        ranges: [],
        range_groups: [],
      }),
    )
    const ws = server.bootstrap.workspace.id
    const rw = (await server.brands.forWorkspace(ws)).redditWatch
    if (rw === undefined) throw new Error('没装 Reddit 巡查')
    rw.updateSettings({ own_subreddits: ['inmoxr'] })
    const reddit = server.roles.assignments
      .listByRole('social.reddit')
      .find((a) => a.workspace_id === ws)
    expect(reddit).toBeDefined()
    void asg

    // 插件来问（连着 Reddit）：刚连上会马上来一轮，活可能当场就发下来
    let got = await data<RedditReadNextResponse>(
      await plugin('/v1/extension/reddit/next?connected=1', redeemed.token),
    )
    if (got.job === undefined) {
      await rw.runNow()
      got = await data<RedditReadNextResponse>(
        await plugin('/v1/extension/reddit/next?connected=1', redeemed.token),
      )
    }
    const job = got.job
    if (job === undefined) throw new Error('没领到活')
    expect(job.reads.map((r) => r.key)).toEqual(['inbox', 'sub_new:inmoxr', 'sub_comments:inmoxr'])
    const res = await runRedditRead(job, {
      fetch: fakeFetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    expect(res.outcome).toBe('done')
    const accepted = await plugin(`/v1/extension/reddit/${job.id}/result`, redeemed.token, {
      method: 'POST',
      body: res,
    })
    expect(accepted.status).toBe(200)

    const view = await data<RedditWatchView>(
      await call('GET', '/v1/reddit-watch', undefined, reddit?.id),
    )
    expect(view.last_run?.parts.map((p) => `${p.part}:${p.status}`)).toEqual([
      'inbox:ok',
      'own_sub:ok',
    ])
    const pending = view.pending.find((x) => x.fullname === 't1_c9')
    expect(pending?.judgement?.reply).toBe(true)
    const dismissed = await call(
      'POST',
      `/v1/reddit-watch/items/${pending?.id}/status`,
      { status: 'dismissed' },
      reddit?.id,
    )
    expect(dismissed.status).toBe(200)
    const digest = await data<RedditWatchDigest>(
      await call('GET', '/v1/reddit-watch/digest', undefined, reddit?.id),
    )
    expect(digest.own_sub.posts).toBe(1)
    expect(digest.inbox.total).toBe(1)

    // 巡查数据 → 报告积木「查巡查数据」读得到（WP331：没注入 watchSource 时用的就是这个品牌的巡查库）
    const src = redditWatchSourceOf(rw)
    const w = {
      since: '2000-01-01T00:00:00.000Z',
      until: new Date(Date.now() + 60_000).toISOString(),
    }
    const q = queryWatchItems({
      items: await src.items(w),
      ownPlaces: await src.ownPlaces(),
      window: w,
    })
    expect(q.totals.own).toEqual({ posts: 1, comments: 1 })
    expect((await src.sweeps(w)).length).toBeGreaterThanOrEqual(1)
    expect(q.items.some((x) => x.place === 'inmoxr')).toBe(true)
  })
})
