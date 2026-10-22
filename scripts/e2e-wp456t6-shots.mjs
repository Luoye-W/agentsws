#!/usr/bin/env node
/**
 * WP456-T6（设置页）：设置弹窗每一节浅 / 深各拍一张（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），按左栏一节一节点过去：
 * - `<prefix>-<theme>-<节>.png`：和示意稿同一个视口（1440×900、2x），只拍弹窗；
 * - `<prefix>-<theme>-<节>-full.png`：把弹窗拉到这一节的全高再拍一张（长的节看得到底）。
 * 顺手查（`--no-check` 只拍不查）：
 * - 弹窗里没有小于 12px 的中文；
 * - 分段切换都是共用那一种（`.ws-seg`）；
 * - 岗位与职责里看不到 `store_main` 这类内部范围 id；
 * - 账号连接：顶上一个搜索框、「已连接」「常用」两节、底下一行「看全部」，服务是列表组里的一行行。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓）。
 *
 * ```
 * npx tsc -b apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp456t6-shots.mjs [--port 4776] [--out <目录>] [--prefix after] [--only connections,positions] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp456-t6'))
const PREFIX = argOf('--prefix') ?? 'after'
const ONLY = argOf('--only')?.split(',')
const PORT = Number(argOf('--port') ?? '4776') || 4776
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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

/** 弹窗里字号小于 12px、又含中文的可见文字。 */
const tinyChinese = (page) =>
  page.evaluate(() => {
    const out = []
    const root = document.querySelector('[data-testid="settings-dialog"]') ?? document.body
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      if (!/[一-鿿]/.test(text)) continue
      const el = n.parentElement
      if (el === null || el.closest('[aria-hidden="true"], svg, .sr-only') !== null) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (Number.parseFloat(style.fontSize) < 12) out.push(text.trim().slice(0, 16))
    }
    return out
  })

/** 「看起来像分段切换」却不是共用那一种的。 */
const strayToggles = (page) =>
  page.evaluate(() => {
    const out = []
    for (const g of document.querySelectorAll('[role="tablist"], fieldset')) {
      const items = g.querySelectorAll(':scope > button[aria-pressed], :scope > button[role="tab"]')
      const shown = g.getClientRects().length > 0
      if (
        shown &&
        items.length >= 2 &&
        !g.classList.contains('ws-seg') &&
        !g.classList.contains('ws-opts')
      )
        out.push(g.getAttribute('data-testid') ?? g.getAttribute('aria-label') ?? g.tagName)
    }
    return out
  })

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
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
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
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/settings/general`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('settings-nav').waitFor({ timeout: 90_000 })
      await page.waitForTimeout(1500)
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="settings-nav-"]')]
          .map((el) => el.getAttribute('data-testid')?.slice('settings-nav-'.length) ?? '')
          .filter((id) => id !== ''),
      )
      for (const id of ids) {
        if (ONLY !== undefined && !ONLY.includes(id)) continue
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto(`${BASE}/settings/${id}`, { waitUntil: 'load', timeout: 90_000 })
        const dialog = page.getByTestId('settings-dialog')
        await dialog.waitFor({ timeout: 90_000 })
        await page.waitForTimeout(2500)
        const tiny = await tinyChinese(page)
        check(
          tiny.length === 0,
          `[${theme}] ${id} 没有小于 12px 的中文${tiny.length > 0 ? `（${tiny.slice(0, 6).join('、')}）` : ''}`,
        )
        const stray = await strayToggles(page)
        check(
          stray.length === 0,
          `[${theme}] ${id} 分段切换都是共用那一种${stray.length > 0 ? `（还有：${stray.join('、')}）` : ''}`,
        )
        if (id === 'positions') {
          const text = (await dialog.textContent()) ?? ''
          check(!/store_main/.test(text), `[${theme}] 岗位与职责里没有 store_main 这类内部 id`)
        }
        if (id === 'connections' && PREFIX !== 'before') {
          check(
            (await page.getByTestId('connections-search').count()) === 1,
            `[${theme}] 账号连接顶上一个搜索框`,
          )
          check(
            (await page.locator('[data-testid="provider-card"].ws-row').count()) > 0,
            `[${theme}] 服务是列表组里的一行行`,
          )
          check(
            (await page.getByTestId('connections-show-all').count()) === 1,
            `[${theme}] 底下一行「看全部」`,
          )
        }
        await dialog.screenshot({ path: join(SHOTS, `${PREFIX}-${theme}-${id}.png`) })
        console.log(`  📷 ${PREFIX}-${theme}-${id}.png`)
        // 两个改得最多的节多拍一张「点开之后」：岗位行点开 +「⋯」；账号连接「看全部」之后
        if (PREFIX !== 'before' && id === 'positions') {
          await page.getByTestId('position-open').first().click()
          await page.getByTestId('position-menu').first().click()
          await page.waitForTimeout(600)
          await dialog.screenshot({ path: join(SHOTS, `${PREFIX}-${theme}-${id}-open.png`) })
          console.log(`  📷 ${PREFIX}-${theme}-${id}-open.png`)
          await page.keyboard.press('Escape')
        }
        if (PREFIX !== 'before' && id === 'connections') {
          await page.getByTestId('connections-show-all').click()
          await page.waitForTimeout(1500)
          await page.getByTestId('connections-show-all').scrollIntoViewIfNeeded()
          await page.waitForTimeout(400)
          await dialog.screenshot({ path: join(SHOTS, `${PREFIX}-${theme}-${id}-all.png`) })
          console.log(`  📷 ${PREFIX}-${theme}-${id}-all.png`)
          await page.getByTestId('settings-pane').evaluate((el) => {
            el.scrollTop = 0
          })
        }
        // 整节：把弹窗拉到这一节的全高再拍一张
        const full = await page.evaluate(() => {
          const pane = document.querySelector('[data-testid="settings-pane"]')
          return pane === null ? 0 : pane.scrollHeight
        })
        if (full > 760) {
          const h = Math.min(full + 80, 6000)
          await page.setViewportSize({ width: 1440, height: h + 80 })
          await page.evaluate((height) => {
            const d = document.querySelector('[data-testid="settings-dialog"]')
            if (d !== null) {
              d.style.height = `${height}px`
              d.style.maxHeight = 'none'
            }
          }, h)
          await page.waitForTimeout(600)
          await dialog.screenshot({ path: join(SHOTS, `${PREFIX}-${theme}-${id}-full.png`) })
          console.log(`  📷 ${PREFIX}-${theme}-${id}-full.png`)
        }
      }
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
