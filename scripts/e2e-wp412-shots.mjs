#!/usr/bin/env node
/**
 * WP412（真机 10-18 #8 #12，决策 1035 更正）：端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright：
 *
 * **端到端**：进岗位 → 面板默认开着 → 进职责（优先「外部版块」）→ 面板默认开着、中间栏是岗位页那个对话框 →
 * 写一句发出去，服务端真的开出一件事 → 右上角面板开关收起 → 换一条职责还是收着、回岗位页照旧开着。
 * 不通过就退出码 1。
 *
 * **截图**（`--out` 目录，默认 `docs/assets/wp412`；审稿截图放私有仓，别提交进公开仓）：
 * 1. `1-duty-light` / `1-duty-dark`：职责页新样子 + 右侧面板默认打开；
 * 2. `2-topbar-light` / `2-topbar-dark`：顶栏特写——露出的工具、「⋮」菜单展开、最右面板开关（带汇总点）；
 * 3. `3-duty-about-light` / `3-duty-about-dark`：职责页「⋯ 这条职责能做什么」；
 * 4. `4-position-light` / `4-position-dark`：岗位页同一个样子，面板默认打开；
 * 5. `5-compact`：窗口窄于 900——面板先收着、工具收进「⋮」；
 * 6. `6-overflow-light` / `6-overflow-dark`：「⋮」展开——职责定义、技能、知识、记忆、额度，再是教程。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp412-shots.mjs [--port 4412] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp412'))
const PORT = Number(argOf('--port') ?? '4412') || 4412
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}

async function get(token, path, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(600)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
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
    const open = async (theme, viewport = { width: 1440, height: 900 }) => {
      const context = await browser.newContext({ viewport, colorScheme: theme })
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
      return { context, page }
    }
    const panelOpen = async (page) => (await page.getByTestId('rail-panel-frame').count()) > 0
    const cardsShown = (page) =>
      page
        .getByTestId('rail-cards')
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)

    // ── 端到端 ──
    let positionUrl = ''
    let dutyUrl = ''
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const position = page.getByTestId('nav-position').first()
      await position.waitFor({ timeout: 20_000 })
      await position.click()
      await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 20_000 })
      positionUrl = page.url()
      check(await cardsShown(page), '进岗位页：右侧面板默认打开')
      const row = page.getByTestId('nav-position-row').first()
      const shown = await row
        .getByTestId('nav-duties')
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (!shown) await row.getByTestId('nav-position-toggle').click()
      const duties = row.getByTestId('nav-duty')
      await duties.first().waitFor({ timeout: 20_000 })
      const external = row.getByTestId('nav-duty').filter({ hasText: '外部版块' })
      const target = (await external.count()) > 0 ? external.first() : duties.first()
      await target.click()
      await page.waitForURL(/\/duties\//, { timeout: 20_000 })
      dutyUrl = page.url()
      check(await cardsShown(page), '进职责页：右侧面板默认打开')
      await page.getByTestId('position-handoff').waitFor({ timeout: 20_000 })
      check(
        (await page.getByTestId('duty-open-text').count()) === 0,
        '职责页中间栏是岗位页那个对话框（旧的一行灰字输入框没了）',
      )
      const asg = /\/positions\/([^/]+)\/duties\/([^/?]+)/.exec(dutyUrl)
      const titles = async () => {
        const rail = await get(owner, '/v1/work/rail?limit=20', asg?.[1])
        return rail.positions.flatMap((p) => p.duties.flatMap((d) => d.matters.map((m) => m.title)))
      }
      const before = (await titles()).length
      const sentence = '把这周要回的帖子列个清单'
      await page.getByTestId('position-entry-input').fill(sentence)
      await page.getByTestId('matter-send').click()
      let ok = false
      for (let i = 0; i < 60 && !ok; i += 1) {
        const now = await titles()
        ok =
          /\/matters\//.test(page.url()) ||
          (await page.getByTestId('quick-answer').count()) > 0 ||
          now.length > before ||
          now.includes(sentence)
        if (!ok) await page.waitForTimeout(500)
      }
      check(ok, `职责页对话框发出去，服务端接住了（「${asg?.[2]}」）`)
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await cardsShown(page)
      await page.getByTestId('rail-toggle').click()
      await page.waitForTimeout(300)
      check(!(await panelOpen(page)), '右上角面板开关点一下收起')
      const other = (await duties.count()) > 1 ? duties.nth(1) : duties.first()
      await other.click()
      await page.waitForURL(/\/duties\//, { timeout: 20_000 })
      await page.waitForTimeout(800)
      check(!(await panelOpen(page)), '换一条职责：按页面类型记住，还是收着')
      await page.goto(positionUrl, { waitUntil: 'networkidle' })
      check(await cardsShown(page), '回岗位页：岗位页另记，照旧打开')
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await cardsShown(page)
      await page.waitForTimeout(800)
      await shot(page, `1-duty-${theme}`)
      await page.getByTestId('rail-overflow').click()
      await page.getByTestId('rail-menu').waitFor({ timeout: 10_000 })
      const bar = await page.getByTestId('top-bar').boundingBox()
      if (bar !== null)
        await shot(page, `2-topbar-${theme}`, {
          screenshot: (o) =>
            page.screenshot({
              ...o,
              clip: { x: bar.x + bar.width - 420, y: bar.y, width: 420, height: bar.height + 300 },
            }),
        })
      // 「⋮」展开：设定那几格（职责页叫「职责定义」）+ 教程
      await shot(page, `6-overflow-${theme}`, page.getByTestId('rail-menu'))
      await page.keyboard.press('Escape')
      await page.getByTestId('duty-about-link').click()
      await page.getByTestId('duty-about').waitFor({ timeout: 20_000 })
      await shot(page, `3-duty-about-${theme}`)
      await page.goto(positionUrl, { waitUntil: 'networkidle' })
      await cardsShown(page)
      await shot(page, `4-position-${theme}`)
      await context.close()
    }
    {
      const { context, page } = await open('light', { width: 860, height: 760 })
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-overflow').click()
      await page.getByTestId('rail-menu').waitFor({ timeout: 10_000 })
      check(!(await panelOpen(page)), '窄于 900：面板先收着')
      await shot(page, '5-compact')
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
