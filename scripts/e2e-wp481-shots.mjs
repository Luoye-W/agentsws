#!/usr/bin/env node
/**
 * WP481（决策 1632 / 1634）：右栏不挤中栏、左栏收窄、左下角整理——浅 / 深各拍一套（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。顺手查几件事：
 * - **桌面壳加宽**：假装是桌面壳（桥上给一个 `sidePane`，壳那边用「把视口加宽」模拟窗口向右加宽）——
 *   日历与待办页开教程：窗口宽了右栏那么宽、右栏并排、中栏（`main`）宽度和开之前一样；关掉窗口缩回原宽；
 * - **最大化 / 放不下**：壳回 `overlay` → 右栏是浮层，中栏宽度不变；
 * - **浏览器里**（没有 `sidePane`）：一律浮层，中栏宽度不变；
 * - 左栏展开宽 208；左下角名字下面没有「default」、没有单独的「反馈」按钮，个人菜单里有「反馈」「我的反馈」。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<序号>-<什么>.png`。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp481-shots.mjs --port 4888 --out <目录> [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp481'))
const PORT = Number(argOf('--port') ?? '4888') || 4888
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const WIDTH = 1280
const HEIGHT = 840

async function call(method, path, body, token, asg) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
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

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

const shot = async (page, theme, name, opts = {}) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`), ...opts })
  console.log(`  📷 ${theme}-${name}.png`)
}

/** 中栏（外壳的 main）有多宽。 */
const mainWidth = (page) =>
  page.evaluate(() =>
    Math.round(document.querySelector('main')?.getBoundingClientRect().width ?? 0),
  )

/**
 * WP485：中栏里一块「空白处」（不是按钮、链接、输入框，鼠标不是小手，也不在第三栏里）的坐标；找不到回 `null`。
 */
const blankPoint = (page) =>
  page.evaluate(() => {
    const main = document.querySelector('main')
    const frame = document.querySelector('[data-testid="rail-panel-frame"]')
    if (main === null) return null
    const box = main.getBoundingClientRect()
    const right =
      frame === null ? box.right : Math.min(box.right, frame.getBoundingClientRect().left)
    const hit =
      'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [contenteditable="true"], .cursor-pointer'
    for (let y = box.top + 24; y < Math.min(box.bottom, innerHeight) - 8; y += 24) {
      for (let x = box.left + 16; x < right - 8; x += 24) {
        const el = document.elementFromPoint(x, y)
        if (el === null || !main.contains(el)) continue
        if (el.closest(hit) !== null || getComputedStyle(el).cursor === 'pointer') continue
        return { x, y }
      }
    }
    return null
  })

const frameLayout = (page) =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid="rail-panel-frame"]')?.getAttribute('data-layout') ?? '',
  )

