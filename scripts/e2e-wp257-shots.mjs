#!/usr/bin/env node
/**
 * WP257（决策 152 / 156）：「群里的帖子」判类打标签与 Telegram 群的截图，可重跑出处（照 WP256 那份改）。
 *
 * 起一个 demo（端口默认 4477，不碰 4317）。demo 里「Reddit 官方号浏览器通道」是内存替身（打开即登录、
 * 新帖队列里有两三条），**不起浏览器、不连 reddit.com**；demo 没连 Discord / Telegram（不连 discord.com /
 * telegram.org）。拍：
 *
 * - Reddit「群里的帖子」：自家版新帖进来就带标签，上方一排标签按类筛 + 「模型复核」开关（亮 / 暗；再拍一张点了一类的）；
 * - Telegram「群里的帖子」：现在会自动拉了——没连上时照实说「还没连上 · 去连接页」。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp257-shots.mjs [--port 4477]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp257')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4477'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    let me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    for (const role_id of ['social.reddit', 'social.telegram-group'])
      if (!me.assignments.some((a) => a.role_id === role_id))
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id,
          ranges: [{ kind: 'brand', id: me.workspace.id }],
        })
    me = await api(token, undefined, 'GET', '/v1/me')
    const reddit = me.assignments.find((a) => a.role_id === 'social.reddit').id
    const telegram = me.assignments.find((a) => a.role_id === 'social.telegram-group').id
    await api(token, reddit, 'POST', '/v1/social/accounts', {
      channel: 'reddit',
      handle: 'r/nordvolt',
      display_name: 'r/nordvolt',
      url: 'https://www.reddit.com/r/nordvolt/',
      external_id: 'nordvolt',
      own_subreddit: true,
    })
    await api(token, reddit, 'POST', '/v1/social/reddit-browser/check')
    // 读一次自家版队列：新帖顺手进「群里的帖子」
    await api(token, reddit, 'GET', '/v1/social/own-sub/queue')

    browser = await chromium.launch({ headless: true })
    const contextOf = async (width, dark) => {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: dark ? 'dark' : 'light',
      })
      await context.addInitScript(
        ([t, theme]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', theme)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, dark ? 'dark' : 'light'],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const shotOf = async (locator, name) => {
      await locator.page().waitForTimeout(400)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const openQuick = async (page, assignment, quick, sel) => {
      await page.goto(`${BASE}/positions/${assignment}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.locator(`[data-testid="work-quick"][data-quick="${quick}"]`).click()
      await page.waitForSelector(sel, { timeout: 20_000 })
      await page.waitForTimeout(600)
      return page.locator('[data-testid="work-quick-view"]')
    }

    for (const dark of [false, true]) {
      const { context, page } = await contextOf(1440, dark)
      const panel = await openQuick(
        page,
        reddit,
        'quick:threads:social.reddit',
        '[data-testid="threads-tags"]',
      )
      await shotOf(panel, `reddit-tags-${dark ? 'dark' : 'light'}`)
      if (!dark) {
        // 点第一类（demo 里有哪类就点哪类）
        await page.locator('[data-testid="threads-tag"]:not([data-tag="all"])').first().click()
        await shotOf(panel, 'reddit-tags-filtered-light')
      }
      await context.close()
    }
    {
      const { context, page } = await contextOf(1440, false)
      const panel = await openQuick(
        page,
        telegram,
        'quick:threads:social.telegram-group',
        '[data-testid="threads-empty"]',
      )
      await shotOf(panel, 'telegram-threads-light')
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
