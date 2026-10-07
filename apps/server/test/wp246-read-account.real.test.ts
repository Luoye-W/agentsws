/**
 * WP246：读号那一档用**本机已装的 Chrome / Edge** 对本地假 Reddit 真跑（不访问 reddit.com、不登录任何网站；
 * 「登录」= 假站点种一个 cookie）。默认跳过；要跑：
 *   AGENTSWS_REAL_CHROME=1 npx vitest run apps/server/test/wp246-read-account.real.test.ts
 *
 * 钉的是：用这份目录自己的登录态读（cookie 跨页、跨重启都在）、页面脚本照样关（页面想发的 POST 一个没发）、
 * 只发 GET 页面、体检读得出页头的用户名、登录的是品牌登记的号就拦。
 * 只跑无头（有头最小化会在这台电脑上弹出窗口）；有头那一档由 Fable 在 Windows 真机上看。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRedditReadAccount } from '../src/readonly-browser/account.js'
import { findBrowser } from '../src/readonly-browser/find-browser.js'
import { createReadonlyBrowser, type ReadonlyBrowser } from '../src/readonly-browser/index.js'
import { startFakeReddit } from './fake-reddit-site.js'

const RUN = process.env.AGENTSWS_REAL_CHROME === '1' && findBrowser().ok

describe.skipIf(!RUN)('读号 × 本机 Chrome × 本地假 Reddit', () => {
  let site: Awaited<ReturnType<typeof startFakeReddit>>
  let root: string
  let rb: ReadonlyBrowser
  let now = Date.parse('2026-10-07T10:00:00Z')
  const make = () =>
    createReadonlyBrowser({
      dir: join(root, 'brand-a', 'readonly-browser'),
      allowedHosts: () => ['localhost'],
      limits: () => ({ min_interval_seconds: 20, max_pages_per_hour: 30, max_pages_per_day: 200 }),
      nowMs: () => now,
      idleMs: 60_000,
      useProfile: () => true,
      windowMode: () => 'headless',
    })

  beforeAll(async () => {
    site = await startFakeReddit()
    root = mkdtempSync(join(tmpdir(), 'wp246-ro-account-'))
    rb = make()
  })
  afterAll(async () => {
    await rb?.close()
    await site?.close()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  it('读号的登录态跨页、跨重启都在；页面脚本照样关、只发 GET；体检认出页头用户名', async () => {
    const set = await rb.read(`${site.origin}/set-reader/?u=reader_bob`)
    expect(set.ok).toBe(true)
    now += 21_000
    const account = createRedditReadAccount({
      browser: rb,
      dir: join(root, 'brand-a', 'readonly-browser'),
      brandHandles: () => ['inmo_official'],
      nowMs: () => now,
      whoamiUrl: `${site.origin}/old-home/`,
    })
    expect(await account.check()).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
    const home = site.seen.filter((r) => r.path === '/old-home/')
    expect(home.at(-1)?.cookie).toContain('reader=reader_bob')
    // 关掉（体面地关，让浏览器把 cookie 写盘）再起一个：登录态还在
    await rb.close()
    rb = make()
    now += 21_000
    const again = createRedditReadAccount({
      browser: rb,
      brandHandles: () => [],
      nowMs: () => now,
      whoamiUrl: `${site.origin}/old-home/`,
    })
    expect(await again.check()).toMatchObject({ state: 'logged_in', username: 'reader_bob' })
    // 页面里那段想往外写的脚本一个请求都没发出去；全程只有 GET
    expect(site.seen.some((r) => r.path === '/api/vote' || r.path === '/track')).toBe(false)
    expect(site.seen.every((r) => r.method === 'GET')).toBe(true)
  })

  it('登录的是品牌登记的号：拦下', async () => {
    now += 21_000
    await rb.read(`${site.origin}/set-reader/?u=inmo_official`)
    now += 21_000
    const account = createRedditReadAccount({
      browser: rb,
      brandHandles: () => ['u/INMO_Official'],
      nowMs: () => now,
      whoamiUrl: `${site.origin}/old-home/`,
    })
    expect(await account.check()).toMatchObject({ state: 'refused', username: 'inmo_official' })
    expect(account.gate()).toMatchObject({ ok: false, refused: true })
  })
})
