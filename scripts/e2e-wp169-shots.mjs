#!/usr/bin/env node
/**
 * WP169：市场三件小事——截图的可重跑出处（不联网）。
 *
 * 在本进程里起一个 demo（`createDemo`，第 ② 步那一轮分析 replay pack 里的 `fixtures/site/*`；搜索数据接口换成替身），
 * 拍到 `docs/assets/wp169/`：
 *
 * 1. `wizard-markets-cost.png`：向导第 ② 步档案卡——选了两个市场，一句「多一个市场，搜索可见度的探测花费多一份」；
 *    `wizard-markets-cost-hint.png`：同一处问号悬停展开细节（每周默认 6 问 × 3 平台 × 2 个市场 × 0.2 积分；
 *    每日 SERP 每个市场各 5 次）；
 * 2. `seo-geo-languages.png`：「内容与搜索」面板的每周 AI 探测——每个市场旁边写用什么语言问；demo 没配模型，
 *    所以德国那一行注明「先按原语言问」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp169-shots.mjs [--port 4469]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp169')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4469'))
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
    // ── 向导第 ② 步：选两个市场 → 花费提示 ─────────────────────────
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
    // 官网推出来的是中国 / 港 / 澳 / 台；去掉到只剩一个，再加美国 = 两个市场
    for (const code of ['MO', 'HK', 'TW']) {
      const x = w.page.locator(`[data-testid="market-remove-${code}"]`)
      if ((await x.count()) > 0) await x.click()
    }
    await w.page.selectOption('[data-testid="market-add"]', 'US')
    await w.page.waitForSelector('[data-testid="markets-cost"]')
    await w.page.mouse.move(0, 0)
    await w.page.waitForTimeout(300)
    await card.screenshot({ path: join(SHOTS, 'wizard-markets-cost.png') })
    console.log('  📷 wizard-markets-cost.png')
    await w.page.hover('[data-testid="markets-cost-hint"]')
    await w.page.waitForTimeout(600)
    await w.page.screenshot({ path: join(SHOTS, 'wizard-markets-cost-hint.png'), fullPage: true })
    console.log('  📷 wizard-markets-cost-hint.png')
    await w.page.mouse.move(0, 0)
    await w.page.click('[data-testid="intake-confirm"]')
    await w.page.waitForSelector('[data-testid="intake-confirmed"]')

    // ── 「内容与搜索」面板：每个市场用什么语言问 ──────────────────
    const profile = (await call(owner, ownerAsg, 'GET', '/v1/onboarding/state')).profile
    await call(owner, ownerAsg, 'PUT', '/v1/workspace/profile', {
      legal_name: profile.legal_name,
      markets: ['US', 'DE', 'JP'],
    })
    const li = await login(CONTENT)
    const content = (await me(li)).assignments.find(
      (a) => a.role_id === 'dtc.content' && a.revoked_at === undefined,
    )
    await call(li, content.id, 'PUT', '/v1/seo/geo-questions', { settings: { max_questions: 4 } })
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
    await geo.screenshot({ path: join(SHOTS, 'seo-geo-languages.png') })
    console.log('  📷 seo-geo-languages.png')
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
