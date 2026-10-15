#!/usr/bin/env node
/**
 * WP349（Luoye 10-15 改决策 881）：品牌分析联网查的截图，可重跑出处（不联网、不接 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停）。品牌网站是 demo 自带的离线夹具
 * （NordVolt，`.example` 域名），联网搜索与 AI 归纳都是 demo 的写死替身——一个字节都不出这台机器。
 *
 * 1. `1-onboarding-competitors`：首次设置第 ② 步档案卡，竞品一行一个带理由，「🔗 N」点开列出来源；
 * 2. `2-onboarding-positioning`：同一张卡，定位那一格点开来源（搜到的评测）；
 * 3. `3-settings-reanalyze`：设置页「重新分析一次」对比，新的一列竞品来源点开。
 *
 * ```
 * npx tsc -b apps/cli && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp349-shots.mjs [--port 4447]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp349')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4447')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SITE = 'https://nordvolt.example/'

async function req(method, path, body, token, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await req('POST', '/v1/auth/magic-link', { email })
  return (await req('POST', '/v1/auth/verify', { token: link.token })).session_token
}

async function analyze(token, asg) {
  const run = await req('POST', '/v1/brand-intake/runs', { urls: [SITE] }, token, asg)
  for (let i = 0; i < 200; i++) {
    const now = await req('GET', `/v1/brand-intake/runs/${run.id}`, undefined, token, asg)
    if (now.status !== 'running') return now
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('分析没跑完')
}

/** 把服务端回的 `data` 换掉（别的照走 demo）。 */
async function patchGet(page, pattern, patch) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...json, data: patch(json.data) }),
    })
  })
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-15T09:00:00Z'),
  })
  await demo.server.listen()
  console.log('  demo 起来了')
  const browser = await chromium.launch({ headless: true })
  try {
    const token = await login(OWNER)
    const me = await req('GET', '/v1/me', undefined, token)
    const asg = (me.assignments ?? []).find(
      (a) => a.revoked_at === undefined && a.role_id === 'common.owner',
    )?.id
    console.log(`  登录了（分配 ${asg}）`)
    const first = await analyze(token, asg)
    console.log(
      `  分析跑完：${first.status} / ${first.insights} / 联网 ${first.web?.status} ${first.web?.searches} 次`,
    )
    if (first.insights !== 'done') throw new Error(`AI 那一步没跑：${first.insights}`)
    if (first.web?.status !== 'done')
      throw new Error(`联网那一步没跑：${JSON.stringify(first.web)}`)
    if ((first.profile.competitors?.value ?? []).length === 0) throw new Error('竞品是空的')

    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ── 1 / 2. 首次设置第 ② 步：档案卡，竞品与定位的来源点开 ─────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/onboarding/state', (data) => ({
        ...data,
        needs_setup: true,
        added_brand: true,
        model_configured: true,
      }))
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="brand-profile-card"]')
      await card.waitFor({ timeout: 30_000 })
      await card.locator('[data-testid="insight-sources-competitors"]').click()
      await page.waitForTimeout(400)
      await card
        .locator('[data-testid="brand-insight-fields"]')
        .screenshot({ path: join(SHOTS, '1-onboarding-competitors.png') })
      console.log('  📷 1-onboarding-competitors.png')
      await card.locator('[data-testid="insight-sources-competitors"]').click()
      await card.locator('[data-testid="insight-sources-positioning"]').click()
      await page.waitForTimeout(400)
      await card
        .locator('[data-testid="brand-insight-fields"]')
        .screenshot({ path: join(SHOTS, '2-onboarding-positioning.png') })
      console.log('  📷 2-onboarding-positioning.png')
      await page.close()
    }

    // 确认写进档案；人在设置页把竞品改成自己的（重跑时才有「现在 / 新的」可比）
    await req('POST', `/v1/brand-intake/runs/${first.id}/confirm`, {}, token, asg)
    const profile = (await req('GET', '/v1/onboarding/state', undefined, token, asg)).profile
    await req(
      'PUT',
      '/v1/workspace/profile',
      {
        legal_name: profile.legal_name,
        competitors: [{ name: 'EcoFlow', reason: '我们最常被拿来比' }],
      },
      token,
      asg,
    )

    // ── 3. 设置页：重新分析一次 → 对比，新的一列竞品来源点开 ─────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
      const box = page.locator('[data-testid="settings-company"]')
      await box.locator('[data-testid="brand-insight-fields"]').waitFor({ timeout: 30_000 })
      await box.locator('[data-testid="reanalyze-open"]').click()
      await box.locator('[data-testid="reanalyze-start"]').click()
      await box.locator('[data-testid="reanalyze-compare"]').waitFor({ timeout: 30_000 })
      await box.locator('[data-testid="insight-sources-reanalyze-competitors"]').click()
      await page.waitForTimeout(400)
      await box
        .locator('[data-testid="reanalyze"]')
        .screenshot({ path: join(SHOTS, '3-settings-reanalyze.png') })
      console.log('  📷 3-settings-reanalyze.png')
      await page.close()
    }
    await context.close()
  } finally {
    await browser.close()
    await demo.close()
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  // demo 里有定时器没收干净（拍完照就该走），不等它
  .finally(() => process.exit())
