#!/usr/bin/env node
/**
 * WP150：DeepSeek 账号「登录失效」与「登出前停任务」三张截图的可重跑出处。
 *
 * 起一个 demo（不联网：demo 里的 DeepSeek 账号是**替身**，见 WP134 的 `e2e-deepseek-login-shots.mjs`），
 * 先照真流程登上（替身授权页 → 回调 → 自动存 + 三步验证），再拍：
 *
 * 1. `deepseek-account-sign-out-tasks`：点「登出」时正在用这个账号跑的事列在卡片里，等人确认；
 * 2. `deepseek-account-expired`：登录失效被自动登出后那张卡——"登录过期了，点一下重新登录"，按钮叫「重新登录」；
 * 3. `deepseek-account-expired-topbar`：同一时刻顶栏那个"还没接模型"的胶囊（这条模型来源被摘了）。
 *
 * **替身数据**（浏览器侧改服务端回的那一格，别的照走 demo）：第 1 张的两件"正在跑的事"；
 * 第 2、3 张的"失效登出"状态与摘掉之后的模型清单——形状就是服务端真回的那样
 * （`apps/server/test/deepseek-account.test.ts` 的 WP150 用例用官方模块把这两种状态真走过一遍）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-deepseek-account-lifecycle-shots.mjs [--port 4439]
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
const PORT = Number(value('--port', '4439'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

/** 替身：两件"正在用这个账号跑"的事（事项名是 demo 里那家店会有的活）。 */
const TASKS = [
  { run_id: 'run_demo_1', matter_id: 'mat_demo_1', title: '回复客户 Anna 的退货' },
  { run_id: 'run_demo_2', matter_id: 'mat_demo_2', title: '给 12 位数码达人发合作邀约' },
]

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
    // "系统浏览器"那一跳：拦下地址，自己开一次（替身授权页就是本机回调，打开即登录）
    let authorizeUrl
    await context.route('**/oauth/callback**', (route) => {
      authorizeUrl = route.request().url()
      return route.abort()
    })

    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="model-deepseek-account-card"]')
    await card.waitFor()
    await page.click('[data-testid="dsa-login"]')
    await page.waitForSelector('[data-testid="dsa-waiting"]')
    await context.unroute('**/oauth/callback**')
    if (authorizeUrl === undefined) throw new Error('没拦到授权页地址')
    const loginTab = await context.newPage()
    await loginTab.goto(authorizeUrl)
    await loginTab.close()
    await page.waitForSelector('[data-testid="dsa-ok"]', { timeout: 20_000 })

    // ① 点登出：有两件正在用这个账号跑的事 → 卡片里列出来，等人确认
    await patchGet(page, '**/v1/settings/models/deepseek-account', (data) => ({
      ...data,
      running_tasks: TASKS,
    }))
    await page.click('[data-testid="dsa-sign-out"]')
    await page.waitForSelector('[data-testid="dsa-sign-out-tasks"]')
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'deepseek-account-sign-out-tasks.png') })
    console.log('  📷 deepseek-account-sign-out-tasks.png')
    await page.click('[data-testid="dsa-sign-out-keep"]')
    await page.unroute('**/v1/settings/models/deepseek-account')

    // ② ③ 平台那边登录失效：服务端自动登出、摘掉这条模型来源（替身：改这两条 GET 的回话）
    await patchGet(page, '**/v1/settings/models/deepseek-account', (data) => {
      const {
        account: _a,
        balance: _b,
        running_tasks: _r,
        attempt: _t,
        account_error: _e,
        ...rest
      } = data
      return {
        ...rest,
        signed_in: false,
        session_expired: {
          at: new Date().toISOString(),
          message: 'DeepSeek 账号的登录过期了（DeepSeek 那边不认这次的登录了），点一下重新登录。',
        },
      }
    })
    await patchGet(page, '**/v1/models/providers**', (data) => ({
      ...data,
      providers: (data.providers ?? []).filter((p) => p.kind !== 'deepseek_account'),
    }))
    // 摘掉之后默认模型那一格空了（服务端 `remove` 连默认一起清），顶栏的模型芯片随之不出
    await patchGet(page, '**/v1/models/defaults**', (data) => ({
      ...data,
      default: '',
      choices: [],
    }))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dsa-expired"]')
    await page.waitForSelector('[data-testid="no-model-chip"]')
    const expired = page.locator('[data-testid="model-deepseek-account-card"]')
    await expired.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await expired.screenshot({ path: join(SHOTS, 'deepseek-account-expired.png') })
    console.log('  📷 deepseek-account-expired.png')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(200)
    await page.screenshot({
      path: join(SHOTS, 'deepseek-account-expired-topbar.png'),
      clip: { x: 0, y: 0, width: 1280, height: 120 },
    })
    console.log('  📷 deepseek-account-expired-topbar.png')
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
