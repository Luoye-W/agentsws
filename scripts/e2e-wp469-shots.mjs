#!/usr/bin/env node
/**
 * WP469（决策 1521–1527）：日历与待办——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起 demo（浅 / 深各起一次，互不影响），用 Playwright 走：
 * 清单（三档写在右边）→ 一行的「⋯」→ 切到日历（左边「还没排期的」、顶上「本周要做」那一条、做完的划掉）
 * → 从左边拖一件到周四 14:00（拖到一半拍一张）→ 再拖回左边 → 拖进「全天」→「帮我排进空档」（虚线候选、
 * 换一个、采用一件、都不要）→ 月视图 → 首页那一行 → 收件箱「记成待办」→「去看」落在清单本周最上面
 * → 老地址 `/todos`、`/calendar` 转到对应那一面。不通过就退出码 1。
 *
 * 截图一定要写到 `--out` 指的目录（审稿截图放私有仓，别进公开仓），浅 / 深各一套：
 * `{theme}-list.png`、`-list-menu.png`、`-calendar.png`、`-calendar-drag.png`、`-calendar-undated.png`、
 * `-month.png`、`-nav.png`（首页 + 左栏）、`-from-inbox.png`、`-from-inbox-landed.png`；
 * 给了 `--mockups <目录>` 再出一份和示意稿并排的 `compare-{theme}-*.png`（左示意、右实拍）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * npx tsc -b apps/cli
 * node scripts/e2e-wp469-shots.mjs --out <私有仓>/docs/assets/wp469 [--port 4772] [--mockups <示意稿目录>]
 * ```
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (argOf('--out') === undefined)
  throw new Error(
    '要给 --out <目录>：截图放私有仓（比如 agentsws-internal/docs/assets/wp469），别进公开仓',
  )
const SHOTS = resolve(argOf('--out'))
const MOCKUPS = argOf('--mockups') === undefined ? undefined : resolve(argOf('--mockups'))
const PORT = Number(argOf('--port') ?? '4772') || 4772
if (PORT === 4317 || PORT + 1 === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
/** 浅色用 PORT、深色用 PORT + 1（两次 demo 各起各的，前一个刚关的端口不复用） */
let BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
/** demo 的「现在」：2026-10-22 周四 北京 09:30 */
const NOW = Date.parse('2026-10-22T01:30:00Z')

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

/** 示意稿 → 实拍的对照（左右并排）。 */
const PAIRS = [
  ['list', 'list'],
  ['list-menu', 'list-menu'],
  ['calendar', 'calendar'],
  ['calendar-drag', 'calendar-drag'],
  ['calendar-undated', 'calendar-undated'],
  ['month', 'month'],
  ['nav', 'nav'],
  ['from-inbox', 'from-inbox'],
  ['from-inbox-landed', 'from-inbox-landed'],
]

async function call(method, path, body, token, assignment) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (assignment !== undefined) headers['x-assignment'] = assignment
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

/** 从一个元素的中心拖到另一个点（浏览器自己的拖放；中间停一下好拍「拖到一半」）。 */
async function drag(page, from, to, { pause } = {}) {
  const a = await from.boundingBox()
  if (a === null) throw new Error('拖的那一件不在屏幕上')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  if (pause !== undefined) await pause()
  await page.mouse.up()
  await page.waitForTimeout(600)
}

/** 周视图里某天某个钟点的屏幕坐标（时间格那一列按 8:00–20:00 画）。 */
async function slotPoint(page, day, minutes) {
  const col = page.locator(`[data-time-grid-date="${day}"]`)
  const box = await col.boundingBox()
  if (box === null) throw new Error(`周视图里没有 ${day} 那一列`)
  const frac = (minutes - 8 * 60 + 10) / (12 * 60)
  return { x: box.x + box.width / 2, y: box.y + frac * box.height }
}

