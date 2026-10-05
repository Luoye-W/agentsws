/**
 * WP228：本机只读浏览器接进服务进程与 WP220 的 Reddit 路由（替身会话，不起真浏览器、不联网）。
 *
 * - 连接页那一格：`GET /v1/settings/reddit-browser-read/status`（没找到浏览器 / 可用 / 额度用完 / 被拦了）；
 * - `read_reddit`：接口中台没配 → 落到浏览器只读，取回的条目与接口中台同一个结构，记来源；
 * - 被拦了：这一路记 `blocked`，照实说；限速与连接页数的是同一本账；
 * - 品牌关掉时浏览器跟着关。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadonlyBrowserStatus, ResearchFetchRecord } from '@agentsws/contracts'
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS, REDDIT_READ_HOSTS } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloud } from '../src/cloud.js'
import { createServer, type Server } from '../src/index.js'
import { createReadonlyBrowser } from '../src/readonly-browser/index.js'
import { redditReadBrowserOf, redditReadLimiterOf } from '../src/readonly-browser/reddit.js'
import type { BrowserSession, PageRead } from '../src/readonly-browser/session.js'
import { createResearchToolExecutor } from '../src/research-tools.js'
import { SECRETS_KEY_ENV, type SecretStore } from '../src/secret-store.js'

const listing = (items: Record<string, unknown>[], text = ''): PageRead => ({
  status: 200,
  finalUrl: 'https://www.reddit.com/search/?q=inmo',
  extract: {
    signals: { title: '', text, passwordInputs: 0, frameSources: [], items: items.length },
    items,
  },
})

function fakeSession(pages: PageRead[]): BrowserSession {
  return {
    readPage: vi.fn(async () => pages.shift() ?? listing([])),
    close: vi.fn(async () => undefined),
    killNow: vi.fn(),
  }
}

describe('read_reddit × 本机只读浏览器', () => {
  const call = (input: Record<string, unknown>) => ({ id: 'c1', name: 'read_reddit', input })
  const setup = (pages: PageRead[], limits = { ...DEFAULT_REDDIT_BROWSER_READ_LIMITS }) => {
    let now = Date.parse('2026-10-05T10:00:00Z')
    const session = fakeSession(pages)
    const rb = createReadonlyBrowser({
      allowedHosts: () => REDDIT_READ_HOSTS,
      limits: () => limits,
      nowMs: () => now,
      exists: () => true,
      platform: 'win32',
      env: {},
      launch: async () => session,
    })
    const records: ResearchFetchRecord[] = []
    const exec = createResearchToolExecutor({
      route: () => ({ order: ['workshop', 'browser_readonly'], disabled: [] }),
      limits: () => limits,
      browser: () => redditReadBrowserOf(rb),
      limiter: redditReadLimiterOf(rb),
      nowMs: () => now,
      onRecord: (r) => records.push(r),
    })
    return { rb, session, exec, records, tick: (ms: number) => (now += ms) }
  }

  it('接口中台没配 → 落到浏览器只读；条目与接口中台同一个结构；记来源', async () => {
    const h = setup([
      listing([
        {
          kind: 'post',
          url: '/r/inmo/comments/a1/hi/',
          title: 'Hi',
          subreddit: 'inmo',
          score: 3,
          comments: 1,
          created_at: '2026-10-04T08:00:00.000Z',
          text: 'hello',
        },
      ]),
    ])
    const got = await h.exec(call({ action: 'search', query: 'inmo', limit: 5 }))
    expect(got).toMatchObject({
      status: 'ok',
      data: {
        rows: 1,
        items: [
          {
            kind: 'post',
            url: 'https://www.reddit.com/r/inmo/comments/a1/hi/',
            title: 'Hi',
            subreddit: 'inmo',
            score: 3,
          },
        ],
        source: { route: 'browser_readonly', cached: false },
      },
    })
    expect(h.records[0]?.attempts.map((a) => [a.route, a.outcome])).toEqual([
      ['workshop', 'not_configured'],
      ['browser_readonly', 'ok'],
    ])
    expect(vi.mocked(h.session.readPage).mock.calls[0]?.[0]).toMatch(
      /^https:\/\/www\.reddit\.com\/search\/\?q=inmo/u,
    )
    expect(vi.mocked(h.session.readPage).mock.calls[0]?.[1]).toEqual({ limit: 5, maxText: 4000 })
  })

  it('被拦了：这一路记 blocked、照实说；暂停期间路由在门口就挡住，不再开页面', async () => {
    const h = setup([listing([], 'are you a robot?')])
    const got = await h.exec(call({ action: 'posts', subreddit: 'inmo' }))
    expect(got).toMatchObject({ status: 'ok', data: { rows: 0 } })
    expect(h.records[0]?.attempts.at(-1)).toMatchObject({ outcome: 'blocked' })
    expect(h.rb.status().state).toBe('blocked')
    h.tick(60_000)
    await h.exec(call({ action: 'posts', subreddit: 'inmo' }))
    expect(h.records[1]?.attempts.at(-1)).toMatchObject({ outcome: 'blocked' })
    expect(h.session.readPage).toHaveBeenCalledTimes(1)
  })

  it('限速与连接页同一本账：太快记 rate_limited；一天额度用完连接页显示「额度用完」', async () => {
    const limits = { min_interval_seconds: 20, max_pages_per_hour: 30, max_pages_per_day: 2 }
    const page = () => listing([{ kind: 'post', url: '/r/a/comments/x/y/', title: 't', text: '' }])
    const h = setup([page(), page(), page()], limits)
    await h.exec(call({ action: 'search', query: 'a' }))
    await h.exec(call({ action: 'search', query: 'a' }))
    expect(h.records[1]?.attempts.at(-1)).toMatchObject({ outcome: 'rate_limited' })
    h.tick(21_000)
    await h.exec(call({ action: 'search', query: 'a' }))
    expect(h.rb.status()).toMatchObject({ state: 'quota_used_up', pages_last_day: 2 })
  })
})

let server: Server | undefined
let dir = ''
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function boot(
  readonlyBrowser: Parameters<typeof createServer>[0] extends infer O
    ? O extends { readonlyBrowser?: infer R }
      ? R
      : never
    : never,
) {
  dir = mkdtempSync(join(tmpdir(), 'wp228-server-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    modelFetch: async () => new Response('{}', { status: 401 }),
    tokenRefreshIntervalMs: 0,
    ...(readonlyBrowser === undefined ? {} : { readonlyBrowser }),
  })
  const { url } = await server.listen(0)
  const s = server
  const status = async (): Promise<ReadonlyBrowserStatus> => {
    const res = await fetch(`${url}/v1/settings/reddit-browser-read/status`, {
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
      },
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: ReadonlyBrowserStatus }).data
  }
  return { status, brand: await s.brands.forWorkspace(s.brands.bootstrap) }
}

describe('连接页那一格：GET /v1/settings/reddit-browser-read/status', () => {
  it('没找到 Chrome / Edge：照实说，带一句怎么办', async () => {
    const { status } = await boot({ exists: () => false, platform: 'darwin', env: {} })
    const s = await status()
    expect(s).toMatchObject({ state: 'no_browser', pages_last_day: 0, max_pages_per_day: 200 })
    expect(s.message).toMatch(/装一个 Chrome/u)
  })
  it('找到了就是可用；品牌关掉时浏览器跟着关', async () => {
    const session = fakeSession([
      listing([{ kind: 'post', url: '/r/a/comments/x/y/', title: 't', text: '' }]),
    ])
    const { status, brand } = await boot({
      exists: (p) => p.includes('Microsoft Edge'),
      platform: 'darwin',
      env: {},
      launch: async () => session,
    })
    expect(await status()).toMatchObject({ state: 'ready', browser: 'Edge' })
    const rb = brand.readonlyBrowser
    expect(rb).toBeDefined()
    expect(await rb?.read('https://www.reddit.com/r/a/')).toMatchObject({ ok: true })
    expect(rb?.running()).toBe(true)
    await server?.close()
    server = undefined
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})

describe('托管实例（Luoye 10-05）：浏览器只读那一路停用，取数只走接口中台', () => {
  const vault = {
    available: true,
    get: () => undefined,
    record: () => undefined,
  } as unknown as SecretStore
  const cloudOf = (hosted: boolean) =>
    createCloud({
      clock: { now: () => '2026-10-05T10:00:00.000Z' },
      secrets: vault,
      env: {},
      ...(hosted ? { hosted: true } : {}),
    })
  it('默认路由里这一路是停用的；存过的设置也压住', async () => {
    expect(cloudOf(false).redditReadRoute().disabled).toEqual([])
    const hosted = cloudOf(true)
    expect(hosted.redditReadRoute()).toEqual({
      order: ['workshop', 'browser_readonly'],
      disabled: ['browser_readonly'],
    })
    const actor = { workspace_id: 'ws_1', person_id: 'p_1' } as never
    await hosted.port.setCapabilitySources(actor, {
      capability_sources: {},
      data_source_routing: {
        'reddit.read': { order: ['browser_readonly', 'workshop'], disabled: [] },
      },
    })
    expect(hosted.redditReadRoute().disabled).toContain('browser_readonly')
  })
  it('read_reddit 在托管实例上只试接口中台，浏览器那一路记「停用」', async () => {
    const hosted = cloudOf(true)
    const exec = createResearchToolExecutor({
      route: () => hosted.redditReadRoute(),
      limits: () => hosted.redditBrowserReadLimits(),
      nowMs: () => 0,
    })
    const got = await exec({
      id: 'c1',
      name: 'read_reddit',
      input: { action: 'search', query: 'x' },
    })
    expect(got).toMatchObject({ status: 'ok', data: { rows: 0 } })
    const source = (got as { data: { source: ResearchFetchRecord } }).data.source
    expect(source.attempts.map((a) => [a.route, a.outcome])).toEqual([
      ['workshop', 'not_configured'],
      ['browser_readonly', 'disabled'],
    ])
  })
})