/** 开教程（右上「⋮」→ 教程）。 */
async function openHelp(page) {
  await page.getByTestId('rail-overflow').click()
  await page.getByTestId('rail-menu-help').click()
  await page.getByTestId('rail-panel-frame').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(900)
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
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner')?.id
    const positions = await call('GET', '/v1/positions', undefined, owner, ownerAsg)
    const support = (positions.instances ?? []).find((i) => i.name?.zh === '客服')
    const supportAsg = support?.roles?.map((r) => r.my_assignment_id).find((x) => x !== undefined)

    /**
     * `shell`：`browser` = 普通浏览器（桥上没有 sidePane）；`desktop` = 桌面壳、右边有地方（视口加宽模拟窗口加宽）；
     * `maximized` = 桌面壳但窗口最大化 / 右边没地方（壳回 overlay）。
     */
    const open = async (theme, shell) => {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      const state = { base: WIDTH, calls: [] }
      let page
      await context.exposeBinding('__wp481SidePane', async (_source, width) => {
        state.calls.push(width)
        if (shell === 'maximized') return width === null ? 'none' : 'overlay'
        await page.setViewportSize({
          width: width === null ? state.base : state.base + width,
          height: HEIGHT,
        })
        return width === null ? 'none' : 'widened'
      })
      await context.addInitScript(
        ([t, th, desktop]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
          if (desktop)
            window.agentsws = {
              platform: 'darwin',
              version: 'e2e',
              sidePane: { sync: (w) => window.__wp481SidePane(w) },
            }
        },
        [owner, theme, shell !== 'browser'],
      )
      page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page, state }
    }

    for (const theme of ['light', 'dark']) {
      // ① 桌面壳、右边有地方：日历与待办 + 教程 → 窗口向右加宽
      {
        const { context, page, state } = await open(theme, 'desktop')
        await page.goto(`${BASE}/planner`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('sidebar').waitFor({ timeout: 60_000 })
        await page.waitForTimeout(1500)
        const before = await mainWidth(page)
        await shot(page, theme, '1-calendar')
        await openHelp(page)
        const after = await mainWidth(page)
        const vw = await page.evaluate(() => window.innerWidth)
        check(
          state.calls.includes(380) && vw === WIDTH + 380,
          `[${theme}] 桌面壳开教程：请壳加宽 380，窗口 ${WIDTH} → ${vw}`,
        )
        check((await frameLayout(page)) === 'docked', `[${theme}] 窗口加宽后右栏并排`)
        check(after === before, `[${theme}] 中栏宽度不变（开之前 ${before}，开之后 ${after}）`)
        await shot(page, theme, '2-calendar-help-widened')
        await page.getByTestId('rail-panel-close').click()
        await page.waitForTimeout(800)
        const back = await page.evaluate(() => window.innerWidth)
        check(back === WIDTH, `[${theme}] 关掉教程窗口缩回 ${WIDTH}（现在 ${back}）`)
        check((await mainWidth(page)) === before, `[${theme}] 关掉后中栏宽度还是 ${before}`)
        await context.close()
      }
      // ② 桌面壳、窗口最大化 / 右边没地方：浮层
      {
        const { context, page } = await open(theme, 'maximized')
        await page.goto(`${BASE}/planner`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('sidebar').waitFor({ timeout: 60_000 })
        await page.waitForTimeout(1500)
        const before = await mainWidth(page)
        await openHelp(page)
        check((await frameLayout(page)) === 'overlay', `[${theme}] 最大化时右栏是浮层`)
        check(
          (await mainWidth(page)) === before,
          `[${theme}] 浮层不挤中栏（${before} → ${await mainWidth(page)}）`,
        )
        await shot(page, theme, '3-calendar-help-overlay')
        await page.keyboard.press('Escape')
        await page.waitForTimeout(600)
        check(
          (await page.getByTestId('rail-panel-frame').count()) === 0,
          `[${theme}] 浮层按 Esc 收起`,
        )
        await context.close()
      }
      // ③ 浏览器里：岗位页（有看板）开浏览器 → 浮层，看板不让位
      if (supportAsg !== undefined) {
        const { context, page } = await open(theme, 'browser')
        await page.goto(`${BASE}/positions/${supportAsg}`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('position-page').waitFor({ timeout: 60_000 })
        await page.waitForTimeout(1500)
        const before = await mainWidth(page)
        const boardBefore = await page.getByTestId('rail-board').count()
        await page.getByTestId('rail-icon-browser').click()
        await page.getByTestId('rail-panel-frame').waitFor({ timeout: 20_000 })
        await page.waitForTimeout(900)
        check((await frameLayout(page)) === 'overlay', `[${theme}] 浏览器里右栏一律浮层`)
        check(
          (await mainWidth(page)) === before &&
            (await page.getByTestId('rail-board').count()) === boardBefore,
          `[${theme}] 浏览器里开右栏：中栏 ${before} 不变、看板不让位`,
        )
        await shot(page, theme, '4-position-browser-overlay')
        // WP485（决策 1672）：中栏没有遮罩挡着——点中栏里的普通按钮照常生效、浮层不收；点空白处才收
        check(
          (await page.getByTestId('rail-scrim').count()) === 0,
          `[${theme}] 浮层下中栏不被遮罩挡住`,
        )
        const plain = await blankPoint(page)
        check(plain !== null, `[${theme}] 中栏找得到一块空白处`)
        if (plain !== null) {
          await page.mouse.click(plain.x, plain.y)
          await page.waitForTimeout(600)
        }
        check(
          (await page.getByTestId('rail-panel-frame').count()) === 0,
          `[${theme}] 点中栏空白处浮层收起`,
        )
        // ④ 左栏新宽度（208）+ 左下角
        const side = await page.evaluate(() =>
          Math.round(
            document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width ?? 0,
          ),
        )
        check(side === 208, `[${theme}] 左栏展开宽 208（现在 ${side}）`)
        const bottom = await page.getByTestId('rail-bottom').innerText()
        check(!/default/i.test(bottom), `[${theme}] 左下角没有「default」`)
        check(
          (await page.getByTestId('feedback-button').count()) === 0,
          `[${theme}] 左下角没有单独的「反馈」按钮`,
        )
        await shot(page, theme, '5-sidebar')
        await page.getByTestId('account-toggle').click()
        await page.getByTestId('account-menu').waitFor()
        check(
          (await page.getByTestId('account-feedback').innerText()).includes('反馈') &&
            (await page.getByTestId('account-feedback-mine').innerText()).includes('我的反馈'),
          `[${theme}] 个人菜单里有「反馈」「我的反馈」`,
        )
        await shot(page, theme, '6-account-menu')
        await page.getByTestId('account-feedback').click()
        await page.getByTestId('feedback-send').waitFor({ timeout: 10_000 })
        check(true, `[${theme}] 菜单「反馈」打开反馈框`)
        await context.close()
      }
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
