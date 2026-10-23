#!/usr/bin/env node
/**
 * WP437（Luoye 10-21）：三栏口径 + 两种对话框，端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright 查：
 * - 首页：顶上那颗「有什么要我做的？」没了，底部居中一个半透明悬浮的简易对话框；回车进助理、那句话在助理对话里；
 * - 岗位 / 职责 / 事项页：完整对话框（模型 / 思考档 / 快捷按钮）在中栏底部居中、悬浮；滚到底时内容不被它挡；
 * - 看板：宽 / 中 / 窄三档按「核心区最小宽度 600 + 看板」算，放不下就自动隐藏、顶栏出「看一眼」，点了浮出来、点外面收；
 * - 第三栏：开着时把中栏挤窄、看板让位；连核心区都保不住时盖在中栏上。
 * 不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp437-shots.mjs [--port 4636] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp437'))
const PORT = Number(argOf('--port') ?? '4636') || 4636
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

const WIDTHS = {
  wide: { width: 1680, height: 1000 },
  medium: { width: 1280, height: 860 },
  narrow: { width: 1000, height: 800 },
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
    const me = await call('GET', '/v1/me', undefined, owner)
    const asg = me.assignments.find(
      (a) => !a.role_id.startsWith('common.') && a.revoked_at === undefined,
    )
    const { matter } = await call(
      'POST',
      '/v1/matters',
      { kind: 'adhoc', title: '整理这周的退款原因' },
      owner,
      asg.id,
    )

    const open = async (theme, viewport, chrome) => {
      const context = await browser.newContext({ viewport, colorScheme: theme })
      await context.addInitScript(
        ([t, th, c]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
          if (c !== null) window.agentsws = { titleBar: { style: c, setTheme: async () => true } }
        },
        [owner, theme, chrome ?? null],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const visible = (locator, timeout = 20_000) =>
      locator
        .first()
        .waitFor({ timeout })
        .then(() => true)
        .catch(() => false)
    /** 对话框贴在窗口底部（下沿离窗口底不到 40px）、在中栏内容区里居中。 */
    const docked = async (page, testId) => {
      const dock = page.getByTestId(testId)
      if (!(await visible(dock))) return { ok: false, why: '没找到' }
      const form = dock.locator('form').first()
      const box = await form.boundingBox()
      const main = await page.locator('main').boundingBox()
      const vh = page.viewportSize().height
      if (box === null || main === null) return { ok: false, why: '量不到' }
      const bottomGap = vh - (box.y + box.height)
      const centerOff = Math.abs(box.x + box.width / 2 - (main.x + main.width / 2))
      return {
        ok: bottomGap >= 0 && bottomGap < 40 && centerOff < 24,
        why: `下沿离窗口底 ${Math.round(bottomGap)}px，离中栏中线 ${Math.round(centerOff)}px`,
      }
    }
    /** 滚到底：内容最后一块的下沿在对话框上沿之上（没被挡）。 */
    const notHidden = async (page, testId, lastSelector) => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(400)
      const form = await page.getByTestId(testId).locator('form').first().boundingBox()
      const last = await page.locator(lastSelector).last().boundingBox()
      if (form === null || last === null) return true
      return last.y + last.height <= form.y + 1
    }

    const homeUrl = `${BASE}/`
    const positionUrl = `${BASE}/positions/${asg.id}`
    const dutyUrl = `${BASE}/positions/${asg.id}/duties/${asg.role_id}`
    const matterUrl = `${BASE}/matters/${matter.id}`

    // ── 端到端检查（浅色，宽 / 中 / 窄） ──
    {
      const { context, page } = await open('light', WIDTHS.medium)
      await page.goto(homeUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('home').waitFor({ timeout: 30_000 })
      check(
        (await page.getByTestId('home-free-chat').count()) === 0,
        '首页顶上那颗「有什么要我做的？」没了',
      )
      const home = await docked(page, 'home-composer')
      check(home.ok, `首页：简易对话框在底部居中（${home.why}）`)
      const glass = await page
        .getByTestId('simple-composer')
        .evaluate((el) => getComputedStyle(el).backdropFilter)
      check(glass.includes('blur'), `首页：简易对话框半透明 + 毛玻璃（backdrop-filter: ${glass}）`)
      check(
        (await page.getByTestId('home-composer').locator('[data-testid^="model-pick"]').count()) ===
          0,
        '首页：简易对话框没有模型 / 思考档',
      )
      await page.getByTestId('simple-composer-input').fill('今天有几张卡等我？')
      await page.getByTestId('simple-composer-input').press('Enter')
      await page.waitForURL(/\/assistant/, { timeout: 20_000 })
      check(
        await visible(page.getByText('今天有几张卡等我？')),
        '首页回车：进「我的助理」，那句话在对话里',
      )

      await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('position-page').waitFor({ timeout: 30_000 })
      const pos = await docked(page, 'position-handoff')
      check(pos.ok, `岗位页：完整对话框在中栏底部居中（${pos.why}）`)
      check(
        (await page
          .getByTestId('position-handoff')
          .locator('[data-testid^="model-pick"]')
          .count()) >= 1,
        '岗位页：完整对话框带模型 / 思考档',
      )
      check(
        await notHidden(page, 'position-handoff', '[data-testid="position-deck"]'),
        '岗位页：滚到底，「要你拍板」的卡不被对话框挡',
      )
      await page.goto(dutyUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('duty-page').waitFor({ timeout: 30_000 })
      const duty = await docked(page, 'position-handoff')
      check(duty.ok, `职责页：完整对话框在中栏底部居中（${duty.why}）`)
      await page.goto(matterUrl, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('matter').waitFor({ timeout: 30_000 })
      const mat = await docked(page, 'matter-dock')
      check(mat.ok, `事项页：完整对话框在中栏底部居中（${mat.why}）`)
      await context.close()

      for (const [name, viewport] of Object.entries(WIDTHS)) {
        const { context, page } = await open('light', viewport)
        await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('position-page').waitFor({ timeout: 30_000 })
        await page.waitForTimeout(800)
        const board = (await page.getByTestId('rail-board').count()) === 1
        const peek = (await page.getByTestId('board-peek').count()) === 1
        const want = name !== 'narrow'
        check(
          board === want && peek === !want,
          `${name}（${viewport.width}）第三栏收着：看板${want ? '在' : '自动隐藏、顶栏出「看一眼」'}`,
        )
        await page
          .getByTestId('rail-icon-browser')
          .click()
          .catch(async () => {
            await page.getByTestId('rail-overflow').click()
            await page.getByTestId('rail-menu-browser').click()
          })
        const frame = page.getByTestId('rail-panel-frame')
        await frame.waitFor({ timeout: 20_000 })
        await page.waitForTimeout(500)
        const layout = await frame.getAttribute('data-layout')
        const boardOpen = (await page.getByTestId('rail-board').count()) === 1
        // WP481（决策 1632）：浏览器里第三栏一律是盖在中栏上的浮层，看板不让位（收着时在就还在）
        const expect = {
          wide: { layout: 'overlay', board: true },
          medium: { layout: 'overlay', board: true },
          narrow: { layout: 'overlay', board: false },
        }[name]
        check(
          layout === expect.layout && boardOpen === expect.board,
          `${name}（${viewport.width}）第三栏开着：${expect.layout === 'docked' ? '并排' : '盖在中栏上'}，看板${expect.board ? '还在' : '自动隐藏'}`,
        )
        if (name === 'narrow') {
          await page.keyboard.press('Escape')
          await page.waitForTimeout(300)
          await page.getByTestId('board-peek').click()
          check(await visible(page.getByTestId('rail-board-peek')), '看一眼：看板浮在内容上')
          await page.mouse.click(200, 400)
          await page.waitForTimeout(300)
          check((await page.getByTestId('rail-board-peek').count()) === 0, '看一眼：点外面收回')
        }
        await context.close()
      }
    }

    // ── 截图 ──
    for (const theme of ['light', 'dark']) {
      for (const [name, viewport] of Object.entries(WIDTHS)) {
        const { context, page } = await open(theme, viewport)
        await page.goto(homeUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('home-composer').waitFor({ timeout: 30_000 })
        await shot(page, `${theme}-${name}-1-home`)
        await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('position-handoff').waitFor({ timeout: 30_000 })
        await shot(page, `${theme}-${name}-2-position`)
        // 第三栏开着
        await page
          .getByTestId('rail-icon-browser')
          .click()
          .catch(async () => {
            await page.getByTestId('rail-overflow').click()
            await page.getByTestId('rail-menu-browser').click()
          })
        await page.getByTestId('rail-panel-frame').waitFor({ timeout: 20_000 })
        await shot(page, `${theme}-${name}-3-position-third-open`)
        if ((await page.getByTestId('board-peek').count()) === 1) {
          await page.getByTestId('board-peek').click()
          await page.getByTestId('rail-board-peek').waitFor({ timeout: 20_000 })
          await shot(page, `${theme}-${name}-4-board-peek`)
          await page.keyboard.press('Escape')
        }
        await page.getByTestId('rail-panel-close').click()
        if (name === 'wide') {
          await page.goto(dutyUrl, { waitUntil: 'load', timeout: 90_000 })
          await page.getByTestId('position-handoff').waitFor({ timeout: 30_000 })
          await shot(page, `${theme}-${name}-5-duty`)
          await page.goto(matterUrl, { waitUntil: 'load', timeout: 90_000 })
          await page.getByTestId('matter-dock').waitFor({ timeout: 30_000 })
          await shot(page, `${theme}-${name}-6-matter`)
          // 滚动中：内容从对话框后面滚过去
          await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
          await page.getByTestId('position-handoff').waitFor({ timeout: 30_000 })
          await page.waitForTimeout(1200)
          await page.evaluate(() => window.scrollTo(0, 220))
          await shot(page, `${theme}-${name}-7-position-scrolled`)
        }
        await context.close()
      }
      // Windows（模拟叠加系统按钮）与 Mac（红绿灯）各一张首页
      for (const chrome of ['overlay', 'inset']) {
        const { context, page } = await open(theme, WIDTHS.medium, chrome)
        await page.goto(homeUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('home-composer').waitFor({ timeout: 30_000 })
        if (chrome === 'overlay') await page.evaluate(fakeCaptionButtons, theme)
        await shot(page, `${theme}-8-home-${chrome === 'overlay' ? 'windows' : 'mac'}`)
        await page.goto(positionUrl, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('position-handoff').waitFor({ timeout: 30_000 })
        if (chrome === 'overlay') await page.evaluate(fakeCaptionButtons, theme)
        await shot(page, `${theme}-9-position-${chrome === 'overlay' ? 'windows' : 'mac'}`)
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
