#!/usr/bin/env node
/**
 * WP224：盈亏线 + 经营一页纸三张截图的可重跑出处。存到 `docs/assets/wp224/`。
 *
 * 1. `org-gross-margin.png`：公司 → 品牌 · 毛利率（品牌一格 20%、品类「充电宝」覆盖 35%）；
 * 2. `ads-campaigns-break-even.png` / `ads-daily-report-break-even.png`：投放（Meta）面板的
 *    campaign 表与日报——ROAS 旁边并排「盈亏线 ROAS」，高于 1 低于盈亏线的那条带提示图标
 *    （鼠标停在图标上出 tooltip）；
 * 3. `weekly-review-card.png`：老板岗位页上整张摊开的「本周经营一页纸」（数带出处 tooltip）。
 *
 * 全走 demo（合成数据，没有一个真账号）；不碰 4317 那个服务。demo 的 Meta 两条 campaign
 * ROAS 是 0.6 / 4.2，所以毛利率填 20%（盈亏线 5）：4.2 那条正好落在「高于 1、低于盈亏线」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node scripts/e2e-wp224-shots.mjs [--port 4424]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp224')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4424'))
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

async function call(path, token, { body, method = 'POST', assignment } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (assignment !== undefined) headers['x-assignment'] = assignment
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return res.json()
}

async function login() {
  const link = await call('/v1/auth/magic-link', undefined, { body: { email: OWNER } })
  const verified = await call('/v1/auth/verify', undefined, { body: { token: link.data.token } })
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
    const me = (await call('/v1/me', token, { method: 'GET' })).data
    const list = (me?.assignments ?? []).filter((a) => a.revoked_at === undefined)
    const owner = list.find((a) => a.role_id === 'common.owner')?.id
    const meta = list.find((a) => a.role_id === 'ads.meta')?.id
    if (owner === undefined) throw new Error(`demo 里这个人没有老板岗位：${JSON.stringify(list)}`)
    console.log(`  owner=${owner} meta=${meta ?? '（没有）'}`)

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

    // ① 公司 → 品牌 · 毛利率：在界面上填（品牌 20%，品类「充电宝」35%）
    await page.goto(`${BASE}/org?tab=brands&focus=gross-margin`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="org-gross-margin"]')
    await card.waitFor({ timeout: 30_000 })
    await page.fill('[data-testid="org-gross-margin-brand"]', '20')
    await card.getByRole('button', { name: '保存' }).click()
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="org-gross-margin-line"]')?.textContent?.includes('5'),
    )
    await card.getByRole('textbox', { name: '品类名或 SKU' }).fill('充电宝')
    await card.getByRole('textbox', { name: '毛利率' }).fill('35')
    await card.getByRole('button', { name: '加一格' }).click()
    await page.locator('[data-testid="org-gross-margin-overrides"]').waitFor()
    await card.screenshot({ path: join(SHOTS, 'org-gross-margin.png') })
    console.log('  ✓ org-gross-margin.png')

    // ② 投放（Meta）面板：campaign 表与日报，ROAS 旁边并排盈亏线（宽一点，表不横向滚）
    if (meta !== undefined) {
      await page.setViewportSize({ width: 1720, height: 1100 })
      await page.goto(`${BASE}/positions/${meta}?tab=view`, { waitUntil: 'networkidle' })
      const table = page.locator('[data-block-id="ads.meta.campaigns"]')
      await table.waitFor({ timeout: 30_000 })
      await table.scrollIntoViewIfNeeded()
      const flag = table.locator('[data-testid="table-flag"]').first()
      if ((await flag.count()) > 0) await flag.hover().catch(() => undefined)
      await page.waitForTimeout(500)
      await table.screenshot({ path: join(SHOTS, 'ads-campaigns-break-even.png') })
      console.log('  ✓ ads-campaigns-break-even.png')
      const report = page.locator('[data-block-id="ads.meta.daily_report"]')
      if ((await report.count()) > 0) {
        await report.scrollIntoViewIfNeeded()
        const f2 = report.locator('[data-testid="table-flag"]').first()
        if ((await f2.count()) > 0) await f2.hover().catch(() => undefined)
        await page.waitForTimeout(500)
        await report.screenshot({ path: join(SHOTS, 'ads-daily-report-break-even.png') })
        console.log('  ✓ ads-daily-report-break-even.png')
      }
      await page.setViewportSize({ width: 1280, height: 900 })
    }

    // ③ 本周经营一页纸：现在推一张，老板岗位页上整张摊开
    const run = await call('/v1/economics/weekly-review/run', token, {
      body: {},
      assignment: owner,
    })
    console.log(`  一页纸：${JSON.stringify(run.data ?? run)}`)
    await page.setViewportSize({ width: 1280, height: 1400 })
    await page.goto(`${BASE}/positions/${owner}`, { waitUntil: 'networkidle' })
    const block = page.locator('[data-testid="report-block"][data-kind="weekly_review"]').first()
    await block.waitFor({ timeout: 30_000 })
    await block.scrollIntoViewIfNeeded()
    // 停在第二条发现的数上（第一条的 tooltip 会盖住「情况」那一行）
    const value0 = block.locator('[data-testid="weekly-finding-value"]').nth(1)
    if ((await value0.count()) > 0) await value0.hover().catch(() => undefined)
    await page.waitForTimeout(500)
    const box = await block.boundingBox()
    if (box !== null)
      await page.screenshot({
        path: join(SHOTS, 'weekly-review-card.png'),
        // 左边多留一截：数的 tooltip 居中在数上，会伸出卡片左缘
        clip: {
          x: Math.max(0, box.x - 90),
          y: box.y - 8,
          width: box.width + 98,
          height: box.height + 16,
        },
      })
    console.log('  ✓ weekly-review-card.png')
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
