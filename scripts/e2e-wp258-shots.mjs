#!/usr/bin/env node
/**
 * WP258：建站岗位「登录 Shopify 后自动取店铺」截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI 与 `shopify store list` 都是替身
 * （`platformCliStandIn` / `themeCliStandIn({ orgs })`：替身账号下两家店，不跑真 shopify、不碰真店）。
 * 一键装 + 一键登录（替身约 20 秒登好）之后打开岗位页依次拍：
 * 1 好几家店 → 下拉框；2 选了之后留一行「改哪家店」；
 * 3 / 4 一家都没有、没找成——这两张是在浏览器里改写 `GET /v1/site/theme` 回包造的（替身只演两家店那一种），
 * 那两种状态由单测钉住。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp258-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp258')
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

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

async function until(read, ok, ms = 90_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await read()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等不到')
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
    await api(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    let theme = me.assignments.find((a) => a.role_id === 'site.shopify-theme')?.id
    if (theme === undefined)
      theme = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: 'site.shopify-theme',
          ranges: [],
        })
      ).id
    console.log(`  网页模板分配：${theme}`)

    // 一键装 → 一键登录（替身）；登好了服务端自己去找这个账号下的店
    const cliState = () =>
      api(token, theme, 'GET', '/v1/platform-kit').then((v) => v.kit?.cli?.state)
    await api(token, theme, 'POST', '/v1/platform-kit/cli/run', { action: 'install' })
    await until(cliState, (s) => s === 'needs_login')
    await api(token, theme, 'POST', '/v1/platform-kit/cli/run', { action: 'login' })
    await until(cliState, (s) => s === 'ready')
    const view = await until(
      () => api(token, theme, 'GET', '/v1/site/theme'),
      (v) => v.store_lookup !== undefined,
    )
    console.log(`  找到 ${view.store_lookup.stores.length} 家店（${view.store_lookup.status}）`)

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
      [token],
    )
    const page = await context.newPage()
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => undefined)
    })
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const header = async (name) => {
      await page.waitForTimeout(400)
      await page.screenshot({
        path: join(SHOTS, `${name}.png`),
        clip: { x: 0, y: 0, width: 1280, height: 420 },
      })
      console.log(`  📷 ${name}.png`)
    }

    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-store-mode="pick"]', {
      timeout: 30_000,
    })
    await header('1-pick-store')
    await page.selectOption('[data-testid="site-theme-store-pick"]', 'nordvolt.myshopify.com')
    await page.waitForSelector('[data-testid="site-theme-store-row"]', { timeout: 30_000 })
    await header('2-store-row')

    // 3 / 4：改写回包造「一家都没有」「没找成」（替身只演两家店）
    const fake = async (patch) => {
      await page.unroute(/\/v1\/site\/theme(\?.*)?$/).catch(() => undefined)
      await page.route(/\/v1\/site\/theme(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const res = await route.fetch()
        const json = await res.json()
        const { store: _s, store_source: _ss, ...rest } = json.data
        json.data = {
          ...rest,
          next: 'store',
          store_lookup: { ...patch, checked_at: rest.store_lookup.checked_at },
        }
        await route.fulfill({ response: res, json })
      })
      await page.reload({ waitUntil: 'networkidle' })
    }
    await fake({ status: 'none', stores: [] })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-store-mode="none"]', {
      timeout: 30_000,
    })
    await header('3-no-store')
    await fake({ status: 'failed', stores: [], message: 'x' })
    await page.waitForSelector('[data-testid="site-theme-retry"]', { timeout: 30_000 })
    await header('4-lookup-failed')
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
