/**
 * WP413：插件侧边栏一整圈（真服务进程、落盘、stub；插件那一侧用替身直接调动作通道，**不起浏览器、不连 Reddit**——
 * 真浏览器那一段在 `scripts/e2e-wp413-sidepanel.mjs`）。
 *
 * 巡查读过一轮（进度：读了几条、几点读完、下次几点）→ 出一张「发出去」卡 → 侧边栏里看到这张卡 →
 * 改草稿、点「填进页面」（插件里批 = 工坊里批：同一张卡、via=extension、批的人是配对时绑定的那个人）→
 * **不等取消窗口**马上交给插件 → 插件填好、人点发送、读回 → 侧边栏这一条「已发 · 已记录」、发出记录记「在插件里批的」。
 * 另：工坊里先批了，侧边栏那张就收起，再点回 409。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PanelSnapshot, type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
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

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([]),
  '/r/ivraxr/new/.json': listing([]),
  '/r/ivraxr/comments/.json': listing([]),
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const body = ROUTES[new URL(url).pathname]
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}

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

async function stage(text: string): Promise<string> {
  const out = await data<{ staged: boolean; approval_item_id: string; message?: string }>(
    await call('/v1/social/reddit/stage', {
      method: 'POST',
      body: JSON.stringify({ target: replyTarget, text }),
    }),
  )
  expect(out.staged, out.message).toBe(true)
  return out.approval_item_id
}

async function pairPlugin(): Promise<string> {
  const made = await data<{ code: string }>(
    await call('/v1/extension/pairings', { method: 'POST', body: '{}', owner: true }),
  )
  const issued = await data<{ token: string; scopes: string[] }>(
    await call('/v1/extension/pair', {
      method: 'POST',
      plugin: '',
      body: JSON.stringify({ code: made.code }),
    }),
  )
  expect(issued.scopes).toEqual(expect.arrayContaining(['reddit.read', 'reddit.write']))
  return issued.token
}

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

beforeEach(async () => {
  t = T0
  dir = mkdtempSync(join(tmpdir(), 'wp413-panel-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
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
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP413 插件侧边栏 × 真服务', () => {
  it('看进度 → 改草稿 → 填进页面（不等取消窗口）→ 插件填、人点、读回 → 已发 · 已记录（在插件里批的）', async () => {
    const b = await brand()
    const rw = b.redditWatch
    if (rw === undefined) throw new Error('没装 Reddit 巡查')
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    const token = await pairPlugin()

    // 巡查跑一轮（插件交回：收件箱 1 条、自家版块 0 条）
    let got = rw.next({ connected: true })
    for (let i = 0; i < 50 && got.job === undefined; i += 1) {
      if (i === 5) await rw.runNow()
      await new Promise((r) => setTimeout(r, 20))
      got = rw.next({ connected: true })
    }
    if (got.job === undefined) throw new Error('没领到巡查的活')
    const read = await runRedditRead(got.job, {
      fetch: fakeFetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    await rw.result(got.job.id, read)

    const id = await stage('Hi Alice — the Air3 fits over most frames.')
    // 插件来过一次（连着 Reddit），之后交出去的活它领得到
    await b.adsActions?.next(['reddit'], 0)

    // ① 看：进度 + 这张卡
    const snap = await data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    expect(snap.can_act).toBe(true)
    expect(snap.progress.configured).toBe(true)
    expect(snap.progress.account).toBe('ivra_official')
    expect(snap.progress.last_run?.finished_at).toBeDefined()
    expect(snap.progress.reading).toBe(false)
    expect(Date.parse(snap.progress.next_run_at ?? '')).toBeGreaterThan(T0)
    expect(snap.cards.map((c) => c.id)).toEqual([id])
    expect(snap.cards[0]?.draft.text).toContain('Air3')

    // ② 改草稿、填进页面
    const filled = await data<{ ok: boolean; write?: { state: string; job_id: string } }>(
      await call(`/v1/extension/panel/cards/${id}/fill`, {
        method: 'POST',
        plugin: token,
        body: JSON.stringify({
          text: 'Hi Alice — edited in Chrome.',
          version: snap.cards[0]?.version,
        }),
      }),
    )
    // WP432：批了 = 等你在插件里打开（插件不自己开页面）
    expect(filled).toMatchObject({ ok: true, write: { state: 'awaiting' } })
    const item = await server.txn.approvals.get(id)
    expect(item?.decision).toMatchObject({ via: 'extension', by: server.bootstrap.person.id })
    expect(item?.state).toBe('applied')

    // ③ WP432：定时领活领不到；人点「打开这一条」才拿到（没等 120 秒）——填的是改过的那一版
    expect((await b.adsActions?.next(['reddit'], 0))?.job).toBeUndefined()
    const opened = await data<{ ok: boolean; job?: { id: string; plan: unknown } }>(
      await call(`/v1/extension/panel/writes/${filled.write?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    const job = opened.job
    expect(job?.id).toBe(filled.write?.job_id)
    expect(JSON.stringify(job?.plan)).toContain('edited in Chrome')
    const mid = await data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    expect(mid.cards).toEqual([])
    expect(mid.writes[0]).toMatchObject({ approval_item_id: id, via_extension: true })

    // ④ 人点发送、插件读回
    b.adsActions?.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_new1', permalink: '/r/ivraxr/comments/abc/slug/new1/' },
    })
    const done = await data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    expect(done.writes[0]).toMatchObject({ state: 'sent', via_extension: true })
    expect(done.writes[0]?.record_id).toBeDefined()
    expect(done.records[0]).toMatchObject({
      action: 'reply',
      content: 'Hi Alice — edited in Chrome.',
      via_extension: true,
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/new1/',
    })
    const rows = await data<{ approved_via?: string; approval_item_id?: string }[]>(
      await call('/v1/outbound/records'),
    )
    expect(rows.find((r) => r.approval_item_id === id)?.approved_via).toBe('extension')
  })

  it('谁先处理算谁的：工坊里先批了，侧边栏那张收起；再点「填进页面」/「不发」回 409', async () => {
    const token = await pairPlugin()
    const first = await stage('Hi Alice — first card.')
    const before = await data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    expect(before.cards.map((c) => c.id)).toEqual([first])

    const fresh = await server.txn.approvals.get(first)
    const tok = fresh?.deliveries.find((d) => d.status === 'sent')?.decision_token as string
    await server.txn.approvals.decide(first, server.bootstrap.person.id, {
      action: 'approve',
      decision_token: tok,
      via: 'workstation',
    })
    const after = await data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    expect(after.cards).toEqual([])
    for (const act of ['fill', 'skip'])
      expect(
        (
          await call(`/v1/extension/panel/cards/${first}/${act}`, {
            method: 'POST',
            plugin: token,
            body: '{}',
          })
        ).status,
      ).toBe(409)

    // 插件里点「不发」= 工坊里驳回：卡在工坊那边也收起
    const second = await stage('Hi Alice — second card.')
    const skipped = await call(`/v1/extension/panel/cards/${second}/skip`, {
      method: 'POST',
      plugin: token,
      body: '{}',
    })
    expect(skipped.status).toBe(200)
    expect((await server.txn.approvals.get(second))?.decision).toMatchObject({
      action: 'reject',
      via: 'extension',
    })
  })
})
