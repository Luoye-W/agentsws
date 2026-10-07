#!/usr/bin/env node
/**
 * WP246：连接页「取数路线」与「登录读号」的截图，可重跑出处。
 *
 * demo 里本机只读浏览器是替身（不起浏览器、不访问 reddit.com）：「登录读号」的窗口开 1.5 秒自己关，
 * 像用户登好关掉了；之后体检认出 u/demo_reader。拍：
 *
 * 1. `wp246-read-routes`：刚打开（Reddit 两级都不通、YouTube / 网页在用本机那一级）；
 * 2. `wp246-read-routes-tooltip`：停在 Reddit「读号浏览器」那个图标上（原因 + 怎么修）；
 * 3. `wp246-read-account-logging-in`：点了「登录读号」、窗口开着；
 * 4. `wp246-read-account-logged-in`：窗口关掉后「已登录：u/demo_reader」、读号浏览器在用；
 * 5. `wp246-read-account-refused`：读号是品牌登记的号 → 拦下、提示换号；
 * 6. `wp246-read-routes-third-party`：打开第三方转文字。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp246-shots.mjs [--port 4467]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp246')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4467'))
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

async function api(token, owner, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(owner === undefined ? {} : { 'x-assignment': owner }),
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
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const section = page.locator('[data-testid="read-routes"]')
    const snap = async (name) => {
      await page.waitForTimeout(500)
      await section.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    await section.waitFor()
    await section.scrollIntoViewIfNeeded()
    await snap('wp246-read-routes')

    await page
      .locator('[data-testid="read-level-reddit-browser_readonly"] [data-testid="status-icon"]')
      .hover()
    await page.waitForTimeout(600)
    const box = await section.boundingBox()
    await page.screenshot({
      path: join(SHOTS, 'wp246-read-routes-tooltip.png'),
      clip: { x: box.x, y: Math.max(0, box.y - 110), width: box.width, height: box.height + 120 },
    })
    console.log('  📷 wp246-read-routes-tooltip.png')
    await page.mouse.move(0, 0)

    await page.locator('[data-testid="read-account-login"]').click()
    await page.waitForSelector('[data-testid="read-account-status"][data-state="logging_in"]')
    await snap('wp246-read-account-logging-in')

    await page.waitForSelector('[data-testid="read-account-status"][data-state="logged_in"]', {
      timeout: 15_000,
    })
    await snap('wp246-read-account-logged-in')

    await page.locator('[data-testid="read-third-party-switch"]').click()
    await page.waitForTimeout(800)
    await snap('wp246-read-routes-third-party')

    // 把读号登记成品牌的 Reddit 号（假装它是版主号），再体检 → 拦下
    // 登记号要社媒职责那条分配（所有者那条没有 social_account.stage）
    const social = me.assignments.find((a) => a.role_id.startsWith('social.'))
    await api(token, social?.id ?? owner, 'POST', '/v1/social/accounts', {
      channel: 'reddit',
      handle: 'u/demo_reader',
      display_name: 'Demo 官方号',
      url: 'https://www.reddit.com/user/demo_reader',
      external_id: 't2_demo',
    }).catch((e) => console.error(`  ⚠️ 登记号没成：${e.message}`))
    await api(token, owner, 'POST', '/v1/settings/reddit-read-account/check')
    await page.reload({ waitUntil: 'networkidle' })
    await section.waitFor()
    await section.scrollIntoViewIfNeeded()
    await page.waitForSelector('[data-testid="read-account-status"][data-state="refused"]')
    await snap('wp246-read-account-refused')
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
