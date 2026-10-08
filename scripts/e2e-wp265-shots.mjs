#!/usr/bin/env node
/**
 * WP265：连接页 Shopify 卡「连接 Shopify」一键授权的截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；云是 demo 的替身（`.invalid` 域，不出网、不碰真店）。
 * 先走一遍**真的**一键授权（替身登录 → 起授权 → 替身 1.5 秒后像店主点了「安装」→ 已连接），
 * 再在浏览器里改写 `GET /v1/shopify-connect*` 的回包造出其余几种状态（各状态的逻辑由单测钉住）：
 * 1 没登录；2 老令牌缺 store（就地重新登录）；3 自动带上店铺域名；4 没有来源（填一格）；
 * 5 等浏览器里点安装；6 已连接（测试连接通了）；7 授权失效 + 缺权限；8 这家店暂不支持；9 「高级」里的老表单。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp265-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp265')
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

const SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_content',
  'write_content',
  'read_online_store_navigation',
  'write_online_store_navigation',
  'read_discounts',
  'write_discounts',
  'read_orders',
  'read_themes',
]
const SHOP = '6suegp-md.myshopify.com'
const IDLE = {
  linked: true,
  email: 'demo@example.com',
  connections: [],
  suggested_shop: SHOP,
  candidates: [{ shop: SHOP, source: 'profile' }],
}
const CONNECTED = {
  ...IDLE,
  candidates: [],
  suggested_shop: undefined,
  connections: [
    {
      shop: SHOP,
      name: 'Rollout',
      app: 'rollout',
      status: 'connected',
      scopes: SCOPES,
      missing_scopes: [],
    },
  ],
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

    // ── 真走一遍：没登录 → 替身账号登录 → 起授权 → 替身「点安装」→ 已连接
    const before = await api(session, owner, 'GET', '/v1/shopify-connect')
    console.log(`  登录前：${before.blocked?.reason}`)
    await api(session, owner, 'POST', '/v1/cloud/account/password-login', {
      email: 'demo@example.com',
      password: 'demo-pass-2026',
    })
    const started = await api(session, owner, 'POST', '/v1/shopify-connect/start', { shop: SHOP })
    console.log(`  起授权：${new URL(started.authorize_url).hostname}`)
    let attempt
    for (let i = 0; i < 20; i += 1) {
      attempt = await api(
        session,
        owner,
        'GET',
        `/v1/shopify-connect/attempts/${started.attempt_id}`,
      )
      if (attempt.status !== 'pending') break
      await new Promise((r) => setTimeout(r, 500))
    }
    const real = await api(session, owner, 'GET', '/v1/shopify-connect')
    console.log(
      `  真流程：${attempt.status}，已连 ${real.connections.map((c) => c.shop).join(',')}`,
    )
    await api(session, owner, 'POST', '/v1/shopify-connect/disconnect', { shop: SHOP })

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
    // 授权页是新标签：一律关掉（替身地址本来也打不开）
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => undefined)
    })
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    let view = IDLE
    let attemptStatus = 'pending'
    let startError
    await page.route(/\/v1\/shopify-connect(\/.*)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url())
      const ok = (data, status = 200) =>
        route.fulfill({ status, json: { data, trace_id: 'tr_shot' } })
      if (url.pathname === '/v1/shopify-connect') return ok(view)
      if (url.pathname === '/v1/shopify-connect/start') {
        if (startError !== undefined)
          return route.fulfill({
            status: 501,
            json: {
              code: 'not_implemented',
              message: startError,
              details: { reason: 'unsupported' },
              trace_id: 'tr',
            },
          })
        return ok(
          {
            attempt_id: 'sha_shot',
            authorize_url: `https://shopify.demo.invalid/admin/oauth/authorize?shop=${SHOP}`,
            shop: SHOP,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
          201,
        )
      }
      if (url.pathname.startsWith('/v1/shopify-connect/attempts/'))
        return ok({ status: attemptStatus, shop: SHOP })
      if (url.pathname === '/v1/shopify-connect/test')
        return ok({
          ok: true,
          shop: SHOP,
          name: 'Rollout',
          domain: SHOP,
          checked_at: new Date().toISOString(),
        })
      return route.continue()
    })

    const card = page.locator('[data-testid="provider-card"][data-service="shopify_admin"]')
    const shot = async (name) => {
      await page.waitForTimeout(400)
      await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const load = async (v) => {
      view = v
      await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
      await card.waitFor({ timeout: 30_000 })
      await page.locator('[data-testid="shopconnect"]').waitFor({ timeout: 30_000 })
    }

    await load({
      linked: false,
      blocked: { reason: 'not_linked', message: 'x' },
      connections: [],
      candidates: [],
    })
    await shot('1-not-linked')
    await load({ ...IDLE, connections: [], blocked: { reason: 'scope_missing', message: 'x' } })
    await page.click('[data-testid="shopconnect-relogin"]')
    await shot('2-scope-missing-relogin')
    await load(IDLE)
    await shot('3-suggested-shop')
    await load({ ...IDLE, suggested_shop: undefined, candidates: [] })
    await shot('4-type-shop')
    await load(IDLE)
    attemptStatus = 'pending'
    await page.click('[data-testid="shopconnect-connect"]')
    await page.locator('[data-testid="shopconnect-waiting"]').waitFor()
    await shot('5-waiting-install')
    view = CONNECTED
    attemptStatus = 'connected'
    await page.locator('[data-testid="shopconnect-row"]').waitFor({ timeout: 10_000 })
    await page.click('[data-testid="shopconnect-test"]')
    await page.locator('[data-testid="shopconnect-test-result"]').waitFor()
    await shot('6-connected-tested')
    await load({
      ...CONNECTED,
      connections: [
        {
          shop: SHOP,
          name: 'Rollout',
          status: 'reauth_required',
          reauth_reason: 'app_uninstalled',
          scopes: SCOPES,
          missing_scopes: ['read_orders'],
        },
      ],
    })
    await shot('7-reauth-missing')
    await load({ ...IDLE, suggested_shop: 'inmoglobal.myshopify.com', candidates: [] })
    startError = '这家店暂不支持一键授权，等公开应用上线。'
    await page.click('[data-testid="shopconnect-connect"]')
    await page.locator('[data-testid="shopconnect-outcome"]').waitFor()
    await shot('8-unsupported')
    startError = undefined
    await load(IDLE)
    await card.locator('[data-testid="provider-advanced-toggle"]').click()
    await card.locator('[data-testid="provider-legacy"]').waitFor()
    await shot('9-advanced-own-app')
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
