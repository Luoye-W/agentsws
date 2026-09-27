#!/usr/bin/env node
/**
 * WP158（Search Console / GA4 真读数）：截图的可重跑出处。存到 `docs/assets/wp158/*.png`。
 *
 * `gsc-pick-site.png`：「内容与搜索」职责页上那张「选一下是哪个站点」的小卡；
 * 之后替它选一个，断言小卡收起（不另外截图）。
 *
 * **不联网、不用真账号**：demo 里 Search Console 读数层配的是替身连接器（`apps/cli/src/demo-google.ts`），
 * 两个站点属性、合成那一周的查询词。用李默（持有「内容与搜索」）登录。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-gsc-ga4-shots.mjs [--port 4448]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp158')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4448'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'li@nordvolt.example'

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
    // `/v1/me` 带着这个人名下的分配；「内容与搜索」那一条就是职责页要的 assignment
    const me = await (
      await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()
    const content = (me.data?.assignments ?? []).find(
      (a) => a.role_id === 'dtc.content' && a.revoked_at === undefined,
    )
    if (content === undefined)
      throw new Error(`李默名下没有「内容与搜索」：${JSON.stringify(me).slice(0, 300)}`)
    // 职责页挂在岗位下面：岗位 id = 这条分配所在的岗位（demo 里岗位与分配同 id 时直接用它）
    const positionId = content.position_id ?? content.id
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const p = await context.newPage()
    p.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const duty = `/positions/${encodeURIComponent(positionId)}/duties/dtc.content`
    await p.goto(`${BASE}${duty}`, { waitUntil: 'networkidle' })
    const card = p.locator('[data-testid="google-source-picker-gsc"]')
    await card.waitFor({ timeout: 20_000 })
    await p.waitForTimeout(400)
    await card.screenshot({ path: join(SHOTS, 'gsc-pick-site.png') })
    console.log('  📷 gsc-pick-site.png')
    await p.selectOption('[data-testid="google-source-gsc"]', 'sc-domain:nordvolt.example')
    await p.getByRole('button', { name: '就用这个' }).click()
    await card.waitFor({ state: 'detached', timeout: 20_000 })
    console.log('  ✓ 选好之后小卡收起')
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
