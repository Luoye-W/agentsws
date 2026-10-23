/**
 * WP493（决策 1718）：ego 能用时——
 * - Reddit 巡查 / 现读的只读活交给 ego 领（插件来问不发活、不改状态）；不催配对插件；
 * - 岗位要插件做的 Reddit / 社媒发帖 ego 都能做 → 不催装插件，插件降为「备用」；
 * - `read_reddit` 先在 ego 里读，读不了时的话术叫人在 ego 里登录（不再叫人装插件）。
 * 全是替身：不起服务、不起 ego、不联网。
 */
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import {
  type BrowserExtensionUse,
  DEFAULT_REDDIT_BROWSER_READ_LIMITS,
  type RunRequest,
} from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createEgoRedditPump, egoRedditRead } from '../src/ego-read/index.js'
import { createExtensionOnboarding } from '../src/extension-onboarding.js'
import { createRedditWatch, createRedditWatchStore } from '../src/reddit-watch/index.js'
import { createResearchToolExecutor } from '../src/research-tools.js'

const ACTOR = { person_id: 'p1', assignment_id: 'as1', role_id: 'social.reddit' } as never

function watchWith(egoReady: () => boolean, onQueued = vi.fn()) {
  const connects: unknown[] = []
  let n = 0
  const watch = createRedditWatch({
    workspace_id: 'ws_1' as never,
    store: createRedditWatchStore(),
    now: () => '2026-10-23T02:00:00.000Z',
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'IVRA',
    setupCards: async () =>
      ({
        askConnect: async (i: unknown) => {
          connects.push(i)
          return undefined
        },
        askSetup: async () => undefined,
      }) as never,
    actor: () => ACTOR,
    egoReady,
    onQueued,
  })
  return { watch, connects, onQueued }
}

