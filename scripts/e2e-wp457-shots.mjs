#!/usr/bin/env node
/**
 * WP457（WP456 第 3 节的 4 处 P0）：端到端看一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright 查：
 * - 日历周视图：全天区不超过 3 行高（每天最多 2 条 + 「还有 N 项」），小时格不被挤；
 *   「卡片到期」不是红色；深色下「今天」那颗圆是品牌色，不是 Schedule-X 自带的紫；
 * - 事项页：卡里没有「stub」「运行时」这类内部词；
 * - 设置 → 岗位与职责：没有「(store_main)」这种括号里的内部 id。
 * 不通过就退出码 1。插件侧边栏那一处用 `e2e-wp413-sidepanel.mjs --shots=<目录>` 拍。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：calendar、matter、settings-positions。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp457-shots.mjs [--port 4676] [--out <目录>] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp457'))
const PORT = Number(argOf('--port') ?? '4676') || 4676
const CHECK = !args.includes('--no-check')
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

const shot = async (page, name) => {
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

/** 一段文字里有没有内部词（与 `apps/workstation/test/wp457-internal-words.test.ts` 同一份口径）。 */
const INTERNAL =
  /\bstub\b|运行时(?!长)|\bdirect-llm\b|\(\s*[a-z]+_[a-z0-9_]+\s*\)|（\s*[a-z]+_[a-z0-9_]+\s*）/

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
    // 演示世界的钟停在 10-18（和 WP456 改前那张一样）：13 张卡的到期日都落在 10-25 那一天，
    // 浏览器用真钟，周视图停在「今天」那一周——两边合起来就是改前那一屏（全天区堆满一天）
    now: Date.parse('2026-10-18T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
            window.localStorage.setItem('agentsws.calendar.view', 'week')
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

    // 找一个事项页（搜索弹窗里「最近」的第一条）
    let matterUrl = ''
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      await page
        .getByTestId('shell-search')
        .waitFor({ timeout: 90_000 })
        .catch(async (e) => {
          await page.screenshot({ path: join(SHOTS, 'debug-home.png') })
          throw e
        })
      await page.getByTestId('shell-search').click()
      await page.getByTestId('search-dialog').waitFor({ timeout: 10_000 })
      const recent = page.getByTestId('command-recent').first()
      await recent.waitFor({ timeout: 10_000 })
      await recent.click()
      await page.waitForURL(/\/matters\//, { timeout: 20_000 })
      matterUrl = page.url()
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      // ── 日历周视图 ──
      await page.goto(`${BASE}/calendar`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('calendar-host').waitFor({ timeout: 30_000 })
      await page.locator('.sx__week-grid').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1000)
      const grid = await page.evaluate(() => {
        const dateGrid = document.querySelector('.sx__date-grid')
        const hour = document.querySelector('.sx__week-grid__hour')
        const today = document.querySelector(
          '.sx__week-grid__date--is-today .sx__week-grid__date-number',
        )
        const more = document.querySelectorAll('[data-event-id^="cal_more_"]').length
        const cardDue = document.querySelector('[data-event-id^="cal_card_"]')
        // 「出错」那个红在这一屏算出来是什么颜色（深浅色不一样）
        const probe = document.createElement('span')
        probe.style.color = 'var(--ws-bad)'
        document.querySelector('.sx-host')?.appendChild(probe)
        const bad = getComputedStyle(probe).color
        probe.remove()
        return {
          dateGridHeight: dateGrid?.getBoundingClientRect().height ?? -1,
          hourHeight: hour?.getBoundingClientRect().height ?? -1,
          todayBg: today === null ? '' : getComputedStyle(today).backgroundColor,
          brand: getComputedStyle(document.documentElement).getPropertyValue('--ws-brand').trim(),
          more,
          cardDueBorder: cardDue === null ? '' : getComputedStyle(cardDue).borderLeftColor,
          bad,
        }
      })
      console.log(`  [${theme}] 日历：${JSON.stringify(grid)}`)
      check(grid.dateGridHeight > 0 && grid.dateGridHeight <= 90, `[${theme}] 全天区不超过 3 行高`)
      check(grid.hourHeight >= 48, `[${theme}] 小时格没被挤（每格 ≥ 48px）`)
      check(grid.more > 0, `[${theme}] 多出来的全天事项折成「还有 N 项」`)
      check(
        grid.cardDueBorder !== '' && grid.cardDueBorder !== grid.bad,
        `[${theme}] 「卡片到期」不是红色`,
      )
      check(
        !/rgb\(208, 188, 255\)/.test(grid.todayBg),
        `[${theme}] 「今天」那颗圆不是 Schedule-X 自带的紫`,
      )
      await shot(page, `${theme}-calendar`)
      // 点「还有 N 项」：列出那一天折起来的几条
      const more = page.locator('[data-event-id^="cal_more_"]').first()
      if ((await more.count()) > 0) {
        await more.click()
        const card = page.getByTestId('calendar-more-card')
        const opened = await card
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
        check(
          opened && (await card.getByTestId('calendar-more-item').count()) > 0,
          `[${theme}] 点「还有 N 项」列出折起来的那几条`,
        )
        if (opened) {
          await card.scrollIntoViewIfNeeded()
          await shot(page, `${theme}-calendar-more`)
        }
      }

      // ── 事项页 ──
      if (matterUrl !== '') {
        await page.goto(matterUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('top-bar').waitFor({ timeout: 30_000 })
        await page.waitForTimeout(2000)
        const text = await page.locator('main').innerText()
        check(!INTERNAL.test(text), `[${theme}] 事项页没有内部词`)
        await shot(page, `${theme}-matter`)
      }

      // ── 设置 → 岗位与职责 ──
      await page.goto(`${BASE}/settings/positions`, { waitUntil: 'load', timeout: 90_000 })
      await page.waitForTimeout(3000)
      const dialog = page.getByRole('dialog').first()
      const settingsText = (await dialog.count()) > 0 ? await dialog.innerText() : ''
      check(settingsText.length > 0, `[${theme}] 设置弹窗打开了`)
      check(!INTERNAL.test(settingsText), `[${theme}] 岗位与职责里没有括号里的内部 id`)
      await shot(page, `${theme}-settings-positions`)
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
