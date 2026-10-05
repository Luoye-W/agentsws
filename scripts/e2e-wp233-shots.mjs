#!/usr/bin/env node
/**
 * WP233：首次设置第 ② 步「你的账号」两态 + 设置页「公司邮箱后缀」的截图出处。
 *
 * 起一个 demo（不联网），云账号那一条（`GET /v1/cloud/account`）与本机身份（`GET /v1/onboarding/state`
 * 的 `person.email`）在浏览器里换成替身——demo 世界没有云账号，也不是占位邮箱：
 *
 * 1. `wp233-step2-cloud`：关联了云账号 → 一行「你的账号：…」；
 * 2. `wp233-step2-local`：没有云账号、本机还是占位 `owner@localhost` → 那一行整个不出；
 * 3. `wp233-settings-suffix`：设置页「公司邮箱后缀」从云账号邮箱带出的建议值。
 *
 * 截图里的邮箱都是 `.example` 假地址。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp233-shots.mjs [--port 4399]
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
const PORT = Number(value('--port', '4399'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const CLOUD_EMAIL = 'boss@nordvolt.example'

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

/** 云账号与本机身份换成替身（`linked` = 关联了云账号）。 */
async function stub(page, linked) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await page.route(/\/v1\/cloud\/account(\?.*)?$/, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: linked
          ? {
              linked: true,
              email: CLOUD_EMAIL,
              org_name: 'nordvolt',
              expires_at: '2027-01-01T00:00:00.000Z',
              scopes: ['ai'],
              linked_at: '2026-10-05T00:00:00.000Z',
              cloud_base_url: 'https://cloud.agentsws.dev',
            }
          : { linked: false, cloud_base_url: 'https://cloud.agentsws.dev' },
      }),
    }),
  )
  await page.route(/\/v1\/onboarding\/state(\?.*)?$/, async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    body.data.person.email = linked ? CLOUD_EMAIL : 'owner@localhost'
    // 设置页那一格要看「建议值」：档案里存过的后缀先拿掉
    if (body.data.profile !== undefined) delete body.data.profile.domain
    await route.fulfill({ response: res, json: body })
  })
}

async function step2(page, linked, name) {
  await stub(page, linked)
  await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await page.click('[data-testid="ai-demo"]')
  await page.click('[data-testid="intake-no-site"]')
  await page.waitForSelector('[data-testid="onboarding-person"]')
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
  console.log(`  📷 ${name}.png`)
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

    await step2(page, true, 'wp233-step2-cloud')
    await step2(page, false, 'wp233-step2-local')

    await stub(page, true)
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="settings-company"]')
    await card.waitFor()
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await card.screenshot({ path: join(SHOTS, 'wp233-settings-suffix.png') })
    console.log('  📷 wp233-settings-suffix.png')
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