async function runTheme(browser, theme) {
  const port = theme === 'dark' ? PORT + 1 : PORT
  BASE = `http://127.0.0.1:${port}`
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port, quiet: true, now: NOW })
  await demo.server.listen()
  try {
    const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
    const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
    const me = await call('GET', '/v1/me', undefined, token)
    const asg = me.assignments?.[0]?.id
    const todos = async () =>
      (await call('GET', '/v1/todos?status=open,doing,blocked', undefined, token, asg)).todos
    const byTitle = async (title) => (await todos()).find((t) => t.title === title)

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
      deviceScaleFactor: 2,
      timezoneId: 'Asia/Shanghai',
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
    // 页面里的「现在」钉在 demo 那一刻（今天是周四、现在线在 9:30）
    await context.addInitScript(`{
      const real = Date; const offset = ${NOW} - real.now();
      class D extends real { constructor(...a) { super(...(a.length === 0 ? [real.now() + offset] : a)) } static now() { return real.now() + offset } }
      globalThis.Date = D
    }`)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shot = async (name) => {
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`) })
      console.log(`  📷 ${theme}-${name}.png`)
    }

    // ① 清单（第一次打开是清单，决策 1523）
    // Luoye 10-23：第一次打开改成日历（fix/default-views）；清单那一面用 `?view=list` 进
    await page.goto(`${BASE}/planner`, { waitUntil: 'load', timeout: 90_000 })
    await page.getByTestId('cal-todo').waitFor({ timeout: 30_000 })
    check(
      (await page.getByTestId('cal-todo').getAttribute('data-face')) === 'calendar',
      '第一次打开是日历',
    )
    await page.goto(`${BASE}/planner?view=list`, { waitUntil: 'load', timeout: 90_000 })
    await page.getByTestId('horizon-week').waitFor({ timeout: 30_000 })
    const kinds = await page
      .getByTestId('todo-when')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    check(
      kinds.includes('clock') && kinds.includes('day') && kinds.includes('none'),
      `清单每行写清在哪一档（${[...new Set(kinds)].join(' / ')}）`,
    )
    check(
      (await page.getByTestId('nav-cal-todo').textContent())?.includes('日历与待办') === true,
      '左栏叫「日历与待办」',
    )
    await shot('list')

    // ② 一行的「⋯」
    const undatedRow = page.locator('[data-testid="todo-row"][data-level="undated"]').first()
    await undatedRow.hover()
    await undatedRow.getByRole('button', { name: '更多' }).click()
    await page.getByTestId('todo-menu').waitFor()
    check((await page.getByTestId('todo-menu-date').count()) === 1, '「⋯」里有「改日子…」')
    await shot('list-menu')
    await page.keyboard.press('Escape')

    // ③ 日历（周视图）
    await page.getByTestId('caltodo-face-calendar').click()
    await page.getByTestId('caltodo-rail').waitFor()
    await page.locator('.sx__calendar').waitFor({ timeout: 30_000 })
    if ((await page.getByTestId('calendar').getAttribute('data-view')) !== 'week')
      await page.getByTestId('calendar-views').getByRole('button', { name: '周' }).click()
    check(
      (await page.getByTestId('caltodo-strip').count()) === 1,
      '周视图顶上「本周要做 · 还有 N 件没排日子」',
    )
    check(
      (await page.locator('[data-todo-check][data-done="true"]').count()) > 0,
      '做完的待办在日历上划掉（还在）',
    )
    check(
      (await page.getByTestId('calendar-layers').getByText('定时任务').count()) === 1 &&
        (await page
          .locator('[data-testid="calendar-layer"][data-layer="scheduled_task"]')
          .getAttribute('data-on')) === 'false',
      '「定时任务」那一层默认关',
    )
    await shot('calendar')

    // ④ 从左边拖「写新品页文案」到周四 14:00（拖到一半拍一张）
    const row = page.locator('[data-testid="caltodo-rail-row"]', { hasText: '写新品页文案' })
    const target = await slotPoint(page, '2026-10-22', 14 * 60)
    await drag(page, row, target, {
      pause: async () => {
        await page
          .getByTestId('calendar-drop-hint')
          .waitFor({ timeout: 5000 })
          .catch(() => {})
        check(
          (await page.getByTestId('calendar-drop-hint').count()) === 1,
          '拖到一半有「松手：排到…」',
        )
        await shot('calendar-drag')
      },
    })
    let copy = await byTitle('写新品页文案')
    check(
      copy?.scheduled !== undefined && new Date(copy.scheduled.start).getUTCHours() === 6,
      '松手：排到周四 14:00（第三档）',
    )
    // 再拖回左边 = 不排了
    await page.waitForTimeout(500)
    const block = page.locator(`[data-todo-drag="${copy?.id}"]`).first()
    const rail = await page.getByTestId('caltodo-rail').boundingBox()
    await drag(page, block, { x: rail.x + rail.width / 2, y: rail.y + 60 })
    copy = await byTitle('写新品页文案')
    check(copy?.scheduled === undefined && copy?.due === undefined, '拖回左边：不排了（第一档）')
    // 拖进周五「全天」= 只定日子
    const allday = await page.locator('[data-date-grid-date="2026-10-23"]').boundingBox()
    await drag(
      page,
      page.locator('[data-testid="caltodo-rail-row"]', { hasText: '写新品页文案' }),
      { x: allday.x + allday.width / 2, y: allday.y + allday.height / 2 },
    )
    copy = await byTitle('写新品页文案')
    check(
      copy?.due !== undefined && copy?.scheduled === undefined,
      '拖进「全天」：只定日子（第二档）',
    )
    // 放回左边，留给 AI 排
    await call(
      'PUT',
      `/v1/todos/${copy.id}`,
      { due: null, scheduled: null, horizon: 'week' },
      token,
      asg,
    )
    await page.reload({ waitUntil: 'load' })
    await page.getByTestId('caltodo-rail').waitFor()
    await page.locator('.sx__calendar').waitFor({ timeout: 30_000 })

    // ⑤ 帮我排进空档：选三件 → 虚线候选（不点采用什么都不写）→ 换一个 → 采用一件 → 都不要
    for (const title of ['写新品页文案', '整理 3 个红人的寄样清单', '给工厂确认 12 月备货量'])
      await page
        .locator('[data-testid="caltodo-rail-row"]', { hasText: title })
        .getByRole('button', { pressed: false })
        .click()
    const before = JSON.stringify((await todos()).map((t) => [t.id, t.scheduled, t.due]))
    await page.getByTestId('caltodo-ai').click()
    await page.getByTestId('caltodo-ai-bar').waitFor({ timeout: 15_000 })
    await page.locator('[data-ghost-act="take"]').first().waitFor({ timeout: 10_000 })
    const ghosts = await page.locator('.ws-ghost').count()
    check(ghosts === 3, `虚线候选 ${ghosts} 块`)
    check(
      JSON.stringify((await todos()).map((t) => [t.id, t.scheduled, t.due])) === before,
      '没点「采用」：一件都没排上',
    )
    await shot('calendar-undated')
    const swapId = await page.locator('[data-ghost-act="swap"]').first().getAttribute('data-ghost')
    const timeBefore = await page
      .locator(`.ws-ghost[data-ghost-id="${swapId}"] .ws-ghost-time`)
      .textContent()
    await page.locator(`[data-ghost-act="swap"][data-ghost="${swapId}"]`).click()
    await page.waitForTimeout(400)
    const timeAfter = await page
      .locator(`.ws-ghost[data-ghost-id="${swapId}"] .ws-ghost-time`)
      .textContent()
    check(timeBefore !== timeAfter, `换一个：${timeBefore} → ${timeAfter}`)
    const takeId = await page.locator('[data-ghost-act="take"]').first().getAttribute('data-ghost')
    await page.locator(`[data-ghost-act="take"][data-ghost="${takeId}"]`).click()
    await page.waitForTimeout(800)
    const taken = (await todos()).find((t) => t.id === takeId)
    check(taken?.scheduled !== undefined, '「采用」那一件排上了')
    await page.getByTestId('caltodo-ai-none').click()
    check((await page.locator('.ws-ghost').count()) === 0, '「都不要」：虚线块都没了')
    const others = (await todos()).filter(
      (t) =>
        t.id !== takeId &&
        ['写新品页文案', '整理 3 个红人的寄样清单', '给工厂确认 12 月备货量'].includes(t.title),
    )
    check(
      others.every((t) => t.scheduled === undefined),
      '没采用的那两件还是没排',
    )

    // ⑥ 月视图
    await page.getByTestId('calendar-views').getByRole('button', { name: '月' }).click()
    await page.locator('.sx__month-grid-day').first().waitFor({ timeout: 10_000 })
    await shot('month')
    await page.getByTestId('calendar-views').getByRole('button', { name: '周' }).click()

    // ⑦ 首页那一行 + 左栏
    await page.goto(`${BASE}/`, { waitUntil: 'load' })
    await page.getByTestId('home-todo-line').waitFor({ timeout: 30_000 })
    check(
      /今天 \d+ 件待办/.test((await page.getByTestId('home-todo-count').textContent()) ?? ''),
      '首页：今天 N 件待办',
    )
    await shot('nav')

    // ⑧ 收件箱「记成待办」
    await page.goto(`${BASE}/inbox?mode=list`, { waitUntil: 'load' })
    await page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
    const mailRow = page.locator('[data-testid="inbox-row"][data-type="mail"]').first()
    const target2 = (await mailRow.count()) > 0 ? mailRow : page.getByTestId('inbox-row').nth(1)
    const itemId = await target2.getAttribute('data-id')
    await target2.getByTestId('inbox-row-more').click()
    await page.getByTestId('inbox-row-menu').waitFor()
    check(
      (
        await page.getByTestId('inbox-row-menu').getByRole('menuitem').first().textContent()
      )?.startsWith('记成待办') === true,
      '收件箱「⋯」第一项是「记成待办」',
    )
    await page.getByTestId('inbox-menu-todo').click()
    await page.getByTestId('inbox-notice').waitFor({ timeout: 10_000 })
    await page.getByTestId('inbox-row-recorded').first().waitFor({ timeout: 10_000 })
    check((await page.getByTestId('inbox-row-recorded').count()) === 1, '记完那一行收成一行')
    await shot('from-inbox')
    const landed = (await todos()).find((t) => t.origin?.inbox_item === itemId)
    check(
      landed?.horizon === 'week' || landed?.horizon === 'today',
      `落在清单「${landed?.horizon}」`,
    )
    await page.getByTestId('inbox-notice-go').click()
    await page
      .locator(`[data-testid="todo-row"][data-todo="${landed?.id}"]`)
      .waitFor({ timeout: 10_000 })
    check(
      (await page
        .getByTestId('horizon-week')
        .locator('[data-testid="todo-row"]')
        .first()
        .getAttribute('data-todo')) === landed?.id || landed?.horizon === 'today',
      '「去看」：落在清单本周最上面',
    )
    await shot('from-inbox-landed')

    // ⑨ 老地址
    await page.goto(`${BASE}/todos`, { waitUntil: 'load' })
    await page.waitForURL(/\/planner\?view=list/, { timeout: 10_000 })
    check(page.url().includes('/planner?view=list'), '/todos → 清单')
    await page.goto(`${BASE}/calendar?layers=social_post,todo`, { waitUntil: 'load' })
    await page.waitForURL(/view=calendar/, { timeout: 10_000 })
    check(/layers=social_post/.test(page.url()), '/calendar?layers= → 日历，图层照旧')
    // 记住上次那一面：现在是日历，回 /planner 还是日历
    await page.goto(`${BASE}/planner`, { waitUntil: 'load' })
    await page.getByTestId('cal-todo').waitFor()
    check(
      (await page.getByTestId('cal-todo').getAttribute('data-face')) === 'calendar',
      '记住上次那一面',
    )
    await context.close()
  } finally {
    await demo.close()
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      await runTheme(browser, theme)
    }
    if (MOCKUPS !== undefined) {
      const page = await browser.newPage({ viewport: { width: 2880, height: 900 } })
      for (const theme of ['light', 'dark'])
        for (const [mine, mock] of PAIRS) {
          const a = join(MOCKUPS, `${theme}-${mock}.png`)
          const b = join(SHOTS, `${theme}-${mine}.png`)
          if (!existsSync(a) || !existsSync(b)) continue
          const src = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
          await page.setContent(
            `<body style="margin:0;display:flex;background:${theme === 'dark' ? '#111' : '#ddd'}"><img src="${src(a)}" style="width:1440px;height:900px"><img src="${src(b)}" style="width:1440px;height:900px"></body>`,
          )
          await page.screenshot({ path: join(SHOTS, `compare-${theme}-${mine}.png`) })
          console.log(`  📷 compare-${theme}-${mine}.png`)
        }
      await page.close()
    }
  } finally {
    await browser.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
