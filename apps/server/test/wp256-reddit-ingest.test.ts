/**
 * WP256（决策 147）：Reddit 自家版新帖自动进「群里的帖子」，端到端（起真进程 → 打 HTTP；Reddit 一侧是内存里的
 * old.reddit 替身，**不访问 reddit.com、不起浏览器**）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 打开「自家版待处理」读队列那一次，`unmoderated` 里的新帖顺手记成线程；不判类、不出卡 | 复用 WP249 的读 |
 * | 同一条只记一次（按 fullname）；只被举报的旧帖（只在 modqueue）不算新帖 | 去重 |
 * | 没人看视图：定时那一拍一小时最多补读一页（只读新帖那一页）；视图刚读过就不补读 | 读的频率不增加 |
 * | 没登记成自家版的版一页都不读；被拦（验证码）照实记下 | 只对自家版、限速照旧 |
 * | `GET /v1/social/ingest`：Reddit 没接上 / Discord 没连上照实说 | 空态照实说 |
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createFakeOldReddit, type FakeOldReddit } from '../src/reddit-official-browser/stand-in.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const ORIGIN = 'https://old.reddit.com'
const MIN = 60_000

let server: Server
let url: string
let reddit: Assignment
let discord: Assignment
let site: FakeOldReddit
let t = Date.parse(T0)

const api = async (path: string, init: RequestInit = {}, as?: Assignment): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', (as ?? reddit).id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}, as?: Assignment): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, as)
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

/** 社媒那条每 5 分钟的定时（真按调度器跑那条任务：先定时发布，再顺手自动进帖）。 */
const tick = async () => server.schedule.scheduler.runNow('sched_social_publish')

const unmoderatedReads = () => site.visited.filter((p) => p.includes('/about/unmoderated')).length

const cardCount = async (): Promise<number> =>
  (await server.txn.runtime.store.listApprovals({ workspace_id: server.bootstrap.workspace.id }))
    .length

interface ThreadRow {
  id: string
  external_id: string
  text: string
  triage?: string
  triage_by?: string
  account_name: string
}
const threads = async (): Promise<ThreadRow[]> =>
  (await data<{ rows: ThreadRow[] }>(await api('/v1/social/threads?channel=reddit&open=true'))).rows

beforeEach(async () => {
  t = Date.parse(T0)
  site = createFakeOldReddit(ORIGIN)
  site.queues.unmoderated = [
    {
      kind: 't3',
      id: 'new1',
      title: 'First impressions',
      body: 'Hinge feels solid.',
      author: 'amy',
      reports: [],
    },
    {
      kind: 't3',
      id: 'new2',
      title: 'Battery?',
      body: 'How long does it last?',
      author: 'ben',
      reports: [],
    },
  ]
  // 只被举报、不在新帖队列里的旧帖：不是「新帖」
  site.queues.modqueue = [
    {
      kind: 't3',
      id: 'old9',
      title: 'Old post',
      body: 'buy cheap here',
      author: 'spam',
      reports: ['spam'],
    },
  ]
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    redditOfficialBrowser: {
      origin: ORIGIN,
      openPage: site.opener(),
      sleep: async () => undefined,
    },
  })
  ;({ url } = await server.listen(0))
  const grant = (role_id: string) =>
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id,
    })
  reddit = grant('social.reddit')
  discord = grant('social.discord')
})

afterEach(async () => {
  await server.close()
})

async function registerOwnSub(own = true): Promise<string> {
  const account = await data<{ id: string }>(
    await post('/v1/social/accounts', {
      channel: 'reddit',
      handle: 'r/inmoxr',
      display_name: 'INMO XR',
      url: 'https://www.reddit.com/r/inmoxr/',
      external_id: 'inmoxr',
      own_subreddit: own,
    }),
  )
  return account.id
}

async function login(): Promise<void> {
  await post('/v1/social/reddit-browser/login')
  site.loggedIn = true
  await post('/v1/social/reddit-browser/check')
}

