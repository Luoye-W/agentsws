#!/usr/bin/env node
/**
 * WP234（docs/54 §6 / docs/70 §5）：岗位弹性化的截图，可重跑出处。
 *
 * 起一个 demo（演示世界：推荐走按词对的替身，回执上明说不是 AI），用真浏览器走一遍：
 *
 * 1. `wp234-step3-recs`：第 ③ 步——输入框 + 推荐（一条不预勾）+ 岗位划分建议；
 * 2. `wp234-step3-board`：「按推荐来」之后，把一条职责「移到…」另一个岗位、改个名；
 * 3. `wp234-nav-no-owner`：完成之后的左栏——「岗位」里没有「负责人」；
 * 4. `wp234-org-owner`：公司页顶上的负责人身份卡与「转交给…」；
 * 5. `wp234-org-merge` / `wp234-org-split`：岗位卡上的「合并到…」「拆出…」；
 * 6. `wp234-org-merged`：合并之后的回执（几条分配、几件事、岗位记忆跟过去了）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp234-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SITE = 'https://nordvolt.example/'
const INTENT =
  '做了三年 Shopify 店。接下来只做 Reddit：盯着大家怎么说我们，也自己发帖；网站客服也得有人管。'

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

async function main() {
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
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ①② 走演示旁路 + 分析 pack 夹具里的那个网站，确认档案卡
    await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="ai-demo"]')
    await page.fill('[data-testid="intake-url"]', SITE)
    await page.click('[data-testid="intake-start"]')
    await page.waitForSelector('[data-testid="intake-confirm"]', { timeout: 90_000 })
    await page.click('[data-testid="intake-confirm"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="onboarding-next"]')
    await page.waitForSelector('[data-testid="onboarding-intent-text"]')

    // ③ 说说你要做什么 → 推荐（不预勾）+ 划分建议。整屏拍：视口拉高，左栏不会被截成半截
    await page.setViewportSize({ width: 1280, height: 1900 })
    await page.fill('[data-testid="onboarding-intent-text"]', INTENT)
    await page.click('[data-testid="onboarding-intent-go"]')
    await page.waitForSelector('[data-testid="onboarding-recs-split"]', { timeout: 30_000 })
    await page.click('[data-testid="onboarding-category-toggle"][data-category="pr"]')
    await shot(page, 'wp234-step3-recs')

    // 「按推荐来」→ 你的岗位；把「社群管理」移到 Reddit 那个岗位、改名「Reddit 与社群」
    await page.click('[data-testid="onboarding-recs-adopt"]')
    await page.waitForSelector('[data-testid="onboarding-board-row"]')
    const redditRow = page
      .locator('[data-testid="onboarding-board-row"]')
      .filter({ has: page.locator('[data-role="social.reddit"]') })
      .first()
    const redditKey = await redditRow.getAttribute('data-row')
    const community = page.locator(
      '[data-testid="onboarding-board-duty"][data-role="dtc.community-support"] [data-testid="onboarding-board-move"]',
    )
    if ((await community.count()) > 0 && redditKey !== null) await community.selectOption(redditKey)
    await redditRow.locator('[data-testid="onboarding-board-name"]').fill('Reddit 与社群')
    await shot(page, 'wp234-step3-board')
    await page.setViewportSize({ width: 1280, height: 900 })

    // ④ 完成 → 左栏里没有「负责人」
    await page.click('[data-testid="onboarding-next"]')
    await page.waitForSelector('[data-testid="onboarding-finish"]', { timeout: 30_000 })
    await page.click('[data-testid="onboarding-finish"]')
    await page.waitForSelector('[data-testid="onboarding-enter"]', { timeout: 30_000 })
    await page.click('[data-testid="onboarding-enter"]')
    await page.waitForSelector('[data-testid="main-nav"]')
    await page.waitForTimeout(1200)
    await shot(page, 'wp234-nav-no-owner')

    // 公司页：负责人身份卡
    await page.goto(`${BASE}/org`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="org-owner"]', { timeout: 30_000 })
    await shot(page, 'wp234-org-owner')

    // 岗位卡：合并到… / 拆出…
    await page.getByRole('tab', { name: '岗位' }).click()
    await page.waitForSelector('[data-testid="position-card"]')
    const cards = page.locator('[data-testid="position-card"]')
    const reddit = cards.filter({ hasText: 'Reddit 与社群' }).first()
    const host = (await reddit.count()) > 0 ? reddit : cards.first()
    await host.locator('[data-testid="position-merge"]').click()
    await host.locator('[data-testid="position-merge-target"]').selectOption({ label: '社媒运营' })
    await host.scrollIntoViewIfNeeded()
    await shot(page, 'wp234-org-merge')
    const web = cards.filter({ hasText: '网站运营' }).first()
    await web.locator('[data-testid="position-split"]').click()
    await web.locator('[data-testid="position-split-name"]').fill('发货')
    await web.locator('[data-testid="position-split-duty"]', { hasText: '订单履约' }).click()
    await web.scrollIntoViewIfNeeded()
    await shot(page, 'wp234-org-split')

    // 真合并一次，看回执（拆出那张卡要是同一张，合并表单已经收起来了，再点开）
    if ((await host.locator('[data-testid="position-merge-go"]').count()) === 0)
      await host.locator('[data-testid="position-merge"]').click()
    await host.locator('[data-testid="position-merge-go"]').click()
    await page.waitForSelector('[data-testid="positions-reshaped"]', { timeout: 30_000 })
    await page.locator('[data-testid="positions-reshaped"]').scrollIntoViewIfNeeded()
    await shot(page, 'wp234-org-merged')
    // 合并之后的左栏：「Reddit 与社群」并进了「社媒运营」
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="main-nav"]')
    await page.waitForTimeout(1200)
    await shot(page, 'wp234-nav-after-merge')
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
