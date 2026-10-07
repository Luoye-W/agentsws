#!/usr/bin/env node
/**
 * WP247：连接页「本机连接器」各状态截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4417，不碰 4317）。demo 里连接器是开发替身，所以本机连接器的各个状态用
 * 路由改写 `GET /v1/connections/runtime` / `GET /v1/connections/providers` 的回包造出来（真的下载、
 * 起停与加固由单测与真子进程测试钉住）。依次拍：没下载 → 点卡先问 → 下载中 → 启动中 → 就绪 →
 * 下载失败（网络）→ 起不来 → 设置 · 诊断里的连接器 → 暗色的「没下载」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp247-shots.mjs [--port 4417]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp247')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4417') || 4417
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const NOW = new Date().toISOString()

const LOCAL = {
  version: '1.8.0',
  download_bytes: 27_800_000,
  update_available: false,
  desired: 'run',
}
const base = (state, local, extra = {}) => ({
  state,
  base_url: 'http://127.0.0.1:43170',
  reasons: state === 'ready' ? [] : ['runtime_unreachable'],
  checks: [],
  checked_at: NOW,
  secrets_vault: { available: true },
  local: { ...LOCAL, ...local },
  ...extra,
})
const STATES = {
  not_installed: base('absent', { status: 'not_installed' }),
  downloading: base('absent', {
    status: 'downloading',
    job: { phase: 'downloading', version: '1.8.0', started_at: NOW, fetched: 143, total: 318 },
  }),
  starting: base('absent', {
    status: 'starting',
    installed: '1.8.0',
    supervisor: { state: 'starting', port: 43170, attempts: 0, updated_at: NOW },
  }),
  ready: base('ready', {
    status: 'ready',
    installed: '1.8.0',
    previous: '1.7.0',
    supervisor: { state: 'running', port: 43170, pid: 4242, attempts: 0, updated_at: NOW },
  }),
  error_network: base('absent', {
    status: 'error',
    job: {
      phase: 'failed',
      version: '1.8.0',
      started_at: NOW,
      finished_at: NOW,
      fetched: 12,
      total: 318,
      error: { code: 'network', detail: 'ENOTFOUND' },
    },
  }),
  error_crashed: base('absent', {
    status: 'error',
    installed: '1.8.0',
    supervisor: {
      state: 'failed',
      port: 43170,
      attempts: 9,
      updated_at: NOW,
      last_exit: { code: 1, signal: null, at: NOW },
      last_error: '[agentsws-oc] EADDRINUSE',
    },
  }),
}

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
    browser = await chromium.launch({ headless: true })
    let current = 'not_installed'
    const contextOf = async (dark) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 760 },
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
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      // 本机连接器的状态由这里给（demo 是替身档，没有 local 那一块）
      await page.route('**/v1/connections/runtime', (route) =>
        route.fulfill({ json: { data: STATES[current] } }),
      )
      await page.route('**/v1/connections/runtime/local**', (route) =>
        route.fulfill({ json: { data: STATES[current] } }),
      )
      await page.route('**/v1/connections/providers', async (route) => {
        const res = await route.fetch()
        const json = await res.json()
        for (const p of json.data?.providers ?? []) {
          if (p.requires_runtime === true && current !== 'ready') {
            p.available = true
            p.needs_download = true
          }
        }
        await route.fulfill({ response: res, json })
      })
      return { context, page }
    }
    const shot = async (page, name) => {
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const show = async (page, state) => {
      current = state
      await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="runtime-bar"]', { timeout: 30_000 })
    }

    const { context, page } = await contextOf(false)
    await show(page, 'not_installed')
    await shot(page, '1-not-installed')
    // 点 Shopify 卡：先问一句
    const shop = page.locator('[data-testid="provider-card"][data-service="shopify_admin"]')
    await shop.scrollIntoViewIfNeeded()
    await shop.getByRole('button', { name: '连接', exact: true }).click()
    await page.waitForSelector('[data-testid="connector-download-confirm"]')
    await shot(page, '2-confirm-download')
    await page.keyboard.press('Escape')
    for (const [i, s] of [
      [3, 'downloading'],
      [4, 'starting'],
      [5, 'ready'],
      [6, 'error_network'],
      [7, 'error_crashed'],
    ]) {
      await show(page, s)
      await shot(page, `${i}-${s.replace('_', '-')}`)
    }
    current = 'ready'
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const diag = page.locator('[data-testid="connector-diagnostics"]')
    await diag.waitFor({ timeout: 30_000 })
    await page.locator('[data-testid="settings-diagnostics"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.locator('[data-testid="settings-diagnostics"]').screenshot({
      path: join(SHOTS, '8-diagnostics.png'),
    })
    console.log('  📷 8-diagnostics.png')
    await context.close()

    const dark = await contextOf(true)
    await show(dark.page, 'not_installed')
    await shot(dark.page, '9-not-installed-dark')
    await dark.context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
