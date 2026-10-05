#!/usr/bin/env node
/**
 * WP231：「用 Agents 工坊的接口」注册 / 登录分开——截图的可重跑出处（存 `docs/assets/wp231/`）。
 *
 * demo 的云账号那一跳是替身（`cloudStandIn`，`.invalid` 保留域，不出网）：
 * 已注册的演示邮箱是 `demo@example.com`（密码 `demo-pass-2026`），验证码任意 6 位都过、`000000` 算不对。
 *
 * 1. `wp231-wizard-signup`：向导第 ① 步「注册新账号」（名字 / 邮箱 / 密码强度 / 勾条款）；
 * 2. `wp231-wizard-signup-code`：发码之后的输码那一步；
 * 3. `wp231-wizard-already-registered`：邮箱注册过 → 「注册过了」+「去登录」；
 * 4. `wp231-wizard-login-code`：「已有账号，登录」→ 邮箱验证码 → 「如果已注册……还没有账号？去注册」；
 * 5. `wp231-wizard-login-password`：密码登录不对 → 一句人话 + 换验证码登录；
 * 6. `wp231-settings-card`：设置页「Agents 工坊账号」卡（同一个件）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp231-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp231')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
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

/** 与工作台自己登录同样的两跳（demo 档 magic-link → verify）。 */
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
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
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
    const T = (id) => page.getByTestId(id)
    const card = T('ai-card-official')
    const shot = async (name, target = card) => {
      await page.waitForTimeout(300)
      await target.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await T('ai-pick-official').click()
    await T('ai-official-name').fill('北风电器')
    await T('ai-official-email').fill('new-owner@example.com')
    await T('ai-official-password').fill('Sunflower-77')
    await T('ai-official-agree').check()
    await shot('wp231-wizard-signup')

    await T('ai-official-send').click()
    await T('ai-official-code').waitFor()
    await shot('wp231-wizard-signup-code')

    // 注册过的邮箱
    await T('ai-official-back').click()
    await T('ai-official-email').fill('demo@example.com')
    await T('ai-official-password').fill('Sunflower-77')
    await T('ai-official-send').click()
    await T('ai-official-switch-login').waitFor()
    await shot('wp231-wizard-already-registered')

    // 一键切到登录 → 验证码
    await T('ai-official-switch-login').click()
    await T('ai-official-email').fill('someone-new@example.com')
    await T('ai-official-send').click()
    await T('ai-official-go-signup').waitFor()
    await shot('wp231-wizard-login-code')

    // 密码登录不对
    await page.reload({ waitUntil: 'networkidle' })
    await T('ai-pick-official').click()
    await T('ai-official-tab-login').click()
    await T('ai-official-via-password').click()
    await T('ai-official-email').fill('demo@example.com')
    await T('ai-official-password').fill('not-the-password')
    await T('ai-official-send').click()
    await T('ai-official-switch-code').waitFor()
    await shot('wp231-wizard-login-password')

    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'networkidle' })
    await T('cloud-account-unlinked').waitFor({ timeout: 20_000 })
    await shot('wp231-settings-card', T('cloud-account'))
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
