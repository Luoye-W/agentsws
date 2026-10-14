/**
 * WP329 × WP328 一整圈（真服务进程；插件那一侧用真执行器读替身 Reddit JSON、写那一侧直接回报结局；
 * **不打开真 Reddit、不起浏览器**——真浏览器那一段在 `scripts/e2e-ext-reddit.mjs`）：
 *
 * 巡查读到一条要回的（收件箱里有人回了我们）→ 自动起草出一张「发出去」卡（条目标「起草中」，版规来自插件只读）
 * → 人批 → 过取消窗口交给插件（与巡查共用一本账）→ 插件填好、人点发送、读回编号与链接
 * → 发出记录多一行（`external_id` 是 Reddit 全名）→ 条目标「回过了」并挂上那一行。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
let t = T0
let server: Server
let dir: string

const NOW_S = Math.floor(T0 / 1000)
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'inmo_official' } },
  '/r/inmoxr/about/rules.json': {
    rules: [{ short_name: 'No referral links', description: 'Do not post affiliate links.' }],
  },
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
        link_id: 't3_p1',
        link_title: 'Air3 setup tips',
        context: '/r/inmoxr/comments/p1/air3_setup/c9/?context=3',
        created_utc: NOW_S - 600,
      },
    },
  ]),
  '/r/inmoxr/new/.json': listing([]),
  '/r/inmoxr/comments/.json': listing([]),
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const body = ROUTES[new URL(url).pathname]
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}

async function approve(id: string): Promise<void> {
  const fresh = await server.txn.approvals.get(id)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

const records = async (): Promise<
  { id: string; external_id?: string; parent_external_id?: string }[]
> =>
  (
    (await (
      await server.gateway.fetch(
        new Request('http://127.0.0.1/v1/outbound/records', {
          headers: {
            Authorization: `Bearer ${server.bootstrap.internalToken}`,
            'X-Assignment': server.bootstrap.ownerAssignment.id,
          },
        }),
      )
    ).json()) as { data: { id: string; external_id?: string; parent_external_id?: string }[] }
  ).data

beforeEach(async () => {
  t = T0
  dir = mkdtempSync(join(tmpdir(), 'wp329-loop-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
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

describe('WP329 × WP328：巡查出一条要回 → 起草出卡 → 批 → 插件填、人点 → 读回 → 条目回过了、发出记录有行', () => {
  it('一整圈', async () => {
    const ws = server.bootstrap.workspace.id
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: ws,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id: 'social.reddit',
    })
    const brand = await server.brands.forWorkspace(ws)
    const rw = brand.redditWatch
    if (rw === undefined) throw new Error('没装 Reddit 巡查')
    rw.updateSettings({ own_subreddits: ['inmoxr'], brand_username: 'inmo_official' })

    // ① 巡查：插件来问 → 读替身 Reddit → 交回
    // 插件刚连上会马上起一轮（异步）；没起就点一次「现在巡查」
    // （刚连上的那一次 next 会当场起一轮、当场把活发下来）
    let got = rw.next({ connected: true })
    for (let i = 0; i < 50 && got.job === undefined; i += 1) {
      if (i === 5) await rw.runNow()
      await new Promise((r) => setTimeout(r, 20))
      got = rw.next({ connected: true })
    }
    if (got.job === undefined) throw new Error('没领到巡查的活')
    const res = await runRedditRead(got.job, {
      fetch: fakeFetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    expect(res.outcome).toBe('done')
    await rw.result(got.job.id, res)
    const entry = rw.items({ reply: true }).find((x) => x.fullname === 't1_c9')
    expect(entry?.judgement?.reply).toBe(true)
    // 版规是插件只读读回来的（决策 764）
    expect(rw.rules('inmoxr')?.rules).toEqual(['No referral links：Do not post affiliate links.'])

    // ② 自动起草出卡（条目标「起草中」）
    let card: ApprovalItem | undefined
    for (let i = 0; i < 50 && card === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      card = server.txn.runtime.store
        .listApprovals({ workspace_id: ws, kind: 'outbound_draft' })
        .find((c) => (c.payload as { form?: string }).form === 'reddit_write')
    }
    if (card === undefined) throw new Error('没出卡')
    expect(card.payload).toMatchObject({
      form: 'reddit_write',
      reddit: {
        kind: 'reply',
        parent_fullname: 't1_c9',
        permalink: '/r/inmoxr/comments/p1/air3_setup/c9/',
        source: { type: 'reddit_watch_item', id: entry?.id },
      },
      rules: ['No referral links：Do not post affiliate links.'],
    })
    expect(card.automation.level_at_creation).toBe('L1')
    expect(rw.item(entry?.id as string)?.status).toBe('drafting')

    // ③ 人批 → 过取消窗口 → 交给插件（还没发，不记发出记录）
    await approve(card.id)
    t += 125_000
    expect(await brand.redditWrites.sweep()).toBe(1)
    expect(await records()).toEqual([])

    // ④ 插件领到、填好、人点发送、读回
    const write = await brand.adsActions?.next(['reddit'], 0)
    const job = write?.job
    expect(job?.plan.kind).toBe('reddit_reply')
    expect(job?.account).toEqual({ platform: 'reddit', id: 'inmo_official' })
    // 与巡查共用一本账：写活占着号时巡查领不到
    await rw.runNow()
    expect(rw.next({ connected: true }).job).toBeUndefined()
    brand.adsActions?.result(job?.id as string, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: { fullname: 't1_new1', permalink: '/r/inmoxr/comments/p1/air3_setup/new1/' },
    })

    // ⑤ 发出记录有行；条目回过了、挂上那一行
    const row = (await records()).find((r) => r.external_id === 't1_new1')
    expect(row?.parent_external_id).toBe('t1_c9')
    expect(rw.item(entry?.id as string)).toMatchObject({
      status: 'done',
      outbound_record_id: row?.id,
    })
  })
})
