/**
 * WP432（Luoye 10-20 反馈 9，最急）：Reddit 发帖回帖改成**插件半自动**——真服务进程、落盘、stub；
 * 插件那一侧用替身直接调接口（**不起浏览器、不连 Reddit**；真浏览器那一段在 `scripts/e2e-wp413-sidepanel.mjs`）。
 *
 * 1. 工坊卡上点「发送」= 批准：过了取消窗口也**不自动开任何页面**——插件的定时领活领不到，卡变「等你在插件里发」，
 *    铃铛里一条「等你发」；
 * 2. 侧边栏是发帖台：这一条带草稿全文、原帖、被回的那句、为什么回；顶上「今天发了几条、等你发几条」；
 * 3. 人点「打开这一条」（在侧边栏里改了字）→ 插件这才拿到那一件（按改过的字）；人在页面上又改了再发 →
 *    读回真发出去的字：发出记录按真发的记、批的那一版进 `draft_content`、差进学习回路；铃铛那条收成已读；
 * 4. 「不发了」也在侧边栏；默认新版 www.reddit.com，侧边栏设置里选旧版才走 old.reddit；
 * 5. 没配对的插件也问得到「文件夹里是哪一版」（跟着工坊更新），工坊看得到它报的版本。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionJob, PanelSnapshot } from '@agentsws/browser-action'
import type { Assignment, NotificationList, OutboundRecord } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-21T09:00:00.000Z')
const EXT_ORIGIN = 'chrome-extension://mlbfinfiigagllemohnopbhfdghagijg'
let t = T0
let server: Server
let dir: string
let reddit: Assignment

const call = async (path: string, init: RequestInit & { plugin?: string; owner?: true } = {}) => {
  const headers = new Headers(init.headers)
  if (init.plugin !== undefined) {
    headers.set('Origin', EXT_ORIGIN)
    if (init.plugin !== '') headers.set('Authorization', `Bearer ${init.plugin}`)
  } else {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set(
      'X-Assignment',
      init.owner === true ? server.bootstrap.ownerAssignment.id : reddit.id,
    )
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }))
}
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const replyTarget = {
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
  inbox_type: 'comment_reply',
}
const DRAFT = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

async function pairPlugin(): Promise<string> {
  const made = await data<{ code: string }>(
    await call('/v1/extension/pairings', { method: 'POST', body: '{}', owner: true }),
  )
  const issued = await data<{ token: string }>(
    await call('/v1/extension/pair', {
      method: 'POST',
      plugin: '',
      body: JSON.stringify({ code: made.code }),
    }),
  )
  return issued.token
}

/** 出卡 → 在工坊里点「发送」（批）→ 过取消窗口施行。回卡 id。 */
async function stageAndSend(text = DRAFT): Promise<string> {
  const staged = await data<{ staged: boolean; approval_item_id: string; message?: string }>(
    await call('/v1/social/reddit/stage', {
      method: 'POST',
      body: JSON.stringify({ target: { ...replyTarget }, text, reason: '在问戴眼镜能不能用' }),
    }),
  )
  expect(staged.staged, staged.message).toBe(true)
  const id = staged.approval_item_id
  const fresh = await server.txn.approvals.get(id)
  const token = fresh?.deliveries.find((d) => d.status === 'sent')?.decision_token as string
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
  t += 125_000
  expect(await (await brand()).redditWrites.sweep()).toBe(1)
  return id
}

const snapshot = (token: string) =>
  call('/v1/extension/panel', { plugin: token }).then((r) => data<PanelSnapshot>(r))

