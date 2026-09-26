#!/usr/bin/env node
/**
 * WP134：「用我的 DeepSeek 账号登录」四张截图的可重跑出处。
 *
 * 起一个 demo（不联网：demo 里的 DeepSeek 账号是**替身**——点登录打开的"授权页"就是本机回调，
 * 打开即登录；账号名与余额是替身数据；三步验证打的是认得测试图的假 Messages 口），用真浏览器拍四张：
 *
 * 1. `deepseek-login-wizard`：向导第 ① 步三张大卡，第三张「用我的 DeepSeek 账号登录」展开；
 * 2. `deepseek-login-waiting`：点了登录、浏览器那边还没点同意——"在浏览器里登录并点同意"；
 * 3. `deepseek-login-signed-in`：设置页那张卡——账号名、余额（赠送另列）、三步都过；
 * 4. `deepseek-login-balance-failed`：余额查不到时那句人话（浏览器侧替身改那一格）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-deepseek-login-shots.mjs [--port 4421]
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
const PORT = Number(value('--port', '4421'))
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
    // "系统浏览器"那一跳先拦住：拍完"等浏览器"那一张再放行
    let authorizeUrl
    await context.route('**/oauth/callback**', (route) => {
      authorizeUrl = route.request().url()
      return route.abort()
    })

    // ① 向导第 ① 步：第三张大卡展开
    const wizard = await context.newPage()
    wizard.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await wizard.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await wizard.click('[data-testid="ai-pick-account"]')
    await wizard.waitForSelector('[data-testid="dsa-login"]')
    await wizard.waitForTimeout(300)
    await wizard.locator('[data-testid="onboarding-ai"]').screenshot({
      path: join(SHOTS, 'deepseek-login-wizard.png'),
    })
    console.log('  📷 deepseek-login-wizard.png')

    // ② 点登录：授权页交给"系统浏览器"（这里是新标签页，被上面拦住），界面在等
    await wizard.click('[data-testid="dsa-login"]')
    await wizard.waitForSelector('[data-testid="dsa-waiting"]')
    await wizard.waitForTimeout(400)
    await wizard.locator('[data-testid="ai-card-account"]').screenshot({
      path: join(SHOTS, 'deepseek-login-waiting.png'),
    })
    console.log('  📷 deepseek-login-waiting.png')

    // 放行：用户在浏览器里点了同意 → 回到服务进程自己的端口 → 登上
    await context.unroute('**/oauth/callback**')
    const loginTab = await context.newPage()
    if (authorizeUrl === undefined) throw new Error('没拦到授权页地址')
    await loginTab.goto(authorizeUrl)
    await loginTab.close()
    await wizard.waitForSelector('[data-testid="dsa-ok"]', { timeout: 20_000 })
    await wizard.close()

    // ③ 设置页那张卡：账号名、余额、三步都过
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await card.waitFor()
    await page.waitForSelector('[data-testid="dsa-ok"]')
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'deepseek-login-signed-in.png') })
    console.log('  📷 deepseek-login-signed-in.png')

    // ④ 余额查不到：浏览器侧把那一格换成服务端那句话（别的照走 demo）
    await page.route('**/v1/settings/models/deepseek-account', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const json = await res.json()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            ...json.data,
            balance: {
              status: 'failed',
              message:
                '余额暂时查不到——DeepSeek 那边这会儿没回话。不影响用它干活，过一会儿再看，或者去 DeepSeek 开放平台看。',
            },
          },
        }),
      })
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dsa-balance-failed"]')
    const again = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await again.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await again.screenshot({ path: join(SHOTS, 'deepseek-login-balance-failed.png') })
    console.log('  📷 deepseek-login-balance-failed.png')
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
