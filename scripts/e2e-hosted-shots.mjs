#!/usr/bin/env node
/**
 * WP128：聊天窗设置页「转发方式」第三项——客服增值服务（云端替你值守）两张截图的可重跑出处。
 *
 * 起一个 demo（不联网），用真浏览器拍两张：
 *
 * 1. `hosted-relay-on`：订阅生效、托管实例在跑——「云端替你值守中」+ 最近心跳 + 取消 / 两颗同步按钮；
 * 2. `hosted-relay-off`：没开——一句「没开」+ 开通（30 积分 / 月）。
 *
 * demo 里没有云端，所以 `/v1/chat/relay/hosted` 由浏览器侧的路由替身给（`page.route`）：
 * 界面画的是真的，只是那一条接口回的是固定的一份。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-hosted-shots.mjs [--port 4412]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4412'))
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

const envelope = (data) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ data }),
})

const ON = () => ({
  available: true,
  linked: true,
  subscription: { status: 'active', current_cycle_end: '2026-10-23T09:00:00.000Z' },
  hosted: {
    state: 'running',
    last_heartbeat_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    snapshot: {
      at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      bytes: 482_113,
      source: 'hosted',
    },
  },
})
const OFF = { available: true, linked: true, subscription: { status: 'none' } }

async function shoot(context, name, view) {
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  await page.route('**/v1/chat/relay/hosted', (route) => route.fulfill(envelope(view)))
  await page.goto(`${BASE}/chat-window`, { waitUntil: 'networkidle' })
  const box = page.locator('[data-testid="relay-hosted"]')
  await box.waitFor()
  await page.waitForTimeout(400)
  // 拍「转发方式」整张卡：三项放在一起看才看得出第三项是什么
  await page
    .locator('[data-testid="relay-mode"]')
    .locator('xpath=../..') // relay-mode → CardContent → Card
    .screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
  await page.close()
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    await shoot(context, 'hosted-relay-on', ON())
    await shoot(context, 'hosted-relay-off', OFF)
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