beforeEach(async () => {
  t = T0
  dir = mkdtempSync(join(tmpdir(), 'wp432-assisted-'))
  // 桌面版放插件的固定文件夹（里面是工坊带的那一版）
  const ext = join(dir, 'chrome-extension')
  mkdirSync(ext, { recursive: true })
  writeFileSync(
    join(ext, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.2.1', version_name: '0.2.1-beta.5' }),
  )
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    env: {
      [SECRETS_KEY_ENV]: 'e'.repeat(64),
      AGENTSWS_OWNER_EMAIL: 'owner@example.com',
      AGENTSWS_EXTENSION_DIR: ext,
      AGENTSWS_VERSION: '0.2.1-beta.5',
    },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })
  reddit = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
  ;(await brand()).redditWatch?.updateSettings({ brand_username: 'ivra_official' })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP432 Reddit 写：批了不自动开页面，在插件侧边栏里人发', () => {
  it('批 → 等你在插件里发（领不到、铃铛一条）→ 侧边栏改字打开 → 人在页面上又改了再发 → 按真发的记、差进学习回路', async () => {
    const token = await pairPlugin()
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const id = await stageAndSend()

    // ① 批了不开页面：插件每分钟来领一次，一天都领不到
    for (let i = 0; i < 3; i += 1) {
      expect((await b.adsActions?.next(['reddit'], 0))?.job).toBeUndefined()
      t += 8 * 60 * 60 * 1000
    }
    const card = await server.txn.approvals.get(id)
    expect(card?.state).toBe('applied')

    // 铃铛里「等你发」一条
    await server.notifications.flush()
    const bell = await data<NotificationList>(await call('/v1/notifications?view=unread'))
    const ready = bell.items.find((n) => n.category === 'outbound')
    expect(ready?.text).toContain('等你在浏览器插件里发')

    // ② 侧边栏发帖台：草稿全文、原帖、被回的那句、为什么回；顶上等你发 1 条
    const snap = await snapshot(token)
    const w = snap.writes[0]
    expect(w).toMatchObject({
      state: 'awaiting',
      kind: 'reply',
      text: DRAFT,
      post_title: 'Does the Air3 work with glasses?',
      parent_author: 'alice',
      parent_text: 'Mine fogs up a bit when I wear glasses.',
      reason: '在问戴眼镜能不能用',
      thread_link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
    })
    expect(snap.progress.awaiting).toBe(1)
    expect(snap.progress.sent_today).toBe(0)
    expect('site' in snap).toBe(false)
    expect(snap.notify_system).toBe(true)

    // ③ 侧边栏里改了字、点「打开这一条」→ 插件这才拿到（按改过的字；默认新版 Reddit）
    const SIDE = 'Hi Alice — the Air3 fits over most prescription frames, and the insert helps.'
    const opened = await data<{ ok: boolean; job?: ActionJob; message?: string }>(
      await call(`/v1/extension/panel/writes/${w?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: JSON.stringify({ text: SIDE }),
      }),
    )
    expect(opened.ok, opened.message).toBe(true)
    const job = opened.job as ActionJob
    expect(job.plan.allow.values).toEqual([SIDE])
    expect(job.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
      // WP467：带上帖子 id（已经开着这个帖子就地填）
      post: 'abc',
    })
    expect(job.plan.steps.at(-1)).toMatchObject({ op: 'await_sent', author: 'ivra_official' })
    // 再点一次：已经打开了
    const again = await data<{ ok: boolean; message?: string }>(
      await call(`/v1/extension/panel/writes/${job.id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('已经打开') })

    // ④ 人在页面上又改了一句才点发送 → 读回真发出去的字
    const FINAL = 'Hi Alice, the Air3 fits over most prescription frames. Happy to help!'
    b.adsActions?.result(job.id, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: {
        fullname: 't1_new1',
        permalink: '/r/ivraxr/comments/abc/comment/new1/',
        sent_text: FINAL,
      },
    })
    const records = await data<OutboundRecord[]>(await call('/v1/outbound/records'))
    expect(records[0]).toMatchObject({
      content: FINAL,
      draft_content: DRAFT,
      external_id: 't1_new1',
      approval_item_id: id,
    })
    const done = await snapshot(token)
    expect(done.writes[0]).toMatchObject({ state: 'sent' })
    expect(done.progress).toMatchObject({ sent_today: 1, awaiting: 0 })
    const writes = await data<{ rows: { edited?: boolean; sent_text?: string }[] }>(
      await call('/v1/social/reddit/writes'),
    )
    expect(writes.rows[0]).toMatchObject({ edited: true, sent_text: FINAL })

    // 差进学习回路；铃铛那条收成已读
    const lessons = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'lesson.pooled' && e.payload?.after_send === true)
    expect(lessons.length).toBeGreaterThan(0)
    await server.notifications.flush()
    const after = await data<NotificationList>(await call('/v1/notifications?view=unread'))
    expect(after.items.some((n) => n.category === 'outbound')).toBe(false)
  })

  it('侧边栏里点「不发了」：不开页面、不再提醒；别人的那一条 404', async () => {
    const token = await pairPlugin()
    await stageAndSend()
    const w = (await snapshot(token)).writes[0]
    const nope = await call('/v1/extension/panel/writes/rdw_nope/drop', {
      method: 'POST',
      plugin: token,
      body: '{}',
    })
    expect(nope.status).toBe(404)
    const out = await call(`/v1/extension/panel/writes/${w?.job_id}/drop`, {
      method: 'POST',
      plugin: token,
      body: JSON.stringify({ reason: '这条不合适' }),
    })
    expect(out.status).toBe(200)
    const rows = (
      await data<{ rows: { state: string; outcome?: string; dismissed?: boolean }[] }>(
        await call('/v1/social/reddit/writes'),
      )
    ).rows
    expect(rows[0]).toMatchObject({ state: 'failed', outcome: 'dropped', dismissed: true })
    expect((await (await brand()).adsActions?.next(['reddit'], 0))?.job).toBeUndefined()
  })

  it('WP445（决策 1323）：新版 / 旧版开关去掉了——设置接口没了；一律新版，旧版选择器只作页面兜底', async () => {
    const token = await pairPlugin()
    const set = await call('/v1/extension/panel/settings', {
      method: 'PUT',
      plugin: token,
      body: JSON.stringify({ site: 'old' }),
    })
    expect(set.status).toBe(404)
    await stageAndSend()
    const snap = await snapshot(token)
    const opened = await data<{ job?: ActionJob }>(
      await call(`/v1/extension/panel/writes/${snap.writes[0]?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    expect(opened.job?.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
      // WP467：带上帖子 id（已经开着这个帖子就地填）
      post: 'abc',
    })
    // 每一步先按新版找、找不到再按旧版（www 被跳到 old.reddit 时也填得进去）
    const fill = opened.job?.plan.steps.find((x) => x.op === 'fill')
    expect(fill?.op === 'fill' ? fill.selector : '').toMatch(
      /shreddit-comment.* \|\| #thing_t1_c1/u,
    )
    expect(opened.job?.plan.allow.hosts).toEqual(
      expect.arrayContaining(['www.reddit.com', 'old.reddit.com']),
    )
  })

  it('没配对的插件也问得到文件夹里是哪一版（不要令牌）；工坊看得到它报的版本', async () => {
    const probe = await call('/v1/extension/version/probe', {
      method: 'POST',
      plugin: '',
      body: JSON.stringify({ version: '0.2.1-beta.3' }),
    })
    expect(await data(probe)).toEqual({ folder_version: '0.2.1-beta.5' })
    const view = await data<{ unpaired?: { version: string }; folder_version?: string }>(
      await call('/v1/extension/install', { owner: true }),
    )
    expect(view).toMatchObject({
      folder_version: '0.2.1-beta.5',
      unpaired: { version: '0.2.1-beta.3' },
    })
    // 侧边栏底下也写得出两边的版本
    const token = await pairPlugin()
    expect((await snapshot(token)).versions).toEqual({
      workshop: '0.2.1-beta.5',
      folder: '0.2.1-beta.5',
    })
  })
})

describe('WP432 发出去之后：巡查顺手读回票数，记进发出记录', () => {
  it('品牌号最近 7 天发出去的那几条：巡查时一起查票数（只读一页），记进那一行', async () => {
    const token = await pairPlugin()
    const b = await brand()
    const rw = b.redditWatch
    if (rw === undefined) throw new Error('没装 Reddit 巡查')
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    await b.adsActions?.next(['reddit'], 0)
    await stageAndSend()
    const w = (await snapshot(token)).writes[0]
    const opened = await data<{ job?: ActionJob }>(
      await call(`/v1/extension/panel/writes/${w?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    b.adsActions?.result(opened.job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_new1', permalink: '/r/ivraxr/comments/abc/comment/new1/' },
    })
    t += 60 * 60 * 1000
    const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
    const ROUTES: Record<string, unknown> = {
      '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
      '/message/inbox/.json': listing([]),
      '/r/ivraxr/new/.json': listing([]),
      '/r/ivraxr/comments/.json': listing([]),
      '/api/info.json': listing([
        {
          kind: 't1',
          data: {
            id: 'new1',
            name: 't1_new1',
            author: 'ivra_official',
            body: DRAFT,
            subreddit: 'ivraxr',
            score: 7,
            created_utc: Math.floor(t / 1000) - 3600,
            permalink: '/r/ivraxr/comments/abc/comment/new1/',
          },
        },
      ]),
    }
    const asked: string[] = []
    const fakeFetch = async (url: string) => {
      asked.push(url)
      const body = ROUTES[new URL(url).pathname]
      return body === undefined
        ? { status: 404, url, content_type: 'application/json', body: '{}' }
        : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
    }
    const { runRedditRead } = await import('@agentsws/browser-action')
    let got = rw.next({ connected: true })
    for (let i = 0; i < 50 && got.job === undefined; i += 1) {
      if (i === 5) await rw.runNow()
      await new Promise((r) => setTimeout(r, 20))
      got = rw.next({ connected: true })
    }
    if (got.job === undefined) throw new Error('没领到巡查的活')
    expect(got.job.reads.find((r) => r.kind === 'info')).toMatchObject({
      key: 'scores',
      ids: ['t1_new1'],
      max_pages: 1,
    })
    const read = await runRedditRead(got.job, {
      fetch: fakeFetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    await rw.result(got.job.id, read)
    expect(asked.some((u) => u.includes('/api/info.json?') && u.includes('id=t1_new1'))).toBe(true)
    const records = await data<OutboundRecord[]>(await call('/v1/outbound/records'))
    expect(records[0]).toMatchObject({ external_id: 't1_new1', score: 7 })
  })
})