describe('WP256 Reddit 自家版新帖进「群里的帖子」', () => {
  it('读队列那一次顺手记新帖：不判类、不出卡；再读不重记；被举报的旧帖不算', async () => {
    await registerOwnSub()
    await login()
    const cardsBefore = await cardCount()
    await api('/v1/social/own-sub/queue')
    const rows = await threads()
    expect(rows.map((r) => r.external_id).sort()).toEqual(['t3_new1', 't3_new2'])
    expect(rows.find((r) => r.external_id === 't3_new1')).toMatchObject({
      id: 'ct_reddit_t3_new1',
      text: 'First impressions\nHinge feels solid.',
      account_name: 'INMO XR',
    })
    // WP257（决策 152）：入库就按规则打标签（仍不出卡、不转客服）
    expect(rows.every((r) => r.triage !== undefined && r.triage_by === 'rule')).toBe(true)
    expect(await cardCount()).toBe(cardsBefore)

    // 再读一次：一条都不多；「回复」那条口子拿到的是同一行
    await api('/v1/social/own-sub/queue')
    expect(await threads()).toHaveLength(2)
    const again = await data<{ thread_id: string }>(
      await post('/v1/social/own-sub/thread', {
        account_id: (await data<{ rows: { id: string }[] }>(await api('/v1/social/accounts')))
          .rows[0]?.id,
        item_id: 't3_new1',
      }),
    )
    expect(again.thread_id).toBe('ct_reddit_t3_new1')
    expect(await threads()).toHaveLength(2)

    const view = await data<{ connected: boolean; accounts: { state: string }[] }>(
      await api('/v1/social/ingest?channel=reddit'),
    )
    expect(view).toMatchObject({ auto: true, connected: true, accounts: [{ state: 'ok' }] })
  })

  it('没人看视图：定时那一拍一小时最多补读一页新帖；视图刚读过就不补读', async () => {
    await registerOwnSub()
    await login()
    await tick()
    expect(unmoderatedReads()).toBe(1)
    // 补读只读新帖那一页（不读 modqueue、不读版规）
    expect(site.visited.filter((p) => p.includes('/about/modqueue'))).toEqual([])
    expect(await threads()).toHaveLength(2)

    t += 30 * MIN
    await tick()
    expect(unmoderatedReads()).toBe(1)

    site.queues.unmoderated.push({
      kind: 't3',
      id: 'new3',
      title: 'Third',
      body: 'Any update on shipping?',
      author: 'cat',
      reports: [],
    })
    t += 31 * MIN
    await tick()
    expect(unmoderatedReads()).toBe(2)
    expect((await threads()).map((r) => r.external_id)).toContain('t3_new3')

    // 视图读过（算一次读）→ 一小时内定时不再补读
    t += 61 * MIN
    await api('/v1/social/own-sub/queue')
    const afterView = unmoderatedReads()
    t += 10 * MIN
    await tick()
    expect(unmoderatedReads()).toBe(afterView)
  })

  it('没标成自家版的版、没接上：一页都不读，视图照实说没接上', async () => {
    await registerOwnSub(false)
    await login()
    await tick()
    expect(unmoderatedReads()).toBe(0)

    await server.close()
    site = createFakeOldReddit(ORIGIN)
    server = await createServer({
      quiet: true,
      clock: { now: () => new Date(t).toISOString() },
      scheduleIntervalMs: 0,
      startRun: false,
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
      redditOfficialBrowser: {
        origin: ORIGIN,
        openPage: site.opener(),
        sleep: async () => undefined,
      },
    })
    ;({ url } = await server.listen(0))
    reddit = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id: 'social.reddit',
    })
    await registerOwnSub()
    await tick()
    expect(site.visited).toEqual([])
    const view = await data<{ connected: boolean; accounts: { state: string }[] }>(
      await api('/v1/social/ingest?channel=reddit'),
    )
    expect(view).toMatchObject({ connected: false, accounts: [{ state: 'not_connected' }] })
  })

  it('被拦（验证码）：照实记下、不重试；Discord 没连上照实说', async () => {
    await registerOwnSub()
    await login()
    site.captchaNext = true
    await tick()
    const view = await data<{ accounts: { state: string; message?: string }[] }>(
      await api('/v1/social/ingest?channel=reddit'),
    )
    expect(view.accounts[0]?.state).toMatch(/limited|failed/u)
    expect(view.accounts[0]?.message).toBeTruthy()
    expect(await threads()).toEqual([])

    const dc = await data<{ connected: boolean; auto: boolean; every_minutes: number }>(
      await api('/v1/social/ingest?channel=discord', {}, discord),
    )
    expect(dc).toMatchObject({ connected: false, auto: true, every_minutes: 15 })
    // 改频率：只认 5 分钟到 24 小时
    const bad = await api(
      '/v1/social/ingest',
      { method: 'PUT', body: JSON.stringify({ channel: 'discord', every_minutes: 1 }) },
      discord,
    )
    expect(bad.status).toBe(400)
    const good = await api(
      '/v1/social/ingest',
      { method: 'PUT', body: JSON.stringify({ channel: 'discord', every_minutes: 30 }) },
      discord,
    )
    expect(await data<{ every_minutes: number }>(good)).toMatchObject({ every_minutes: 30 })
    const missing = await api('/v1/social/ingest', {}, discord)
    expect(missing.status).toBe(400)
  })
})
