#!/usr/bin/env node
/**
 * WP348（决策 887）：配置卡方案先行——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317；stub 运行时、联网搜索是演示替身，一行网都不出），全程不碰任何凭据：
 *
 * 0. 用 API 配一把演示插件令牌，替插件交回一次「只看登着哪个号」（u/NordVolt_Official）——方案里的品牌号只从这里来；
 * 1. 负责人「先设好 Reddit 巡查，再每天看看大家怎么说我们」→ AI 要卡 → 出卡前先查（档案、插件里登着的号、
 *    演示搜索搜到的版块）→ 事项里「Reddit 巡查：我打算这样设」**方案卡（收起）**；
 * 2. 点「改一下」→ 表单展开、预填方案值；
 * 3. 「就这样」存好之后，「把 Reddit 巡查的重点版块改成 …」→ **改设置方案卡**（现值 → 新值）。
 *
 * ```
 * npx tsc -b
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp348-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp348')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4399') || 4399
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
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id

    // ⓪ 演示插件：配对 → 来问一次 → 交回「只看登着哪个号」
    const ORIGIN = 'chrome-extension://wp348demoabcdefghijklmnopabcdef'
    const pairing = await api(token, owner, 'POST', '/v1/extension/pairings', {
      label: 'WP348 演示',
    })
    const redeemed = await (
      await fetch(`${BASE}/v1/extension/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ code: pairing.code }),
      })
    ).json()
    const ext = { authorization: `Bearer ${redeemed.data.token}`, origin: ORIGIN }
    const next = await (
      await fetch(`${BASE}/v1/extension/reddit/next?connected=1`, { headers: ext })
    ).json()
    if (next.data?.job !== undefined) {
      await fetch(`${BASE}/v1/extension/reddit/${next.data.job.id}/result`, {
        method: 'POST',
        headers: { ...ext, 'content-type': 'application/json' },
        body: JSON.stringify({
          outcome: 'done',
          message: '读完了。',
          user: 'NordVolt_Official',
          parts: [],
        }),
      })
      console.log('  演示插件交回了登着的号')
    } else console.log(`  演示插件没领到「看登着哪个号」：${JSON.stringify(next)}`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [token],
    )
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shotOf = async (locator, name) => {
      await page.waitForTimeout(600)
      try {
        await locator.screenshot({
          path: join(SHOTS, `${name}.png`),
          animations: 'disabled',
          timeout: 30_000,
        })
        console.log(`  📷 ${name}.png`)
      } catch (e) {
        await page.screenshot({
          path: join(SHOTS, `${name}.png`),
          animations: 'disabled',
          timeout: 120_000,
        })
        console.log(`  📷 ${name}.png（整页：${String(e).split('\n')[0]}）`)
      }
    }
    const cardOf = async (matter, kind) => {
      for (let i = 0; i < 120; i += 1) {
        const view = await api(token, owner, 'GET', `/v1/matters/${matter}`)
        const ids = view.timeline.map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await api(token, owner, 'GET', `/v1/approvals/${id}`)
          if (card.kind === kind && card.state === 'pending') return card
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      const view = await api(token, owner, 'GET', `/v1/matters/${matter}`)
      console.log(
        `  等不到 ${kind} 卡：\n${view.timeline.map((e) => `  ${e.kind} ${e.text}`).join('\n')}`,
      )
      return undefined
    }
    const ask = (title) =>
      api(token, owner, 'POST', `/v1/positions/${owner}/matters`, {
        title,
        role_id: 'common.owner',
      })
    const cardBox = page.locator('[data-testid="matter-setup-card"]').last()

    // ① 方案卡（收起）
    const a = await ask('先设好 Reddit 巡查，再每天看看大家怎么说我们')
    const plan = await cardOf(a.matter.id, 'setup_request')
    if (plan !== undefined) {
      await page.goto(`${BASE}/matters/${a.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-setup-card"] [data-testid="setup-plan"]', {
        timeout: 30_000,
      })
      await page.locator('[data-testid="setup-plan-steps"] summary').last().click()
      await shotOf(page.locator('main'), '1-reddit-plan-card')
      // ② 改一下：表单展开、预填方案值
      await cardBox.locator('[data-testid="setup-plan-edit"]').click()
      await page.waitForSelector('[data-testid="setup-fields"]', { timeout: 10_000 })
      await shotOf(cardBox, '2-reddit-plan-edit')
      await cardBox.locator('[data-testid="setup-plan-fold"]').click()
      await cardBox.locator('[data-testid="setup-plan-accept"]').click()
      for (let i = 0; i < 80; i += 1) {
        const c = await api(token, owner, 'GET', `/v1/approvals/${plan.id}`)
        if (c.state !== 'pending') break
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    // ③ 已设好再改：我打算改成这样
    const b = await ask('把 Reddit 巡查的重点版块改成 UsbCHardware, anker（每周2次）')
    if ((await cardOf(b.matter.id, 'setup_request')) !== undefined) {
      await page.goto(`${BASE}/matters/${b.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="setup-plan"][data-mode="change"]', {
        timeout: 30_000,
      })
      await shotOf(page.locator('main'), '3-reddit-change-card')
    }
    await context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
