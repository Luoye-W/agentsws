#!/usr/bin/env node
/**
 * WP174（docs/84 §11.1 第 3 条）：两张截图的可重跑出处。存到 `docs/assets/wp174/`。
 *
 * 1. `position-supervisor.png`：公司页「岗位」里 B2B 那张卡，「上级」下拉选的是李默（说明在问号里）；
 * 2. `quote-to-supervisor.png`：李默登录后在他的 B2B 岗位里看到那张超授权的报价卡，
 *    标题下一句「转给了「B2B」岗位的上级李默」。
 *
 * 全走 demo 的真路由：老板把「B2B 业务」这条职责也分给李默（上级自己也得做这条活，
 * 卡才出现在他那个岗位的队列里）→ 设 B2B 岗位的上级 = 李默 → 老板用自己那条 B2B 分配
 * 提一张 1.84 万美元、毛利 18.5% 的报价。没有浏览器侧替身。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-supervisor-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp174')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN_KEY = 'agentsws.session_token'

async function api(path, { method = 'GET', body, token, assignment } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  if (assignment !== undefined) headers['X-Assignment'] = assignment
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${parsed.code} ${parsed.message}`)
  return parsed.data
}

/** demo 档：magic-link 直接回 token（`apps/workstation/src/lib/api.ts` 的 `ensureSession` 同一条路）。 */
async function login(email) {
  const issued = await api('/v1/auth/magic-link', { method: 'POST', body: { email } })
  const verified = await api('/v1/auth/verify', { method: 'POST', body: { token: issued.token } })
  return verified.session_token
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })

  // ── 准备：真路由 ──────────────────────────────────────────────────
  const ownerToken = await login('wang@nordvolt.example')
  const me = await api('/v1/me', { token: ownerToken })
  const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner')?.id
  const ownerSales = me.assignments.find((a) => a.role_id === 'b2b.sales')?.id
  if (ownerAsg === undefined || ownerSales === undefined) throw new Error('老板没有 owner / B2B 分配')
  const members = await api(`/v1/workspaces/${me.workspace.id}/members`, {
    token: ownerToken,
    assignment: ownerAsg,
  })
  const li = members.find((m) => m.name === '李默')
  if (li === undefined) throw new Error('demo 里没有李默')
  if (!li.assignments.some((a) => a.role_id === 'b2b.sales'))
    await api('/v1/assignments', {
      method: 'POST',
      token: ownerToken,
      assignment: ownerAsg,
      body: { person_id: li.person_id, role_id: 'b2b.sales', ranges: [{ kind: 'store', id: 'store_main' }] },
    })
  await api('/v1/org/positions/b2b/supervisor', {
    method: 'PUT',
    token: ownerToken,
    assignment: ownerAsg,
    body: { person_id: li.person_id },
  })
  const draft = await api('/v1/b2b/quotes/drafts', {
    method: 'POST',
    token: ownerToken,
    assignment: ownerSales,
    body: {
      record: { account_id: 'acc_volthaus' },
      quote_version: {
        lines: [{ sku: 'GAN65', description: '65W GaN charger', qty: 1000, unit_price_usd: 18.4 }],
        margin_pct: 18.5,
        discount_pct: 3,
        payment_terms_days: 30,
        incoterm: 'FOB',
        valid_until: '2026-10-28',
      },
    },
  })
  const staged = await api(`/v1/b2b/quotes/drafts/${draft.draft.id}/submit`, {
    method: 'POST',
    token: ownerToken,
    assignment: ownerSales,
  })
  console.log(`  报价卡 ${staged.approval_item_id}：approver=${staged.approver}`)
  const liToken = await login(li.email)
  const liMe = await api('/v1/me', { token: liToken })
  const liSales = liMe.assignments.find((a) => a.role_id === 'b2b.sales')?.id
  if (liSales === undefined) throw new Error('李默没有 B2B 业务那条分配')

  // ── 拍 ───────────────────────────────────────────────────────────
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const shoot = async (token) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.addInitScript(
        ([key, value]) => {
          window.localStorage.setItem(key, value)
        },
        [TOKEN_KEY, token],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return page
    }

    // ① 公司页 → 岗位 → B2B 那张卡
    const owner = await shoot(ownerToken)
    await owner.goto(`${BASE}/org`, { waitUntil: 'networkidle' })
    const card = owner.locator('[data-testid="position-card"][data-position="b2b"]')
    await card.waitFor({ timeout: 20_000 })
    await card.locator('[data-testid="position-supervisor-select"]').waitFor()
    await card.scrollIntoViewIfNeeded()
    await card.locator('[data-slot="hint"]').first().hover()
    await owner.waitForTimeout(600)
    await owner.screenshot({ path: join(SHOTS, 'position-supervisor.png') })
    console.log('  📷 position-supervisor.png')

    // ② 李默的 B2B 岗位 → 那张报价卡
    const lin = await shoot(liToken)
    await lin.goto(`${BASE}/positions/${liSales}`, { waitUntil: 'networkidle' })
    const note = lin.locator('[data-testid="deck-routed-note"]').first()
    await note.waitFor({ timeout: 20_000 })
    await note.scrollIntoViewIfNeeded()
    await lin.waitForTimeout(500)
    await lin.screenshot({ path: join(SHOTS, 'quote-to-supervisor.png') })
    console.log(`  📷 quote-to-supervisor.png（${await note.textContent()}）`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
