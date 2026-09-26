#!/usr/bin/env node
/**
 * WP155：连接页「搜索数据」一行的截图出处（可重跑，不联网）。
 *
 * 起一个 demo，拍三张：
 *
 * 1. `search-data-none.png`：什么都没接（demo 没有搜索数据）——三个按钮 + 一句人话；
 * 2. `search-data-official.png`：官方那一档（**替身**：浏览器侧把 `GET /v1/search-data` 改成
 *    「关联了云账号、官方已开通」——demo 的云是假的，开不了官方）；单价常显；
 * 3. `search-data-byo.png`：点「自带 key」后的原生表单（选服务商 + 填 key），什么都不填。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-search-data-shots.mjs [--port 4443]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp155')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4443'))
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

async function shot(page, name) {
  const section = page.locator('[data-testid="search-data"]')
  await section.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await section.screenshot({ path: join(SHOTS, name) })
  console.log(`  📷 ${name}`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ① 什么都没接
    await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="search-data-status"]')
    await shot(page, 'search-data-none.png')

    // ② 官方那一档（替身：关联了云账号、官方已开通）
    await page.route('**/v1/search-data', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const json = await res.json()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...json,
          data: {
            choice: 'auto',
            status: {
              configured: true,
              route: 'official',
              engines: ['google', 'bing'],
              platforms: ['chatgpt', 'perplexity', 'gemini', 'google_ai_overview'],
              prices: { serp: 0.2, ai_answer: 0.4 },
            },
          },
        }),
      })
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="search-data-price"]')
    await shot(page, 'search-data-official.png')
    await page.unroute('**/v1/search-data')

    // ③ 自带 key：原生表单
    await page.reload({ waitUntil: 'networkidle' })
    await page.click('[data-testid="search-data-choice-byo"]')
    await page.waitForSelector('[data-testid="search-data-byo"]')
    await shot(page, 'search-data-byo.png')
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
