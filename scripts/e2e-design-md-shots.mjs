#!/usr/bin/env node
/**
 * WP122b（71 §4 / 交付 ⑦）：设计规范三张截图的可重跑出处。
 *
 * `docs/assets/workstation/design-md-{empty,tokens,source}.png` 不是手拍的——
 * 这个脚本起一个 demo（不联网），用真浏览器拍三张：
 *
 * 1. `design-md-empty`：还没抓过时空态与两条来路入口；
 * 2. `design-md-tokens`：可视化令牌，**含小铅笔**（改一格那一跳的入口）；
 * 3. `design-md-source`：色块上悬停出的**出处 tooltip**（"凭什么说这是主色"）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-design-md-shots.mjs [--port 4408]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4408'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

/** 种进去的那份 DESIGN.md（走整份替换的口，与用户粘贴同一条路）。 */
const DESIGN_MD = `---
version: alpha
name: Heritage Supply
colors:
  primary: "#0a7d33"
  secondary: "#b8422e"
  surface: "#f7f5f2"
  on-surface: "#1a1c1e"
typography:
  h1:
    fontFamily: Inter
    fontSize: 40px
  body-md:
    fontFamily: Inter
    fontSize: 16px
rounded:
  md: 8px
spacing:
  md: 16px
  lg: 24px
---

## Overview

Heritage Supply 的视觉基调来自工坊木作与纸张的质感。
`

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
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

async function ownerAssignment(token) {
  const me = await (
    await fetch(`${BASE}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()
  const mine = (me.data?.assignments ?? []).filter((a) => a.revoked_at === undefined)
  const owner = mine.find((a) => a.role_id === 'common.owner') ?? mine[0]
  if (owner === undefined) throw new Error('owner 的分配没找到')
  return owner.id
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const assignment = await ownerAssignment(token)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ① 空态
    await page.goto(`${BASE}/brand-design`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="design-md-empty"]')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'design-md-empty.png') })
    console.log('  📷 design-md-empty.png')

    // 种一份 DESIGN.md（走整份替换的口；demo 是内存库，不落数据）
    const put = await fetch(`${BASE}/v1/brand-design`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Assignment': assignment,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ markdown: DESIGN_MD }),
    })
    if (!put.ok) throw new Error(`种 DESIGN.md 没成：${put.status} ${await put.text()}`)

    // ② 可视化（含小铅笔）
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="design-md-tokens"]')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'design-md-tokens.png') })
    console.log('  📷 design-md-tokens.png')

    // ③ 出处 tooltip：悬停主色色块
    await page.hover('[data-testid="design-md-color-primary"] > div > div')
    await page.waitForSelector('[data-radix-popper-content-wrapper]')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, 'design-md-source.png') })
    console.log('  📷 design-md-source.png')
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
