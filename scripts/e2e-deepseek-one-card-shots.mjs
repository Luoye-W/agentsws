#!/usr/bin/env node
/**
 * WP152：DeepSeek 两种连法合成一张卡「DeepSeek 官方」的截图出处（可重跑）。
 *
 * 起一个 demo（不联网：demo 里的 DeepSeek 账号是**替身**，授权页就是本机回调），拍：
 *
 * 1. `wizard-account.png` / `wizard-api.png`：向导第 ① 步第三张大卡「DeepSeek 官方」的两种选中态；
 * 2. `settings-add-account.png` / `settings-add-api.png`：设置页「加一个」里那张合并卡的两种选中态；
 * 3. `settings-configured.png`：「已配的」两条（官方 API 接口连接 + 官方账户登录）；
 * 4. `settings-account-balance.png`：登上之后卡里的余额（平台回长串，界面两位小数、赠送为 0 不说）。
 *
 * **替身数据**（浏览器侧改服务端回的那一格，别的照走 demo）：第 3 张里「官方 API 接口连接」那一条
 * （demo 不给存真 key：存 key 会顺手去官方拉一次模型清单，要出网）——名字就是服务端
 * `providerDisplayLabel` 给老数据的那个（`apps/server/test/models.test.ts` 的 WP152 用例）；
 * 第 4 张的余额长串与为 0 的赠送（Luoye 真账号冒烟看到的形状）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-deepseek-one-card-shots.mjs [--port 4441]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp152')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4441'))
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

    // ① 向导第 ① 步：「DeepSeek 官方」大卡，默认「官方账户登录」→ 切到「官方 API 接口连接」
    const wizard = await context.newPage()
    wizard.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await wizard.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await wizard.click('[data-testid="ai-pick-account"]')
    await wizard.waitForSelector('[data-testid="dsa-login"]')
    await wizard.waitForTimeout(300)
    await wizard.locator('[data-testid="onboarding-ai"]').screenshot({
      path: join(SHOTS, 'wizard-account.png'),
    })
    console.log('  📷 wizard-account.png')
    await wizard.click('[data-testid="ai-ds-mode-api"]')
    await wizard.waitForSelector('[data-testid="ai-card-account"] [data-testid="model-form"]')
    await wizard.waitForTimeout(300)
    await wizard.locator('[data-testid="onboarding-ai"]').screenshot({
      path: join(SHOTS, 'wizard-api.png'),
    })
    console.log('  📷 wizard-api.png')
    await wizard.close()

    // ② 设置页「加一个」：那张合并卡的两种选中态
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await card.waitFor()
    await card.locator('[data-testid="dsa-login"]').waitFor()
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'settings-add-account.png') })
    console.log('  📷 settings-add-account.png')
    await card.getByText('官方 API 接口连接', { exact: true }).click()
    await card.getByText('填 API key').click()
    await card.locator('[data-testid="model-form"]').waitFor()
    await page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'settings-add-api.png') })
    console.log('  📷 settings-add-api.png')

    // ③ 照真流程用替身账号登上（授权页 → 本机回调 → 自动存 + 三步验证）
    await card.getByText('官方账户登录', { exact: true }).click()
    await page.click('[data-testid="dsa-login"]')
    await page.waitForSelector('[data-testid="dsa-waiting"]')
    await context.unroute('**/oauth/callback**')
    if (authorizeUrl === undefined) throw new Error('没拦到授权页地址')
    const loginTab = await context.newPage()
    await loginTab.goto(authorizeUrl)
    await loginTab.close()
    await page.waitForSelector('[data-testid="dsa-ok"]', { timeout: 20_000 })

    // 替身：老用户还配着一条 DeepSeek key（名字是服务端给老数据的新叫法）；余额是平台回的长串
    await patchGet(page, '**/v1/models/providers**', (data) => ({
      ...data,
      providers: [
        {
          id: 'deepseek',
          kind: 'deepseek',
          label: 'DeepSeek 官方 · 官方 API 接口连接',
          base_url: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          region: 'cn',
          has_key: true,
          active: true,
          vision_status: 'ok',
          last_test: {
            ...(data.providers ?? []).find((p) => p.kind === 'deepseek_account')?.last_test,
            model: 'deepseek/deepseek-flash',
          },
        },
        ...(data.providers ?? []),
      ],
    }))
    await patchGet(page, '**/v1/settings/models/deepseek-account', (data) => ({
      ...data,
      balance: {
        status: 'ready',
        wallets: [{ currency: 'CNY', balance: '28.1146885000000000' }],
        bonus: [{ currency: 'CNY', balance: '0' }],
      },
    }))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dsa-balance"]')
    const configured = page.locator('[data-testid="model-row"]').first().locator('xpath=../..')
    await configured.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await configured.screenshot({ path: join(SHOTS, 'settings-configured.png') })
    console.log('  📷 settings-configured.png')
    const signedIn = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await signedIn.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await signedIn.screenshot({ path: join(SHOTS, 'settings-account-balance.png') })
    console.log('  📷 settings-account-balance.png')
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
