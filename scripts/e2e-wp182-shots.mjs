#!/usr/bin/env node
/**
 * WP182（docs/84 §3）：B2B 业务的截图，可重跑。存到 `docs/assets/wp182/`。
 *
 * 1. `b2b-inquiry-first-reply-card.png`：询盘首回卡（分级 + 引了哪几张事实卡 + 回信正文切原文看）；
 * 2. `b2b-quote-card.png`：超授权报价卡（转上级 / 老板，写清超了哪几条）；
 * 3. `b2b-quote-pdf.png`：报价单 PDF（本机生成，经真路由取回来，再用 macOS `sips` 转成图）；
 * 4. `b2b-sales-panel.png`：「业务」职责页那一块（事实卡齐没齐、报价、样品超期）；
 * 5. `b2b-handover-card.png`：离职交接卡（落老板）；
 * 6. `b2b-panel-sales.png`：岗位面板「业务」四块（询盘带分级、样品带超期）。
 *
 * 全走 demo 的真路由与真界面（`apps/cli/src/demo.ts` 的 `seedSales`）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-wp182-shots.mjs [--port 4399]
 * ```
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp182')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

async function shotCard(page, text, file) {
  // 卡片一张一张翻：先在「全部列出」里点那一张，它就成了当前那张
  if ((await page.locator('[data-testid="deck-list-item"]').count()) === 0) {
    await page.getByTestId('deck-list-toggle').first().click()
    await page.waitForTimeout(400)
  }
  const item = page.locator('[data-testid="deck-list-item"]', { hasText: text }).first()
  if ((await item.count()) > 0) {
    await item.click()
    await page.waitForTimeout(400)
  }
  const card = page.locator('[data-testid="deck-card"]', { hasText: text }).first()
  await card.waitFor({ timeout: 20_000 })
  await card.scrollIntoViewIfNeeded()
  await card.screenshot({ path: join(SHOTS, file) })
  console.log(`  📷 ${file}`)
  return card
}

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
    // 卡片是一张一张翻的：「全部列出」把这个岗位的卡都摆出来

    // ① 询盘首回卡（中文摘要）；切到「原文」看回信正文
    await shotCard(page, '回询盘', 'b2b-inquiry-first-reply-card.png')
    // WP288：语言切换收进了「要你处理」那一行的筛选图标里
    await page.getByTestId('deck-filter').first().click()
    await page.getByTestId('deck-modes').getByText('原文', { exact: true }).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await shotCard(page, '回询盘', 'b2b-inquiry-first-reply-original.png')
    await page.getByTestId('deck-filter').first().click()
    await page.getByTestId('deck-modes').getByText('中文摘要', { exact: true }).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // ② 超授权报价卡；⑤ 离职交接卡
    await shotCard(page, '报价 Q-20260929-02', 'b2b-quote-card.png')
    await shotCard(page, '离职交接', 'b2b-handover-card.png')

    // ④ 「业务」职责页那一块
    const duty = await page
      .locator('a[href*="/duties/b2b.sales"]')
      .first()
      .getAttribute('href', { timeout: 20_000 })
    if (duty === null) throw new Error('找不到「业务」那条职责')
    await page.goto(`${BASE}${duty}`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="b2b-sales-panel"]')
    await panel.locator('[data-testid="b2b-sample-overdue"]').waitFor({ timeout: 20_000 })
    await panel.screenshot({ path: join(SHOTS, 'b2b-sales-panel.png') })
    console.log('  📷 b2b-sales-panel.png')

    // ③ 报价单 PDF：经真路由取回来（带登录与分配头），转成图
    const asg = duty.split('/')[2] ?? ''
    const bytes = await page.evaluate(
      async ({ asg }) => {
        const token = localStorage.getItem('agentsws.session_token')
        const headers = {
          'X-Assignment': asg,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }
        const list = await (await fetch('/v1/b2b/sales', { headers })).json()
        const q = list.data.quotes.find((x) => x.number === 'Q-20260928-01') ?? list.data.quotes[0]
        const res = await fetch(`/v1/b2b/quotes/${q.id}/pdf`, { headers })
        return Array.from(new Uint8Array(await res.arrayBuffer()))
      },
      { asg },
    )
    const pdf = join(tmpdir(), 'wp182-quote.pdf')
    writeFileSync(pdf, Buffer.from(bytes))
    writeFileSync(join(SHOTS, 'b2b-quote-sample.pdf'), Buffer.from(bytes))
    execFileSync('sips', ['-s', 'format', 'png', pdf, '--out', join(SHOTS, 'b2b-quote-pdf.png')], {
      stdio: 'ignore',
    })
    console.log('  📷 b2b-quote-pdf.png（+ b2b-quote-sample.pdf）')

    // ⑥ 岗位面板「业务」四块
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    await page.getByText('面板', { exact: true }).first().click({ timeout: 20_000 })
    const inquiries = page.locator('[data-testid="block"][data-block-id="b2b.sales.inquiries"]')
    await inquiries.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'b2b-panel-sales.png'), fullPage: true })
    console.log('  📷 b2b-panel-sales.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
