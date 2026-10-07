#!/usr/bin/env node
/**
 * WP245：Shopify CLI 卡「一键安装 / 一键登录」各状态截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI 是替身（`platformCliStandIn`：不跑真 npm、
 * 不开真登录页）。品牌平台设成 Shopify、给自己上建站岗位，然后在连接页依次拍：
 * 没装 → 安装中 → 没登录 → 等浏览器 → 好了；「装失败（网络）」与「详情展开」这两张用路由改写
 * `GET /v1/platform-kit` 的回包造出来（替身不演失败）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp245-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp245')
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

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
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
    await api(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    if (!me.assignments.some((a) => a.role_id === 'site.shopify-theme'))
      await api(token, owner, 'POST', '/v1/assignments', {
        person_id: me.person.id,
        role_id: 'site.shopify-theme',
        ranges: [],
      })
    const kit = await api(token, owner, 'GET', '/v1/platform-kit')
    console.log(`  CLI 卡：${kit.kit?.cli?.state ?? '（没有）'}`)

    browser = await chromium.launch({ headless: true })
    const contextOf = async (dark) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        colorScheme: dark ? 'dark' : 'light',
      })
      await context.addInitScript(
        ([t, theme]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', theme)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, dark ? 'dark' : 'light'],
      )
      const page = await context.newPage()
      // 登录网址交给「系统浏览器」那一下在这里是新标签页：记下来、关掉（.test 域名本来也打不开）
      context.on('page', (p) => {
        if (p === page) return
        void p
          .waitForLoadState('commit')
          .catch(() => undefined)
          .then(() => {
            console.log(`  ↗ 打开了：${p.url()}`)
            void p.close().catch(() => undefined)
          })
      })
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const card = (page) => page.locator('[data-testid="platform-cli-card"]')
    const shot = async (page, name) => {
      await page.waitForTimeout(300)
      await card(page).screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const waitState = async (page, sel) => page.waitForSelector(sel, { timeout: 60_000 })

    const { context, page } = await contextOf(false)
    await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    await waitState(page, '[data-testid="platform-cli-card"][data-state="missing"]')
    await card(page).scrollIntoViewIfNeeded()
    await shot(page, '1-missing')
    await page.click('[data-testid="platform-cli-install-run"]')
    await waitState(page, '[data-testid="platform-cli-job"][data-phase="installing"]')
    await page.waitForTimeout(1600)
    await shot(page, '2-installing')
    await waitState(page, '[data-testid="platform-cli-card"][data-state="needs_login"]')
    await page.waitForSelector('[data-testid="platform-cli-login-run"]')
    await shot(page, '3-needs-login')
    await page.click('[data-testid="platform-cli-login-run"]')
    await waitState(page, '[data-testid="platform-cli-reopen"]')
    await shot(page, '4-waiting-browser')
    await waitState(page, '[data-testid="platform-cli-card"][data-state="ready"]')
    await shot(page, '5-ready')
    await page.click('[data-testid="platform-cli-details"] summary')
    await shot(page, '6-ready-details')

    // 失败（网络）：改写回包造出来——替身不演失败
    await page.route('**/v1/platform-kit*', async (route) => {
      const res = await route.fetch()
      const json = await res.json()
      const cli = json.data?.kit?.cli
      if (cli !== undefined) {
        cli.state = 'missing'
        cli.probe = { ...cli.probe, installed: false, version: undefined, source: undefined }
        cli.login_confirmed_at = undefined
        cli.job = {
          action: 'install',
          phase: 'failed',
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          error: { code: 'network', detail: 'ENOTFOUND' },
          command: 'npm install --prefix "<数据目录>/tools/shopify-cli" @shopify/cli@latest',
          log: [
            'npm error code ENOTFOUND',
            'npm error syscall getaddrinfo',
            'npm error errno ENOTFOUND',
            'npm error network request to https://registry.npmjs.org/@shopify%2fcli failed',
          ],
        }
      }
      await route.fulfill({ response: res, json })
    })
    await page.reload({ waitUntil: 'networkidle' })
    await waitState(page, '[data-testid="platform-cli-error"]')
    await shot(page, '7-install-failed-network')
    await page.unroute('**/v1/platform-kit*')
    await context.close()

    const dark = await contextOf(true)
    await dark.page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    await waitState(dark.page, '[data-testid="platform-cli-card"][data-state="ready"]')
    await shot(dark.page, '8-ready-dark')
    await dark.context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
