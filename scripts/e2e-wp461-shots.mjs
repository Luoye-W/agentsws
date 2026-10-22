#!/usr/bin/env node
/**
 * WP461（WP456 T1：视觉 token 与基础样式）：改前 / 改后对照截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），浅 / 深各拍一套：
 * 首页、岗位页、设置（通用 + 账号连接）、日历（周）。同时查两件 T1 的事：
 * - 深色下卡片有一圈细边（`--ws-card-edge` 落到了 `.ws-card` 上）；
 * - 页面上没有小于 12px 的中文（Windows 上微软雅黑 11px 会糊）。
 * 不通过就退出码 1；`--no-check` 只拍不查（拍改前那套用）。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），文件名 `<prefix>-<theme>-<页>.png`。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp461-shots.mjs [--port 4692] [--out <目录>] [--prefix after] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp461'))
const PREFIX = argOf('--prefix') ?? 'after'
const PORT = Number(argOf('--port') ?? '4692') || 4692
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

const shot = async (page, theme, name) => {
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, `${PREFIX}-${theme}-${name}.png`) })
  console.log(`  📷 ${PREFIX}-${theme}-${name}.png`)
}

/** 这一屏上字号小于 12px、又含中文的可见文字（取前几条给人看）。 */
const tinyChinese = (page) =>
  page.evaluate(() => {
    const out = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      if (!/[一-鿿]/.test(text)) continue
      const el = n.parentElement
      if (el === null || el.closest('[aria-hidden="true"], svg') !== null) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const size = Number.parseFloat(style.fontSize)
      if (size < 12) out.push(`${size}px「${text.trim().slice(0, 16)}」`)
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
    const me = await call('GET', '/v1/me', undefined, owner)
    const asg = me.assignments.find(
      (a) => !a.role_id.startsWith('common.') && a.revoked_at === undefined,
    )

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

    const pages = [
      {
        name: '1-home',
        url: '/',
        ready: (p) => p.getByTestId('home').waitFor({ timeout: 60_000 }),
      },
      {
        name: '2-position',
        url: `/positions/${asg.id}`,
        ready: (p) => p.getByTestId('top-bar').waitFor({ timeout: 60_000 }),
      },
      {
        name: '3-settings-general',
        url: '/settings/general',
        ready: (p) => p.getByRole('dialog').first().waitFor({ timeout: 60_000 }),
      },
      {
        name: '4-settings-connections',
        url: '/settings/connections',
        ready: (p) => p.getByRole('dialog').first().waitFor({ timeout: 60_000 }),
      },
      {
        name: '5-calendar',
        url: '/calendar',
        ready: (p) => p.locator('.sx__week-grid').waitFor({ timeout: 60_000 }),
      },
    ]

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      for (const target of pages) {
        await page.goto(`${BASE}${target.url}`, { waitUntil: 'load', timeout: 90_000 })
        await target.ready(page)
        await page.waitForTimeout(800)
        const tiny = await tinyChinese(page)
        check(
          tiny.length === 0,
          `[${theme}] ${target.name} 没有小于 12px 的中文${tiny.length > 0 ? `（${tiny.slice(0, 6).join('、')}）` : ''}`,
        )
        if (theme === 'dark' && target.name === '1-home') {
          const edge = await page.evaluate(() => {
            const card = document.querySelector('.ws-card')
            return card === null ? '' : getComputedStyle(card).boxShadow
          })
          check(/inset/.test(edge), `[dark] 卡片有一圈细边（${edge.slice(0, 60)}…）`)
        }
        await shot(page, theme, target.name)
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
