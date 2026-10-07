/**
 * WP246：取数路线的接口——体检（快查 / 重新体检）、设置、Reddit 读号；与岗位页「连上就能开工」同一个判据。
 * 替身浏览器会话、替身登录窗口、本地假站点；不起真浏览器、不访问真网站。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadRouteHealth, ReadRoutesView, RedditReadAccountStatus } from '@agentsws/contracts'
import { REDDIT_READ_ROUTE_KEY } from '@agentsws/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { readRouteLevelOf } from '../src/read-route.js'
import { type LoginWindow, REDDIT_WHOAMI_URL } from '../src/readonly-browser/account.js'
import type { BrowserSession, PageRead } from '../src/readonly-browser/session.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { startFakeReadSites } from './fake-read-sites.js'

let site: Awaited<ReturnType<typeof startFakeReadSites>>
beforeAll(async () => {
  site = await startFakeReadSites()
})
afterAll(async () => {
  await site.close()
})

let server: Server | undefined
let dir = ''
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const who = (account?: string): PageRead => ({
  status: 200,
  finalUrl: REDDIT_WHOAMI_URL,
  extract: {
    signals: {
      title: '',
      text: '',
      passwordInputs: 0,
      frameSources: [],
      items: 2,
      ...(account === undefined ? {} : { account }),
    },
    items: [],
  },
})

async function boot(opts: { account?: string; browser?: boolean; net?: 'ok' | 'down' } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'wp246-server-'))
  let account = opts.account
  const session: BrowserSession = {
    readPage: vi.fn(async (url: string) => (url === REDDIT_WHOAMI_URL ? who(account) : who())),
    close: vi.fn(async () => undefined),
    killNow: vi.fn(),
  }
  let closeWindow: () => void = () => undefined
  const loginWindow = vi.fn(async (): Promise<LoginWindow> => {
    let done: () => void = () => undefined
    const closed = new Promise<void>((r) => {
      done = r
    })
    closeWindow = done
    return { closed, close: async () => done() }
  })
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    modelFetch: async () => new Response('{}', { status: 401 }),
    tokenRefreshIntervalMs: 0,
    ...(opts.browser === false
      ? {}
      : {
          readonlyBrowser: {
            exists: () => true,
            platform: 'darwin' as const,
            env: {},
            launch: async () => session,
            loginWindow,
          },
        }),
    ...(opts.net === undefined
      ? {}
      : {
          readNet:
            opts.net === 'ok'
              ? { fetch: site.fetch, lookup: site.lookup }
              : {
                  fetch: async () => {
                    throw Object.assign(new TypeError('fetch failed'), {
                      cause: { code: 'ECONNREFUSED' },
                    })
                  },
                  lookup: site.lookup,
                },
        }),
  })
  const { url } = await server.listen(0)
  const s = server
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: T }).data
  }
  return {
    call,
    brand: await s.brands.forWorkspace(s.brands.bootstrap),
    setAccount: (a: string | undefined) => {
      account = a
    },
    closeWindow: () => closeWindow(),
    loginWindow,
  }
}

const row = (v: ReadRoutesView, platform: string): ReadRouteHealth => {
  const r = v.doctor.routes.find((x) => x.platform === platform)
  if (r === undefined) throw new Error(`没有 ${platform}`)
  return r
}
const level = (r: ReadRouteHealth, l: string) => r.levels.find((x) => x.level === l)

describe('GET /v1/settings/read-routes（快查）', () => {
  it('三条路线一行一个：每级通 / 不通 + 原因 + 怎么修；现在走哪一级', async () => {
    const h = await boot()
    const v = await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes')
    expect(v.doctor.deep).toBe(false)
    expect(v.doctor.routes.map((r) => r.platform)).toEqual(['reddit', 'youtube', 'web'])
    const reddit = row(v, 'reddit')
    expect(reddit.levels.map((l) => l.level)).toEqual(['workshop', 'browser_readonly'])
    expect(level(reddit, 'workshop')).toMatchObject({ state: 'down', action: 'link_account' })
    expect(level(reddit, 'browser_readonly')).toMatchObject({
      state: 'down',
      action: 'login_read_account',
    })
    expect(level(reddit, 'browser_readonly')?.fix).toContain('别用版主号')
    expect(reddit.active).toBeUndefined()
    expect(row(v, 'youtube')).toMatchObject({
      active: 'page_captions',
      tool: 'read_youtube_transcript',
    })
    expect(level(row(v, 'youtube'), 'workshop')).toMatchObject({ state: 'pending' })
    const web = row(v, 'web')
    expect(web.active).toBe('local_extract')
    expect(level(web, 'third_party_reader')).toMatchObject({ state: 'off', action: 'enable_level' })
    expect(level(web, 'third_party_reader')?.reason).toContain('Jina Reader')
    expect(v.settings).toEqual({
      web_third_party_reader: false,
      reddit_browser_window: 'minimized',
    })
    expect(v.reddit_account).toMatchObject({ state: 'none' })
  })

  it('品牌调了 Reddit 的顺序 / 关了一级：体检按生效的顺序，关了的显示「关了」', async () => {
    const h = await boot()
    const sources = await h.call<{ capability_sources: Record<string, string> }>(
      'GET',
      '/v1/settings/capability-sources',
    )
    await h.call('PUT', '/v1/settings/capability-sources', {
      capability_sources: sources.capability_sources,
      data_source_routing: {
        [REDDIT_READ_ROUTE_KEY]: {
          order: ['browser_readonly', 'workshop'],
          disabled: ['workshop'],
        },
      },
    })
    const reddit = row(await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes'), 'reddit')
    expect(reddit.levels.map((l) => [l.level, l.state])).toEqual([
      ['browser_readonly', 'down'],
      ['workshop', 'off'],
    ])
  })
})

describe('Reddit 读号：登录 → 体检 → 走得通', () => {
  it('登录读号窗口关掉后体检认出 u/xxx：浏览器那一级通、成为现在走的那一级；岗位页判据跟着变', async () => {
    const h = await boot({ account: 'reader_bob' })
    const levelOf = () =>
      readRouteLevelOf(
        h.brand.ownCloud,
        h.brand.readonlyBrowser,
        h.brand.readRoutes?.account,
      )(REDDIT_READ_ROUTE_KEY)
    expect(levelOf()).toBeUndefined()
    const st = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/login',
    )
    expect(st.state).toBe('logging_in')
    expect(h.loginWindow).toHaveBeenCalledTimes(1)
    const during = row(await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes'), 'reddit')
    expect(level(during, 'browser_readonly')).toMatchObject({ state: 'down', action: 'wait' })
    h.closeWindow()
    await vi.waitFor(() => expect(h.brand.readRoutes?.account?.status().state).toBe('logged_in'))
    const v = await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes')
    const reddit = row(v, 'reddit')
    expect(reddit.active).toBe('browser_readonly')
    expect(level(reddit, 'browser_readonly')).toMatchObject({ state: 'ok', detail: 'u/reader_bob' })
    expect(v.reddit_account).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
    expect(levelOf()).toBe('browser_readonly')
  })

  it('登录的是品牌登记的 Reddit 号：拦下、提示换号；岗位页照旧算缺', async () => {
    const h = await boot({ account: 'nordvolt_official' })
    await h.brand.socialService.port.createAccount(
      { person_id: 'p_owner', workspace_id: 'ws', role_id: 'social.reddit' } as never,
      {
        channel: 'reddit',
        handle: 'u/Nordvolt_Official',
        display_name: 'Nordvolt',
        url: 'https://www.reddit.com/user/Nordvolt_Official',
        external_id: 't2_x',
      } as never,
    )
    const st = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/check',
    )
    expect(st).toMatchObject({ state: 'refused', username: 'nordvolt_official' })
    const reddit = row(await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes'), 'reddit')
    expect(level(reddit, 'browser_readonly')).toMatchObject({
      state: 'down',
      action: 'login_read_account',
      detail: 'u/nordvolt_official',
    })
    expect(level(reddit, 'browser_readonly')?.fix).toContain('换一个普通号')
  })

  it('没装本机只读浏览器（演示 / 测试）：读号那一格照实说，不起任何窗口', async () => {
    const h = await boot({ browser: false })
    const st = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/login',
    )
    expect(st.message).toContain('没装本机只读浏览器')
    const v = await h.call<ReadRoutesView>('GET', '/v1/settings/read-routes')
    expect(v.reddit_account).toBeUndefined()
  })
})

describe('设置与重新体检', () => {
  it('打开第三方转文字：那一级从「关了」变成通；重新体检真去探 YouTube 与第三方（本地假站点）', async () => {
    const h = await boot({ net: 'ok' })
    const v = await h.call<ReadRoutesView>('PUT', '/v1/settings/read-routes', {
      web_third_party_reader: true,
    })
    expect(v.settings.web_third_party_reader).toBe(true)
    expect(level(row(v, 'web'), 'third_party_reader')).toMatchObject({ state: 'ok' })
    const before = site.seen.length
    const deep = await h.call<ReadRoutesView>('POST', '/v1/settings/read-routes/doctor')
    expect(deep.doctor.deep).toBe(true)
    expect(level(row(deep, 'youtube'), 'page_captions')).toMatchObject({ state: 'ok' })
    const probed = site.seen.slice(before).map((s) => `${s.host}${s.path}`)
    expect(probed).toEqual(expect.arrayContaining(['www.youtube.com/robots.txt', 'r.jina.ai/']))
  })

  it('连不上外网：重新体检说「连不上」+ 检查网络；第三方没开就不去探它', async () => {
    const h = await boot({ net: 'down' })
    const deep = await h.call<ReadRoutesView>('POST', '/v1/settings/read-routes/doctor')
    const yt = level(row(deep, 'youtube'), 'page_captions')
    expect(yt).toMatchObject({ state: 'down', action: 'check_network' })
    expect(yt?.reason).toContain('ECONNREFUSED')
    expect(row(deep, 'youtube').active).toBeUndefined()
    expect(level(row(deep, 'web'), 'third_party_reader')).toMatchObject({ state: 'off' })
  })

  it('换 Reddit 读取时的开法：开着的浏览器关掉，下次按新的起', async () => {
    const h = await boot({ account: 'reader_bob' })
    await h.call('POST', '/v1/settings/reddit-read-account/check')
    expect(h.brand.readonlyBrowser?.running()).toBe(true)
    const v = await h.call<ReadRoutesView>('PUT', '/v1/settings/read-routes', {
      reddit_browser_window: 'headless',
    })
    expect(v.settings.reddit_browser_window).toBe('headless')
    expect(h.brand.readonlyBrowser?.running()).toBe(false)
  })
})
