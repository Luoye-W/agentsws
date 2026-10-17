#!/usr/bin/env node
/**
 * WP372（决策 1001–1005 / 1019）布局重排：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright：
 *
 * **端到端**：进岗位 → 进职责 → 右上角「对话」→ 右侧面板「+ 新对话」→ 写一句回车 →
 * 服务端真的开出一件事（`/v1/work/rail` 里多一条、标题就是那句话）。不通过就退出码 1。
 *
 * **截图**（`docs/assets/wp372/`）：
 * 1. `1-wide-light` / `1-wide-dark`：宽窗，职责页 + 右侧面板六张卡（对话展开）；
 * 2. `2-menu`：右上角「⋮」菜单；
 * 3. `3-position-landing`：岗位页中间栏（标题 + 对话框 + 快捷按钮 + 要你拍板）；
 * 4. `4-reports-wide`：报表「显示更多」（看板在下半截），面板加宽；
 * 5. `5-narrow-light` / `5-narrow-dark`：窄窗（1000 宽），面板盖在主区上、图标还在；
 *    `5-compact`：再窄（860），右上角只剩「⋮」；
 * 6. `6-left-rail`：左栏两层特写；
 * 7. `7-titlebar-1280`：1280×800（Windows 常见窗口大小）顶栏右上角特写——窗口用系统标题栏，
 *    这一排在标题栏下面，Mac 红绿灯 / Windows 窗口按钮都挡不到（无边框那件事单列决策，没做）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp372-shots.mjs [--port 4472]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp372')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4472')
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
    now: Date.parse('2026-10-17T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  let failed = false
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

    // ── 端到端：进岗位 → 进职责 → 右侧面板开新对话 → 发一条 ──
    let dutyUrl = ''
    let positionUrl = ''
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const position = page.getByTestId('nav-position').first()
      await position.waitFor({ timeout: 20_000 })
      await position.click()
      await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 20_000 })
      positionUrl = page.url()
      const row = page.getByTestId('nav-position-row').first()
      if ((await row.getByTestId('nav-duties').count()) === 0)
        await row.getByTestId('nav-position-toggle').click()
      await row.getByTestId('nav-duty').first().click()
      await page.waitForURL(/\/duties\//, { timeout: 20_000 })
      dutyUrl = page.url()
      const asg = /\/positions\/([^/]+)\/duties\/([^/?]+)/.exec(dutyUrl)
      const before = await get(owner, '/v1/work/rail?limit=20', asg?.[1])
      const count = (rail) =>
        rail.positions.flatMap((p) => p.duties.flatMap((d) => d.matters)).length
      await page.getByTestId('rail-icon-conversations').click()
      await page.getByTestId('conv-card').waitFor({ timeout: 20_000 })
      await page.getByTestId('conv-new').click()
      const sentence = '把这周要发的三条内容列个清单'
      await page.getByTestId('conv-compose-input').fill(sentence)
      await page.getByTestId('conv-compose-input').press('Enter')
      await page.waitForURL(/\/positions\/[^/]+(\?.*)?$|\/matters\//, { timeout: 20_000 })
      let ok = false
      for (let i = 0; i < 60 && !ok; i += 1) {
        const after = await get(owner, '/v1/work/rail?limit=20', asg?.[1])
        const titles = after.positions.flatMap((p) =>
          p.duties.flatMap((d) => d.matters.map((m) => m.title)),
        )
        ok = count(after) > count(before) || titles.includes(sentence)
        if (!ok) await page.waitForTimeout(500)
      }
      if (ok) console.log(`  ✅ 端到端：在「${asg?.[2]}」右侧面板开了新对话，服务端开出了那件事`)
      else {
        failed = true
        console.error('  ❌ 端到端：发出去之后服务端没开出事项')
      }
      await context.close()
    }

    // ── 宽窗：职责页 + 六张卡（浅 / 深） ──
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-icon-conversations').click()
      await page.getByTestId('rail-cards').waitFor({ timeout: 20_000 })
      await shot(page, `1-wide-${theme}`)
      if (theme === 'light') {
        await page.getByTestId('rail-overflow').click()
        await page.getByTestId('rail-menu').waitFor({ timeout: 10_000 })
        await shot(page, '2-menu')
        await page.keyboard.press('Escape')
        await shot(page, '6-left-rail', page.locator('aside').first())
      }
      await context.close()
    }

    // ── 岗位页中间栏 + 报表（看板在下半截，加宽） ──
    {
      const { context, page } = await open('light')
      await page.goto(positionUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('position-handoff').waitFor({ timeout: 20_000 })
      await shot(page, '3-position-landing')
      await page.getByTestId('rail-icon-reports').click()
      await page.getByTestId('rail-card-more-reports').click()
      await page.getByTestId('reports-panel').waitFor({ timeout: 20_000 })
      await page.getByTestId('rail-panel-wide').click()
      await page.waitForTimeout(1500)
      await shot(page, '4-reports-wide')
      // 还原，免得后面那几张也是宽的（宽度记在本机，这个浏览器上下文一关就没了）
      await page.getByTestId('rail-panel-wide').click()
      await context.close()
    }

    // ── 窄窗：面板盖在主区上；再窄只剩「⋮」 ──
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, { width: 1000, height: 760 })
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-icon-plans').click()
      await page.getByTestId('rail-cards').waitFor({ timeout: 20_000 })
      await shot(page, `5-narrow-${theme}`)
      await context.close()
    }
    {
      const { context, page } = await open('light', { width: 860, height: 760 })
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-overflow').waitFor({ timeout: 20_000 })
      await shot(page, '5-compact')
      await context.close()
    }
    {
      const { context, page } = await open('light', { width: 1280, height: 800 })
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('top-bar').waitFor({ timeout: 20_000 })
      await shot(page, '7-titlebar-1280', page.getByTestId('top-bar'))
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
