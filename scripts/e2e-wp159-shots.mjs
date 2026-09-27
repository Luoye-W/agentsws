#!/usr/bin/env node
/**
 * WP159：知识库页「违规宣称规则」（按市场分组、每条带官方出处）的截图，可重跑。
 *
 * 起一个 demo（不联网），拍两张到 `docs/assets/wp159/`：
 *
 * 1. `claim-rules.png`：按市场分组的规则表（默认按美国开：通用 + 美国，其余组灰着）；
 * 2. `claim-rules-eu-on.png`：手动打开「欧盟 / 英国」、关掉一条之后（标「手动」「改过」）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp159-shots.mjs [--port 4449]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp159')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4449'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

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

async function patch(token, assignment, input) {
  const res = await fetch(`${BASE}/v1/knowledge/claim-rules`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Assignment': assignment,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`改规则表没成：${res.status} ${await res.text()}`)
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
    const assignment = await ownerAssignment(token)
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

    await page.goto(`${BASE}/knowledge`, { waitUntil: 'networkidle' })
    const section = page.locator('[data-testid="knowledge-claim-rules"]')
    await section.waitFor()
    await section.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await section.screenshot({ path: join(SHOTS, 'claim-rules.png') })
    console.log('  📷 claim-rules.png')

    await patch(token, assignment, { group: { id: 'eu_uk', enabled: true } })
    await patch(token, assignment, { rule: { id: 'eu.misleading', enabled: false } })
    await page.reload({ waitUntil: 'networkidle' })
    const eu = page.locator('[data-testid="claim-group-eu_uk"]')
    await eu.waitFor()
    await eu.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await eu.screenshot({ path: join(SHOTS, 'claim-rules-eu-on.png') })
    console.log('  📷 claim-rules-eu-on.png')
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
