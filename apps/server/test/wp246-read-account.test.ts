/**
 * WP246（决策 87 / 88）：Reddit 浏览器备选改用**读号**——替身会话与替身登录窗口，不起真浏览器、不联网。
 *
 * - 没登录读号：浏览器那一路不读（照实说怎么修），一页都不开；
 * - 「登录读号」：先停掉自动读取的浏览器，再开登录窗口（同一份目录）；窗口开着时不读；
 *   关掉后自动体检，认出 u/xxx；之后用读号的登录态（profile）读；
 * - 读号是品牌登记的号（官方 / 版主）：拦下，路由记「会话被拒」；
 * - 认不出是谁（被验证码拦了）：先不读，提示在登录窗口里手动过一次；
 * - 自动读取被验证码拦：提示在「登录读号」窗口里手动过一次。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResearchFetchRecord } from '@agentsws/contracts'
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS, REDDIT_READ_HOSTS } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRedditReadAccount,
  type LoginWindow,
  REDDIT_LOGIN_URL,
  REDDIT_WHOAMI_URL,
} from '../src/readonly-browser/account.js'
import { createReadonlyBrowser } from '../src/readonly-browser/index.js'
import {
  READ_ACCOUNT_CAPTCHA_HINT,
  redditReadBrowserOf,
  redditReadLimiterOf,
} from '../src/readonly-browser/reddit.js'
import type { BrowserSession, PageRead, ReadPageOptions } from '../src/readonly-browser/session.js'
import { createResearchToolExecutor } from '../src/research-tools.js'

const page = (
  over: Partial<PageRead['extract'] & object> = {},
  extra: Partial<PageRead> = {},
): PageRead => ({
  status: 200,
  finalUrl: 'https://www.reddit.com/r/inmo/new/',
  extract: {
    signals: {
      title: '',
      text: '',
      passwordInputs: 0,
      frameSources: [],
      items: 1,
      ...(over.signals ?? {}),
    },
    items: over.items ?? [
      { kind: 'post', url: '/r/inmo/comments/a1/x/', title: 'Hi', text: 'hello' },
    ],
  },
  ...extra,
})
const whoPage = (account?: string): PageRead => ({
  status: 200,
  finalUrl: REDDIT_WHOAMI_URL,
  extract: {
    signals: {
      title: 'reddit',
      text: '',
      passwordInputs: 0,
      frameSources: [],
      items: 3,
      ...(account === undefined ? {} : { account }),
    },
    items: [],
  },
})

let dir = ''
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function harness(opts: { who?: string; brand?: string[]; pages?: PageRead[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'wp246-account-'))
  let now = Date.parse('2026-10-07T10:00:00Z')
  let who: PageRead = whoPage(opts.who)
  const pages = [...(opts.pages ?? [])]
  const calls: { url: string; opts?: ReadPageOptions }[] = []
  const session: BrowserSession = {
    readPage: vi.fn(async (url: string, _a, _h, o?: ReadPageOptions) => {
      calls.push({ url, ...(o === undefined ? {} : { opts: o }) })
      return url === REDDIT_WHOAMI_URL ? who : (pages.shift() ?? page())
    }),
    close: vi.fn(async () => undefined),
    killNow: vi.fn(),
  }
  const rb = createReadonlyBrowser({
    dir: join(dir, 'readonly-browser'),
    allowedHosts: () => REDDIT_READ_HOSTS,
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    nowMs: () => now,
    exists: () => true,
    platform: 'darwin',
    env: {},
    launch: async () => session,
    useProfile: () => true,
  })
  let closeWindow: () => void = () => undefined
  const openWindow = vi.fn(async (): Promise<LoginWindow> => {
    let done: () => void = () => undefined
    const closed = new Promise<void>((r) => {
      done = r
    })
    closeWindow = done
    return { closed, close: async () => done() }
  })
  const account = createRedditReadAccount({
    browser: rb,
    dir: join(dir, 'readonly-browser'),
    brandHandles: () => opts.brand ?? ['INMO_Official', 'u/inmo_mod'],
    nowMs: () => now,
    openWindow,
    platform: 'darwin',
    env: {},
  })
  const records: ResearchFetchRecord[] = []
  const exec = createResearchToolExecutor({
    route: () => ({ order: ['browser_readonly'], disabled: [] }),
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    browser: () => redditReadBrowserOf(rb, account),
    limiter: redditReadLimiterOf(rb),
    nowMs: () => now,
    onRecord: (r) => records.push(r),
  })
  const read = async () =>
    (await exec({
      name: 'read_reddit',
      input: { subreddit: 'inmo' },
      request: undefined as never,
    })) as {
      data: { rows: number; missing?: string; source: ResearchFetchRecord }
    }
  return {
    rb,
    account,
    session,
    calls,
    openWindow,
    read,
    closeWindow: async () => {
      closeWindow()
      // 关窗口之后体检是异步的：等它走完
      await vi.waitFor(() => expect(account.status().state).not.toBe('logging_in'))
    },
    setWho: (p: PageRead) => {
      who = p
    },
    tick: (ms: number) => (now += ms),
  }
}

describe('Reddit 读号', () => {
  it('没登录读号：浏览器那一路不读、一页都不开，照实说怎么修', async () => {
    const h = harness()
    expect(h.account.status().state).toBe('none')
    const got = await h.read()
    expect(got.data.rows).toBe(0)
    expect(got.data.source.attempts).toEqual([
      {
        route: 'browser_readonly',
        outcome: 'not_configured',
        message: expect.stringContaining('登录读号'),
      },
    ])
    expect(h.session.readPage).not.toHaveBeenCalled()
  })

  it('登录读号：停掉自动读取的浏览器、开登录窗口；开着时不读；关掉后体检认出 u/xxx，之后用读号的登录态读', async () => {
    const h = harness({ who: 'reader_bob' })
    // 先让自动读取的浏览器起来（登录前它是能起的：体检要用）
    await h.account.check()
    expect(h.rb.running()).toBe(true)
    h.account.status() // logged_in 了：下面重新走一遍登录流程
    const st = await h.account.openLogin()
    expect(st.state).toBe('logging_in')
    expect(h.rb.running()).toBe(false)
    expect(h.session.close).toHaveBeenCalled()
    expect(h.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ profileDir: h.rb.profileDir, url: REDDIT_LOGIN_URL }),
    )
    // 窗口开着：不读
    h.tick(30_000)
    const during = await h.read()
    expect(during.data.source.attempts[0]).toMatchObject({ outcome: 'not_configured' })
    expect(during.data.missing).toBeDefined()
    // 再点一次不会开第二个窗口
    await h.account.openLogin()
    expect(h.openWindow).toHaveBeenCalledTimes(1)
    await h.closeWindow()
    expect(h.account.status()).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
    h.tick(30_000)
    const after = await h.read()
    expect(after.data.rows).toBe(1)
    expect(after.data.source.route).toBe('browser_readonly')
    // 读号那一档：用这份目录自己的登录态（profile）读
    expect(h.calls.filter((c) => c.url !== REDDIT_WHOAMI_URL).at(-1)?.opts).toEqual({
      profile: true,
    })
  })

  it('读号是品牌登记的号（官方 / 版主）：拦下，路由记「会话被拒」，提示换号', async () => {
    const h = harness({ who: 'inmo_mod' })
    const st = await h.account.check()
    expect(st).toMatchObject({ state: 'refused', username: 'inmo_mod' })
    expect(st.message).toContain('换一个普通号')
    h.tick(30_000)
    const got = await h.read()
    expect(got.data.rows).toBe(0)
    expect(got.data.source.attempts[0]).toMatchObject({ outcome: 'session_refused' })
    // 大小写、u/ 前缀都归一了再比
    const h2 = harness({ who: 'INMO_OFFICIAL' })
    expect((await h2.account.check()).state).toBe('refused')
  })

  it('页面上没有用户名 = 没登录；体检页被验证码拦 = 认不出，先不读，提示在登录窗口里手动过一次', async () => {
    const h = harness()
    expect((await h.account.check()).state).toBe('none')
    h.setWho(whoPage('reader_bob'))
    h.tick(30_000)
    expect((await h.account.check()).state).toBe('logged_in')
    h.setWho({
      status: 200,
      finalUrl: REDDIT_WHOAMI_URL,
      extract: {
        signals: {
          title: '',
          text: 'prove you are human',
          passwordInputs: 0,
          frameSources: [],
          items: 0,
        },
        items: [],
      },
    })
    h.tick(30_000)
    const st = await h.account.check()
    expect(st.state).toBe('unknown')
    expect(st.message).toContain('手动过一次验证')
    expect(h.account.gate()).toMatchObject({ ok: false })
  })

  it('读号状态落盘：重启之后还记得', async () => {
    const h = harness({ who: 'reader_bob' })
    await h.account.check()
    const again = createRedditReadAccount({
      browser: h.rb,
      dir: join(dir, 'readonly-browser'),
      brandHandles: () => [],
      nowMs: () => 0,
    })
    expect(again.status()).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
  })

  it('自动读取被验证码拦：照实停下，提示在「登录读号」窗口里手动过一次；登录体检通过后解除暂停', async () => {
    const captcha = page({
      signals: {
        title: '',
        text: '',
        passwordInputs: 0,
        frameSources: ['https://www.google.com/recaptcha/x'],
        items: 0,
      },
      items: [],
    })
    const h = harness({ who: 'reader_bob', pages: [captcha] })
    await h.account.check()
    h.tick(30_000)
    const got = await h.read()
    expect(got.data.source.attempts[0]).toMatchObject({ outcome: 'blocked' })
    expect(got.data.missing ?? got.data.source.attempts[0]?.message).toContain(
      READ_ACCOUNT_CAPTCHA_HINT,
    )
    expect(h.rb.status().state).toBe('blocked')
    await h.account.openLogin()
    await h.closeWindow()
    expect(h.rb.status().state).toBe('ready')
  })
})
