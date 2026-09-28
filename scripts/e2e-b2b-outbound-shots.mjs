#!/usr/bin/env node
/**
 * WP173（docs/84 §2 / §11.1）：四张截图的可重跑出处。存到 `docs/assets/wp173/`。
 *
 * 1. `b2b-sender-choice-card.png`：「开发信从哪只邮箱发？」选择卡（单独域名 / 就用现在的邮箱，两个选项）；
 * 2. `b2b-outbound-de-at.png`：「主动开发」职责页上的开发信一块——德国潜在客户默认不发，原因写着；
 * 3. `b2b-first-batch-card.png`：在卡上选了单独域名 → 体检（替身 DNS + 替身测试信）→ 批量首封卡；
 * 4. `b2b-sequence-funnel.png`：批了那张卡（替身 SMTP"发出去"）之后，岗位面板上的「序列漏斗」。
 *
 * 全走 demo 的真路由与真界面（`apps/cli/src/demo.ts` 的 `seedOutbound`），开发信那几跳是 demo 的
 * 替身（不做真 DNS 查询、没有真邮箱、不真发信）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-b2b-outbound-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp173')

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

    // 左栏「B2B」岗位 → 岗位页（卡在这里）；「主动开发」那条职责页（开发信那一块在这里）
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

    // ① 发信域名选择卡
    const choice = page.locator('[data-testid="deck-card"]', { hasText: '开发信从哪只邮箱发' })
    await choice.waitFor({ timeout: 20_000 })
    await choice.scrollIntoViewIfNeeded()
    await choice.screenshot({ path: join(SHOTS, 'b2b-sender-choice-card.png') })
    console.log('  📷 b2b-sender-choice-card.png')

    // ② 职责页上的开发信一块：德国潜在客户默认不发
    await page.goto(`${BASE}${duty}`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="b2b-outbound-panel"]')
    await panel.locator('[data-testid="b2b-de-at-excluded"]').waitFor({ timeout: 20_000 })
    await panel.screenshot({ path: join(SHOTS, 'b2b-outbound-de-at.png') })
    console.log('  📷 b2b-outbound-de-at.png')

    // ③ 在卡上选单独域名 → 体检（替身）→ 批量首封卡
    await page.goto(`${BASE}${position}`, { waitUntil: 'networkidle' })
    await choice.waitFor({ timeout: 20_000 })
    await choice
      .locator('[data-testid="deck-card-options"] label', { hasText: '用单独的发信域名' })
      .click()
    await choice.getByRole('button', { name: '就这条' }).click()
    await page.waitForTimeout(4000)
    await page.reload({ waitUntil: 'networkidle' })
    const batch = page.locator('[data-testid="deck-card"]', { hasText: '第一轮首封' })
    await batch.first().waitFor({ timeout: 20_000 })
    await batch.first().scrollIntoViewIfNeeded()
    await batch.first().screenshot({ path: join(SHOTS, 'b2b-first-batch-card.png') })
    console.log('  📷 b2b-first-batch-card.png')

    // ④ 批了那张卡（替身 SMTP）→ 岗位面板上的「序列漏斗」
    await batch.first().getByRole('button', { name: '发送' }).click()
    await page.waitForTimeout(4000)
    // 面板挂在「主动开发」那条分配上（职责页链接里的那个 assignment）
    const outboundAsg = duty.split('/')[2] ?? ''
    await page.goto(`${BASE}/positions/${outboundAsg}`, { waitUntil: 'networkidle' })
    await page.getByText('面板', { exact: true }).first().click({ timeout: 20_000 })
    const funnel = page.locator('[data-testid="block"][data-block-id="b2b.outbound.funnel"]')
    await funnel.waitFor({ timeout: 20_000 })
    await funnel.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await funnel.screenshot({ path: join(SHOTS, 'b2b-sequence-funnel.png') })
    console.log('  📷 b2b-sequence-funnel.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
