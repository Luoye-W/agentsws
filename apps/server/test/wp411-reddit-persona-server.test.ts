/**
 * WP411（#11 第 4 条）：真服务进程里——品牌号怎么说话没定时，巡查出的要回条目**不起草**，先出一张
 * 「品牌号怎么说话：我打算这样设」卡（AI 从品牌号以前的发言里猜：个人口吻 + 原话里的自我介绍）；
 * 定好之后等着的条目重新交给起草、出「发出去」卡。替身插件读替身 Reddit JSON，不打开真 Reddit。
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
const c = (id: string, over: Record<string, unknown>) => ({
  kind: 't1',
  data: {
    id,
    name: `t1_${id}`,
    author: 'alice',
    subreddit: 'ivraxr',
    link_id: 't3_post1',
    parent_id: 't3_post1',
    link_title: 'Air3 setup tips',
    permalink: `/r/ivraxr/comments/post1/air3_setup/${id}/`,
    created_utc: NOW_S - 600,
    ...over,
  },
})
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([
    c('c9', { type: 'comment_reply', parent_id: 't1_o1', body: 'does it work with iPhone?' }),
  ]),
  '/r/ivraxr/comments/.json': listing([
    c('o1', {
      author: 'ivra_official',
      body: 'I used to work at IVRA, so happy to share what I know about the Air3.',
      created_utc: NOW_S - 86_400,
    }),
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
  dir = mkdtempSync(join(tmpdir(), 'wp411-persona-'))
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

describe('WP411 品牌号怎么说话：没定不起草，先出设置卡；定了接着起草', () => {
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
    if (rw === undefined || brand.redditPersona === undefined) throw new Error('没装')
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    // 插件来问几次：巡查那一件、读整串那一件
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
    const list = (kind: 'setup_request' | 'outbound_draft') =>
      server.txn.runtime.store.listApprovals({ workspace_id: ws, kind })
    let setup = list('setup_request').find((x) => x.title.startsWith('品牌号怎么说话'))
    for (let i = 0; i < 50 && setup === undefined; i += 1) {
      await sleep(40)
      setup = list('setup_request').find((x) => x.title.startsWith('品牌号怎么说话'))
    }
    if (setup === undefined) throw new Error('没出「品牌号怎么说话」卡')
    // 卡上：AI 从品牌号以前的发言里猜的个人口吻 + 原话里的自我介绍
    const fields = (setup.payload as { fields: { key: string; suggested?: string }[] }).fields
    expect(fields.find((f) => f.key === 'stance')?.suggested).toBe('personal')
    expect(fields.find((f) => f.key === 'intro')?.suggested).toBe(
      'I used to work at IVRA, so happy to share what I know about the Air3',
    )
    // 没定之前一张「发出去」卡都没有，条目还开着
    expect(list('outbound_draft')).toHaveLength(0)
    expect(rw.items({ reply: true }).find((x) => x.fullname === 't1_c9')?.status).toBe('open')

    // 定了 → 等着的那条接着起草出卡
    await brand.redditPersona.setupTarget().apply({ stance: 'personal' })
    let card = list('outbound_draft')[0]
    for (let i = 0; i < 50 && card === undefined; i += 1) {
      await sleep(40)
      card = list('outbound_draft')[0]
    }
    expect(card?.payload).toMatchObject({
      form: 'reddit_write',
      reddit: { kind: 'reply', parent_fullname: 't1_c9' },
    })
    expect(rw.items({ reply: true }).find((x) => x.fullname === 't1_c9')?.status).toBe('drafting')
  })
})
