#!/usr/bin/env node
/**
 * WP147（截图给 AI 看）：三处白话告知的截图，可重跑出处。存到 `docs/assets/wp147/`。
 *
 * 1. `settings-computer-use.png`：设置页「电脑操控」——打开前那段白话里多了
 *    「截图会发给你选的 AI 模型用来看界面，不会存进 Agents 工坊的记录」；
 * 2. `settings-browser.png`：设置页「浏览器」——开头那段说明里同一句；
 * 3. `card-computer-use.png`：牌堆里的授权卡「让它在接下来 10 分钟操作这台电脑？」同一句
 *    （`--card-gallery` 摆拍，文案与运行时 `request_computer_use` 出的逐字相同）。
 *
 * **不启动真驱动、不动这台电脑、不截真屏**：只拍工作台页面。demo 没有数据目录，
 * 「驱动已装好」是浏览器侧替身（与 WP144 的截图脚本同一个替身）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node scripts/e2e-screenshots-privacy-shots.mjs [--port 4437]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp147')
const SENTENCE = '截图会发给你选的 AI 模型用来看界面，不会存进 Agents 工坊的记录'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4437'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT), '--card-gallery'],
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

/** 浏览器侧替身：驱动已装好（demo 没有数据目录，也不许真跑驱动）。 */
async function driverInstalled(page) {
  await page.route('**/v1/settings/computer-use', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...json.data,
          driver: {
            installed: true,
            path: '~/Library/Application Support/agentsws/data/computer-use/cua-driver-0.28.0/cua-driver',
            pinned_version: '0.28.0',
            platform_key: 'darwin-arm64',
          },
        },
      }),
    })
  })
}

async function expectSentence(locator, what) {
  const text = await locator.innerText()
  if (!text.includes(SENTENCE)) throw new Error(`${what} 里没有那句告知：\n${text}`)
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 设置页「电脑操控」：总开关关着时那段白话
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await driverInstalled(page)
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const cu = page.locator('[data-testid="settings-computer-use"]')
    await cu.waitFor()
    await cu.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await expectSentence(cu, '设置页电脑操控')
    await cu.screenshot({ path: join(SHOTS, 'settings-computer-use.png') })
    console.log('  📷 settings-computer-use.png')

    // ② 设置页「浏览器」开头那段说明
    const br = page.locator('[data-testid="settings-browser"]')
    await br.waitFor()
    await br.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await expectSentence(br, '设置页浏览器')
    await br.screenshot({ path: join(SHOTS, 'settings-browser.png') })
    console.log('  📷 settings-browser.png')

    // ③ 牌堆里的授权卡
    const home = await context.newPage()
    home.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await home.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const deck = () => home.locator('[data-testid="deck-card"]').first()
    await deck().waitFor({ timeout: 20_000 })
    const hit = async () =>
      /操作这台电脑/.test(
        await deck()
          .innerText()
          .catch(() => ''),
      )
    for (let i = 0; i < 40 && !(await hit()); i += 1) {
      const next = home.locator('[data-testid="deck-next"]').first()
      if (!(await next.count()) || (await next.isDisabled())) break
      await next.click()
      await home.waitForTimeout(300)
    }
    if (!(await hit())) throw new Error('牌堆里找不到电脑操控那张授权卡')
    await home.waitForTimeout(300)
    await expectSentence(deck(), '授权卡')
    await deck().screenshot({ path: join(SHOTS, 'card-computer-use.png') })
    console.log('  📷 card-computer-use.png')
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
