#!/usr/bin/env node
/**
 * WP442（docs/108 §5.3）：回信跟进——催促卡 + 规则清单「系统规则」那一行，端到端走一遍 + 截图，可重跑
 * （不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。demo 种了一封 6 天前发给买家、
 * 对方一直没回的样品报价，种完巡检一轮 → 有一张「Sophie Laurent 还没回」的催促卡。用 Playwright 查：
 * 卡片页上是催促卡（你哪天发的、草稿、「发出」「修改」在卡身里、底下「再等等」「不用跟了」）；
 * 消息页右栏「规则」里有「发出 3 个工作日没回 → 提醒我」。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓）：card-light / card-dark / card-edit-light /
 * rule-light / rule-dark。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp442-shots.mjs [--port 4712] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(tmpdir(), 'agentsws-wp442-shots'))
const PORT = Number(argOf('--port') ?? '4712') || 4712
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
    // 周三：6 天前（上周四）发的那封已经过了 3 个工作日
    now: Date.parse('2026-10-28T03:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const brand = await demo.server.brands.forWorkspace(demo.server.brands.bootstrap)
    const rows = brand.followUp?.rows() ?? []
    const card_id = rows.find((r) => r.follow_up.state === 'carded')?.follow_up.card_id
    check(typeof card_id === 'string', `种完巡检一轮就出了催促卡（${card_id}）`)

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
    const shot = async (page, name) => {
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      // 卡片页（首页「要你定」/ 消息页「等对方回」点进来是同一个样子）
      await page.goto(`${BASE}/cards/${encodeURIComponent(card_id ?? '')}`, {
        waitUntil: 'load',
        timeout: 90_000,
      })
      const card = page.getByTestId('deck-follow-up').first()
      await card.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await card.count()) > 0, `${theme}：卡片页是催促卡`)
      if ((await card.count()) > 0) {
        const meta = await page.getByTestId('follow-up-meta').first().innerText()
        check(/发的/.test(meta), `${theme}：灰字「${meta}」`)
        const draft = await page.getByTestId('follow-up-draft').first().innerText()
        check(/^Hi Sophie,/.test(draft), `${theme}：草稿按对方语言（英文）写、称呼名字`)
        const bar = await page.getByTestId('deck-action-bar').first().innerText()
        check(
          bar.includes('再等等') && bar.includes('不用跟了') && !bar.includes('发送'),
          `${theme}：卡底那排是「${bar.replace(/\s+/g, ' / ')}」`,
        )
        await card.scrollIntoViewIfNeeded()
        await shot(page, `card-${theme}`)
        if (theme === 'light') {
          await page.getByTestId('follow-up-edit').first().click()
          await page.getByTestId('follow-up-text').first().waitFor({ timeout: 10_000 })
          check(true, '点「修改」就地改字')
          await shot(page, 'card-edit-light')
        }
      }

      // 消息页右栏「规则」：系统规则那一行
      await page.goto(`${BASE}/messages?panel=rules`, { waitUntil: 'load', timeout: 90_000 })
      const rule = page.getByTestId('follow-up-rule-row')
      await rule.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await rule.count()) === 1, `${theme}：规则清单里有「系统规则」那一行`)
      if ((await rule.count()) === 1) {
        const label = await page.getByTestId('follow-up-rule-label').innerText()
        check(label.includes('发出 3 个工作日没回 → 提醒我'), `${theme}：「${label}」`)
        const per = page.getByTestId('follow-up-rule-per-account')
        check((await per.count()) === 1, `${theme}：有「按邮箱分开设」`)
        if ((await per.count()) === 1) {
          await per.click()
          await page.getByTestId('follow-up-rule-accounts').waitFor({ timeout: 10_000 })
        }
        await shot(page, `rule-${theme}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
  console.log('WP442 截图走完')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
