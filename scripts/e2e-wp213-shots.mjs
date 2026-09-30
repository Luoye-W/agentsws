#!/usr/bin/env node
/**
 * WP213：岗位与职责线描图标——每个接入点一张，明暗两套。存 `docs/assets/wp213/`。
 *
 * 起一个 demo（不联网；图标与角标全是打进产物的本地文件），以负责人身份拍：
 *
 * 1. `rail-*`：左栏岗位树（几个岗位展开、选中一条渠道职责）；
 * 2. `rail-add-duty-*`：岗位行「+」展开的加职责胶囊；
 * 3. `rail-new-position-*`：「岗位」标题旁「+」展开的新建岗位胶囊；
 * 4. `org-position-card-*`：公司页岗位卡（标题图标 + 职责折叠层 + 改职责胶囊）；
 * 5. `position-page-*`：岗位页页头与职责折叠层；
 * 6. `duty-page-*`：职责页页头；
 * 7. `third-column-*`：第三栏面板头；
 * 8. `command-palette-*`：⌘K 里的岗位 / 职责；
 * 9. `onboarding-roles-*`：首次设置第 ③ 步的岗位 / 职责（拍得到才拍）。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp213-shots.mjs [--port 4471]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp213')
const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 && args[at + 1] !== undefined ? args[at + 1] : '4471')
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
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  /** 不是本机的请求（图标与角标都该是本地文件，一条外发都不该有）。 */
  const external = []
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
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
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      page.on('request', (r) => {
        const u = r.url()
        if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'))
          external.push(u)
      })
      const shot = async (locator, name) => {
        await locator.scrollIntoViewIfNeeded()
        await page.waitForTimeout(350)
        await locator.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
        console.log(`  📷 ${name}-${theme}.png`)
      }
      const aside = page.locator('aside').first()
      const row = (id) => page.locator(`[data-testid="nav-position-row"][data-position="${id}"]`)
      const expand = async (id) => {
        const toggle = row(id).locator('[data-testid="nav-position-toggle"]')
        if ((await toggle.count()) === 0) return
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      }

      // ① 左栏：几个岗位展开，选中红人营销里的一条渠道职责
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="nav-position-row"]').first().waitFor({ timeout: 30_000 })
      for (const id of ['customer-care', 'kol-marketing', 'social-media', 'site']) await expand(id)
      const duty = row('kol-marketing').locator('[data-testid="nav-duty"]').first()
      await duty.click()
      await page.locator('[data-testid="duty-page"]').waitFor()
      await page.waitForLoadState('networkidle')
      await shot(aside, 'rail')

      // ⑥ 职责页页头
      await shot(page.locator('[data-testid="duty-page"] header').first(), 'duty-page')

      // ⑦ 第三栏：开一个跟着岗位 / 职责走的面板，拍面板头那一截
      const railIcon = page.locator('[data-testid="rail-icon-settings"]')
      if ((await railIcon.count()) > 0) {
        await railIcon.click()
        const frame = page.locator('[data-testid="rail-panel-frame"]')
        await frame.waitFor()
        await page.waitForTimeout(500)
        const box = await frame.boundingBox()
        if (box !== null) {
          await page.screenshot({
            path: join(SHOTS, `third-column-${theme}.png`),
            clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 260) },
          })
          console.log(`  📷 third-column-${theme}.png`)
        }
        await page.locator('[data-testid="rail-panel-close"]').first().click()
      }

      // ② 岗位行「+」：加职责
      await row('customer-care').hover()
      await row('customer-care').locator('[data-testid="rail-add-duty-plus"]').click()
      await page.locator('[data-testid="rail-add-duty-role"]').first().waitFor()
      await shot(aside, 'rail-add-duty')
      await row('customer-care').locator('[data-testid="rail-add-duty-plus"]').click()

      // ③ 「岗位」标题旁「+」：新建岗位
      await page.locator('[data-testid="rail-new-position-plus"]').click()
      await page.locator('[data-testid="rail-new-position-role"]').first().waitFor()
      await shot(page.locator('[data-testid="rail-new-position"]'), 'rail-new-position')
      await page.locator('[data-testid="rail-new-position-plus"]').click()

      // ⑤ 岗位页：页头 + 职责折叠层
      await row('kol-marketing').locator('[data-testid="nav-position"]').click()
      const entry = page.locator('[data-testid="position-entry"]')
      await entry.waitFor()
      const fold = entry.locator('[data-testid="position-roles-toggle"]')
      if ((await fold.count()) > 0) await fold.click()
      await shot(entry, 'position-page')

      // ⑧ ⌘K
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
      const dialog = page.locator('[role="dialog"]').first()
      await dialog.waitFor()
      await page.keyboard.type('红人')
      await shot(dialog, 'command-palette')
      await page.keyboard.press('Escape')

      // ④ 公司页岗位卡
      await page.goto(`${BASE}/org`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="position-card"][data-position="site"]')
      await card.waitFor({ timeout: 20_000 })
      const cardFold = card.locator('[data-testid="position-duties-toggle"]')
      if ((await cardFold.count()) > 0) await cardFold.click()
      await card.getByRole('button', { name: /加减职责|Edit duties/ }).click()
      await shot(card, 'org-position-card')

      // ⑨ 首次设置第 ③ 步：先用「先随便看看」跳过接 AI，再过第 ② 步
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
      try {
        await page.locator('[data-testid="ai-demo"]').click({ timeout: 10_000 })
        const roles = page.locator('[data-testid="onboarding-roles"]')
        for (let i = 0; i < 3 && !(await roles.isVisible()); i += 1) {
          await page.locator('[data-testid="onboarding-next"]').click({ timeout: 10_000 })
          await page.waitForTimeout(600)
        }
        await roles.waitFor({ timeout: 10_000 })
        const expandBtn = roles.locator('[data-testid="onboarding-expand"]').first()
        if ((await expandBtn.count()) > 0) await expandBtn.click()
        await shot(roles, 'onboarding-roles')
      } catch (e) {
        console.log(`  … 首次设置第 ③ 步没走到，跳过（${String(e).slice(0, 80)}）`)
      }

      await context.close()
    }
    console.log(
      external.length === 0
        ? '外发请求：0 条'
        : `⚠️ 外发请求 ${external.length} 条：\n${[...new Set(external)].join('\n')}`,
    )
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

await main()
