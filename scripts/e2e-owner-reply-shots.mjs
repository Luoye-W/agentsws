#!/usr/bin/env node
/**
 * WP153：真账号冒烟那一问在 demo（stub 运行时）里复现一次的截图出处（可重跑）。
 *
 * 起一个 demo（不联网、不用真账号），用店主身份在「店主 / 负责人」岗位上问：
 * 「帮我看看有哪些岗位和连接，最该先处理哪三件事」，然后拍事项页：
 *
 * 1. `owner-reply.png`：整页——顶部摘要是这件事本身，时间线里的回话有真岗位 / 连接名、
 *    粗体与编号正常显示、没有工具名；
 * 2. `owner-reply-timeline.png`：只拍时间线那一段（看得清粗体与列表）。
 *
 * 同时在终端里打出回话与摘要，并检查：路由落到「工作区所有者」、回话里没有工具名、
 * 没有原样的 `**`（界面上）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-owner-reply-shots.mjs [--port 4442]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp153')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4442'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const ASK = '帮我看看有哪些岗位和连接，最该先处理哪三件事'
const TOOL_NAMES = /list_positions|list_connections|search_policies|get_order|list_orders/

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

async function json(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init)
  const body = await res.json()
  if (body.data === undefined) throw new Error(`${path}：${body.code} ${body.message}`)
  return body.data
}

async function login() {
  const link = await json('/v1/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER }),
  })
  const verified = await json('/v1/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link.token }),
  })
  return verified.session_token
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const auth = { Authorization: `Bearer ${token}` }
    const me = await json('/v1/me', { headers: auth })
    const owner = me.assignments.find((a) => a.role_id === 'common.owner' && !a.revoked_at)
    if (owner === undefined) throw new Error('demo 身份没有店主职责')

    // 在「店主 / 负责人」岗位上问（不点名职责：岗位内路由要把它交给工作区所有者）
    const opened = await json('/v1/positions/owner/matters', {
      method: 'POST',
      headers: { ...auth, 'X-Assignment': owner.id, 'content-type': 'application/json' },
      body: JSON.stringify({ title: ASK }),
    })
    console.log(`  路由：${opened.picked?.role_name}（${opened.reason}）`)
    if (opened.picked?.role_id !== 'common.owner') throw new Error('没有路由到工作区所有者')

    const view = await json(`/v1/matters/${opened.matter.id}`, {
      headers: { ...auth, 'X-Assignment': owner.id },
    })
    const reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    console.log(`  摘要：${view.matter.context.summary}`)
    console.log(`  回话：\n${reply.replace(/^/gm, '    ')}`)
    if (TOOL_NAMES.test(reply)) throw new Error('回话里露了工具名')

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/matters/${opened.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="reply-markdown"]')
    await page.waitForTimeout(400)
    const screenText = await page.locator('[data-testid="matter"]').innerText()
    if (screenText.includes('**')) throw new Error('界面上还有原样的 **')
    if (TOOL_NAMES.test(screenText)) throw new Error('界面上露了工具名')
    await page.screenshot({ path: join(SHOTS, 'owner-reply.png'), fullPage: true })
    console.log('  📷 owner-reply.png')
    await page.locator('[data-testid="reply-markdown"]').screenshot({
      path: join(SHOTS, 'owner-reply-timeline.png'),
    })
    console.log('  📷 owner-reply-timeline.png')
  } finally {
    await browser?.close()
    child.kill()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
