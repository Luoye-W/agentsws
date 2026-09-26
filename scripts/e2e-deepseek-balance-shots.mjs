#!/usr/bin/env node
/**
 * WP151：DeepSeek「余额不足」三张截图的可重跑出处（demo 端口默认 4440）。
 *
 * 起一个 demo（不联网：demo 里的 DeepSeek 账号是**替身**），照真流程登上（替身授权页 → 回调 →
 * 自动存 + 三步验证），再拍：
 *
 * 1. `deepseek-balance-account`：账号卡——"DeepSeek 账号余额不足，充值后再让它接着做" +「去充值」（官方 `links.topUpUrl`）；
 * 2. `deepseek-balance-topbar`：同一时刻顶栏那个黄色小胶囊「DeepSeek 余额不足」；
 * 3. `deepseek-balance-api-key`：API key 那一条模型卡——"DeepSeek API 余额不足，去开放平台充值后再试" +「去充值」。
 *
 * **替身数据**（浏览器侧改服务端回的那一格，别的照走 demo）：余额不足那一格（`quota_exceeded`）、钱包 0，
 * 以及第 3 张那条 API key 来源——形状就是服务端真回的那样（`apps/server/test/deepseek-balance.test.ts`
 * 用真服务进程 + 回 402 的替身上游把两条路真走过一遍）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-deepseek-balance-shots.mjs [--port 4440]
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
const PORT = Number(value('--port', '4440'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const AT = new Date().toISOString()
const ACCOUNT_QUOTA = 'DeepSeek 账号余额不足，充值后再让它接着做。'
const API_QUOTA = 'DeepSeek API 余额不足，去开放平台充值后再试。'
const PLATFORM_TOP_UP = 'https://platform.deepseek.com/top_up'

/** 第 3 张那条 DeepSeek 官方 API key 来源（替身行，不含任何 key）。 */
const KEY_ROW = {
  id: 'deepseek',
  kind: 'deepseek',
  label: 'DeepSeek 官方',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  region: 'cn',
  has_key: true,
  active: true,
  vision_status: 'ok',
  quota_exceeded: { at: AT, message: API_QUOTA, top_up_url: PLATFORM_TOP_UP },
}

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

/** 把服务端回的 `data` 改一格（别的照走 demo）。 */
async function patchGet(page, pattern, patch) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...json, data: patch(json.data) }),
    })
  })
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    let authorizeUrl
    await context.route('**/oauth/callback**', (route) => {
      authorizeUrl = route.request().url()
      return route.abort()
    })

    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await card.waitFor()
    await page.click('[data-testid="dsa-login"]')
    await page.waitForSelector('[data-testid="dsa-waiting"]')
    await context.unroute('**/oauth/callback**')
    if (authorizeUrl === undefined) throw new Error('没拦到授权页地址')
    const loginTab = await context.newPage()
    await loginTab.goto(authorizeUrl)
    await loginTab.close()
    await page.waitForSelector('[data-testid="dsa-ok"]', { timeout: 20_000 })

    // 推理口回了 402：账号那一块记下"余额不足"、钱包是 0（替身：改这两条 GET 的回话）
    await patchGet(page, '**/v1/settings/models/deepseek-account', (data) => ({
      ...data,
      balance: { status: 'ready', wallets: [{ currency: 'CNY', balance: '0.00' }], bonus: [] },
      quota_exceeded: { at: AT, message: ACCOUNT_QUOTA },
    }))
    await patchGet(page, '**/v1/models/providers**', (data) => ({
      ...data,
      providers: [
        ...(data.providers ?? []).map((p) =>
          p.kind === 'deepseek_account'
            ? {
                ...p,
                quota_exceeded: { at: AT, message: ACCOUNT_QUOTA, top_up_url: PLATFORM_TOP_UP },
              }
            : p,
        ),
        KEY_ROW,
      ],
    }))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dsa-signed-in"] [data-testid="model-quota"]')
    await page.waitForSelector('[data-testid="quota-chip"]')
    const account = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await account.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await account.screenshot({ path: join(SHOTS, 'deepseek-balance-account.png') })
    console.log('  📷 deepseek-balance-account.png')

    const keyRow = page.locator('[data-testid="model-row"][data-id="deepseek"]')
    await keyRow.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await keyRow.screenshot({ path: join(SHOTS, 'deepseek-balance-api-key.png') })
    console.log('  📷 deepseek-balance-api-key.png')

    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(200)
    await page.screenshot({
      path: join(SHOTS, 'deepseek-balance-topbar.png'),
      clip: { x: 0, y: 0, width: 1280, height: 120 },
    })
    console.log('  📷 deepseek-balance-topbar.png')
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
