#!/usr/bin/env node
/**
 * WP209：技能页与知识库页「先分类、再展开」的截图，可重跑。存到 `docs/assets/wp209/`。
 *
 * 0. `skills-owner.png`：技能页（demo 的王岚是所有者，十个岗位全开了，所以没有「没开的岗位」）；
 * 1. `skills-grouped.png`：技能页——按岗位分组，本人开了的岗位在前，「没开的岗位」收着。
 *    **注意**：demo 里只有一个人、持有全部岗位，看不出折叠。这两张在浏览器里把 `/v1/skills`
 *    回包的 `mine` 改成「只开了客服 / B2B / 网站运营」（`SIMULATED_MINE`），其余数据原样——
 *    模拟一个只做这三个岗位的同事看到的样子；
 * 2. `skills-others-open.png`：同上，点开「没开的岗位」和里面一个岗位（默认都收着）；
 * 3. `skills-expanded.png`：点开一张小卡，看段落与三层改动；
 * 4. `skills-search.png`：搜「报价」（名字、说明、段落正文都搜），结果所在的组自动摊开；
 * 5. `knowledge-grouped.png`：知识库页——按类型分组，每条标状态与来源；
 * 6. `knowledge-scope.png`：按「品牌 / 范围」筛（demo 种了几条只管某个站点 / 店铺组的）；
 * 7. `knowledge-status.png`：按状态筛「待确认」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-wp209-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp209')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

async function shot(page, name, testId) {
  await page.waitForTimeout(400)
  if (testId === undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true })
  // 知识库页整页太长（下面还有宣称规则、缺口、业务边界）：只截「知识」那一块
  else await page.getByTestId(testId).screenshot({ path: join(SHOTS, name) })
  console.log(`  📷 ${name}`)
}

/** 模拟「只开了这几个岗位」的人（见文件头 1 / 2）。 */
const SIMULATED_MINE = new Set(['customer-care', 'b2b', 'web-ops'])

async function simulateMine(page) {
  await page.route('**/v1/skills', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    for (const s of body.data ?? []) {
      for (const p of s.positions ?? []) p.mine = SIMULATED_MINE.has(p.id)
      for (const r of s.roles ?? []) r.mine = r.position_ids.some((id) => SIMULATED_MINE.has(id))
      s.in_use = (s.roles ?? []).some((r) => r.mine)
    }
    await route.fulfill({ response: res, json: body })
  })
}

const group = (page, id) => page.locator(`[data-testid="library-group"][data-group="${id}"]`)

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

    // ── 技能页 ──
    await page.goto(`${BASE}/skills`, { waitUntil: 'load' })
    await page.getByTestId('skill-groups').waitFor({ timeout: 30_000 })
    await shot(page, 'skills-owner.png')

    const sim = await context.newPage()
    await simulateMine(sim)
    await sim.goto(`${BASE}/skills`, { waitUntil: 'load' })
    await sim.getByTestId('skill-groups').waitFor({ timeout: 30_000 })
    await shot(sim, 'skills-grouped.png')
    await group(sim, 'others').getByTestId('library-group-toggle').first().click()
    await group(sim, 'kol-marketing').getByTestId('library-group-toggle').first().click()
    await shot(sim, 'skills-others-open.png')
    await sim.close()

    await page.goto(`${BASE}/skills`, { waitUntil: 'load' })
    await page.getByTestId('skill-groups').waitFor({ timeout: 30_000 })
    await page.getByTestId('skill-tile').first().getByTestId('skill-tile-toggle').click()
    await page.getByTestId('skill-details').waitFor()
    await shot(page, 'skills-expanded.png')

    await page.getByTestId('skills-search').fill('报价')
    await shot(page, 'skills-search.png')

    // ── 知识库页 ──
    await page.goto(`${BASE}/knowledge`, { waitUntil: 'load' })
    await page.getByTestId('knowledge-groups').waitFor({ timeout: 30_000 })
    await page.getByTestId('knowledge-library').scrollIntoViewIfNeeded()
    await shot(page, 'knowledge-grouped.png', 'knowledge-library')

    const scope = page.getByTestId('knowledge-scope')
    await scope.waitFor({ timeout: 10_000 })
    const values = await scope
      .locator('option')
      .evaluateAll((els) => els.map((e) => e.getAttribute('value')))
    const pick = values.find((v) => v?.startsWith('market:')) ?? values.at(-1)
    await scope.selectOption(pick ?? '')
    await shot(page, 'knowledge-scope.png', 'knowledge-library')

    await scope.selectOption('*')
    await page.getByTestId('knowledge-status-pending').click()
    await shot(page, 'knowledge-status.png', 'knowledge-library')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
