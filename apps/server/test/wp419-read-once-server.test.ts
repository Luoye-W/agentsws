/**
 * WP419：巡查那一份的 `readOnce`——借插件现读一次（`read_reddit` 的第三路）：插件来领、交回、原样给等着的人；
 * 插件不在线照实说；到点没来领就撤掉、不卡住巡查。替身插件读替身 JSON，不连 Reddit。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let server: Server
let dir: string
const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const path = new URL(url).pathname
  const body =
    path === '/api/me.json'
      ? { kind: 't2', data: { name: 'ivra_official' } }
      : path === '/r/ivraxr/new/.json'
        ? listing([
            {
              kind: 't3',
              data: {
                id: 'p1',
                name: 't3_p1',
                title: 'Battery after 2.1?',
                selftext: 'drains fast',
                author: 'alice',
                subreddit: 'ivraxr',
                permalink: '/r/ivraxr/comments/p1/x/',
                created_utc: Math.floor(Date.now() / 1000) - 600,
              },
            },
          ])
        : listing([])
  return { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp419-once-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
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
    role_id: 'pr.reddit',
  })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP419 借插件现读一次', () => {
  it('插件没来过：照实说；来过：领活、交回、原样给等着的人；到点没来领就撤掉', async () => {
    const rw = (await server.brands.forWorkspace(server.bootstrap.workspace.id)).redditWatch
    if (rw === undefined) throw new Error('没装')
    const req = {
      key: 'adhoc:sub_new:ivraxr',
      kind: 'sub_new' as const,
      subreddit: 'ivraxr',
      max_pages: 1,
    }
    const never = await rw.readOnce([req])
    expect(never).toMatchObject({ ok: false, why: '插件还没配对' })

    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    // 插件来问过一次（在线），把巡查那一件先读掉，让出位置
    for (let i = 0; i < 4; i += 1) {
      const got = rw.next({ connected: true })
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
    }
    const pending = rw.readOnce([req], { timeoutMs: 10_000, pollMs: 20 })
    let job = rw.next({ connected: true }).job
    for (let i = 0; i < 50 && job === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 20))
      job = rw.next({ connected: true }).job
    }
    expect(job?.title).toBe('替 AI 读一下 Reddit')
    if (job === undefined) throw new Error('没领到')
    await rw.result(
      job.id,
      await runRedditRead(job, {
        fetch: fakeFetch,
        sleep: async () => {},
        stopped: () => false,
        gapMs: 0,
      }),
    )
    const got = await pending
    expect(got.ok).toBe(true)
    if (got.ok) expect(got.result.parts[0]?.items[0]?.title).toBe('Battery after 2.1?')

    // 到点没来领：撤掉，不占着插件那一侧
    const late = await rw.readOnce([req], { timeoutMs: 100, pollMs: 20 })
    expect(late.ok).toBe(false)
    expect(rw.next({ connected: true }).job?.title ?? '').not.toBe('替 AI 读一下 Reddit')
  })
})
