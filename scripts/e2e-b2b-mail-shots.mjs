#!/usr/bin/env node
/**
 * WP172（docs/84 §5）：三张截图的可重跑出处。存到 `docs/assets/wp172/`。
 *
 * 1. `messages-b2b-folder.png`：「消息」页左栏的「B2B 往来」与里面那封询盘；
 * 2. `messages-pending-b2b.png`：「待确认」一栏里拿不准的询盘挂着「这是 B2B」；
 * 3. `b2b-panel-inquiry.png`：B2B「业务」那条职责的面板，「待回询盘」第一行就是分拣落成的那条。
 *
 * 全是 demo 种进去的真数据、走真路由（`apps/cli/src/demo.ts` 的 m110 / m111 与 B2B 库里那条询盘），
 * 没有浏览器侧替身，也没有连任何邮箱。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-b2b-mail-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp172')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ① 「B2B 往来」
    await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
    const folder = page.locator('[data-testid="messages-folder"][data-folder="b2b"]')
    await folder.waitFor({ timeout: 20_000 })
    await folder.click()
    await page.getByText('Quotation request - 20000mAh power bank').first().click()
    await page.waitForTimeout(800)
    await page.locator('[data-testid="messages-page"]').screenshot({
      path: join(SHOTS, 'messages-b2b-folder.png'),
    })
    console.log('  📷 messages-b2b-folder.png')

    // ② 「待确认」里的「这是 B2B」
    await page.locator('[data-testid="messages-pending"]').click()
    await page
      .locator('[data-testid="messages-pending-yes"]', { hasText: 'B2B' })
      .first()
      .waitFor({ timeout: 20_000 })
    await page.waitForTimeout(300)
    await page.locator('[data-testid="messages-page"]').screenshot({
      path: join(SHOTS, 'messages-pending-b2b.png'),
    })
    console.log('  📷 messages-pending-b2b.png')

    // ③ B2B 面板：左栏岗位那一行「B2B」→ 岗位页 →「面板」那一栏（「待回询盘」那一块）
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const position = await page
      .locator('a[href^="/positions/"]', { hasText: /^B2B/ })
      .first()
      .getAttribute('href', { timeout: 20_000 })
    if (position === null) throw new Error('左栏里找不到 B2B 岗位')
    const asg = position.split('/')[2] ?? ''
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    await page.getByText('面板', { exact: true }).first().click({ timeout: 20_000 })
    const row = page.getByText('Quotation request - 20000mAh power bank').first()
    await row.waitFor({ timeout: 20_000 })
    await row.scrollIntoViewIfNeeded()
    await page.mouse.wheel(0, -200)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'b2b-panel-inquiry.png') })
    console.log('  📷 b2b-panel-inquiry.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
