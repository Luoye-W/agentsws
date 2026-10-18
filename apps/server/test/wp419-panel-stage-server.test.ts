/**
 * WP419（自查 R5 / U17）：新用户第一次巡查后**卡在哪一步，侧边栏照实说**——真服务进程 + 替身插件读替身 Reddit JSON
 * （不起浏览器、不连 Reddit）。
 *
 * 读到 alice 的回复 → 「先在你的浏览器里读整串」→ 读完了口吻还没定 →「1 条等你先定品牌号怎么说话」（带工坊里那张卡）→
 * 定了 → 出「发出去」卡、卡在哪那一行消失；卡上带 WP411 的整串信息（品牌号在这串里说过几次）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PanelSnapshot, type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const NOW_S = Math.floor(T0 / 1000)
const EXT_ORIGIN = 'chrome-extension://mlbfinfiigagllemohnopbhfdghagijg'
let server: Server
let dir: string

const call = async (path: string, init: RequestInit & { plugin?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.plugin !== undefined) {
    headers.set('Origin', EXT_ORIGIN)
    if (init.plugin !== '') headers.set('Authorization', `Bearer ${init.plugin}`)
  } else {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }))
}
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const cm = (id: string, author: string, body: string, parent: string, ago: number) => ({
  kind: 't1',
  data: {
    id,
    name: `t1_${id}`,
    author,
    body,
    subreddit: 'ivraxr',
    link_id: 't3_abc',
    parent_id: parent,
    link_title: 'Does the Air3 work with glasses?',
    permalink: `/r/ivraxr/comments/abc/slug/${id}/`,
    created_utc: NOW_S - ago,
  },
})
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([
    {
      ...cm('c1', 'alice', 'Does the Air3 work with prescription frames?', 't1_ours', 900),
      data: {
        ...cm('c1', 'alice', 'Does the Air3 work with prescription frames?', 't1_ours', 900).data,
        type: 'comment_reply',
        context: '/r/ivraxr/comments/abc/slug/c1/?context=3',
      },
    },
  ]),
  // 整串：原帖 + 品牌号以前那一条 + alice 回它的这一条
  '/comments/abc/.json': [
    listing([
      {
        kind: 't3',
        data: {
          id: 'abc',
          name: 't3_abc',
          title: 'Does the Air3 work with glasses?',
          selftext: '',
          author: 'carol',
          subreddit: 'ivraxr',
          permalink: '/r/ivraxr/comments/abc/slug/',
          created_utc: NOW_S - 86_400,
        },
      },
    ]),
    listing([
      cm('ours', 'ivra_official', 'We have a clip-on insert for most frames.', 't3_abc', 7200),
      cm('c1', 'alice', 'Does the Air3 work with prescription frames?', 't1_ours', 900),
    ]),
  ],
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const path = new URL(url).pathname
  const body = ROUTES[path] ?? (/\.json$/u.test(path) ? listing([]) : undefined)
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pairPlugin(): Promise<string> {
  const made = await data<{ code: string }>(
    await call('/v1/extension/pairings', { method: 'POST', body: '{}' }),
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp419-stage-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(T0).toISOString() },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })
  server.roles.assignments.create({
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

describe('WP419 侧边栏照实说起草卡在哪一步', () => {
  it('等读整串 → 等你定口吻（带卡）→ 定了出卡、那一行消失；卡上带「品牌号在这串里说过」', async () => {
    const ws = server.bootstrap.workspace.id
    const brand = await server.brands.forWorkspace(ws)
    const rw = brand.redditWatch
    if (rw === undefined || brand.redditPersona === undefined) throw new Error('没装')
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    const token = await pairPlugin()
    const panel = async () =>
      data<PanelSnapshot>(await call('/v1/extension/panel', { plugin: token }))
    const read = async () => {
      const got = rw.next({ connected: true })
      if (got.job === undefined) return false
      await rw.result(
        got.job.id,
        await runRedditRead(got.job, {
          fetch: fakeFetch,
          sleep: async () => {},
          stopped: () => false,
          gapMs: 0,
        }),
      )
      await sleep(30)
      return true
    }

    // 第一轮：读收件箱 / 自家版块
    let got = rw.next({ connected: true })
    for (let i = 0; i < 50 && got.job === undefined; i += 1) {
      if (i === 3) await rw.runNow()
      await sleep(20)
      got = rw.next({ connected: true })
    }
    if (got.job === undefined) throw new Error('没领到巡查的活')
    await rw.result(
      got.job.id,
      await runRedditRead(got.job, {
        fetch: fakeFetch,
        sleep: async () => {},
        stopped: () => false,
        gapMs: 0,
      }),
    )
    await sleep(30)
    // 插件在线 → 先读整串：侧边栏说「先在你的浏览器里读整串」
    let snap = await panel()
    expect(snap.progress.stage).toMatchObject({ kind: 'reading_thread', count: 1 })
    expect(snap.progress.drafting).toBe(0)

    // 插件来把整串读了 → 口吻没定：「1 条等你先定品牌号怎么说话」，带工坊里那张卡
    expect(await read()).toBe(true)
    let persona = server.txn.runtime.store
      .listApprovals({ workspace_id: ws, kind: 'setup_request' })
      .find((x) => x.title.startsWith('品牌号怎么说话'))
    for (let i = 0; i < 50 && persona === undefined; i += 1) {
      await sleep(40)
      persona = server.txn.runtime.store
        .listApprovals({ workspace_id: ws, kind: 'setup_request' })
        .find((x) => x.title.startsWith('品牌号怎么说话'))
    }
    snap = await panel()
    expect(snap.progress.stage).toMatchObject({
      kind: 'needs_persona',
      count: 1,
      card_id: persona?.id,
    })
    expect(snap.progress.stage?.text).toContain('品牌号怎么说话')
    expect(snap.cards).toHaveLength(0)

    // 定了 → 起草出卡，那一行消失；卡上带「品牌号在这串里说过」
    await brand.redditPersona.setupTarget().apply({ stance: 'team' })
    for (let i = 0; i < 50 && snap.cards.length === 0; i += 1) {
      await sleep(40)
      snap = await panel()
    }
    expect(snap.cards).toHaveLength(1)
    expect(snap.progress.stage).toBeUndefined()
    expect(snap.cards[0]?.prior_replies?.[0]?.text).toContain('clip-on insert')
  })
})
