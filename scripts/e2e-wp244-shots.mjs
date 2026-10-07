#!/usr/bin/env node
/**
 * WP244：首次设置 / 岗位工作那几处改动的截图（demo 端口默认 4399，不联网）。
 *
 * 起一个 demo，浏览器侧把服务端回的那几格换成「真机那一刻」的样子（形状就是服务端真回的——
 * `apps/server/test/wp244-*.test.ts` 用真服务进程把这几条路走过一遍），再拍：
 *
 * 1. `fresh-store-card`：第 ② 步读到一家刚开的 Shopify 空店——明说「品牌资料请自己填」，品牌名 / 一句话空着能填；
 * 2. `resume-step3`：第 ② 步做过了，重开向导直接站在第 ③ 步（①② 打勾），推荐里建站排最前；
 * 3. `work-stuck-done`：岗位页工作列表——「卡住了」一组说缺什么、答完了的进已完成并标「待你看结果」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp244-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp244')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const AT = new Date().toISOString()

/** 一家刚开的 Shopify 空店分析出来的样子（与 `wp244-fresh-store-onboarding.test.ts` 同形）。 */
const freshRun = (status) => ({
  id: 'bi_fresh',
  schema_version: 1,
  workspace_id: 'ws_rollout',
  status,
  inputs: [{ url: 'https://rollout.example', kind: 'website' }],
  pages: [{ url: 'https://rollout.example/', kind: 'home', ok: true }],
  budget: { estimated_credits: 1.8, cap_credits: 2, spent_credits: 0.3 },
  profile: {
    storefront_platform: {
      value: 'shopify',
      confidence: 'medium',
      evidence: [{ url: 'https://rollout.example/', locator: 'page:cdn.shopify.com' }],
    },
  },
  fresh_store: true,
  created_at: AT,
  updated_at: AT,
})

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
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
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

async function shot(page, name, locator) {
  await page.waitForTimeout(400)
  await (locator ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ── 1. 第 ② 步：空店 ─────────────────────────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/onboarding/state', (data) => ({
        ...data,
        needs_setup: true,
        brand_name: 'Rollout',
        workspace_name: 'Rollout',
        added_brand: true,
        model_configured: true,
      }))
      await patchGet(page, '**/v1/brand-intake/runs/**', () => freshRun('awaiting_confirm'))
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="intake-fresh"]')
      await shot(page, 'fresh-store-card')
      await page.close()
    }

    // ── 2. 重开向导：从第 ③ 步接着走 ─────────────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/onboarding/state', (data) => ({
        ...data,
        needs_setup: true,
        brand_name: 'Rollout',
        workspace_name: 'Rollout',
        added_brand: true,
        model_configured: true,
        business_done: true,
      }))
      await patchGet(page, '**/v1/brand-intake/runs/**', () => freshRun('confirmed'))
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="onboarding-recs"]')
      await shot(page, 'resume-step3')
      await page.close()
    }

    // ── 3. 岗位页工作：卡住了 / 待你看结果 ───────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      const me = await (
        await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
      ).json()
      const mine = (me.data?.assignments ?? []).find((a) => a.revoked_at === undefined)
      const positions = await (
        await fetch(`${BASE}/v1/positions`, {
          headers: { authorization: `Bearer ${token}`, 'x-assignment': mine?.id ?? '' },
        })
      ).json()
      if (positions.data === undefined) throw new Error(`拿不到岗位：${JSON.stringify(positions)}`)
      const first = positions.data.positions[0]
      const asg = first.position_id
      const role = { role_id: first.role_id, role_name: first.role_name, assignment_id: asg }
      const item = (over) => ({
        kind: 'matter',
        role_id: role.role_id,
        role_name: role.role_name,
        assignment_id: asg,
        status: 'open',
        cards: 0,
        card_ids: [],
        source: 'you',
        updated_at: AT,
        movable: false,
        ...over,
      })
      await patchGet(page, '**/v1/positions/*/work', (data) => ({
        ...data,
        items: [
          item({
            id: 'matter:m_run',
            ref_id: 'm_run',
            matter_id: 'm_run',
            title: '整理本周 r/SmartGlasses 热帖',
            group: 'doing',
            progress: '在读第 3 页',
          }),
          item({
            id: 'matter:m_stuck',
            ref_id: 'm_stuck',
            matter_id: 'm_stuck',
            title: '回版主私信：问 flair 规则',
            group: 'stuck',
            progress: '这份活现在交不出来——不是没人干，是没接上。',
            stuck_reason: '缺品牌 Reddit 号连接',
          }),
          item({
            id: 'matter:m_done',
            ref_id: 'm_done',
            matter_id: 'm_done',
            title: '查一下近视求助帖',
            group: 'done',
            progress: '查完了。',
            result_ready: true,
          }),
        ],
        counts: { ...data.counts, doing: 1, stuck: 1, done: 1, queued: 0, waiting: 0 },
        duties: [role],
      }))
      await page.goto(`${BASE}/positions/${encodeURIComponent(asg)}`, {
        waitUntil: 'networkidle',
      })
      await page.waitForSelector('[data-testid="work-row"][data-group="stuck"]')
      const section = page.locator('[data-testid="work-section"]')
      await section.scrollIntoViewIfNeeded()
      await shot(page, 'work-stuck-done', section)
      await page.close()
    }
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