/** 替身 Reddit（JSON），按路径给。 */
const fakeReddit =
  (user: string | undefined) =>
  async (url: string): Promise<RedditFetched> => {
    const u = new URL(url)
    const body =
      u.pathname === '/api/me.json'
        ? user === undefined
          ? {}
          : { kind: 't2', data: { name: user } }
        : {
            kind: 'Listing',
            data: {
              after: null,
              children: [
                {
                  kind: 't1',
                  data: {
                    id: 'c1',
                    name: 't1_c1',
                    author: 'zed',
                    subreddit: 'ivraxr',
                    body: 'does it fit glasses?',
                    created_utc: Date.parse('2026-10-22T10:00:00Z') / 1000,
                    permalink: '/r/ivraxr/comments/p1/x/c1/',
                    type: 'comment_reply',
                    parent_id: 't1_x',
                    context: '/r/ivraxr/comments/p1/x/c1/',
                  },
                },
              ],
            },
          }
    return { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
  }

describe('巡查：ego 能用时 ego 领活、插件是备用', () => {
  it('不催配对插件；排活时通知 ego；插件来问不发活；ego 来领拿到活、读完交回', async () => {
    const { watch, connects, onQueued } = watchWith(() => true)
    watch.updateSettings({ own_subreddits: ['r/ivraxr'], brand_username: 'ivra_official' })
    const run = await watch.runNow()
    // 没出「装插件 / 连 Reddit」那张连接卡；收件箱 / 自家版块等着读
    expect(connects).toEqual([])
    expect(run.parts.find((p) => p.part === 'inbox')?.status).toBe('waiting')
    await Promise.resolve()
    expect(onQueued).toHaveBeenCalled()
    // 插件来问：不发活
    expect(watch.next({ connected: false })).toEqual({ retry_after_ms: 60_000 })
    // ego 来领
    const got = watch.next({ connected: true, via: 'ego' })
    expect(got.job?.expect_user).toBe('ivra_official')
    const res = await runRedditRead(got.job as never, {
      fetch: fakeReddit('ivra_official'),
      sleep: async () => undefined,
      stopped: () => false,
      gapMs: 0,
    })
    expect(await watch.result(got.job?.id ?? '', res)).toEqual({ accepted: true })
    const done = watch.runs()[0]
    expect(done?.parts.find((p) => p.part === 'inbox')?.status).toBe('ok')
    expect(watch.pluginState()).toMatchObject({ state: 'connected', user: 'ivra_official' })
    expect(watch.sessionReady()).toBe(true)
  })
  it('ego 里没登录：照实说「ego 里的 Reddit 没登录」，现读不排活', async () => {
    const { watch } = watchWith(() => true)
    watch.updateSettings({ own_subreddits: ['r/ivraxr'] })
    await watch.runNow()
    const got = watch.next({ connected: true, via: 'ego' })
    const res = await runRedditRead(got.job as never, {
      fetch: fakeReddit(undefined),
      sleep: async () => undefined,
      stopped: () => false,
      gapMs: 0,
    })
    await watch.result(got.job?.id ?? '', res)
    expect(watch.draftState()).toMatchObject({
      plugin_ready: false,
      plugin_why: 'ego 里的 Reddit 没登录品牌号',
    })
    expect(
      await watch.readOnce([{ key: 'k', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 1 }]),
    ).toEqual({
      ok: false,
      why: 'ego 里的 Reddit 没登录品牌号',
    })
    expect(watch.sessionReady()).toBeUndefined()
  })
  it('ego 不能用：和原来一样（插件没配对就出连接卡、插件来问照常领活）', async () => {
    const { watch, connects } = watchWith(() => false)
    watch.updateSettings({ own_subreddits: ['r/ivraxr'] })
    const run = await watch.runNow()
    expect(run.parts.find((p) => p.part === 'inbox')?.status).toBe('needs_connection')
    expect(connects).toHaveLength(1)
  })
  it('ego 替插件领活整条跑通：现读（read_reddit 第三路）由 ego 读回', async () => {
    const { watch } = watchWith(() => true)
    const ego = {
      fetch: vi.fn(async (_start: string, urls: readonly string[]) => ({
        ok: true as const,
        responses: await Promise.all(
          urls.map(async (u) => {
            const r = await fakeReddit('ivra_official')(u)
            return {
              url: u,
              status: r.status,
              final_url: u,
              content_type: r.content_type,
              body: r.body,
            }
          }),
        ),
      })),
    }
    const pump = createEgoRedditPump({
      watch: () => watch,
      ready: () => true,
      run: (job) => egoRedditRead(job, { reader: ego, gapMs: 0 }),
      setTimer: () => ({ cancel: () => undefined }),
    })
    const pending = watch.readOnce(
      [{ key: 'adhoc', kind: 'sub_new', subreddit: 'ivraxr', max_pages: 1 }],
      {
        timeoutMs: 5_000,
        pollMs: 5,
      },
    )
    await Promise.resolve()
    await pump.kick()
    const got = await pending
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.result.parts[0]?.items[0]?.name).toBe('t1_c1')
    // 第一趟就是这一件现读（之后还会顺手看一眼登着哪个号）
    expect(ego.fetch.mock.calls[0]?.[1]).toContain(
      'https://old.reddit.com/r/ivraxr/new/.json?limit=100&raw_json=1',
    )
    pump.stop()
  })
})

