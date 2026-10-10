#!/usr/bin/env node
/**
 * WP288：岗位页简化的截图，可重跑出处。
 *
 * 起一个 demo（演示世界），拍：
 *
 * 0. `wp288-position-page`：岗位页一屏——连接正常（标题旁绿勾，悬停出 tooltip）、没有状态行与页签、
 *    「要你处理 N」一行含筛选与翻页；`wp288-before-after`：与 WP287 那张（改前）并排；
 * 1. `wp288-connection-missing`：演示世界本来的样子——缺必需连接，一行醒目提示（没有绿勾）；
 *    `wp288-connection-expired`：店铺授权过期——一行「重新授权」（没有绿勾）；
 * 2. `wp288-filter-pop` / `wp288-filter-active`：点开筛选图标的弹层；筛选生效时标题下一排已选条件；
 * 3. `wp288-rail-records`：第三栏「记录」；
 * 4. `wp288-ask-thread`：问一句进会话——页头没有状态与职责、没有「会话 · 转成任务」那一排、
 *    回答前没有「跑完了 · 0 秒」；`wp288-ask-menu`：「转成任务」在「⋯」里。
 *
 * 「连接正常」与「授权过期」两种在演示世界里造不出来：拦下连接 / 店铺授权那两条读取，换成那种状态，
 * 拍的是真界面怎么画它（判据由 `wp241-position-v2` / `wp261-shop-admin-banner` 单测钉住）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp288-shots.mjs [--port 4398]
 * ```
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp288')
const BEFORE = join(ROOT, 'docs/assets/wp287/wp287-position-page.png')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4398'))
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

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
  console.log(`  📷 ${name}.png`)
}

async function api(token, owner, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(owner === undefined ? {} : { 'x-assignment': owner }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

/** 连接读取：全部连上（「连接正常」那一种）。 */
async function connectionsOk(route) {
  const res = await route.fetch()
  const json = await res.json()
  json.data.missing_required = []
  json.data.ready = true
  json.data.items = json.data.items.map((i) => (i.required ? { ...i, connected: true } : i))
  await route.fulfill({ response: res, json })
}

/** 店铺授权读取：换成给定的状态。 */
function shopAdminAs(state) {
  return async (route) => {
    await route.fulfill({
      json: {
        data: {
          applicable: true,
          state,
          store: 'nordvolt-demo.myshopify.com',
          scopes_needed: ['write_products', 'write_online_store_pages'],
          scopes_granted:
            state === 'authorized'
              ? ['read_products', 'write_products', 'write_online_store_pages']
              : [],
          missing: [],
          refreshable: true,
        },
      },
    })
  }
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
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const mine = await api(token, owner, 'GET', '/v1/positions')
    const instances = mine.instances ?? []
    const web = instances.find((p) => p.position_id === 'web-ops') ?? instances[0]
    const asg = web.roles.find((r) => r.my_assignment_id !== undefined).my_assignment_id
    console.log(`  岗位：${web.name.zh}（${asg}）`)

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
    const positionUrl = `${BASE}/positions/${asg}`

    // 0. 连接正常：标题旁一个绿勾（悬停出 tooltip）
    await page.route('**/v1/positions/*/connections*', connectionsOk)
    await page.route('**/v1/shop-admin*', shopAdminAs('authorized'))
    await page.goto(positionUrl, { waitUntil: 'networkidle' })
    const tick = page.getByTestId('position-connected')
    await tick.waitFor({ timeout: 20_000 })
    await tick.hover()
    await page.waitForTimeout(300)
    await shot(page, 'wp288-position-page')
    await page.mouse.move(640, 600)

    // 2. 筛选：弹层；生效时标题下一排已选条件
    const filter = page.getByTestId('deck-filter').first()
    await filter.click()
    await page.getByTestId('deck-filters').waitFor()
    await shot(page, 'wp288-filter-pop')
    await page.getByTestId('deck-modes').getByText('原文', { exact: true }).click()
    const source = page.getByTestId('deck-filters').getByLabel('来源')
    await source.selectOption('system').catch(() => undefined)
    await page.keyboard.press('Escape')
    await page.getByTestId('deck-active-filters').waitFor()
    await shot(page, 'wp288-filter-active')

    // 3. 第三栏「记录」
    await page.goto(positionUrl, { waitUntil: 'networkidle' })
    await page.getByTestId('rail-icon-records').click()
    await page
      .locator('[data-testid="records"], [data-testid="records-empty"]')
      .first()
      .waitFor({ timeout: 20_000 })
    await shot(page, 'wp288-rail-records')
    await page.getByTestId('rail-icon-records').click()

    // 1b. 授权过期：一行「重新授权」，没有绿勾
    await page.unroute('**/v1/shop-admin*')
    await page.route('**/v1/shop-admin*', shopAdminAs('expired'))
    await page.goto(positionUrl, { waitUntil: 'networkidle' })
    await page.getByTestId('shop-admin-banner').waitFor({ timeout: 20_000 })
    await shot(page, 'wp288-connection-expired')

    // 1a. 演示世界本来的样子：缺必需连接（一行醒目提示，没有绿勾）
    await page.unroute('**/v1/shop-admin*')
    await page.unroute('**/v1/positions/*/connections*')
    await page.goto(positionUrl, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    await shot(page, 'wp288-connection-missing')

    // 4. 问一句：进会话线程
    const box = page.locator('[data-testid="position-entry-input"]')
    await box.waitFor({ timeout: 30_000 })
    await box.click()
    await box.fill('现在店铺里有哪些产品')
    await box.press('Enter')
    await page.waitForURL(/\/matters\//, { timeout: 20_000 })
    await page
      .waitForSelector('[data-kind="agent_message"]', { timeout: 20_000 })
      .catch(() => undefined)
    await page.waitForTimeout(2500)
    await shot(page, 'wp288-ask-thread')
    await page.getByTestId('matter-menu').click()
    await page.getByTestId('matter-ask-promote').waitFor()
    await shot(page, 'wp288-ask-menu')

    // 改前 / 改后并排（改前 = WP287 合并时的岗位页）
    const b64 = (p) => readFileSync(p).toString('base64')
    const compare = await context.newPage()
    await compare.setViewportSize({ width: 2600, height: 980 })
    await compare.setContent(`<!doctype html><html><body style="margin:0;background:#e9ebe8;font:600 22px system-ui;color:#333">
      <div style="display:flex;gap:40px;padding:20px">
        <figure style="margin:0"><figcaption style="margin-bottom:10px">改前（WP287）</figcaption>
          <img style="width:1260px;border:1px solid #ccc" src="data:image/png;base64,${b64(BEFORE)}"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:10px">改后（WP288）</figcaption>
          <img style="width:1260px;border:1px solid #ccc" src="data:image/png;base64,${b64(join(SHOTS, 'wp288-position-page.png'))}"></figure>
      </div></body></html>`)
    await compare.waitForTimeout(300)
    await compare.screenshot({ path: join(SHOTS, 'wp288-before-after.png'), fullPage: true })
    console.log('  📷 wp288-before-after.png')
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
