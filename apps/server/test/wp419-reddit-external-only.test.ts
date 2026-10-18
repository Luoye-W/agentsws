/**
 * WP419（自查 R4）：**只担「外部版块」**（公关 `pr.reddit`，公关岗位默认勾的那条）也要巡查、也要起草——
 * 以前巡查的执行人只认官方版块 `social.reddit`，插件配好了也什么都不发生。
 * 两人分担时：外部读到的草稿归担外部版块的人，收件箱 / 自家版块的归担官方版块的人。
 * 替身插件读替身 Reddit JSON，不打开真 Reddit。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const NOW_S = Math.floor(T0 / 1000)
let server: Server
let dir: string

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([
    {
      kind: 't1',
      data: {
        id: 'c9',
        name: 't1_c9',
        type: 'comment_reply',
        author: 'alice',
        body: 'does it work with iPhone?',
        subreddit: 'ivraxr',
        link_id: 't3_post1',
        parent_id: 't1_o1',
        link_title: 'Air3 setup tips',
        permalink: '/r/ivraxr/comments/post1/air3_setup/c9/',
        created_utc: NOW_S - 600,
      },
    },
  ]),
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const path = new URL(url).pathname
  const body = ROUTES[path] ?? (/\.json$/u.test(path) ? listing([]) : undefined)
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp419-ext-only-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(T0).toISOString() },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const assign = (role_id: string) =>
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id,
  })

async function patrolOnce(): Promise<void> {
  const rw = (await server.brands.forWorkspace(server.bootstrap.workspace.id)).redditWatch
  if (rw === undefined) throw new Error('没装巡查')
  for (let i = 0; i < 6; i += 1) {
    let got = rw.next({ connected: true })
    if (got.job === undefined && i === 0) {
      await rw.runNow()
      got = rw.next({ connected: true })
    }
    if (got.job !== undefined)
      await rw.result(
        got.job.id,
        await runRedditRead(got.job, {
          fetch: fakeFetch,
          sleep: async () => {},
          stopped: () => false,
          gapMs: 0,
        }),
      )
    await sleep(20)
  }
}

describe('WP419 只担「外部版块」也巡查、也起草', () => {
  it('只担 pr.reddit：每日巡查那条定时建了；读到要回的 → 出口吻卡 → 定了出「发出去」卡，记在外部版块那条职责上', async () => {
    const ws = server.bootstrap.workspace.id
    assign('pr.reddit')
    let task = server.schedule.scheduler.get('sched_reddit_patrol')
    for (let i = 0; i < 50 && (task === undefined || task.state !== 'active'); i += 1) {
      await sleep(40)
      task = server.schedule.scheduler.get('sched_reddit_patrol')
    }
    expect(task?.state).toBe('active')

    const brand = await server.brands.forWorkspace(ws)
    const rw = brand.redditWatch
    if (rw === undefined || brand.redditPersona === undefined) throw new Error('没装')
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    await patrolOnce()
    const list = (kind: 'setup_request' | 'outbound_draft') =>
      server.txn.runtime.store.listApprovals({ workspace_id: ws, kind })
    let persona = list('setup_request').find((x) => x.title.startsWith('品牌号怎么说话'))
    for (let i = 0; i < 50 && persona === undefined; i += 1) {
      await sleep(40)
      persona = list('setup_request').find((x) => x.title.startsWith('品牌号怎么说话'))
    }
    expect(persona?.role_id).toBe('pr.reddit')

    await brand.redditPersona.setupTarget().apply({ stance: 'team' })
    let card = list('outbound_draft')[0]
    for (let i = 0; i < 50 && card === undefined; i += 1) {
      await sleep(40)
      card = list('outbound_draft')[0]
    }
    expect(card?.payload).toMatchObject({ form: 'reddit_write', reddit: { kind: 'reply' } })
    expect(card?.role_id).toBe('pr.reddit')
  })

  it('两条都有人担：收件箱那条的草稿归官方版块（social.reddit）', async () => {
    const ws = server.bootstrap.workspace.id
    assign('pr.reddit')
    assign('social.reddit')
    const brand = await server.brands.forWorkspace(ws)
    const rw = brand.redditWatch
    if (rw === undefined || brand.redditPersona === undefined) throw new Error('没装')
    brand.redditPersona.set({ stance: 'team' })
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    await patrolOnce()
    const list = () =>
      server.txn.runtime.store.listApprovals({ workspace_id: ws, kind: 'outbound_draft' })
    let card = list()[0]
    for (let i = 0; i < 50 && card === undefined; i += 1) {
      await sleep(40)
      card = list()[0]
    }
    expect(card?.role_id).toBe('social.reddit')
  })
})
