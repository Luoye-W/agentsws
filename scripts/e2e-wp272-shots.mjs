#!/usr/bin/env node
/**
 * WP272：Shopify 卡不再内嵌工坊账号登录、补权限全自动——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；云是 demo 的替身（`.invalid` 域，不出网、不碰真店）。
 * 账号页两张是真的（没登录 / 替身账号登录之后带 relogin=1）；Shopify 卡几种状态在浏览器里改写
 * `GET /v1/shopify-connect` 的回包造出来（各状态的逻辑由单测钉住）：
 * 1 没登录（一句话 +「去登录」，卡里没有表单）；2 点「去登录」落到设置 → 账号（带 return）；
 * 3 后台补签也没成（「工坊账号需要重新登录」）；4 账号页 relogin=1（表单只在这里）；
 * 5 连不上（问号里原因码）；6 补签成了 = 卡上直接能连。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp272-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp272')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4399') || 4399
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

const SHOP = '6suegp-md.myshopify.com'
const IDLE = {
  linked: true,
  email: 'demo@example.com',
  connections: [],
  suggested_shop: SHOP,
  candidates: [{ shop: SHOP, source: 'profile' }],
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
    const session = (
      await post('/v1/auth/verify', {
        token: (await post('/v1/auth/magic-link', { email: OWNER })).data.token,
      })
    ).data.session_token
    const me = await api(session, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [session],
    )
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    let view = IDLE
    let mock = true
    await page.route(/\/v1\/shopify-connect(\?.*)?$/, async (route) => {
      if (!mock) return route.continue()
      return route.fulfill({ status: 200, json: { data: view, trace_id: 'tr_shot' } })
    })

    const card = page.locator('[data-testid="provider-card"][data-service="shopify_admin"]')
    const shotCard = async (name) => {
      await page.waitForTimeout(400)
      await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const account = page.locator('[data-testid="cloud-account"]')
    const shotAccount = async (name) => {
      await page.waitForTimeout(400)
      await account.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(
        `  📷 ${name}.png（${new URL(page.url()).pathname}${new URL(page.url()).search}）`,
      )
    }
    const load = async (v) => {
      view = v
      await page.goto(`${BASE}/connections?service=shopify_admin`, { waitUntil: 'networkidle' })
      await card.waitFor({ timeout: 30_000 })
      await page.locator('[data-testid="shopconnect"]').waitFor({ timeout: 30_000 })
    }

    // 1 + 2：没登录 → 「去登录」→ 设置 → 账号（真的，demo 还没登录工坊账号）
    await load({
      linked: false,
      blocked: { reason: 'not_linked', message: 'x' },
      connections: [],
      candidates: [],
    })
    if ((await card.locator('input[type="password"], [data-testid$="-auth"]').count()) > 0)
      throw new Error('卡里还有登录表单')
    await shotCard('1-not-linked')
    await page.click('[data-testid="shopconnect-login"]')
    await account.locator('[data-testid="cloud-account-unlinked"]').waitFor({ timeout: 30_000 })
    await shotAccount('2-account-page-login')

    // 3：后台补签也没成
    await load({ ...IDLE, blocked: { reason: 'scope_missing', message: 'x' } })
    await shotCard('3-relogin-needed')

    // 4：替身账号真登录之后，从卡上「去重新登录」→ 账号页摊开登录表单（relogin=1）
    await api(session, owner, 'POST', '/v1/cloud/account/password-login', {
      email: 'demo@example.com',
      password: 'demo-pass-2026',
    })
    await load({ ...IDLE, blocked: { reason: 'scope_missing', message: 'x' } })
    await page.click('[data-testid="shopconnect-relogin"]')
    await account.locator('[data-testid="cloud-account-relogin-auth"]').waitFor({ timeout: 30_000 })
    await shotAccount('4-account-page-relogin')

    // 5：连不上（自动重试过一次）——问号里原因码
    await load({
      ...IDLE,
      blocked: { reason: 'offline', message: 'x', cause_code: 'ENOTFOUND' },
    })
    await page.hover('[data-testid="shopconnect-offline-hint"]')
    await page.waitForTimeout(600)
    const box = await card.boundingBox()
    await page.screenshot({
      path: join(SHOTS, '5-offline-cause.png'),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height + 90 },
    })
    console.log('  📷 5-offline-cause.png')

    // 6：真的卡（不改写）：替身云 + 刚登录的账号 → 卡上直接是「连接 Shopify」
    mock = false
    await page.goto(`${BASE}/connections?service=shopify_admin`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="shopconnect"]').waitFor({ timeout: 30_000 })
    console.log(
      `  真卡状态：${await page.locator('[data-testid="shopconnect"]').getAttribute('data-state')}`,
    )
    await shotCard('6-ready-to-connect')
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
