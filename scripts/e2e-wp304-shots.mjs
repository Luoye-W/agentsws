#!/usr/bin/env node
/**
 * WP304（决策 445）：建站先选主题——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI、`shopify theme …` 与云都是替身（店里线上是手写的 Horizon 形状
 * 假主题，另有一份手写的 Dawn 那一代形状 2.0 主题「Lumen」与一份老主题；高级主题的包是手写的占位；不跑真 shopify、
 * 不碰真店、不连真云）。品牌平台设成 Shopify、给自己上网页模板职责、填店铺地址、关联（替身）工坊账号，然后：
 *
 * 1. 「从头给我搭个首页」→ 选主题卡：高级主题排第一（卖点 + 价格 + 预览占位），店里的免费主题能选、老主题只列；
 * 2. 选店里的 Lumen → 服务端复制它起底、记一句 → 接着做到「预览好了」；
 * 3. 「换个主题」→ 再出卡、选高级主题 → 「花钱」卡：这家店一次 560 积分，买下 / 先不买（没点，什么都不扣）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsc -b
 * node scripts/e2e-wp304-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp304')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4399') || 4399
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

    // 岗位页那一行引导走完（装 → 登 → 填店），与 WP253 同一条路
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="install_cli"]', {
      timeout: 30_000,
    })
    await page.click('[data-testid="site-theme-install"]')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', {
      timeout: 90_000,
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', {
      timeout: 30_000,
    })
    await page.click('[data-testid="site-theme-login"]')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="store"]', {
      timeout: 90_000,
    })
    await page.reload({ waitUntil: 'networkidle' })
    const manual = page.locator('[data-testid="site-theme-manual"]')
    if (await manual.isVisible().catch(() => false)) await manual.click()
    await page.waitForSelector('[data-testid="site-theme-store-input"]', { timeout: 30_000 })
    await page.fill('[data-testid="site-theme-store-input"]', SHOP)
    await page.click('[data-testid="site-theme-store-save"]')
    await page.waitForSelector('[data-testid="site-theme-banner"]', {
      state: 'detached',
      timeout: 30_000,
    })

    // 关联工坊账号（替身云：发信后 1.5 秒像用户点了链接）——高级主题那一行才是「可买」
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    for (let i = 0; i < 40; i += 1) {
      if ((await api(token, owner, 'GET', '/v1/cloud/account')).linked === true) break
      await new Promise((r) => setTimeout(r, 250))
    }

    const cardOf = async (matter, kind) => {
      for (let i = 0; i < 80; i += 1) {
        const view = await api(token, theme, 'GET', `/v1/matters/${matter}`)
        const ids = view.timeline.map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await api(token, theme, 'GET', `/v1/approvals/${id}`)
          if (card.kind === kind && card.state === 'pending') return card
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error(`等不到 ${kind} 卡`)
    }
    const decide = (id, body) =>
      api(token, theme, 'POST', `/v1/approvals/${id}/decide`, { via: 'workstation', ...body })

    // ① 从头搭：先出选主题卡
    const built = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '从头给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    const choice = await cardOf(built.matter.id, 'theme_choice')
    console.log(`  选主题卡：${choice.options.map((o) => o.label).join(' / ')}`)
    // 卡片流（岗位页）里的样子：高级主题排第一
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    const deckCard = page.locator('[data-testid="theme-choice"]').first()
    await deckCard.waitFor({ timeout: 30_000 })
    await shotOf(
      page.locator('[data-testid="deck-card"][data-kind="theme_choice"]').first(),
      '1-theme-choice-card',
    )
    // 事项里同一张卡的投影
    await page.goto(`${BASE}/matters/${built.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-card"]', { timeout: 30_000 })
    await shotOf(page.locator('main'), '1b-theme-choice-in-matter')

    // ② 选店里的 Lumen → 起底 → 接着做到预览
    await decide(choice.id, { action: 'approve', selected_option_id: 'store:100002' })
    await page.goto(`${BASE}/matters/${built.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-preview-open"]', { timeout: 60_000 })
    await shotOf(page.locator('main'), '2-free-theme-preview')
    console.log(
      `  起底：${JSON.stringify((await api(token, theme, 'GET', '/v1/site/theme')).workspace.base)}`,
    )

    // ③ 换个主题 → 选高级主题 → 花钱卡（不点）
    const sw = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '换个主题',
      role_id: 'site.shopify-theme',
    })
    const again = await cardOf(sw.matter.id, 'theme_choice')
    await decide(again.id, { action: 'approve', selected_option_id: 'premium' })
    const buy = await cardOf(sw.matter.id, 'theme_purchase')
    console.log(`  花钱卡：${buy.title}`)
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    const buyCard = page.locator('[data-testid="deck-card"][data-kind="theme_purchase"]').first()
    if (await buyCard.isVisible().catch(() => false))
      await shotOf(buyCard, '3-premium-purchase-card')
    else {
      await page.goto(`${BASE}/matters/${sw.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-card"]', { timeout: 30_000 })
      await shotOf(page.locator('main'), '3-premium-purchase-card')
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
