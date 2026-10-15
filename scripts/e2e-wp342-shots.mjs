#!/usr/bin/env node
/**
 * WP342（决策 853）：外壳整理——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4442，不碰 4317）。演示世界没关联工坊账号、也没接模型，所以**只在浏览器这一侧**
 * 把两条只读接口换成示意数据（`/v1/cloud/credits` 余额、`/v1/free-chat/models` 已接的模型）：
 * 不填任何 key、不关联任何账号、不发任何请求出去。
 *
 * 拍（`--tag before` 用于改前的界面，只拍整页）：
 *
 * 1. 首页整页：1280×800 浅色 / 深色，最小窗 800×560；
 * 2. 账号菜单展开（两组都展开、余额低的小点）；
 * 3. 岗位页输入框左下角的 AI 钮（工坊的只画标记）+ 展开的模型清单 + 换成自接的（图标 + 短名）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp342-shots.mjs [--port 4442] [--tag after|before]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp342')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4442') || 4442
const TAG = argOf('--tag') ?? 'after'
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

/** 示意数据：余额低（头像上那个小点）、两个已接的模型（工坊的是默认）。 */
const CREDITS = {
  linked: true,
  balance: { available: 96.059, low_balance: true, low_balance_threshold: 100 },
  can_topup: true,
  can_view_usage: true,
}
const MODELS = {
  choices: [
    {
      id: 'agentsws-cloud/deepseek-v3.2',
      label: 'Agents 工坊（用积分）',
      official: true,
      vision: 'ok',
    },
    {
      id: 'deepseek/deepseek-flash',
      label: 'DeepSeek 官方 · 官方 API 接口连接',
      official: false,
      vision: 'no',
    },
  ],
  default: 'agentsws-cloud/deepseek-v3.2',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
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
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
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
    const session = (
      await post('/v1/auth/verify', {
        token: (await post('/v1/auth/magic-link', { email: OWNER })).data.token,
      })
    ).data.session_token
    const meRes = await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${session}` } })
    const me = (await meRes.json()).data
    const duty = me.assignments.find(
      (a) => a.role_id !== 'common.owner' && a.role_id !== 'common.member',
    )

    browser = await chromium.launch({ headless: true })
    const open = async ({ width, height, theme }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [session, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.route(/\/v1\/cloud\/credits(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: CREDITS, trace_id: 'tr_shot' } }),
      )
      await page.route(/\/v1\/free-chat\/models(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: MODELS, trace_id: 'tr_shot' } }),
      )
      return { context, page }
    }
    const shot = async (page, name) => {
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  ✓ ${name}.png`)
    }

    // 1. 首页整页：1280×800 浅色 / 深色、最小窗 800×560
    for (const [w, h, theme, name] of [
      [1280, 800, 'light', `${TAG}-home-1280-light`],
      [1280, 800, 'dark', `${TAG}-home-1280-dark`],
      [800, 560, 'light', `${TAG}-home-800x560-light`],
    ]) {
      const { context, page } = await open({ width: w, height: h, theme })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="account-toggle"]').waitFor({ timeout: 30_000 })
      await shot(page, name)
      await context.close()
    }
    if (TAG !== 'after') return

    // 2. 账号菜单展开（两组都展开）
    {
      const { context, page } = await open({ width: 1280, height: 800, theme: 'light' })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="account-low-dot"]').waitFor({ timeout: 30_000 })
      await page.click('[data-testid="account-toggle"]')
      await page.click('[data-testid="account-group-work-toggle"]')
      await page.click('[data-testid="account-group-settings-toggle"]')
      await shot(page, 'after-account-menu-light')
      await context.close()
    }
    {
      const { context, page } = await open({ width: 1280, height: 800, theme: 'dark' })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="account-toggle"]').waitFor({ timeout: 30_000 })
      await page.click('[data-testid="account-toggle"]')
      await page.click('[data-testid="account-group-work-toggle"]')
      await page.click('[data-testid="account-group-settings-toggle"]')
      await shot(page, 'after-account-menu-dark')
      await context.close()
    }

    // 3. 岗位页输入框里的 AI 钮 + 展开的清单（1280 与最小窗各一张）
    for (const [w, h, name] of [
      [1280, 800, 'after-model-picker-1280'],
      [800, 560, 'after-model-picker-800x560'],
    ]) {
      const { context, page } = await open({ width: w, height: h, theme: 'light' })
      await page.goto(`${BASE}/positions/${duty.id}`, { waitUntil: 'networkidle' })
      const pick = page.locator('[data-testid="position-handoff"] [data-testid="model-pick"]')
      await pick.waitFor({ timeout: 30_000 })
      await pick.scrollIntoViewIfNeeded()
      await shot(page, name.replace('picker', 'button'))
      await pick.click()
      await page.locator('[data-testid="model-pick-menu"]').waitFor()
      await shot(page, name)
      // 换成自接的那个：钮上是服务商图标 + 型号短名（只改这一次，不改默认）
      if (w === 1280) {
        await page
          .locator('[data-testid="model-pick-option"][data-model="deepseek/deepseek-flash"]')
          .click()
        await shot(page, 'after-model-button-own-1280')
      }
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
