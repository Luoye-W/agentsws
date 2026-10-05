#!/usr/bin/env node
/**
 * WP215：「每个品牌的后台同时跑」三张截图的可重跑出处。存到 `docs/assets/wp215/`。
 *
 * 1. `brand-switcher-background.png`：顶栏品牌切换器展开——两个品牌各一行，名字旁边是后台状态
 *    （图标 + 在跑的定时任务数），鼠标停在第二个品牌那一格上出 tooltip；
 * 2. `org-brands-background.png`：公司页「品牌一览」——每行一列后台状态 + 「停后台 / 放开」；
 *    第二个品牌按了急停（暂停样子），第一个照常；
 * 3. `settings-background.png`：设置 → 通用 →「后台」卡（同时最多跑几件）。
 *
 * 全走 demo `--two-brands`（合成数据，没有一个真账号）；不碰 4317 那个服务。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node scripts/e2e-wp215-shots.mjs [--port 4415]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp215')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4415'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT), '--two-brands'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 180; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（90 秒）：\n${log.join('')}`)
}

async function post(path, token, body, method = 'POST') {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return res.json()
}

async function login() {
  const link = await post('/v1/auth/magic-link', undefined, { email: OWNER })
  const verified = await post('/v1/auth/verify', undefined, { token: link.data.token })
  return verified.data.session_token
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 顶栏切换器展开，停在第二个品牌那一格上
    const page = await context.newPage()
    await page.setViewportSize({ width: 1100, height: 520 })
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const switcher = page.locator('[data-testid="brand-switcher"]')
    await switcher.waitFor({ timeout: 30_000 })
    await switcher.locator('button').first().click()
    const menu = page.locator('[data-testid="brand-menu"]')
    await menu.waitFor()
    const options = menu.locator('[data-testid^="brand-option-"]')
    const second = options.nth(1)
    const badge = second.locator('[data-hint]').first()
    if ((await badge.count()) > 0) {
      // 下拉在顶栏贴边：hover 偶尔判"在视口外"，退回直接派一个指针事件让 tooltip 出来
      await badge.hover({ timeout: 4000 }).catch(async () => {
        await badge.dispatchEvent('pointerenter')
        await badge.dispatchEvent('pointermove')
        await badge.focus().catch(() => undefined)
      })
    }
    await page.waitForTimeout(600)
    // 整个视口拍一张（切换器在左上角，下拉 + tooltip 都在里面）
    await page.screenshot({ path: join(SHOTS, 'brand-switcher-background.png') })
    console.log('  📷 brand-switcher-background.png')

    // ② 品牌一览：先把第二个品牌的后台停掉（走真路由），一行停着、一行在跑
    const org = await page.evaluate(async () => {
      const res = await fetch('/v1/orgs', {
        headers: { authorization: `Bearer ${localStorage.getItem('agentsws.session_token')}` },
      })
      return (await res.json()).data?.[0]?.id
    })
    const orgPage = await context.newPage()
    orgPage.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await orgPage.goto(`${BASE}/org?tab=brands`, { waitUntil: 'networkidle' })
    const brands = orgPage.locator('[data-testid="org-brands"]')
    await brands.waitFor({ timeout: 30_000 })
    const toggles = orgPage.locator('[data-testid^="brand-bg-toggle-"]')
    if ((await toggles.count()) > 1) {
      await toggles.nth(1).click()
      await orgPage.waitForTimeout(1200)
    }
    await brands.screenshot({ path: join(SHOTS, 'org-brands-background.png') })
    console.log(`  📷 org-brands-background.png（组织 ${org ?? '?'}）`)
    // 拍完放开，别把 demo 的状态留成停着
    if ((await toggles.count()) > 1) await toggles.nth(1).click()

    // ③ 设置 → 通用 →「后台」卡
    const settings = await context.newPage()
    await settings.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = settings.locator('[data-testid="settings-background"]')
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    await card.screenshot({ path: join(SHOTS, 'settings-background.png') })
    console.log('  📷 settings-background.png')
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
