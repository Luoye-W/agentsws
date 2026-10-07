/**
 * WP249 × 决策 108：在「Reddit 官方号浏览器」里登录过的官方号，一律进只读读号的拦截名单——
 * 官方号不能当读号用（哪怕它没在社媒库里登记成一个号，登记的只是版 r/xxx）。
 * 替身会话、替身登录窗口、内存 old.reddit；不起浏览器、不访问真网站。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RedditReadAccountStatus } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { type LoginWindow, REDDIT_WHOAMI_URL } from '../src/readonly-browser/account.js'
import type { BrowserSession, PageRead } from '../src/readonly-browser/session.js'
import { createFakeOldReddit } from '../src/reddit-official-browser/stand-in.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

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

async function boot(readAs: string) {
  dir = mkdtempSync(join(tmpdir(), 'wp249-block-'))
  const site = createFakeOldReddit('https://old.reddit.com', 'inmoxr')
  site.username = 'INMO_Official'
  const session: BrowserSession = {
    readPage: vi.fn(async (url: string) => (url === REDDIT_WHOAMI_URL ? who(readAs) : who())),
    close: vi.fn(async () => undefined),
    killNow: vi.fn(),
  }
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    modelFetch: async () => new Response('{}', { status: 401 }),
    tokenRefreshIntervalMs: 0,
    readonlyBrowser: {
      exists: () => true,
      platform: 'darwin' as const,
      env: {},
      launch: async () => session,
      loginWindow: vi.fn(
        async (): Promise<LoginWindow> => ({
          closed: new Promise(() => undefined),
          close: async () => undefined,
        }),
      ),
    },
    redditOfficialBrowser: { openPage: site.opener(), sleep: async () => undefined },
  })
  const { url } = await server.listen(0)
  const s = server
  const call = async <T>(method: string, path: string, assignment?: string): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': assignment ?? s.bootstrap.ownerAssignment.id,
      },
    })
    expect(res.status, `${method} ${path} ${await res.clone().text()}`).toBe(200)
    return ((await res.json()) as { data: T }).data
  }
  const social = s.roles.assignments.create({
    person_id: s.bootstrap.person.id,
    workspace_id: s.bootstrap.workspace.id,
    granted_by: s.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
  return { call, site, social: social.id }
}

describe('决策 108：官方号进读号拦截名单', () => {
  it('官方号浏览器里登录过 u/INMO_Official → 读号登的是它就拦下', async () => {
    const h = await boot('inmo_official')
    // 还没在官方号浏览器里登录过：读号认不出它是官方号，放行
    const before = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/check',
    )
    expect(before.state).toBe('logged_in')
    h.site.loggedIn = true
    const official = await h.call<{ state: string; username?: string }>(
      'POST',
      '/v1/social/reddit-browser/check',
      h.social,
    )
    expect(official).toMatchObject({ state: 'logged_in', username: 'INMO_Official' })
    const after = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/check',
    )
    expect(after).toMatchObject({ state: 'refused', username: 'inmo_official' })
    // 官方号后来登出了，名单里照样记着
    h.site.loggedIn = false
    await h.call('POST', '/v1/social/reddit-browser/check', h.social)
    const still = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/check',
    )
    expect(still.state).toBe('refused')
  })

  it('读号是别的普通号：照常放行', async () => {
    const h = await boot('reader_bob')
    h.site.loggedIn = true
    await h.call('POST', '/v1/social/reddit-browser/check', h.social)
    const st = await h.call<RedditReadAccountStatus>(
      'POST',
      '/v1/settings/reddit-read-account/check',
    )
    expect(st).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
  })
})
