#!/usr/bin/env node
/**
 * WP466（决策 1311）：首页告警并进右上铃铛——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo，用 Playwright 查：铃铛有未读红点、展开后「告警」一类在里面且紧急那条排最上（红色、带「紧急」）、
 * 点紧急那条跳到店铺管理的职责页；首页没有单独的告警区。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * `{theme}-1-bell.png`（铃铛展开）、`{theme}-2-home.png`（首页，没有告警区）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp466-shots.mjs [--port 4729] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp466'))
const PORT = Number(argOf('--port') ?? '4729') || 4729
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-22T07:30:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const link = await post('/v1/auth/magic-link', { email: OWNER })
    const owner = (await post('/v1/auth/verify', { token: link.token })).session_token
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      // 铃铛：浅深各开一份新的上下文（读过就不是未读了，所以浅色只看不点，深色最后再点）
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('home').waitFor({ timeout: 30_000 })
      await page.getByTestId('home-decide').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1200)
      check((await page.getByTestId('alerts').count()) === 0, '首页：没有单独的告警区')
      check((await page.getByTestId('alert-block').count()) === 0, '首页：没有告警块')
      await page.screenshot({ path: join(SHOTS, `${theme}-2-home.png`) })
      console.log(`  📷 ${theme}-2-home.png`)

      await page.getByTestId('notify-badge').waitFor({ timeout: 30_000 })
      await page.getByTestId('notify-bell').click()
      await page.getByTestId('notify-panel').waitFor({ timeout: 10_000 })
      const rows = page.getByTestId('notify-item')
      const first = rows.first()
      check((await first.getAttribute('data-category')) === 'alert', '铃铛：第一条是告警')
      check((await first.getAttribute('data-urgent')) === 'true', '铃铛：紧急那条排最上')
      check(
        (await first.getByTestId('notify-item-urgent').textContent())?.trim() === '紧急',
        '铃铛：紧急那条带「紧急」',
      )
      const alerts = await page
        .locator('[data-testid="notify-item"][data-category="alert"]')
        .count()
      check(alerts >= 2, `铃铛：告警 ${alerts} 条（一紧急一普通）`)
      await page.waitForTimeout(800)
      const panel = await page.getByTestId('notify-panel').boundingBox()
      await page.screenshot({
        path: join(SHOTS, `${theme}-1-bell.png`),
        ...(panel === null
          ? {}
          : {
              clip: {
                x: Math.max(0, panel.x - 520),
                y: 0,
                width: Math.min(1440 - Math.max(0, panel.x - 520), panel.width + 560),
                height: Math.min(900, panel.y + panel.height + 24),
              },
            }),
      })
      console.log(`  📷 ${theme}-1-bell.png`)
      if (theme === 'dark') {
        await first.click()
        await page.waitForURL(/\/positions\/[^/]+\/duties\/dtc\.store/, { timeout: 15_000 })
        check(true, '点紧急那条：到店铺管理的职责页')
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
