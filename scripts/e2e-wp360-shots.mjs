#!/usr/bin/env node
/**
 * WP360（决策 947）：需要插件的岗位一开始就引导装好插件——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317；stub 运行时，一行网都不出），全程不碰任何凭据。
 * 插件文件夹用一个临时目录假装（只放一个 manifest.json），好让「打开插件文件夹 / Chrome 扩展页」那一块出来：
 *
 * 1. `1-onboarding-step4`：首次设置第 ③ 步勾了「外部版块」「YouTube 红人」→ 第 ④ 步最前是「先装好浏览器插件」；
 * 2. `2-reddit-position-card`：自建「Reddit 运营」岗位（官方版块 + 外部版块）→ 岗位页顶上那张装插件卡；
 * 3. `3-first-chat-card`：第一次在这个岗位说话 → 事项里先说一句、带上装插件那张卡；
 * 4. `4-reddit-next-step`：配上插件（演示令牌）、插件来问但还没连 Reddit → 顶上那张换成「还差一步」。
 *
 * ```
 * npx tsc -b
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp360-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp360')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4399') || 4399
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo(extDir) {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTSWS_EXTENSION_DIR: extDir },
    },
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
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const extDir = mkdtempSync(join(tmpdir(), 'wp360-ext-'))
  writeFileSync(
    join(extDir, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.2.0', version_name: '0.2.0-beta.9' }),
  )
  const { child, log } = startDemo(extDir)
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const me = await api(token, undefined, 'GET', '/v1/me')
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner')
    const owner = ownerAsg.id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
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
    const shot = async (page, locator, name, pad = 0) => {
      await page.waitForTimeout(700)
      if (pad === 0) {
        await locator.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
      } else {
        const box = await locator.boundingBox()
        await page.screenshot({
          path: join(SHOTS, `${name}.png`),
          animations: 'disabled',
          clip: {
            x: 0,
            y: 0,
            width: 1280,
            height: Math.min(1000, (box?.y ?? 0) + (box?.height ?? 600) + pad),
          },
        })
      }
      console.log(`  📷 ${name}.png`)
    }

    // ① 首次设置：从第 ③ 步开始（AI 已接、第 ② 步做过），勾「外部版块」「YouTube 红人」→ 第 ④ 步
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/onboarding/state', (data) => ({
        ...data,
        needs_setup: true,
        model_configured: true,
        business_done: true,
      }))
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="onboarding-catalog"]', { timeout: 30_000 })
      for (const [category, role] of [
        ['pr', 'pr.reddit'],
        ['kol-marketing', 'kol.youtube'],
      ]) {
        await page.click(`[data-testid="onboarding-category-toggle"][data-category="${category}"]`)
        await page.click(`[data-testid="onboarding-role"][data-role="${role}"]`)
      }
      await page.click('[data-testid="onboarding-next"]')
      const card = page.locator('[data-testid="extension-onboard"]')
      await card.waitFor({ timeout: 30_000 })
      await shot(
        page,
        page.locator('[data-testid="onboarding-plan"]').locator('..'),
        '1-onboarding-step4',
      )
      await page.close()
    }

    // ② 自建「Reddit 运营」：官方版块 + 外部版块，分给本人
    const position = await api(token, owner, 'POST', '/v1/org/positions', {
      name: 'Reddit 运营',
      roles: [
        { role_id: 'social.reddit', default: true },
        { role_id: 'pr.reddit', default: true },
      ],
    })
    await api(token, owner, 'POST', '/v1/assignments', {
      person_id: ownerAsg.person_id,
      position_id: position.id,
      ranges: [],
      range_groups: [],
    })
    const me2 = await api(token, undefined, 'GET', '/v1/me')
    const reddit = me2.assignments.find(
      (a) => a.role_id === 'social.reddit' && a.revoked_at === undefined,
    ).id
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${reddit}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="extension-onboard"]')
      await card.waitFor({ timeout: 30_000 })
      await shot(page, card, '2-reddit-position-card', 40)
      await page.close()
    }

    // ③ 第一次在这个岗位说话 → 事项里先说一句 + 装插件那张卡
    const m = await api(token, reddit, 'POST', `/v1/positions/${reddit}/matters`, {
      title: '看看 Reddit 上最近大家都怎么说我们',
      role_id: 'social.reddit',
    })
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      for (let i = 0; i < 80; i += 1) {
        const view = await api(token, reddit, 'GET', `/v1/matters/${m.matter.id}`)
        if (view.timeline.some((e) => e.kind === 'card')) break
        await new Promise((r) => setTimeout(r, 250))
      }
      await page.goto(`${BASE}/matters/${m.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="setup-need"][data-service="extension"]', {
        timeout: 30_000,
      })
      await shot(page, page.locator('main'), '3-first-chat-card')
      await page.close()
    }

    // ④ 配上插件（演示令牌）、插件来问但还没连 Reddit → 顶上那张换成「还差一步」
    const ORIGIN = 'chrome-extension://wp360demoabcdefghijklmnopabcdef'
    const pairing = await api(token, owner, 'POST', '/v1/extension/pairings', {
      label: 'WP360 演示',
    })
    const redeemed = await (
      await fetch(`${BASE}/v1/extension/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ code: pairing.code }),
      })
    ).json()
    await fetch(`${BASE}/v1/extension/reddit/next?connected=0`, {
      headers: { authorization: `Bearer ${redeemed.data.token}`, origin: ORIGIN },
    })
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${reddit}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="extension-onboard"][data-phase="steps"]')
      await card.waitFor({ timeout: 30_000 })
      await shot(page, card, '4-reddit-next-step', 40)
      await page.close()
    }
    await context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
    rmSync(extDir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
