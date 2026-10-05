/**
 * WP228：用**本机已装的 Chrome / Edge** 对本地假 Reddit 真跑一遍（不访问 reddit.com、不登录任何网站）。
 *
 * 默认跳过（CI 与并行代理不起浏览器）；要跑：
 *   AGENTSWS_REAL_CHROME=1 npx vitest run apps/server/test/readonly-browser.real.test.ts
 * Windows 真机同一条命令（PowerShell：`$env:AGENTSWS_REAL_CHROME=1; npx vitest run …`）。
 * 用的用户数据目录是临时建的，跑完只删它自己。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnChrome } from '../src/readonly-browser/chrome.js'
import { findBrowser } from '../src/readonly-browser/find-browser.js'
import { createReadonlyBrowser, type ReadonlyBrowser } from '../src/readonly-browser/index.js'
import { type BrowserSession, launchChromeSession } from '../src/readonly-browser/session.js'
import { type SeenRequest, startFakeReddit } from './fake-reddit-site.js'

const RUN = process.env.AGENTSWS_REAL_CHROME === '1' && findBrowser().ok
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** 还有没有哪个进程的命令行里带着这份用户数据目录（mac / Linux）。 */
const leftovers = (dir: string): string => {
  if (process.platform === 'win32') return ''
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!RUN)('只读浏览器 × 本机 Chrome × 本地假 Reddit', () => {
  let site: Awaited<ReturnType<typeof startFakeReddit>>
  let root: string
  let rb: ReadonlyBrowser
  let now = Date.parse('2026-10-05T10:00:00Z')
  const sessions: BrowserSession[] = []
  const pagesSeen = (): SeenRequest[] => site.seen.filter((r) => r.path !== '/favicon.ico')
  const next = () => {
    now += 21_000
  }

  beforeAll(async () => {
    site = await startFakeReddit()
    root = mkdtempSync(join(tmpdir(), 'wp228-ro-browser-'))
    rb = createReadonlyBrowser({
      dir: join(root, 'brand-a', 'readonly-browser'),
      allowedHosts: () => ['localhost'],
      limits: () => ({ min_interval_seconds: 20, max_pages_per_hour: 30, max_pages_per_day: 200 }),
      nowMs: () => now,
      idleMs: 60_000,
      launch: async (input) => {
        const s = await launchChromeSession(input)
        sessions.push(s)
        return s
      },
    })
  })
  afterAll(async () => {
    await rb?.close()
    await site?.close()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it('读版的帖子列表：结构化条目；只发了一个 GET 页面，脚本里的 POST、图片、样式一个没发', async () => {
    const got = await rb.read(`${site.origin}/r/inmo/new/`, { limit: 2 })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.items).toHaveLength(2)
    expect(got.items[0]).toMatchObject({
      kind: 'post',
      url: '/r/inmo/comments/a1/inmo_air3_first_impressions/',
      title: 'INMO Air3 first impressions',
      author: 'user_a1',
      subreddit: 'inmo',
      score: 120,
      comments: 34,
      text: 'Body of INMO Air3 first impressions.',
    })
    expect(pagesSeen()).toEqual([{ method: 'GET', path: '/r/inmo/new/' }])
  }, 60_000)

  it('读一条帖子和评论；不带上一页种下的 cookie（每次一个干净的会话）', async () => {
    next()
    const got = await rb.read(`${site.origin}/r/inmo/comments/a1/inmo_air3_first_impressions/`)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.items.map((i) => i.kind)).toEqual(['post', 'comment', 'comment'])
    expect(got.items[1]).toMatchObject({
      author: 'alice',
      score: 9,
      created_at: '2026-10-04T09:00:00.000Z',
    })
    expect(site.seen.every((r) => r.cookie === undefined)).toBe(true)
  }, 60_000)

  it('搜索结果与旧版页面也认得出', async () => {
    next()
    const s = await rb.read(`${site.origin}/search/?q=translation`)
    expect(s.ok && s.items[0]).toMatchObject({
      title: 'AR glasses for translation',
      score: 42,
      comments: 7,
      subreddit: 'smartglasses',
    })
    next()
    const o = await rb.read(`${site.origin}/old/r/inmo/`)
    expect(o.ok && o.items[0]).toMatchObject({
      title: 'Old layout post',
      author: 'carol',
      score: 5,
    })
  }, 60_000)

  it('限速：20 秒内第二页不开（站点一个请求都没收到）', async () => {
    const before = site.seen.length
    const got = await rb.read(`${site.origin}/r/inmo/new/`)
    expect(got).toMatchObject({ ok: false, reason: 'limited' })
    expect(site.seen.length).toBe(before)
  })

  it('白名单：跳去白名单外的站被掐，目标站一个请求都没收到；不在白名单的地址浏览器根本不开', async () => {
    next()
    const got = await rb.read(`${site.origin}/r/offsite/`)
    expect(got).toMatchObject({ ok: false, reason: 'off_site' })
    expect(site.seen.some((r) => r.path === '/offsite-target')).toBe(false)
    const direct = await rb.read(`${site.origin.replace('localhost', '127.0.0.1')}/r/inmo/new/`)
    expect(direct).toMatchObject({ ok: false, reason: 'not_allowed' })
  }, 60_000)

  it('页面改版认不出：照实说，不当 0 条', async () => {
    next()
    expect(await rb.read(`${site.origin}/r/changed/`)).toMatchObject({ ok: false, reason: 'empty' })
  }, 60_000)

  it('登录墙：停下照实说，这一路暂停；暂停期间不再开页面', async () => {
    next()
    const got = await rb.read(`${site.origin}/r/private/`)
    expect(got).toMatchObject({ ok: false, reason: 'wall', wall: 'login' })
    expect(rb.status().state).toBe('blocked')
    const before = site.seen.length
    next()
    expect(await rb.read(`${site.origin}/r/inmo/new/`)).toMatchObject({ reason: 'blocked' })
    expect(site.seen.length).toBe(before)
    now += 2 * 3_600_000
  }, 60_000)

  it('验证码与 429 也停（429 按 Retry-After 停）', async () => {
    const c = await rb.read(`${site.origin}/r/captcha/`)
    expect(c).toMatchObject({ ok: false, wall: 'captcha' })
    now += 7 * 3_600_000
    const l = await rb.read(`${site.origin}/r/limited/`)
    expect(l).toMatchObject({ ok: false, wall: 'rate_limited' })
    expect(rb.status().until).toBe(new Date(now + 7_200_000).toISOString())
    now += 3 * 3_600_000
  }, 60_000)

  it('整个过程只有 GET；关掉之后浏览器进程一个不剩', async () => {
    expect(site.seen.every((r) => r.method === 'GET')).toBe(true)
    expect(site.seen.some((r) => r.path.startsWith('/static/') || r.path.startsWith('/api/'))).toBe(
      false,
    )
    const pids = sessions.map((s) => s.pid)
    expect(rb.running()).toBe(true)
    await rb.close()
    await sleep(500)
    expect(pids.some((p) => alive(p))).toBe(false)
    expect(leftovers(root)).toBe('')
  }, 30_000)

  it('闲着自动关；上次没关干净（服务被强杀）留下的浏览器，下次起之前先结束它', async () => {
    const dir = join(root, 'brand-b', 'readonly-browser')
    const exe = findBrowser()
    if (!exe.ok) return
    // 假装上一次服务进程被强杀：起一个浏览器、不关
    const orphan = await spawnChrome({
      executable: exe.executable,
      profileDir: join(dir, 'profile'),
      platform: process.platform,
      env: process.env,
    })
    expect(alive(orphan.child.pid)).toBe(true)
    let started: BrowserSession | undefined
    const b = createReadonlyBrowser({
      dir,
      allowedHosts: () => ['localhost'],
      limits: () => ({ min_interval_seconds: 5, max_pages_per_hour: 30, max_pages_per_day: 200 }),
      nowMs: () => now,
      idleMs: 1_000,
      launch: async (input) => {
        started = await launchChromeSession(input)
        return started
      },
    })
    const got = await b.read(`${site.origin}/r/inmo/new/`)
    expect(got.ok).toBe(true)
    await sleep(800)
    expect(alive(orphan.child.pid)).toBe(false)
    await sleep(4_500)
    expect(b.running()).toBe(false)
    expect(alive(started?.pid)).toBe(false)
    expect(leftovers(dir)).toBe('')
  }, 60_000)
})
