#!/usr/bin/env node
/**
 * WP194：公司统一充值、给成员 / 岗位分配积分的截图，可重跑。存到 `docs/assets/wp194/`。
 *
 * 1. `org-credits-tab.png`：公司页「积分」tab（管理员）——公司余额、本月按能力四格、充值四档、
 *    成员表与岗位表（快到了 / 用完了），改动记录展开；
 * 2. `org-credits-edit.png`：在成员表里改一个人的上限（输入框那一刻）；
 * 3. `my-allowance.png`：设置 → 积分里的「我的本月额度：已用 X / 上限 Y」；
 * 4. `my-allowance-full.png`：额度到了——同一块变红，写着「本月额度用完了，找管理员加。」
 * 5. `org-credits-full.png`：回到公司页，成员表里那一行标红「用完了」。
 *
 * 全走 demo 的真路由与真界面；云是替身（`cloud-stand-in`，数字是 demo 种的合成数，不真扣钱）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-wp194-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp194')

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ⓪ 关联账号（替身云：发信之后自己点链接）
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    await page
      .locator('[data-testid="cloud-account-linked"], [data-testid="cloud-account-unlinked"]')
      .first()
      .waitFor({ timeout: 20_000 })
    const unlinked = page.getByTestId('cloud-account-unlinked')
    if ((await unlinked.count()) > 0) {
      await unlinked.locator('input[type="email"]').fill('boss@example.com')
      await unlinked.getByRole('button').last().click()
      await page.getByTestId('cloud-account-linked').waitFor({ timeout: 20_000 })
    }

    // ① 公司页「积分」tab
    await page.goto(`${BASE}/org?tab=credits`, { waitUntil: 'load' })
    const tab = page.getByTestId('alloc-tab')
    await tab.waitFor({ timeout: 20_000 })
    await page.getByTestId('alloc-audit-toggle').click()
    await page.waitForTimeout(500)
    await tab.screenshot({ path: join(SHOTS, 'org-credits-tab.png') })
    console.log('  📷 org-credits-tab.png')

    // ② 改一个人的上限（输入框那一刻），再保存
    const firstRow = page.getByTestId('alloc-members').getByTestId('alloc-row').first()
    const owner = await firstRow.getAttribute('data-subject')
    await firstRow.getByTestId('alloc-edit').click()
    await firstRow.getByTestId('alloc-input').fill('75')
    await page
      .getByTestId('alloc-members')
      .screenshot({ path: join(SHOTS, 'org-credits-edit.png') })
    console.log('  📷 org-credits-edit.png')
    await firstRow.getByTestId('alloc-save').click()
    await page.waitForTimeout(800)

    // ③ 设置 → 积分：我的本月额度（上面刚给自己设了 75，已用过了八成）
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    const mine = page.getByTestId('credits-mine')
    await mine.waitFor({ timeout: 20_000 })
    await page.getByTestId('credits-panel').screenshot({ path: join(SHOTS, 'my-allowance.png') })
    console.log(`  📷 my-allowance.png（${owner ?? '?'}）`)

    // ④ 额度到了：回公司页把自己的上限改到比已用少，再看同一块
    await page.goto(`${BASE}/org?tab=credits`, { waitUntil: 'load' })
    const again = page.getByTestId('alloc-members').getByTestId('alloc-row').first()
    await again.getByTestId('alloc-edit').click()
    await again.getByTestId('alloc-input').fill('5')
    await again.getByTestId('alloc-save').click()
    await page.waitForTimeout(800)
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    await page.getByTestId('credits-mine-full').waitFor({ timeout: 20_000 })
    await page
      .getByTestId('credits-mine')
      .screenshot({ path: join(SHOTS, 'my-allowance-full.png') })
    console.log('  📷 my-allowance-full.png')

    // ⑤ 回公司页：成员表里这一行是红的「用完了」
    await page.goto(`${BASE}/org?tab=credits`, { waitUntil: 'load' })
    await page
      .locator('[data-testid="alloc-row"][data-state="full"]')
      .first()
      .waitFor({ timeout: 20_000 })
    await page
      .getByTestId('alloc-members')
      .screenshot({ path: join(SHOTS, 'org-credits-full.png') })
    console.log('  📷 org-credits-full.png')
  } finally {
    await browser.close()
  }
}

await main()
