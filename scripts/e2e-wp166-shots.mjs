#!/usr/bin/env node
/**
 * WP166：目标市场一处定、处处用——截图的可重跑出处（不联网）。
 *
 * 在本进程里起一个 demo（`createDemo`，第 ② 步那一轮分析 replay pack 里的 `fixtures/site/*`；
 * 搜索数据接口换成**替身**：demo 默认没有搜索数据，要拍「每个市场分别探」得有数），拍到 `docs/assets/wp166/`：
 *
 * 1. `wizard-markets.png`：向导第 ② 步档案卡——市场是从官网配送政策推出来的，可增删，出处在问号里（悬停展开）；
 * 2. `wizard-markets-edited.png`：去掉一个、加上美国之后（问号改说「你自己选的」）；
 * 3. `settings-markets.png`：设置页「公司档案」——同一份市场，同一个选择器；
 * 4. `seo-geo-markets.png`：「内容与搜索」面板的每周 AI 探测——3 个市场、花费乘 3、每个市场一个勾；
 * 5. `seo-geo-visibility.png`：同一页「AI 平台可见度」按市场分开（多一列「市场」）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp166-shots.mjs [--port 4466]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp166')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4466'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const CONTENT = 'li@nordvolt.example'
/** pack 夹具里自报家门的那个网址（`packs/dtc-3c-3p/fixtures/site/home.html`）。 */
const SITE = 'https://nordvolt.example/'

/** 搜索数据替身：官方那一档、三个平台、0.2 / 次；英国的 ChatGPT 提到我们，德国的 Gemini 引了我们的站。 */
function searchStandIn() {
  return {
    status: async () => ({
      configured: true,
      route: 'official',
      platforms: ['chatgpt', 'gemini', 'google_ai_overview'],
      prices: { serp: 0.2, ai_answer: 0.2 },
    }),
    serp: async (q) => ({
      query: q,
      items: [],
      fetched_at: '2026-09-27T00:00:00Z',
      source: 'official',
    }),
    aiAnswers: async (p) =>
      p.platforms.map((platform, i) => ({
        platform,
        answer_excerpt: '',
        brand_mentioned: p.country === 'gb' && platform === 'chatgpt',
        our_domain_cited: p.country === 'de' && platform === 'gemini',
        cited_urls: ['https://review.example/best-chargers', `https://forum.example/t/${i}`],
        competitors_mentioned: [],
        fetched_at: '2026-09-27T00:00:00Z',
        source: 'official',
      })),
  }
}

async function login(email) {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
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

async function me(token) {
  return (
    await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()
  ).data
}

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-assignment': assignment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} 没成：${res.status} ${await res.text()}`)
  return (await res.json()).data
}

async function browserFor(chromium, token, viewport) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport })
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem('agentsws.session_token', t)
    } catch {
      /* 写不进去就走 demo 的自动登录 */
    }
  }, token)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  return { browser, page }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const search = searchStandIn()
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    searchDataFor: () => search,
  })
  await demo.server.listen()
  const open = []
  try {
    // ── 向导第 ② 步：档案卡上的市场 ───────────────────────────────
    const owner = await login(OWNER)
    const ownerAsg = (await me(owner)).assignments.find((a) => a.role_id === 'common.owner').id
    const w = await browserFor(chromium, owner, { width: 1280, height: 1000 })
    open.push(w.browser)
    await w.page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await w.page.click('[data-testid="ai-demo"]')
    await w.page.fill('[data-testid="intake-url"]', SITE)
    await w.page.click('[data-testid="intake-start"]')
    const card = w.page.locator('[data-testid="brand-profile-card"]')
    await card.waitFor({ timeout: 90_000 })
    await w.page.waitForSelector('[data-testid="market-chip"]')
    await w.page.hover('[data-testid="markets-origin"]')
    await w.page.waitForTimeout(600)
    await w.page.screenshot({ path: join(SHOTS, 'wizard-markets.png'), fullPage: true })
    console.log('  📷 wizard-markets.png')

    await w.page.click('[data-testid="market-remove-MO"]')
    await w.page.selectOption('[data-testid="market-add"]', 'US')
    await w.page.mouse.move(0, 0)
    await w.page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'wizard-markets-edited.png') })
    console.log('  📷 wizard-markets-edited.png')
    await w.page.click('[data-testid="intake-confirm"]')
    await w.page.waitForSelector('[data-testid="intake-confirmed"]')

    // ── 设置页「公司档案」：同一份 ────────────────────────────────
    await w.page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const company = w.page.locator('[data-testid="settings-company"]')
    await company.waitFor()
    await w.page.locator('[data-testid="profile-markets"]').scrollIntoViewIfNeeded()
    await w.page.waitForTimeout(400)
    await company.screenshot({ path: join(SHOTS, 'settings-markets.png') })
    console.log('  📷 settings-markets.png')

    // ── 「内容与搜索」面板：每个市场分别探 ────────────────────────
    // 卖三个市场（像用户在设置页里改的那样，走同一条接口）
    const profile = (await call(owner, ownerAsg, 'GET', '/v1/onboarding/state')).profile
    await call(owner, ownerAsg, 'PUT', '/v1/workspace/profile', {
      legal_name: profile.legal_name,
      markets: ['US', 'GB', 'DE'],
    })
    const li = await login(CONTENT)
    const content = (await me(li)).assignments.find(
      (a) => a.role_id === 'dtc.content' && a.revoked_at === undefined,
    )
    await call(li, content.id, 'PUT', '/v1/seo/geo-questions', { settings: { max_questions: 4 } })
    await call(li, content.id, 'POST', '/v1/seo/run', { what: 'weekly' })
    const d = await browserFor(chromium, li, { width: 1360, height: 1100 })
    open.push(d.browser)
    const positionId = content.position_id ?? content.id
    await d.page.goto(`${BASE}/positions/${encodeURIComponent(positionId)}/duties/dtc.content`, {
      waitUntil: 'networkidle',
    })
    const geo = d.page.locator('[data-testid="geo-questions"]')
    await geo.waitFor({ timeout: 20_000 })
    await geo.scrollIntoViewIfNeeded()
    await d.page.waitForTimeout(400)
    await geo.screenshot({ path: join(SHOTS, 'seo-geo-markets.png') })
    console.log('  📷 seo-geo-markets.png')
    // 「AI 平台可见度」那一块在岗位页的「面板」那一档（职责视图的块）
    await d.page.goto(`${BASE}/positions/${encodeURIComponent(positionId)}`, {
      waitUntil: 'networkidle',
    })
    await d.page.locator('[role="tab"][id$="-trigger-view"]').click()
    const vis = d.page.locator('[data-block-id="seo.geo_visibility"]')
    await vis.waitFor({ timeout: 20_000 })
    await vis.scrollIntoViewIfNeeded()
    await d.page.waitForTimeout(600)
    await vis.screenshot({ path: join(SHOTS, 'seo-geo-visibility.png') })
    console.log('  📷 seo-geo-visibility.png')
  } finally {
    for (const b of open) await b.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
