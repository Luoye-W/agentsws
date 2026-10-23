#!/usr/bin/env node
/**
 * WP438（WP434 设计第二阶段）：报表与首页重排——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（`reportHistory: true`：补 120 天演示订单，报表的 30 / 90 天图才看得出样子），用 Playwright 查：
 * 首页四块（问候 / 要你定 / 关键数字 / 岗位）、点关键数字在第三栏拉出报表、岗位页看板「报表」卡一行一份、
 * 整份报表（结论、KPI 条、趋势图、两列小块、缺数据源原位占位）、跟 AI 说想看什么 → 小报表 → 固定 → 看板多一行。
 * 不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp438-shots.mjs [--port 4641] [--out <目录>] [--attach]
 * ```
 * `--attach`：不自己起 demo，连已经在跑的（`agentsws demo --port <port> --report-history`）。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp438'))
const PORT = Number(argOf('--port') ?? '4641') || 4641
const ATTACH = args.includes('--attach')
const ONLY = argOf('--only')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
  let demo
  if (!ATTACH) {
    const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
    demo = await createDemo({
      root: ROOT,
      port: PORT,
      quiet: true,
      reportHistory: true,
      now: Date.parse('2026-10-21T07:30:00Z'),
    })
    await demo.server.listen()
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const open = async (theme, viewport = { width: 1440, height: 900 }) => {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        deviceScaleFactor: 2,
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
      return { context, page }
    }
    const shot = async (page, name, theme, target) => {
      await page.waitForTimeout(1200)
      await (target ?? page).screenshot({ path: join(SHOTS, `${theme}-${name}.png`) })
      console.log(`  📷 ${theme}-${name}.png`)
    }
    const want = (name) => ONLY === undefined || ONLY.split(',').includes(name)

    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      // ① 首页
      {
        const { context, page } = await open(theme, { width: 1440, height: 1300 })
        await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('home').waitFor({ timeout: 30_000 })
        await page.getByTestId('home-key-card').first().waitFor({ timeout: 30_000 })
        if (theme === 'light') {
          // WP459（决策 1497）：「要你定」换成一行「收件箱里 N 件等你 →」
          check((await page.getByTestId('home-inbox-line').count()) === 1, '首页：收件箱那一行')
          check((await page.getByTestId('home-decide').count()) === 0, '首页：不再列决策卡')
          const keys = await page.getByTestId('home-key-card').count()
          check(keys >= 1 && keys <= 4, `首页：关键数字 ${keys} 个（最多 4 个）`)
          check((await page.getByTestId('battle-report').count()) === 0, '首页：复盘四格去掉了')
          check((await page.getByTestId('tile-bar').count()) === 0, '首页：按职责重复的数字去掉了')
          check((await page.getByTestId('today-timeline').count()) === 0, '首页：时间轴去掉了')
          const cards = await page
            .getByTestId('position-card')
            .nth(1)
            .waitFor({ timeout: 30_000 })
            .then(() => true)
            .catch(() => false)
          check(cards, '首页：岗位卡')
        }
        if (want('home')) await shot(page, '1-home', theme)
        // ② 首页点数字 → 第三栏拉出报表
        await page.getByTestId('home-key-card').first().click()
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        await page.getByTestId('report-kpis').waitFor({ timeout: 30_000 })
        if (theme === 'light') {
          check(true, '首页点关键数字：第三栏拉出那份报表')
          check(
            // WP481（决策 1632）：浏览器里第三栏一律浮层（不挤中栏）；桌面壳能加宽窗口时才并排
            (await page.getByTestId('rail-panel-frame').getAttribute('data-layout')) === 'overlay',
            '首页、浏览器里：报表从右边盖上来（WP481 浮层，不挤中栏）',
          )
        }
        if (want('home-report')) await shot(page, '2-home-report', theme)
        await context.close()
      }
      // ③ 岗位页 + 看板报表卡；④ 整份经营报表
      let positionUrl = ''
      {
        const { context, page } = await open(theme)
        await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
        const nav = page.getByTestId('nav-position').filter({ hasText: '网站运营' }).first()
        await nav.waitFor({ timeout: 30_000 })
        await nav.click()
        await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 30_000 })
        positionUrl = page.url()
        await page.getByTestId('rail-cards').waitFor({ timeout: 30_000 })
        const card = page.getByTestId('rail-card-reports')
        if ((await card.getAttribute('data-open')) !== 'true')
          await page.getByTestId('rail-card-toggle-reports').click()
        await card.getByTestId('report-row').first().waitFor({ timeout: 30_000 })
        const rows = await card.getByTestId('report-row').count()
        if (theme === 'light') {
          check(
            rows === 4,
            `看板「报表」卡：网站运营 ${rows} 份（经营 / 流量 / SEO 与 AI 搜索 / 邮件）`,
          )
          check(
            (await card.getByTestId('reports-compose').count()) === 1 &&
              (await page.getByTestId('rail-card-action-reports').count()) === 1,
            '卡头「+」与卡底「跟 AI 说想看什么」',
          )
        }
        if (want('position-panel')) await shot(page, '3-position-panel', theme)
        await card.getByTestId('report-row').first().locator('button').first().click()
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        await page.getByTestId('report-trend-chart').waitFor({ timeout: 30_000 })
        if (theme === 'light') {
          check((await page.getByTestId('report-conclusion').count()) === 1, '整份报表：结论卡')
          check((await page.getByTestId('report-tab').count()) === 4, '整份报表：同岗位 4 个页签')
          check(
            (await page.getByTestId('report-missing').count()) >= 1,
            '整份报表：缺数据源的块原位占位',
          )
          // WP481（决策 1632）：浏览器里报表是浮层，看板不让位、不出「看一眼」
          const frame = page.getByTestId('rail-panel-frame')
          check(
            (await frame.getAttribute('data-layout')) === 'overlay' &&
              (await frame.getAttribute('data-board')) === 'shown' &&
              (await page.getByTestId('board-peek').count()) === 0,
            '有看板的页、浏览器里：报表盖上来、看板不让位（不出「看一眼」）',
          )
        }
        if (want('business-report')) {
          // 整页：把第三栏的滚动区展开成全高再拍
          const pane = page.getByTestId('rail-panel-frame')
          await page.setViewportSize({ width: 1440, height: 2300 })
          await page.waitForTimeout(800)
          await shot(page, '4-business-report', theme, pane)
          await page.setViewportSize({ width: 1440, height: 900 })
        }
        await context.close()
      }
      // ⑤–⑧ 跟 AI 做一份 → 固定；⑪ 展开看
      {
        const { context, page } = await open(theme)
        await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('rail-cards').waitFor({ timeout: 30_000 })
        const card = page.getByTestId('rail-card-reports')
        if ((await card.getAttribute('data-open')) !== 'true')
          await page.getByTestId('rail-card-toggle-reports').click()
        // int/1024：WP433 起卡片列常驻、报表卡默认展开，不再先点卡头——先把鼠标移进卡里，「+」才让开拖动把手
        await page.getByTestId('rail-card-toggle-reports').hover()
        await page.waitForTimeout(400)
        await page.getByTestId('rail-card-action-reports').click()
        await page.getByTestId('report-compose').waitFor({ timeout: 30_000 })
        await page.getByTestId('compose-examples').getByRole('button').first().click()
        if (want('ai-compose')) await shot(page, '5-ai-compose', theme)
        await page.getByTestId('compose-send').click()
        await page.getByTestId('mini-report').waitFor({ timeout: 30_000 })
        if (theme === 'light') check(true, '跟 AI 说一句：出一份小报表（3 个数 + 1 张图）')
        if (want('ai-answer')) await shot(page, '6-ai-answer', theme)
        await page.getByTestId('mini-report-pin').click()
        await page.getByTestId('pin-popover').waitFor({ timeout: 10_000 })
        await page.getByTestId('pin-refresh-weekly').click()
        if (want('ai-pin')) await shot(page, '7-ai-pin', theme)
        await page.getByTestId('pin-confirm').click()
        await page.getByTestId('pin-toast').waitFor({ timeout: 30_000 })
        // int/1024：1440 宽开着「做一份报表」时看板让位（决策 1343）——点顶栏「看一眼」把看板浮出来再看那一行
        if ((await page.getByTestId('board-peek').count()) === 1) {
          await page.getByTestId('board-peek').click()
          await page.getByTestId('rail-board-peek').waitFor({ timeout: 10_000 })
        }
        await card.locator('[data-origin="ai"]').first().waitFor({ timeout: 30_000 })
        if (theme === 'light')
          check(
            (await card.getByTestId('report-row').first().getAttribute('data-origin')) === 'ai',
            '固定以后：看板「报表」卡最上面多出这一份（带 AI 标）',
          )
        if (want('ai-pinned')) await shot(page, '8-ai-pinned', theme)
        await page.waitForTimeout(600)
        await card.locator('[data-origin="ai"] button').first().dispatchEvent('click')
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        await page.getByTestId('report-kpis').waitFor({ timeout: 30_000 })
        if (want('ai-expanded')) await shot(page, '11-ai-expanded', theme)
        // 拿掉，下一轮从头来
        await page.getByTestId('report-unpin').click()
        await page.waitForTimeout(800)
        await context.close()
      }
      // ⑨⑩ Reddit 运营报表（公共关系岗位）
      {
        const { context, page } = await open(theme)
        await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
        const nav = page.getByTestId('nav-position').filter({ hasText: '公共关系' }).first()
        await nav.waitFor({ timeout: 30_000 })
        await nav.click()
        await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 30_000 })
        await page.getByTestId('rail-cards').waitFor({ timeout: 30_000 })
        const card = page.getByTestId('rail-card-reports')
        if ((await card.getAttribute('data-open')) !== 'true')
          await page.getByTestId('rail-card-toggle-reports').click()
        await card.getByTestId('report-row').first().waitFor({ timeout: 30_000 })
        if (want('reddit-position')) await shot(page, '9-reddit-position', theme)
        await card.locator('[data-id="pr.reddit"] button').first().click()
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        await page.getByTestId('report-kpis').waitFor({ timeout: 30_000 })
        if (theme === 'light')
          check(
            (await page.getByTestId('report-title').innerText()).includes('Reddit 运营报表'),
            'Reddit 运营报表（原来的数据看板并进来）',
          )
        if (want('reddit-report')) {
          await page.setViewportSize({ width: 1440, height: 2000 })
          await page.waitForTimeout(800)
          await shot(page, '10-reddit-report', theme, page.getByTestId('rail-panel-frame'))
        }
        await context.close()
      }
      // 窄窗：第三栏盖在中栏上
      if (want('narrow')) {
        const { context, page } = await open(theme, { width: 1100, height: 800 })
        await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('home-key-card').first().waitFor({ timeout: 30_000 })
        await page.getByTestId('home-key-card').first().click()
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        if (theme === 'light')
          check(
            (await page.getByTestId('rail-panel-frame').getAttribute('data-layout')) ===
              'overlay' && (await page.getByTestId('rail-scrim').count()) === 0,
            // WP485：浮层不再拿遮罩挡住中栏
            '窄窗（< 1400）：报表盖在中栏上、中栏不被遮罩挡住',
          )
        await shot(page, '12-narrow', theme)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    if (demo !== undefined) await demo.close()
  }
  if (failed) process.exit(1)
  console.log('WP438 截图与检查都过了')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
