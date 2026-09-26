#!/usr/bin/env node
/**
 * WP156（界面减字）：前后对比截图的可重跑出处。存到 `docs/assets/wp156/<tag>-*.png`。
 *
 * 拍四处（派工单点名的）：
 *
 * 1. `<tag>-settings-models.png`：设置页「模型」一段的「加一个」（DeepSeek 官方 / OpenAI 兼容 / 阿里云百炼…）；
 * 2. `<tag>-settings-browser.png`：设置页「浏览器」，选中「我正在用的浏览器」（带三步）；
 * 3. `<tag>-settings-computer-use.png`：设置页「电脑操控」，总开关打开；
 * 4. `<tag>-wizard-ai.png`：向导第 ① 步「接上 AI」，展开「DeepSeek 官方」并切到「官方 API 接口连接」。
 * 5. `<tag>-help-panel.png`（只有 after 有）：点「阿里云百炼」卡上的「看教程」，右栏打开那一篇。
 *
 * **不联网、不用真账号**：demo 里服务端几格"本机才有"的状态（电脑操控 / 浏览器扩展能不能用）
 * 在浏览器侧替身成"能用"，别的照走 demo。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-less-text-shots.mjs --tag before|after [--port 4445]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp156')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4445'))
const TAG = value('--tag', 'after')
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

/** 把服务端回的 `data` 改几格（别的照走 demo）。 */
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

async function shoot(locator, name) {
  await locator.scrollIntoViewIfNeeded()
  await locator.page().waitForTimeout(300)
  await locator.screenshot({ path: join(SHOTS, `${TAG}-${name}.png`) })
  console.log(`  📷 ${TAG}-${name}.png`)
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
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 向导第 ① 步
    const wizard = await context.newPage()
    wizard.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await wizard.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await wizard.locator('[data-testid="onboarding-ai"]').waitFor()
    // 展开「DeepSeek 官方」→ 切到「官方 API 接口连接」：原来这里铺着开放平台的几步与外链
    await wizard.click('[data-testid="ai-pick-account"]')
    await wizard.click('[data-testid="ai-ds-mode-api"]')
    await wizard.locator('[data-testid="ai-ds-api-hint"]').waitFor()
    await shoot(wizard.locator('[data-testid="onboarding-ai"]'), 'wizard-ai')
    await wizard.close()

    // ② 设置页
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await patchGet(page, '**/v1/settings/computer-use', (data) => ({
      ...data,
      allowed: true,
      enabled: true,
      driver: { installed: false, platform_key: 'darwin-arm64', pinned_version: '0.28.0' },
    }))
    await patchGet(page, '**/v1/settings/browser', (data) => ({
      ...data,
      attach_allowed: true,
      browserskill_allowed: true,
    }))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })

    const add = page.locator('[data-testid="model-template"]').first().locator('xpath=../..')
    await add.waitFor()
    await shoot(add, 'settings-models')

    const browserCard = page.locator('[data-testid="settings-browser"]')
    await browserCard.waitFor()
    await page.click('[data-testid="browser-mode-browserskill"]')
    await page.waitForTimeout(300)
    await shoot(browserCard, 'settings-browser')

    const cu = page.locator('[data-testid="settings-computer-use"]')
    await cu.waitFor()
    await shoot(cu, 'settings-computer-use')

    // ③ 点「看教程」→ 右栏打开那一篇（改之前没有这个按钮，跳过）
    // 挑「阿里云百炼」那张（Luoye 09-26 截图里最满的一张）
    const tutorial = page.locator(
      '[data-testid="model-template"][data-vendor="bailian"] [data-testid="tutorial-link"]',
    )
    if ((await tutorial.count()) > 0) {
      await tutorial.scrollIntoViewIfNeeded()
      await tutorial.click()
      const panel = page.locator('[data-testid="help-panel"]')
      await panel.waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(SHOTS, `${TAG}-help-panel.png`) })
      console.log(`  📷 ${TAG}-help-panel.png`)
    }
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
