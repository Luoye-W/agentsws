#!/usr/bin/env node
/**
 * WP176：开发信后续的截图，可重跑。存到 `docs/assets/wp176/`。
 *
 * 1. `b2b-outbound-address-established.png`：「主动开发」职责页上的开发信一块——公司地址只读显示、
 *    「去公司档案改」的链接；选了发信邮箱之后多出来的「这只邮箱已经正常发信很久」勾选（问号里写新域名别勾）；
 * 2. `settings-company-address.png`：设置页「公司档案」里的公司地址一格（demo 种在「主动开发」设置里的
 *    旧地址，第一次读到时已经搬过来了）。
 *
 * 全走 demo 的真路由与真界面（DNS / 邮箱 / SMTP 是 demo 替身）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-b2b-outbound-wp176-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp176')

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

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const position = await page
      .locator('a[href^="/positions/"]', { hasText: /^B2B/ })
      .first()
      .getAttribute('href', { timeout: 20_000 })
    if (position === null) throw new Error('左栏里找不到 B2B 岗位')
    await page.goto(`${BASE}${position}`, { waitUntil: 'networkidle' })
    const duty = await page
      .locator('a[href*="/duties/b2b.outbound"]')
      .first()
      .getAttribute('href', { timeout: 20_000 })
    if (duty === null) throw new Error('找不到「主动开发」那条职责')

    // 先在卡上选单独域名（发信邮箱有了，「已经正常发信很久」那一格才出）
    const choice = page.locator('[data-testid="deck-card"]', { hasText: '开发信从哪只邮箱发' })
    // 同一个 demo 进程跑第二遍时卡已经答过了：跳过
    if ((await choice.count()) > 0) {
      await choice
        .locator('[data-testid="deck-card-options"] label', { hasText: '用单独的发信域名' })
        .click()
      await choice.getByRole('button', { name: '就这条' }).click()
      await page.waitForTimeout(3000)
    }

    // ① 职责页上的开发信一块
    await page.goto(`${BASE}${duty}`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="b2b-outbound-panel"]')
    await panel.locator('[data-testid="b2b-established"]').waitFor({ timeout: 20_000 })
    await panel.locator('[data-testid="b2b-address-value"]').waitFor({ timeout: 20_000 })
    await panel.screenshot({ path: join(SHOTS, 'b2b-outbound-address-established.png') })
    console.log('  📷 b2b-outbound-address-established.png')

    // ② 设置页「公司档案」里的公司地址。demo 的工作区还没建过公司档案（地址还留在「主动开发」设置里，
    //    搬不成）：先存一次档案，再打开一次开发信那一块（第一次读到时搬过去），回来看地址已经在档案里
    await page.goto(`${BASE}/settings#company`, { waitUntil: 'networkidle' })
    const company = page.locator('[data-testid="settings-company"]')
    await company.locator('[data-testid="company-postal-address"]').waitFor({ timeout: 20_000 })
    const legal = company.locator('[data-testid="company-legal-name"]')
    if ((await legal.inputValue()) === '') {
      await legal.fill('深圳诺伏特科技有限公司')
      await company.locator('[data-testid="company-save"]').click()
      await page.waitForTimeout(1500)
    }
    await page.goto(`${BASE}${duty}`, { waitUntil: 'networkidle' })
    await panel.locator('[data-testid="b2b-address-value"]').waitFor({ timeout: 20_000 })
    await page.goto(`${BASE}/settings#company`, { waitUntil: 'networkidle' })
    await company.locator('[data-testid="company-postal-address"]').waitFor({ timeout: 20_000 })
    await company.scrollIntoViewIfNeeded()
    await company.screenshot({ path: join(SHOTS, 'settings-company-address.png') })
    console.log('  📷 settings-company-address.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
