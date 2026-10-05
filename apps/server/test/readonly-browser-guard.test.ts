/** WP228：只读浏览器的闸（只放白名单 GET 页面、认拦截）、找浏览器、限速账本、浏览器参数与环境变量。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserEnv, chromeArgs } from '../src/readonly-browser/chrome.js'
import { browserCandidates, findBrowser } from '../src/readonly-browser/find-browser.js'
import { detectWall, requestVerdict } from '../src/readonly-browser/guard.js'
import { createReadUsage } from '../src/readonly-browser/usage.js'

const HOSTS = ['*.reddit.com', '*.redd.it']
const doc = (url: string, method = 'GET') => ({ method, url, resourceType: 'document' })

describe('requestVerdict：只放白名单站点上的 GET 页面', () => {
  it('白名单里的 GET 页面放行', () => {
    expect(requestVerdict(doc('https://www.reddit.com/r/inmo/new/'), HOSTS).allow).toBe(true)
    expect(requestVerdict(doc('https://old.reddit.com/r/x/'), HOSTS).allow).toBe(true)
  })
  it('POST / PUT / DELETE 一律掐掉（提交、点赞、评论都走这些）', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH'])
      expect(requestVerdict(doc('https://www.reddit.com/api/vote', m), HOSTS).allow).toBe(false)
  })
  it('白名单外的站掐掉；看起来像但不是的也掐', () => {
    expect(requestVerdict(doc('https://evil.example/'), HOSTS).allow).toBe(false)
    expect(requestVerdict(doc('https://reddit.com.evil.example/'), HOSTS).allow).toBe(false)
    expect(requestVerdict(doc('file:///etc/passwd'), HOSTS).allow).toBe(false)
  })
  it('图片 / 样式 / 脚本 / 接口请求不取（只读文字）', () => {
    for (const t of ['image', 'stylesheet', 'script', 'xhr', 'fetch', 'font', 'media'])
      expect(
        requestVerdict({ method: 'GET', url: 'https://www.reddit.com/x', resourceType: t }, HOSTS)
          .allow,
      ).toBe(false)
  })
})

const signals = (over: Partial<Parameters<typeof detectWall>[0]['signals'] & object> = {}) => ({
  title: '',
  text: '',
  passwordInputs: 0,
  frameSources: [],
  items: 3,
  ...over,
})

describe('detectWall：被拦就停下照实说', () => {
  const base = { allowedHosts: HOSTS, finalUrl: 'https://www.reddit.com/r/x/' }
  it('正常页面不算被拦', () => {
    expect(detectWall({ ...base, status: 200, signals: signals() })).toBeUndefined()
  })
  it('429 → 限流', () => {
    expect(detectWall({ ...base, status: 429 })?.kind).toBe('rate_limited')
  })
  it('验证码 iframe / 挂件 / 文案 → 验证码', () => {
    const frame = signals({ frameSources: ['https://www.google.com/recaptcha/api2/anchor'] })
    expect(detectWall({ ...base, status: 200, signals: frame })?.kind).toBe('captcha')
    const text = signals({ text: 'please verify you are human' })
    expect(detectWall({ ...base, status: 200, signals: text })?.kind).toBe('captcha')
  })
  it('403 / 网络安全拦截页 → 被拦', () => {
    expect(detectWall({ ...base, status: 403, signals: signals() })?.kind).toBe('blocked')
    const t = signals({ text: "you've been blocked by network security." })
    expect(detectWall({ ...base, status: 200, signals: t })?.kind).toBe('blocked')
  })
  it('登录页 / 没内容还要密码 → 登录墙；有内容的页面里出现「登录」不算', () => {
    expect(
      detectWall({ ...base, status: 200, finalUrl: 'https://www.reddit.com/login/?dest=x' })?.kind,
    ).toBe('login')
    const wall = signals({ items: 0, passwordInputs: 1 })
    expect(detectWall({ ...base, status: 200, signals: wall })?.kind).toBe('login')
    const fine = signals({ items: 5, text: 'log in to continue' })
    expect(detectWall({ ...base, status: 200, signals: fine })).toBeUndefined()
  })
  it('跳去白名单外 → off_site', () => {
    expect(detectWall({ ...base, status: 200, finalUrl: 'https://evil.example/' })?.kind).toBe(
      'off_site',
    )
  })
  it('404 不算被拦（这一次没取到而已）', () => {
    expect(detectWall({ ...base, status: 404, signals: signals({ items: 0 }) })).toBeUndefined()
  })
})

describe('findBrowser：只找已经装好的，不下载', () => {
  it('Windows 一定列出 Edge；路径里有空格 / 中文照样拼', () => {
    const c = browserCandidates('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\张 三\\AppData\\Local',
    })
    expect(c).toContain('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
    expect(c).toContain('C:\\Users\\张 三\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  })
  it('按优先级找第一个在的；都不在照实说没找到', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    const got = findBrowser({ platform: 'win32', env: {}, exists: (p) => p === edge })
    expect(got).toEqual({ ok: true, executable: edge })
    const none = findBrowser({ platform: 'darwin', env: {}, exists: () => false })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.message).toMatch(/没找到 Chrome 或 Edge/u)
  })
  it('设置里指定了就只认它', () => {
    const got = findBrowser({ preferred: '/x/chrome', exists: () => false })
    expect(got.ok).toBe(false)
  })
})

describe('浏览器参数与环境变量', () => {
  it('无头、单独用户数据目录、随机调试口；没有任何伪装 / 藏自动化的开关', () => {
    const a = chromeArgs('/data/brand/readonly-browser/profile', 'darwin')
    expect(a).toContain('--headless=new')
    expect(a).toContain('--user-data-dir=/data/brand/readonly-browser/profile')
    expect(a).toContain('--remote-debugging-port=0')
    expect(a.join(' ')).not.toMatch(/AutomationControlled|user-agent|load-extension|proxy-server/u)
  })
  it('环境变量走白名单：Windows 那几样带上，密钥不传', () => {
    const env = browserEnv({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\L',
      OPENAI_API_KEY: 'sk-x',
      AGENTSWS_SECRET: 'y',
    })
    expect(env).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\L' })
  })
})

describe('限速账本', () => {
  const limits = { min_interval_seconds: 20, max_pages_per_hour: 3, max_pages_per_day: 4 }
  it('两页之间要隔开；一小时 / 一天到顶就停', () => {
    const u = createReadUsage({ limits: () => limits })
    const t0 = 1_000_000_000
    expect(u.check(t0).ok).toBe(true)
    u.take(t0)
    expect(u.check(t0 + 5_000)).toMatchObject({ ok: false, reason: 'interval' })
    u.take(t0 + 20_000)
    u.take(t0 + 40_000)
    expect(u.check(t0 + 60_000)).toMatchObject({ ok: false, reason: 'hour' })
    u.take(t0 + 3_700_000)
    expect(u.check(t0 + 3_800_000)).toMatchObject({ ok: false, reason: 'day' })
    expect(u.snapshot(t0 + 3_800_000).day_full).toBe(true)
    expect(u.check(t0 + 86_400_000 + 50_000).ok).toBe(true)
  })
  it('被拦了就停到点，落盘、重启还记得', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp228-usage-'))
    try {
      const file = join(dir, 'usage.json')
      const u = createReadUsage({ file, limits: () => limits })
      u.block('captcha', '页面要做人机验证', 1_000)
      const again = createReadUsage({ file, limits: () => limits })
      expect(again.check(2_000)).toMatchObject({ ok: false, reason: 'blocked' })
      expect(again.snapshot(2_000).blocked?.kind).toBe('captcha')
      expect(again.check(1_000 + 6 * 3_600_000 + 1).ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('429 带了更长的 Retry-After 就按它；跳出白名单不停这一路', () => {
    const u = createReadUsage({ limits: () => limits })
    u.block('rate_limited', '429', 0, 5 * 3_600_000)
    expect(u.snapshot(4 * 3_600_000).blocked?.kind).toBe('rate_limited')
    const v = createReadUsage({ limits: () => limits })
    v.block('off_site', 'x', 0)
    expect(v.snapshot(1).blocked).toBeUndefined()
  })
})
