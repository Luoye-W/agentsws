#!/usr/bin/env node
/**
 * WP144（docs/80）：电脑操控三张截图的可重跑出处。存到 `docs/assets/wp144/`。
 *
 * 1. `settings-computer-use.png`：设置页「电脑操控」——打开总开关、勾一条职责、三步向导，自检结果原样列出；
 * 2. `card-computer-use.png`：牌堆里那张授权卡「让它在接下来 10 分钟操作这台电脑？」（`--card-gallery` 摆拍，
 *    形状与运行时 `request_computer_use` 出的逐字相同）；
 * 3. `tray-computer-use.png`：「正在操作」——工作台右上那一行 + 桌面壳托盘菜单模型（红色图标 + 最上面两行）。
 *
 * **不启动真驱动、不动这台电脑**：demo 没有数据目录，驱动"已装好"、自检结果、正在操作那一次都是
 * **浏览器侧替身**（改的只是那几格响应，别的照走 demo）。托盘那一半是把桌面壳的菜单模型
 * （`apps/desktop/dist/menu.js` 的 `buildTrayMenu`，托盘真用的那一份）照 macOS 菜单的样子画出来——
 * headless 拍不到真的系统托盘。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node scripts/e2e-computer-use-shots.mjs [--port 4436]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp144')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4436'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT), '--card-gallery'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

const UNTIL = new Date(Date.now() + 8 * 60_000).toISOString()

/** 浏览器侧替身：驱动已装好、自检结果、正在操作那一次（demo 没有数据目录，也不许真跑驱动）。 */
async function standIns(page, { active }) {
  await page.route('**/v1/settings/computer-use', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ...json.data,
          driver: {
            installed: true,
            path: '~/Library/Application Support/agentsws/data/computer-use/cua-driver-0.28.0/cua-driver',
            pinned_version: '0.28.0',
            platform_key: 'darwin-arm64',
          },
          ...(active
            ? { active: { run_id: 'run_demo_cu', role_id: 'site.shopify-build', until: UNTIL } }
            : {}),
        },
      }),
    })
  })
  await page.route('**/v1/settings/computer-use/check', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          ran: true,
          ok: false,
          checks: [
            { name: 'accessibility', ok: true, detail: '✅ Accessibility: granted.' },
            {
              name: 'screen_recording',
              ok: false,
              detail: '❌ Screen Recording: NOT granted.',
              fix: '打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，把「Agents 工坊」打开，然后重开 Agents 工坊。',
            },
          ],
          raw: '✅ Accessibility: granted.\n❌ Screen Recording: NOT granted.',
          detail: '还有权限没给',
        },
      }),
    }),
  )
  await page.route('**/v1/computer-use/active', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: active
          ? { active: { run_id: 'run_demo_cu', role_id: 'site.shopify-build', until: UNTIL } }
          : {},
      }),
    }),
  )
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { buildTrayMenu } = await import(
    pathToFileURL(join(ROOT, 'apps/desktop/dist/menu.js')).href
  )
  const { TRAY_ICON_ACTIVE_2X_DATA_URL } = await import(
    pathToFileURL(join(ROOT, 'apps/desktop/dist/tray-icon.js')).href
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 设置页：打开总开关 → 勾一条职责 → 自检
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await standIns(page, { active: false })
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="settings-computer-use"]')
    await card.waitFor()
    await card.scrollIntoViewIfNeeded()
    if ((await card.getAttribute('data-enabled')) !== 'on') {
      await page.click('[data-testid="computer-use-enable"]')
    }
    await page.waitForSelector('[data-testid="computer-use-wizard"]')
    const role = page.locator('[data-testid^="computer-use-role-site"]').first()
    await role.waitFor()
    if (!(await role.isChecked())) await role.click()
    await page.waitForTimeout(400)
    await page.click('[data-testid="computer-use-check"]')
    await page.waitForSelector('[data-testid="computer-use-checks"]')
    await page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'settings-computer-use.png') })
    console.log('  📷 settings-computer-use.png')

    // ② 牌堆里的授权卡
    const home = await context.newPage()
    home.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await home.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const deck = () => home.locator('[data-testid="deck-card"]').first()
    await deck().waitFor({ timeout: 20_000 })
    const hit = async () =>
      /操作这台电脑/.test(
        await deck()
          .innerText()
          .catch(() => ''),
      )
    for (let i = 0; i < 40 && !(await hit()); i += 1) {
      const next = home.locator('[data-testid="deck-next"]').first()
      if (!(await next.count()) || (await next.isDisabled())) break
      await next.click()
      await home.waitForTimeout(300)
    }
    if (!(await hit())) throw new Error('牌堆里找不到电脑操控那张授权卡')
    await home.waitForTimeout(300)
    await deck().screenshot({ path: join(SHOTS, 'card-computer-use.png') })
    console.log('  📷 card-computer-use.png')

    // ③ 正在操作：工作台右上那一行 + 托盘菜单模型
    const busy = await context.newPage()
    await standIns(busy, { active: true })
    await busy.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await busy.waitForSelector('[data-testid="computer-use-strip"]', { timeout: 20_000 })
    await busy.waitForTimeout(1500)
    const stripPng = await busy
      .locator('[data-testid="computer-use-strip"]')
      .screenshot({ type: 'png' })
    const menu = buildTrayMenu({
      language: 'zh-CN',
      serverUrl: 'http://127.0.0.1:4317',
      version: '0.1.0',
      server: { name: 'server', state: 'running', pid: 1, attempts: 0 },
      health: { ok: true, status: 'ok', version: '0.1.0', halted: false },
      paused: false,
      connect: undefined,
      launchAtLogin: true,
      computerUse: { until: UNTIL },
    })
    const rows = menu
      .map((m) =>
        m.type === 'separator'
          ? '<div class="sep"></div>'
          : `<div class="row ${m.enabled ? '' : 'off'} ${m.id === 'stop-computer-use' ? 'stop' : ''}">${m.label}</div>`,
      )
      .join('')
    const tray = await context.newPage()
    await tray.setViewportSize({ width: 760, height: 520 })
    await tray.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#e9e9ee}
      .bar{height:26px;background:rgba(246,246,246,.95);border-bottom:1px solid #ccc;display:flex;justify-content:flex-end;align-items:center;padding:0 12px;gap:14px}
      .bar img{width:18px;height:18px}
      .wrap{display:flex;gap:24px;padding:16px}
      .menu{width:300px;background:rgba(250,250,250,.98);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:5px 0}
      .row{padding:3px 14px;line-height:20px;color:#111}.row.off{color:#888}.row.stop{color:#c0262d;font-weight:600}
      .sep{height:1px;background:#ddd;margin:5px 0}
      .note{font-size:11px;color:#555;max-width:360px;line-height:1.5}
      .strip{margin-top:8px;border:1px solid #ddd;border-radius:8px;background:#fff;padding:6px}
    </style></head><body>
      <div class="bar"><span style="color:#555">托盘</span><img src="${TRAY_ICON_ACTIVE_2X_DATA_URL}" alt="tray"></div>
      <div class="wrap"><div class="menu">${rows}</div>
      <div><div class="note">左：桌面壳托盘菜单（<code>buildTrayMenu</code> 的输出照 macOS 菜单画出，图标是运行时换上的红色那张）。<br>下：工作台第三栏右上那一行（真页面截图）。</div>
      <div class="strip"><img src="data:image/png;base64,${stripPng.toString('base64')}" style="max-width:360px"></div></div></div>
    </body></html>`)
    await tray.waitForTimeout(200)
    await tray.screenshot({ path: join(SHOTS, 'tray-computer-use.png') })
    console.log('  📷 tray-computer-use.png')
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
