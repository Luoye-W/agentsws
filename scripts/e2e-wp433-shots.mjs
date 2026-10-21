#!/usr/bin/env node
/**
 * WP433（Luoye 10-20 反馈问题 1 / 5 / 6 / 7 / 8）：端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），加一条「Reddit 运营」职责，用 Playwright 查：
 * 左栏「首页」在最上面；岗位 / 职责页右侧面板一直在、顶栏没有面板开关、面板顶上没有「岗位层 / 职责层」切换；
 * 职责页的卡是职责层的；卡里条数 ≤ 5 时没有「显示更多」；「计划」卡最上面一行「进度」，点开是「工作」（进行中 / 卡住了…），
 * 「报表」里不再有「工作」与数据看板；「显示更多」开在卡片列右边的第三栏、卡片列还在；窄于 1024 时卡片列自动隐藏；
 * Windows（模拟叠加系统按钮）时右上有隔开的细竖线。
 * 不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * position、duty、reddit（岗位页）、reddit-plans（「计划」完整一格）、reddit-duty-plans（Reddit 职责页「计划」）、
 * reddit-reports（报表卡）、narrow（1000 宽：卡片列自动隐藏）、topbar-windows-before / -after（模拟 Windows 叠加按钮）、topbar-mac。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp433-shots.mjs [--port 4620] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp433'))
const PORT = Number(argOf('--port') ?? '4620') || 4620
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', { email })
  return (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
}

const shot = async (page, name, options = {}) => {
  await page.getByTestId('top-bar').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), ...options })
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

/** 模拟 Windows 叠加在右上的三个系统按钮（46×44 一颗，和 Electron titleBarOverlay 同尺寸），只为截图对照。 */
function fakeCaptionButtons(theme) {
  const dark = theme === 'dark'
  const box = document.createElement('div')
  box.setAttribute('data-fake-caption', '1')
  Object.assign(box.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    height: '44px',
    width: '138px',
    display: 'flex',
    zIndex: '9999',
    background: dark ? '#0e100f' : '#f3f5f2',
    color: dark ? '#f1f4f0' : '#263331',
    font: '12px "Segoe MDL2 Assets", system-ui',
  })
  for (const glyph of ['—', '☐', '✕']) {
    const b = document.createElement('div')
    Object.assign(b.style, {
      width: '46px',
      height: '44px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: glyph === '☐' ? '12px' : '11px',
    })
    b.textContent = glyph
    box.appendChild(b)
  }
  document.body.appendChild(box)
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
    // 加一条 Reddit 运营（Luoye 截图里那个岗位），挂整个品牌
    let me = await call('GET', '/v1/me', undefined, owner)
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner').id
    if (!me.assignments.some((a) => a.role_id === 'social.reddit'))
      await call(
        'POST',
        '/v1/assignments',
        {
          person_id: me.person.id,
          role_id: 'social.reddit',
          ranges: [{ kind: 'brand', id: me.workspace.id }],
        },
        owner,
        ownerAsg,
      )
    me = await call('GET', '/v1/me', undefined, owner)
    const reddit = me.assignments.find((a) => a.role_id === 'social.reddit').id
    // 给 Reddit 运营开两件事：一件在做、一件卡住（「进行中 / 卡住了」要有东西）
    for (const title of ['整理这周 r/Smartphones 的热帖', '自家版置顶公告'])
      await call('POST', '/v1/matters', { title, assignment_id: reddit }, owner, reddit).catch(
        () => undefined,
      )

    const open = async (theme, viewport = { width: 1440, height: 900 }, chrome) => {
      const context = await browser.newContext({ viewport, colorScheme: theme })
      await context.addInitScript(
        ([t, th, c]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
          // 模拟桌面壳藏了标题栏（只给标题栏那一座桥，别的桌面能力都没有）
          if (c !== null) window.agentsws = { titleBar: { style: c, setTheme: async () => true } }
        },
        [owner, theme, chrome ?? null],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const cardsShown = (page) =>
      page
        .getByTestId('rail-cards')
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)

    // ── 端到端 ──
    let positionUrl = ''
    let dutyUrl = ''
    const redditPositionUrl = `${BASE}/positions/${reddit}`
    const redditDutyUrl = `${BASE}/positions/${reddit}/duties/social.reddit`
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      const nav = page.getByTestId('main-nav')
      await nav.waitFor({ timeout: 20_000 })
      const hrefs = await nav
        .locator('a')
        .evaluateAll((as) => as.slice(0, 2).map((a) => a.getAttribute('href')))
      check(hrefs[0] === '/' && hrefs[1] === '/assistant', '左栏「首页」在最上面，「助理」第二')
      const position = page.getByTestId('nav-position').first()
      await position.waitFor({ timeout: 20_000 })
      await position.click()
      await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 20_000 })
      positionUrl = page.url()
      check(await cardsShown(page), '岗位页：右侧面板开着')
      check((await page.getByTestId('rail-toggle').count()) === 0, '顶栏没有面板开关')
      check((await page.getByTestId('top-bar-divider').count()) === 0, '也没有开关后面那条细竖线')
      check(
        (await page.getByTestId('rail-tier-switch').count()) === 0,
        '面板顶上没有「岗位层 / 职责层」切换',
      )
      check(
        (await page.getByTestId('rail-panel-cards').getAttribute('data-tier')) === 'position',
        '岗位页看的是岗位层',
      )
      await page.keyboard.press(']')
      await page.waitForTimeout(300)
      check(await cardsShown(page), '按 `]` 面板也不收')
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
      check(await cardsShown(page), '职责页：右侧面板开着')
      check(
        await page
          .locator('[data-testid="rail-panel-cards"][data-tier="role"]')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
        '职责页看的是职责层',
      )
      check(
        await page
          .getByTestId('top-bar')
          .getByTestId('duty-breadcrumb')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
        '职责页回岗位：顶栏标题里的岗位名',
      )
      // Reddit 运营
      await page.goto(redditPositionUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      const conv = page.getByTestId('rail-card-conversations')
      await conv.getByTestId('rail-card-body-conversations').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(1500)
      const convRows = await conv.getByTestId('conv-link').count()
      const convMore = await page.getByTestId('rail-card-more-conversations').count()
      check(
        convRows <= 5 ? convMore === 0 : convMore === 1,
        `对话卡 ${convRows} 条：${convRows <= 5 ? '没有' : '有'}「显示更多」`,
      )
      const progress = page.getByTestId('plan-row-progress')
      check(
        await progress
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false),
        '「计划」卡最上面一行「进度」',
      )
      console.log(`  进度行：${(await progress.innerText()).replace(/\s+/g, ' ')}`)
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      await shot(page, `${theme}-1-position`)
      await page.goto(dutyUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      await shot(page, `${theme}-2-duty`)
      await page.goto(redditPositionUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      await page.getByTestId('plan-row-progress').waitFor({ timeout: 20_000 })
      await shot(page, `${theme}-3-reddit`)
      // 报表卡展开：只有报表
      const reports = page.getByTestId('rail-card-reports')
      if ((await reports.getAttribute('data-open')) !== 'true')
        await page.getByTestId('rail-card-toggle-reports').click()
      await page.waitForTimeout(800)
      const board = page.getByTestId('rail-board')
      await shot(page, `${theme}-4-reddit-reports`, {
        clip: (await board.boundingBox()) ?? undefined,
      })
      // 「计划 → 进度」：「工作」在这里
      await page.getByTestId('plan-row-progress').click()
      await page.getByTestId('plans-panel').waitFor({ timeout: 20_000 })
      const work = await page
        .getByTestId('work-section')
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') {
        check(work, '「计划」那一格里是「工作」（进行中 / 卡住了…）')
        check(
          (await page.getByTestId('rail-cards').count()) === 1 &&
            (await page.getByTestId('rail-panel-frame').getAttribute('data-panel')) === 'schedules',
          '「计划」整格开在卡片列右边的第三栏，卡片列还在',
        )
      }
      await page.getByTestId('plans-boards').scrollIntoViewIfNeeded()
      await shot(page, `${theme}-5-reddit-plans`)
      // Reddit 职责页的「计划」：排期与群发
      await page.goto(redditDutyUrl, { waitUntil: 'load', timeout: 90_000 })
      await cardsShown(page)
      const dutyProgress = page.getByTestId('plan-row-progress')
      if (
        await dutyProgress
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false)
      ) {
        await dutyProgress.click()
        await page.getByTestId('plans-panel').waitFor({ timeout: 20_000 })
        const boards = await page
          .getByTestId('duty-work-boards')
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false)
        if (theme === 'light') check(boards, 'Reddit 职责页「计划」里是排期与群发')
        await shot(page, `${theme}-6-reddit-duty-plans`)
      } else if (theme === 'light') check(false, 'Reddit 职责页「计划」卡有「进度」一行')
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, { width: 1000, height: 800 })
      await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
      // WP433（Luoye 10-21）：放不下「对话区最小宽度 + 卡片列」时卡片列自动隐藏
      await page.getByTestId('position-page').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(800)
      if (theme === 'light')
        check(
          (await page.getByTestId('rail-board').count()) === 0,
          '窄于 1024：卡片列自动隐藏（不盖、不留开关）',
        )
      await shot(page, `${theme}-7-narrow`)
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      // Windows：模拟壳给的叠加按钮
      {
        const { context, page } = await open(theme, { width: 1440, height: 900 }, 'overlay')
        await page.goto(redditPositionUrl, { waitUntil: 'load', timeout: 90_000 })
        await cardsShown(page)
        await page.evaluate(fakeCaptionButtons, theme)
        if (theme === 'light')
          check(
            (await page.getByTestId('caption-gap').count()) === 1,
            'Windows：右上有隔开系统按钮的细竖线',
          )
        const clip = { x: 760, y: 0, width: 680, height: 52 }
        await shot(page, `${theme}-8-topbar-windows-after`, { clip })
        // 对照：去掉这一截空与竖线（就是改之前挤在一起的样子）
        await page.addStyleTag({ content: '[data-testid="caption-gap"]{display:none!important}' })
        await shot(page, `${theme}-8-topbar-windows-before`, { clip })
        await context.close()
      }
      // Mac：红绿灯在左，右边照旧
      {
        const { context, page } = await open(theme, { width: 1440, height: 900 }, 'inset')
        await page.goto(redditPositionUrl, { waitUntil: 'load', timeout: 90_000 })
        await cardsShown(page)
        await shot(page, `${theme}-9-topbar-mac`, { clip: { x: 0, y: 0, width: 1440, height: 52 } })
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
