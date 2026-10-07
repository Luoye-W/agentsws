#!/usr/bin/env node
/**
 * WP253：建站岗位端到端截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI、`shopify theme …`、起底包都是替身
 * （`platformCliStandIn` / `themeCliStandIn` / `fakeThemeBase`：不跑真 npm / shopify、不连 GitHub、不碰真店）。
 * 品牌平台设成 Shopify、给自己上网页模板职责，然后在岗位页依次拍那一行引导：
 * 没装 → 一键安装（卡在下面展开）→ 没登录 → 没店铺地址；再开两件事：
 * 「用 agentsws-theme 给我搭个首页」→ 时间线「预览好了」+ 打开预览；「预览看过了，发布上线」→ 发布卡。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp253-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp253')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4399') || 4399
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = '6suegp-md.myshopify.com'

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
    const shotOf = async (locator, name) => {
      await page.waitForTimeout(400)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const banner = page.locator('[data-testid="site-theme-banner"]')
    const header = async (name) => {
      // 页头 + 那一行：截岗位页上半截
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: 1280, height: 420 } })
      console.log(`  📷 ${name}.png`)
    }

    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="install_cli"]', { timeout: 30_000 })
    await header('1-banner-install')
    await page.click('[data-testid="site-theme-install"]')
    await page.waitForSelector('[data-testid="platform-cli-job"]', { timeout: 30_000 })
    await page.waitForTimeout(1200)
    await shotOf(banner, '2-banner-installing')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', { timeout: 60_000 })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', { timeout: 30_000 })
    await header('3-banner-login')
    await page.click('[data-testid="site-theme-login"]')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="store"]', { timeout: 90_000 })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-store-input"]', { timeout: 30_000 })
    await page.fill('[data-testid="site-theme-store-input"]', SHOP)
    await header('4-banner-store')
    await page.click('[data-testid="site-theme-store-save"]')
    await page.waitForSelector('[data-testid="site-theme-banner"]', { state: 'detached', timeout: 30_000 })
    await header('5-banner-gone')

    // 搭首页：起底 → 检查 → 推未发布；时间线「预览好了」+ 打开预览
    const built = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '用 agentsws-theme 给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    await page.goto(`${BASE}/matters/${built.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-preview-open"]', { timeout: 60_000 })
    await shotOf(page.locator('main'), '6-preview-ready')

    // 发布：只出卡（批了才换）
    await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '预览看过了，发布上线',
      role_id: 'site.shopify-theme',
    })
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="deck-card"]').filter({ hasText: '设为线上主题' }).first()
    await card.waitFor({ timeout: 60_000 })
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, '7-publish-card')
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
