/** WP228：只读浏览器的流程（替身会话，不起真浏览器）：白名单、没找到浏览器、限速、被拦暂停、认不出、关闭、状态。 */
import { describe, expect, it, vi } from 'vitest'
import { createReadonlyBrowser } from '../src/readonly-browser/index.js'
import type { BrowserSession, PageRead } from '../src/readonly-browser/session.js'

const HOSTS = ['*.reddit.com']
const LIMITS = { min_interval_seconds: 20, max_pages_per_hour: 30, max_pages_per_day: 3 }
const post = { kind: 'post', url: '/r/inmo/comments/a1/hi/', title: 'Hi', text: 'hello' }
const okPage = (over: Partial<PageRead> = {}): PageRead => ({
  status: 200,
  finalUrl: 'https://www.reddit.com/r/inmo/new/',
  extract: {
    signals: { title: 't', text: '', passwordInputs: 0, frameSources: [], items: 1 },
    items: [post],
  },
  ...over,
})

function harness(pages: PageRead[], opts: { exists?: boolean } = {}) {
  let now = 1_000_000
  const session: BrowserSession = {
    readPage: vi.fn(async () => pages.shift() ?? okPage()),
    close: vi.fn(async () => undefined),
    killNow: vi.fn(),
  }
  const launch = vi.fn(async () => session)
  const rb = createReadonlyBrowser({
    allowedHosts: () => HOSTS,
    limits: () => LIMITS,
    nowMs: () => now,
    platform: 'darwin',
    env: {},
    exists: () => opts.exists ?? true,
    launch,
  })
  return { rb, session, launch, tick: (ms: number) => (now += ms) }
}

describe('createReadonlyBrowser', () => {
  it('读一页：要用时才起浏览器，读回条目；第二页复用同一个浏览器', async () => {
    const h = harness([])
    const got = await h.rb.read('https://www.reddit.com/r/inmo/new/', { limit: 10 })
    expect(got).toMatchObject({ ok: true, items: [post] })
    h.tick(21_000)
    await h.rb.read('https://www.reddit.com/r/inmo/new/')
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(h.session.readPage).toHaveBeenCalledWith(
      'https://www.reddit.com/r/inmo/new/',
      { limit: 10, maxText: 4000 },
      HOSTS,
    )
    await h.rb.close()
    expect(h.session.close).toHaveBeenCalledTimes(1)
    expect(h.rb.running()).toBe(false)
  })
  it('白名单外的地址连浏览器都不起', async () => {
    const h = harness([])
    const got = await h.rb.read('https://evil.example/')
    expect(got).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(h.launch).not.toHaveBeenCalled()
  })
  it('没找到 Chrome / Edge：照实说，状态也是「没找到」', async () => {
    const h = harness([], { exists: false })
    const got = await h.rb.read('https://www.reddit.com/r/inmo/')
    expect(got).toMatchObject({ ok: false, reason: 'no_browser' })
    expect(h.rb.status().state).toBe('no_browser')
  })
  it('限速：太快不开页；一天额度用完 → 状态「额度用完」', async () => {
    const h = harness([])
    await h.rb.read('https://www.reddit.com/r/a/')
    expect(await h.rb.read('https://www.reddit.com/r/b/')).toMatchObject({ reason: 'limited' })
    h.tick(21_000)
    await h.rb.read('https://www.reddit.com/r/b/')
    h.tick(21_000)
    await h.rb.read('https://www.reddit.com/r/c/')
    expect(h.session.readPage).toHaveBeenCalledTimes(3)
    expect(h.rb.status()).toMatchObject({ state: 'quota_used_up', pages_last_day: 3 })
  })
  it('验证码 / 429 / 登录墙：停下照实说，这一路暂停、不重试', async () => {
    const h = harness([
      okPage({
        extract: {
          signals: {
            title: '',
            text: 'are you a robot?',
            passwordInputs: 0,
            frameSources: [],
            items: 0,
          },
          items: [],
        },
      }),
    ])
    const got = await h.rb.read('https://www.reddit.com/r/a/')
    expect(got).toMatchObject({ ok: false, reason: 'wall', wall: 'captcha' })
    expect(h.rb.status()).toMatchObject({ state: 'blocked' })
    h.tick(60_000)
    expect(await h.rb.read('https://www.reddit.com/r/a/')).toMatchObject({ reason: 'blocked' })
    expect(h.session.readPage).toHaveBeenCalledTimes(1)
  })
  it('跳去白名单外：这一页作废，不暂停这一路', async () => {
    const h = harness([okPage({ status: 0, finalUrl: 'https://evil.example/', offSite: 'x' })])
    expect(await h.rb.read('https://www.reddit.com/r/a/')).toMatchObject({ reason: 'off_site' })
    expect(h.rb.status().state).toBe('ready')
  })
  it('开了但一条都认不出：照实说，不当「0 条」', async () => {
    const h = harness([
      okPage({
        extract: {
          signals: { title: '', text: '', passwordInputs: 0, frameSources: [], items: 0 },
          items: [],
        },
      }),
    ])
    expect(await h.rb.read('https://www.reddit.com/r/a/')).toMatchObject({ reason: 'empty' })
  })
  it('浏览器起不来：照实说，下次还能再试', async () => {
    const h = harness([])
    h.launch.mockRejectedValueOnce(new Error('浏览器一起来就退出了'))
    expect(await h.rb.read('https://www.reddit.com/r/a/')).toMatchObject({ reason: 'failed' })
    h.tick(21_000)
    expect(await h.rb.read('https://www.reddit.com/r/a/')).toMatchObject({ ok: true })
  })
})
