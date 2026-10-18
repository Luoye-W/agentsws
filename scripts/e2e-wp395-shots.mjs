#!/usr/bin/env node
/**
 * WP395（docs/106 §13）Amazon 运营岗位：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright：
 *
 * **端到端**：首次设置推荐（`/v1/onboarding/suggest`，原话「我们在 Amazon 美国站卖电动自行车」）里有亚马逊店铺运营、
 * 划分出「Amazon 运营」→ 照推荐建（`/v1/onboarding/apply`）→ 左栏有它 → 岗位页右侧「报表」里四块都在、
 * 没数据的照实说；原话「我们做独立站」推荐里没有它。不通过就退出码 1。
 *
 * **截图**（浅 / 深各一张）：
 * 1. `1-nav-*`：左栏岗位列表（有「Amazon 运营」）；
 * 2. `2-position-*`：岗位页 + 右侧面板；
 * 3. `3-board-*`：面板四块特写（每日巡检三行「连上 Amazon 店铺后才有」、另三块空态）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp395-shots.mjs --out <截图目录> [--port 4495]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4495'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
// 截图不进开源仓（10-18 起讨论与验收材料在私有仓）：给 --out，不给就落到系统临时目录
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp395-shots')))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

let assignment
async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(token === undefined || assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', undefined, { email })
  return (await call('POST', '/v1/auth/verify', undefined, { token: link.token })).session_token
}

const check = (ok, what) => {
  if (!ok) throw new Error(`✗ ${what}`)
  console.log(`  ✓ ${what}`)
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(500)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
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
    now: Date.parse('2026-10-18T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    // 首次设置那几条口要带一条分配（31 §3.1）：用负责人那一条
    const me = await call('GET', '/v1/me', owner)
    assignment = (me.assignments ?? []).find((a) => a.role_id === 'common.owner')?.id

    // ── 推荐：只说独立站 → 没有；说 Amazon → 有，划分出 Amazon 运营 ──
    const dtc = await call('POST', '/v1/onboarding/suggest', owner, { text: '我们做独立站' })
    check(
      !dtc.positions.some((p) => p.template_id === 'amazon-ops') &&
        !dtc.roles.some((r) => r.role_id.startsWith('amz.')),
      '「我们做独立站」：推荐里没有 Amazon 运营',
    )
    const amz = await call('POST', '/v1/onboarding/suggest', owner, {
      text: '我们在 Amazon 美国站卖电动自行车',
    })
    const plan = amz.positions.find((p) => p.template_id === 'amazon-ops')
    check(plan !== undefined, '「我们在 Amazon 美国站卖电动自行车」：推荐划分出 Amazon 运营')
    await call('POST', '/v1/onboarding/apply', owner, {
      position_ids: [],
      role_ids: [],
      positions: [plan],
    })

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
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
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const nav = page.getByTestId('nav-position').filter({ hasText: 'Amazon 运营' }).first()
      await nav.waitFor({ timeout: 20_000 })
      check(true, `左栏有「Amazon 运营」（${theme}）`)
      const sidebar = page.locator('nav').first()
      await shot(page, `1-nav-${theme}`, sidebar)
      await nav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      // 老地址 `?tab=view` = 打开右侧「报表」（看板在它下半截，WP372）
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'networkidle' })
      const board = page.getByTestId('amzops-board')
      await board.waitFor({ timeout: 20_000 })
      const blocks = await page
        .getByTestId('amzops-block')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-block')))
      check(blocks.join(',') === 'daily,competitors,listing,keywords', `面板四块都在：${blocks}`)
      const text = (await board.textContent()) ?? ''
      check(
        (text.match(/连上 Amazon 店铺后才有/g) ?? []).length === 3 && !/\d/.test(text),
        '每日巡检三行照实说「连上 Amazon 店铺后才有」，一个数字都不出',
      )
      await shot(page, `2-position-${theme}`)
      await board.scrollIntoViewIfNeeded()
      await shot(page, `3-board-${theme}`, board)
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