describe('岗位页：ego 能做的不催装插件', () => {
  const ROLES: Record<string, BrowserExtensionUse[]> = {
    'social.reddit': ['reddit'],
    'social.publish': ['social'],
    'kol.find': ['kol'],
  }
  const make = (held: string[], covers: BrowserExtensionUse[]) => {
    const log: string[] = []
    const ob = createExtensionOnboarding({
      role: (id) => ({
        id: id as never,
        name: { zh: id, en: id },
        browser_extension: { uses: ROLES[id] ?? [] },
      }),
      heldRoleIds: () => held,
      paired: () => false,
      stepDone: async () => false,
      planTarget: async (_ws, target) =>
        target === 'reddit.watch' ? { name: 'Reddit 巡查', satisfied: false } : undefined,
      askPlan: async () => ({}),
      snoozedToday: () => false,
      recordSnooze: () => undefined,
      prompted: () => false,
      askConnect: async () => {
        log.push('card')
        return { card_id: 'c', reused: false }
      },
      note: (_ws, _m, text) => {
        log.push(text)
      },
      recordPrompt: () => undefined,
      egoCovers: () => covers,
    })
    return { ob, log }
  }
  const actor = {
    workspace_id: 'ws_1' as never,
    person_id: 'p',
    assignment_id: 'a',
    role_id: 'social.reddit',
  }
  it('社媒岗位（Reddit + 发帖）ego 全能做：插件备用，不出装插件卡；巡查方案卡照样有', async () => {
    const { ob, log } = make(['social.reddit', 'social.publish'], ['reddit', 'social'])
    const v = await ob.needs(actor)
    expect(v).toMatchObject({
      needed: true,
      uses: [],
      steps: [],
      plugin_backup: true,
      ego_covers: ['reddit', 'social'],
      plans: [{ target: 'reddit.watch', satisfied: false }],
    })
    expect(await ob.nudge({ actor, matter_id: 'm1' })).toBe(false)
    expect(log).toEqual([])
  })
  it('还有 ego 做不了的（收红人）：只为那一样催', async () => {
    const { ob, log } = make(['social.reddit', 'kol.find'], ['reddit', 'social'])
    const v = await ob.needs(actor)
    expect(v).toMatchObject({ uses: ['kol'], ego_covers: ['reddit'], steps: [] })
    expect(v.plugin_backup).toBeUndefined()
    expect(
      await ob.nudge({ actor, matter_id: 'm1', role_ids: ['social.reddit', 'kol.find'] }),
    ).toBe(true)
    expect(log[0]).toContain('收红人')
    expect(log[0]).not.toContain('Reddit')
  })
  it('ego 不能用：照旧催', async () => {
    const { ob } = make(['social.reddit'], [])
    const v = await ob.needs(actor)
    expect(v).toMatchObject({ uses: ['reddit'], steps: [{ step: 'reddit', done: false }] })
    expect(v.plugin_backup).toBeUndefined()
    expect(v.ego_covers).toBeUndefined()
  })
})

describe('read_reddit：ego 先读', () => {
  const request = { id: 'run_1' } as RunRequest
  const item = {
    name: 't3_p1',
    kind: 'post' as const,
    author: 'alice',
    subreddit: 'ivraxr',
    title: 'Battery?',
    text: 'x',
    url: 'https://www.reddit.com/r/ivraxr/comments/p1/x/',
    created_utc: 1_760_000_000,
  }
  const exec = (
    pluginRead: Parameters<typeof createResearchToolExecutor>[0]['pluginRead'],
    callData = vi.fn(async () => {
      throw new Error('no cloud')
    }),
  ) =>
    createResearchToolExecutor({
      route: () => ({ order: ['workshop', 'browser_readonly'], disabled: [] }),
      limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
      nowMs: () => Date.parse('2026-10-23T10:00:00.000Z'),
      callData,
      pluginRead,
      egoFirst: () => true,
    })
  it('ego 读到了：不走云端（不花积分）', async () => {
    const callData = vi.fn(async () => {
      throw new Error('should not be called')
    })
    const res = await exec(
      async () => ({ ok: true, parts: [{ ok: true, items: [item] }] }),
      callData,
    )({
      name: 'read_reddit',
      input: { subreddit: 'ivraxr' },
      request,
    })
    expect(callData).not.toHaveBeenCalled()
    expect(res.data).toMatchObject({ rows: 1, source: { route: 'extension' } })
  })
  it('ego 没读到、前两路也不行：叫人在 ego 里登录，不叫人装插件；ego 不再读第二次', async () => {
    const pluginRead = vi.fn(async () => ({
      ok: false as const,
      why: 'ego 里的 Reddit 没登录品牌号',
    }))
    const res = await exec(pluginRead)({
      name: 'read_reddit',
      input: { subreddit: 'ivraxr' },
      request,
    })
    const missing = (res.data as { missing: string }).missing
    expect(missing).toContain('ego 里登录 Reddit')
    expect(missing).not.toContain('Agents 工坊助手')
    expect(pluginRead).toHaveBeenCalledTimes(1)
  })
})
