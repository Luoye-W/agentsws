#!/usr/bin/env node
/**
 * WP456-T5（WP456 §3.6）：日历页端到端看一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright 查：
 * - 页头：标题是「2026 年 10 月」这种年月、后面跟「本周 N 项」；「安排一件事」在页头右边（小号主按钮）；
 * - 周视图：全天区每天最多 2 条 + 「还有 N 项」（不超过 3 行高）；小时格每格 52；「今天」那颗圆是品牌色；
 *   当前时间那条线是红的（「出错」那个红只在这一处借用：它表示「现在」，不是状态）；
 * - 图层：没勾的勾选框是灰框（不是图层色）；「卡片到期」是「要留意」的黄；图层说明进了问号；
 * - 日 / 月视图：同一套颜色，月格每天最多 3 条。
 * 不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：week、day、month、agenda，2x。
 *
 * ```
 * pnpm build && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp456t5-shots.mjs [--port 4744] [--out <目录>] [--prefix after] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp456-t5'))
const PREFIX = argOf('--prefix') ?? 'after'
const PORT = Number(argOf('--port') ?? '4744') || 4744
const CHECK = !args.includes('--no-check')
const DUMP = args.includes('--dump')
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
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(SHOTS, `${PREFIX}-${name}.png`) })
  console.log(`  📷 ${PREFIX}-${name}.png`)
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

/** 一个 CSS 颜色表达式在这一屏算出来是什么（深浅色不一样）。 */
const resolveColor = (page, expr) =>
  page.evaluate((e) => {
    const probe = document.createElement('span')
    probe.style.color = e
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  }, expr)

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
    // 和 WP457 同一个钟：13 张卡的到期日都落在 10-25（周日），浏览器用真钟停在今天那一周
    now: Date.parse('2026-10-18T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const open = async (theme, view) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(
        ([t, th, v]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
            window.localStorage.setItem('agentsws.calendar.view', v)
            // 和示意稿同一组图层：待办、会议、社媒排期、卡片到期
            window.localStorage.setItem(
              'agentsws.calendar.layers',
              'todo,meeting,social_post,card_due',
            )
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [owner, theme, view],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/calendar`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('calendar-host').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1200)
      return { context, page }
    }

    for (const theme of ['light', 'dark']) {
      // ── 周视图 ──
      {
        const { context, page } = await open(theme, 'week')
        await page.locator('.sx__week-grid').waitFor({ timeout: 30_000 })
        if (DUMP && theme === 'light') {
          const html = await page.locator('[data-testid="calendar"]').innerHTML()
          const { writeFileSync } = await import('node:fs')
          writeFileSync(join(SHOTS, 'dump-week.html'), html)
          const probe = await page.evaluate(() =>
            [...document.querySelectorAll('[data-date-grid-date="2026-10-25"] > *')].map((el) => {
              const cs = getComputedStyle(el)
              return `${el.className} h=${el.getBoundingClientRect().height} m=${cs.marginTop}/${cs.marginBottom} p=${cs.paddingTop}/${cs.paddingBottom}`
            }),
          )
          console.log(probe.join('\n'))
        }
        const brand = await resolveColor(page, 'var(--ws-brand)')
        const bad = await resolveColor(page, 'var(--ws-bad)')
        const warn = await resolveColor(page, 'var(--ws-warn)')
        const lineStrong = await resolveColor(page, 'var(--ws-line-strong)')
        const grid = await page.evaluate(() => {
          const q = (s) => document.querySelector(s)
          const dateGrid = q('.sx__date-grid')
          const hour = q('.sx__week-grid__hour')
          const today = q('.sx__week-grid__date--is-today .sx__week-grid__date-number')
          const now = q('.sx__current-time-indicator')
          const cardDue = q('[data-event-id^="cal_card_"]')
          const off = [
            ...document.querySelectorAll('[data-testid="calendar-layer"][data-on="false"]'),
          ].map((el) => {
            const box = el.querySelector('[data-testid="calendar-layer-check"]')
            return box === null ? '' : getComputedStyle(box).borderTopColor
          })
          const bar = cardDue?.querySelector('.ws-ev-bar') ?? null
          return {
            dateGridHeight: dateGrid?.getBoundingClientRect().height ?? -1,
            hourHeight: hour?.getBoundingClientRect().height ?? -1,
            todayBg: today === null ? '' : getComputedStyle(today).backgroundColor,
            nowBg: now === null ? '' : getComputedStyle(now).backgroundColor,
            more: document.querySelectorAll('[data-event-id^="cal_more_"]').length,
            cardDueBar: bar === null ? '' : getComputedStyle(bar).backgroundColor,
            offBorders: off,
            title: q('[data-testid="calendar-title"]')?.textContent ?? '',
            range: q('[data-testid="calendar-range"]')?.textContent ?? '',
            headerHasSchedule:
              q('[data-testid="calendar-head"] [data-testid="calendar-meet"]') !== null,
            hintParagraph: q('[data-testid="calendar-layers-hint-line"]') !== null,
            hintTip: q('[data-testid="calendar-layers-help"]')?.getAttribute('data-hint') ?? '',
          }
        })
        console.log(`  [${theme}] 周：${JSON.stringify(grid)}`)
        check(/^\d{4} 年 \d{1,2} 月$/.test(grid.title.trim()), `[${theme}] 标题是「YYYY 年 M 月」`)
        check(/本周 \d+ 项/.test(grid.range), `[${theme}] 标题后面跟「本周 N 项」`)
        check(grid.headerHasSchedule, `[${theme}] 「安排一件事」在页头右边`)
        check(!grid.hintParagraph && grid.hintTip !== '', `[${theme}] 图层说明进了问号`)
        check(
          grid.dateGridHeight > 0 && grid.dateGridHeight <= 96,
          `[${theme}] 全天区不超过 3 行高`,
        )
        check(Math.abs(grid.hourHeight - 52) <= 1, `[${theme}] 小时格每格 52`)
        check(grid.more > 0, `[${theme}] 多出来的全天事项折成「还有 N 项」`)
        check(grid.todayBg === brand, `[${theme}] 「今天」那颗圆是品牌色`)
        check(grid.nowBg === '' || grid.nowBg === bad, `[${theme}] 当前时间是一条红线`)
        check(grid.cardDueBar === warn, `[${theme}] 「卡片到期」是「要留意」的黄`)
        check(
          grid.offBorders.length > 0 && grid.offBorders.every((c) => c === lineStrong),
          `[${theme}] 没勾的图层是灰框`,
        )
        await shot(page, `${theme}-week`)
        await context.close()
      }
      // ── 日视图 ──
      {
        const { context, page } = await open(theme, 'day')
        await page.locator('.sx__week-grid').waitFor({ timeout: 30_000 })
        // 翻到 10-20（有全天项也有定了钟点的社媒排期），看两种事件在日视图里的样子
        await page.getByTestId('mini-day').filter({ hasText: /^20$/ }).first().click()
        await page.waitForTimeout(800)
        const hour = await page.evaluate(
          () =>
            document.querySelector('.sx__week-grid__hour')?.getBoundingClientRect().height ?? -1,
        )
        check(Math.abs(hour - 52) <= 1, `[${theme}] 日视图小时格每格 52`)
        await shot(page, `${theme}-day`)
        await context.close()
      }
      // ── 月视图 ──
      {
        const { context, page } = await open(theme, 'month')
        await page.locator('.sx__month-grid-wrapper').waitFor({ timeout: 30_000 })
        const brand = await resolveColor(page, 'var(--ws-brand)')
        const month = await page.evaluate(() => {
          const today = document.querySelector('.sx__month-grid-day__header-date.sx__is-today')
          const most = Math.max(
            0,
            ...[...document.querySelectorAll('.sx__month-grid-day')].map(
              (d) => d.querySelectorAll('.sx__month-grid-event').length,
            ),
          )
          return {
            todayBg: today === null ? '' : getComputedStyle(today).backgroundColor,
            most,
          }
        })
        console.log(`  [${theme}] 月：${JSON.stringify(month)}`)
        check(month.todayBg === brand, `[${theme}] 月视图「今天」是品牌色圈`)
        check(month.most <= 3, `[${theme}] 月格每天最多 3 条`)
        await shot(page, `${theme}-month`)
        await context.close()
      }
      // ── 议程（顺带看一眼：和时间格同一种两行） ──
      {
        const { context, page } = await open(theme, 'agenda')
        await shot(page, `${theme}-agenda`)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
