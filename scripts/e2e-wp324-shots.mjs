#!/usr/bin/env node
/**
 * WP324（决策 690）：配置 / 连接在对话流里完成——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 Shopify CLI、`shopify theme …` 都是替身（不跑真 shopify、不碰真店）。
 * 品牌平台设成 Shopify、给自己上网页模板职责，然后：
 *
 * 1. 「从头给我搭个首页」→ 建站工具没装：出**连接卡**（卡片流里、事项时间线里同一张），卡里就是一键安装 / 登录那一行；
 * 2. 在卡里点「一键安装」「登录 Shopify」（不出页）；
 * 3. 「给我搭个关于我们页」→ 还不知道是哪家店：出**配置卡**（建议值预填）→ 保存 → 这件事自动接着做（到了选主题卡）；
 * 4. 回到第一件事：连接卡上全绿 → 卡自己「接着做」，原任务自动接着跑；
 * 5. 数据看板「去连接」→ 第三栏连接卡（就地连，不跳连接页）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsc -b
 * node scripts/e2e-wp324-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp324')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4399') || 4399
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = '6demox-md.myshopify.com'

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
      await page.waitForTimeout(500)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const cardOf = async (matter, kind) => {
      for (let i = 0; i < 120; i += 1) {
        const view = await api(token, theme, 'GET', `/v1/matters/${matter}`)
        const ids = view.timeline.map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await api(token, theme, 'GET', `/v1/approvals/${id}`)
          if (card.kind === kind && card.state === 'pending') return card
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      const view = await api(token, theme, 'GET', `/v1/matters/${matter}`)
      throw new Error(
        `等不到 ${kind} 卡：\n${view.timeline.map((e) => `  ${e.kind} ${e.text}`).join('\n')}`,
      )
    }

    const runOf = async (matter, text) => {
      for (let i = 0; i < 120; i += 1) {
        const view = await api(token, theme, 'GET', `/v1/matters/${matter}`)
        if (view.timeline.some((e) => e.kind === 'run' && e.text === text)) return
        await new Promise((r) => setTimeout(r, 250))
      }
      throw new Error(`等不到「${text}」`)
    }

    // ① 建站工具没装 → 连接卡
    const a = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '从头给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    const connect = await cardOf(a.matter.id, 'connect_request')
    console.log(`  连接卡：${connect.title}`)
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    const deck = page.locator('[data-testid="deck-card"][data-kind="connect_request"]').first()
    if (await deck.isVisible({ timeout: 10_000 }).catch(() => false))
      await shotOf(deck, '1-connect-card-deck')
    await page.goto(`${BASE}/matters/${a.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-setup-card"]', { timeout: 30_000 })
    await shotOf(page.locator('main'), '1b-connect-card-in-matter')

    // ② 卡里就地装 CLI、登录 Shopify
    await page.click('[data-testid="matter-setup-card"] [data-testid="site-theme-install"]')
    await page.waitForSelector(
      '[data-testid="matter-setup-card"] [data-testid="site-theme-banner"][data-next="login"]',
      { timeout: 90_000 },
    )
    await page.click('[data-testid="matter-setup-card"] [data-testid="site-theme-login"]')
    await page.waitForSelector(
      '[data-testid="matter-setup-card"] [data-testid="site-theme-banner"][data-next="store"]',
      { timeout: 90_000 },
    )

    // ③ 第二件事：还不知道是哪家店 → 配置卡（建议值预填）→ 保存 → 接着做
    const b = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '给我搭个关于我们页',
      role_id: 'site.shopify-theme',
    })
    const setup = await cardOf(b.matter.id, 'setup_request')
    console.log(`  配置卡：${setup.title} · ${setup.payload.fields.map((f) => f.key).join(',')}`)
    await page.goto(`${BASE}/matters/${b.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-setup-card"] [data-testid="setup-fields"]', {
      timeout: 30_000,
    })
    const input = page.locator('[data-testid="setup-field"][data-key="store"] input')
    if ((await input.count()) > 0 && (await input.inputValue()) === '') await input.fill(SHOP)
    await shotOf(page.locator('main'), '2-setup-card-in-matter')
    await page.click('[data-testid="setup-fields-save"]')
    await runOf(b.matter.id, '设好了，接着做')
    await page.goto(`${BASE}/matters/${b.matter.id}`, { waitUntil: 'networkidle' })
    await shotOf(page.locator('main'), '3-setup-saved-resumed')

    // ④ 回到第一件事：连接卡上全绿 → 卡自己「接着做」
    await page.goto(`${BASE}/matters/${a.matter.id}`, { waitUntil: 'networkidle' })
    await runOf(a.matter.id, '连好了，接着做')
    await cardOf(a.matter.id, 'theme_choice')
    await page.goto(`${BASE}/matters/${a.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-card"]', { timeout: 30_000 })
    await shotOf(page.locator('main'), '4-connect-done-resumed')

    // ⑤ 「去连接」→ 第三栏连接卡（找一个有没连数据源的岗位页；没有就试消息页）
    const goSel =
      '[data-testid="connect-card"] button, [data-testid="tile-connect-link"], [data-testid="position-missing-go"], [data-testid="messages-connect"]'
    const pages = [
      ...new Set((await api(token, undefined, 'GET', '/v1/me')).assignments.map((x) => x.id)),
    ]
      .map((id) => `${BASE}/positions/${id}`)
      .concat(`${BASE}/messages`)
    let shot = false
    for (const url of pages) {
      await page.goto(url, { waitUntil: 'networkidle' })
      const go = page.locator(goSel).first()
      if (!(await go.isVisible({ timeout: 3000 }).catch(() => false))) continue
      await go.click()
      if (
        await page
          .waitForSelector('[data-testid="connect-panel"]', { timeout: 15_000 })
          .catch(() => null)
      ) {
        await shotOf(page, '5-rail-connect-card')
        shot = true
        break
      }
    }
    if (!shot) console.log('  （没找到没连的数据源，跳过第三栏那一张）')
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
