#!/usr/bin/env node
/**
 * WP121b（70 §1–§3）：初始化设置三张截图的可重跑出处。
 *
 * `docs/assets/workstation/onboarding-{ai,intake,profile}.png` 不是手拍的——
 * 这个脚本起一个 demo（第 ② 步那一轮分析 replay pack 里的 `fixtures/site/*`，
 * 不联网），用真浏览器点三下、拍三张：
 *
 * 1. `onboarding-ai`：第 ① 步两张大卡（官方接口 / 自有模型）与那条演示旁路；
 * 2. `onboarding-intake`：第 ② 步贴网址那一屏（含开跑前的报价与封顶）；
 * 3. `onboarding-profile`：分析跑完那张可编辑的品牌档案卡。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-onboarding-shots.mjs [--port 4407]
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
const PORT = Number(value('--port', '4407'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
/** pack 夹具里自报家门的那个网址（`packs/dtc-3c-3p/fixtures/site/home.html`）。 */
const SITE = 'https://nordvolt.example/'

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

    await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="onboarding-ai"]')
    await page.screenshot({ path: join(SHOTS, 'onboarding-ai.png') })
    console.log('  📷 onboarding-ai.png')

    await page.click('[data-testid="ai-demo"]')
    await page.waitForSelector('[data-testid="intake-url"]')
    await page.screenshot({ path: join(SHOTS, 'onboarding-intake.png') })
    console.log('  📷 onboarding-intake.png')

    await page.fill('[data-testid="intake-url"]', SITE)
    await page.click('[data-testid="intake-start"]')
    await page.waitForSelector('[data-testid="brand-profile-card"]', { timeout: 90_000 })
    await page.waitForSelector('[data-testid="intake-row-brand_name"]')
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, 'onboarding-profile.png'), fullPage: true })
    console.log('  📷 onboarding-profile.png')
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
