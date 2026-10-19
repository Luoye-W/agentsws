#!/usr/bin/env node
/**
 * WP431（Luoye 10-19，顶栏与右侧面板照 Claude 桌面版）：端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright 查：
 * 左上角没有「Agents 工坊」字标、是左栏开关 + 搜索两颗；岗位 / 职责 / 事项页的名字在顶栏左边（带下拉），
 * 主区没有大标题与「刚建好…」那行；右上从左到右是面板开关 → 细竖线 → 工具 → 设置滑杆 →「⋮」；
 * 面板并排、默认开着、没有标题条 / × / 放大钮；首页没有面板开关；搜索弹窗没打字时列「最近」；
 * 左栏收成图标列、刷新后还收着。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * position、duty、matter、home、topbar（顶栏特写，和 Claude 对照用）、title-menu、search、collapsed，以及窄窗 narrow。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp431-shots.mjs [--port 4608] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp431'))
const PORT = Number(argOf('--port') ?? '4608') || 4608
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

const shot = async (page, name, target) => {
  // 机器忙时网络不一定静下来：等页面主体画出来再多等一会
  await page.getByTestId('top-bar').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
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

    const topText = async (page) =>
      (await page.getByTestId('top-bar').innerText()).replace(/\s+/g, ' ')

    // ── 端到端 ──
    let positionUrl = ''
    let dutyUrl = ''
    let matterUrl = ''
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      const corner = page.getByTestId('rail-brand-row')
      await corner.waitFor({ timeout: 20_000 })
      check(!(await corner.innerText()).includes('Agents 工坊'), '左上角没有「Agents 工坊」字标')
      check(
        (await corner.getByTestId('sidebar-toggle').count()) === 1 &&
          (await corner.getByTestId('shell-search').count()) === 1,
        '左上角是左栏开关 + 搜索两颗图标',
      )
      check(
        (await page.getByTestId('rail-toggle').count()) === 0,
        '首页没有右侧面板，也没有面板开关',
      )
      check((await topText(page)).includes('首页'), '首页顶栏左边写页名')
      const position = page.getByTestId('nav-position').first()
      await position.waitFor({ timeout: 20_000 })
      await position.click()
      await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 20_000 })
      positionUrl = page.url()
      check(await cardsShown(page), '进岗位页：右侧面板默认打开（并排）')
      const name = await page.getByTestId('position-name').innerText()
      check(
        (await page.getByTestId('top-bar').getByTestId('position-name').count()) === 1,
        `岗位名「${name}」在顶栏左边`,
      )
      check(
        (await page.getByTestId('position-status').count()) === 0 ||
          !(await page.getByTestId('position-status').innerText()).includes('刚建好'),
        '主区没有「刚建好，还没开工」那行',
      )
      check((await page.locator('main h1').count()) === 0, '主区没有大标题')
      check(
        (await page.getByTestId('rail-panel-close').count()) === 0 &&
          (await page.getByTestId('rail-panel-wide').count()) === 0,
        '面板没有关闭叉和放大钮',
      )
      const order = await page
        .getByTestId('right-rail')
        .evaluate((nav) =>
          [...nav.querySelectorAll('[data-testid]')]
            .map((e) => e.getAttribute('data-testid'))
            .filter((id) =>
              /^(rail-toggle|top-bar-divider|rail-icon-.*|position-settings-link|rail-overflow)$/.test(
                id,
              ),
            ),
        )
      console.log(`  右上顺序：${order.join(' → ')}`)
      check(
        order[0] === 'rail-toggle' &&
          order[1] === 'top-bar-divider' &&
          order.at(-1) === 'rail-overflow' &&
          order.at(-2) === 'position-settings-link',
        '右上：面板开关 → 细竖线 → 工具 → 岗位设置 → ⋮',
      )
      const banner = page.getByTestId('position-missing-banner')
      if ((await banner.count()) > 0) {
        const text = await banner.innerText()
        console.log(`  黄条：${text}`)
        check(!text.includes('必需'), '黄条不再说「必需」')
      }
      // 职责页
      const row = page.getByTestId('nav-position-row').first()
      const shown = await row
        .getByTestId('nav-duties')
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (!shown) await row.getByTestId('nav-position-toggle').click()
      const duty = row.getByTestId('nav-duty').first()
      await duty.waitFor({ timeout: 20_000 })
      await duty.click()
      await page.waitForURL(/\/duties\//, { timeout: 20_000 })
      dutyUrl = page.url()
      check(await cardsShown(page), '进职责页：右侧面板默认打开')
      await page.getByTestId('top-bar').getByTestId('duty-name').waitFor({ timeout: 20_000 })
      check(
        (await page.getByTestId('top-bar').getByTestId('duty-name').count()) === 1 &&
          (await page.getByTestId('top-bar').getByTestId('duty-breadcrumb').count()) === 1,
        '职责页顶栏左边是「岗位 / 职责」',
      )
      // 搜索弹窗：没打字列「最近」，点一条进事项页
      await page.getByTestId('shell-search').click()
      await page.getByTestId('search-dialog').waitFor({ timeout: 10_000 })
      const recents = page.getByTestId('command-recent')
      const hasRecent = await recents
        .first()
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      check(hasRecent, '搜索弹窗没打字时列最近的事项 / 对话')
      if (hasRecent) {
        await recents.first().click()
        await page.waitForURL(/\/matters\//, { timeout: 20_000 })
        matterUrl = page.url()
        await page
          .getByTestId('top-bar')
          .getByTestId('matter-title')
          .waitFor({ timeout: 20_000 })
          .catch(() => undefined)
        check(
          (await page.getByTestId('top-bar').getByTestId('matter-title').count()) === 1,
          '事项页标题在顶栏左边',
        )
      }
      // ⌘K 也打开同一个
      await page.keyboard.press('Meta+k')
      check(
        await page
          .getByTestId('search-dialog')
          .waitFor({ timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        '⌘K 打开搜索弹窗',
      )
      await page.keyboard.press('Escape')
      // 左栏收起 → 图标列，刷新后还收着
      await page.getByTestId('sidebar-toggle').click()
      await page.waitForTimeout(300)
      check(
        (await page.getByTestId('sidebar').getAttribute('data-collapsed')) === 'true',
        '左栏开关：收成图标列',
      )
      await page.reload({ waitUntil: 'load', timeout: 90_000 })
      check(
        (await page.getByTestId('sidebar').getAttribute('data-collapsed')) === 'true',
        '刷新后左栏还收着（本机记住）',
      )
      await page.getByTestId('sidebar-toggle').click()
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      await page.waitForTimeout(800)
      await shot(page, `${theme}-1-position`)
      const bar = await page.getByTestId('top-bar').boundingBox()
      if (bar !== null)
        await shot(page, `${theme}-2-topbar`, {
          screenshot: (o) =>
            page.screenshot({
              ...o,
              clip: { x: 0, y: 0, width: 1440, height: bar.height + 8 },
            }),
        })
      await page.getByTestId('position-title-menu').click()
      await page.waitForTimeout(300)
      await shot(page, `${theme}-3-title-menu`, {
        screenshot: (o) => page.screenshot({ ...o, clip: { x: 0, y: 0, width: 760, height: 420 } }),
      })
      await page.keyboard.press('Escape')
      await page.goto(dutyUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      await page.waitForTimeout(600)
      await shot(page, `${theme}-4-duty`)
      if (matterUrl !== '') {
        await page.goto(matterUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.waitForTimeout(1200)
        await shot(page, `${theme}-5-matter`)
      }
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      await page.waitForTimeout(800)
      await shot(page, `${theme}-6-home`)
      await page.getByTestId('shell-search').click()
      await page.getByTestId('search-dialog').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(800)
      await shot(page, `${theme}-7-search`)
      await page.keyboard.press('Escape')
      await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('sidebar-toggle').click()
      await page.waitForTimeout(600)
      await shot(page, `${theme}-8-collapsed`)
      await page.getByTestId('sidebar-toggle').click()
      await context.close()
    }
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, { width: 860, height: 760 })
      await page.goto(dutyUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.waitForTimeout(800)
      check(!(await panelOpen(page)), '窄于 900：面板先收着')
      await shot(page, `${theme}-9-narrow`)
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
