#!/usr/bin/env node
/**
 * WP416（自查 kol 组）：**真红人（不是演练）那条主线的点击级证据**，浅色与深色各拍一套。
 *
 * 起一个 demo 服务进程（替身邮箱 / 替身 SMTP，同 B2B 开发信那一套，一封都不真发），用真浏览器点：
 *
 * 1. 红人详情：「一句话介绍我们」从品牌档案预填（决策 531）；
 * 2. 建合作卡：点「不要」那一行删掉；再建一条点「同意」才生效；
 * 3. 起草开发信 → 卡面直接看得见正文 → 批 → 经替身邮箱发出去（读回后记往来、合作进「已建联」、发出记录有一行）；
 * 4. 岗位设置：定时任务按职责合成一行、不露 cron；记忆全空只说一行。
 *
 * 除了登录与几处「建一个测试红人」「读回核对」，脚本只点界面。退出码 0 = 全过。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp416-kol-real.mjs [--port 4540] [--shots <目录>] [--headed] [--keep]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4540'))
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = resolve(value('--shots', join(ROOT, 'docs/assets/workstation')))
const OWNER = 'wang@nordvolt.example'

class StepError extends Error {}
const must = (ok, what) => {
  if (!ok) throw new StepError(what)
}
let step = 0
const say = (text) => {
  step += 1
  console.log(`\n[${String(step).padStart(2, '0')}] ${text}`)
}
let theme = 'light'
const shots = []
async function shoot(page, name) {
  const file = `wp416-${theme}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(SHOTS, file), fullPage: true })
  shots.push(file)
  console.log(`  📷 ${file}`)
}
const settle = (page, ms = 900) => page.waitForTimeout(ms)

/* ── demo 与几个接口小工具 ─────────────────────────────────────────── */

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
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new StepError(`demo 没起来：\n${log.join('').slice(-2000)}`)
}

async function login() {
  const post = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  return (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
}

function apiOf(token, assignment) {
  return async (path, init = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'x-assignment': assignment,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })
    const json = await res.json().catch(() => ({}))
    return json.data
  }
}

/* ── 主线 ─────────────────────────────────────────────────────────── */

async function run(page, ctx) {
  const { api, assignment } = ctx
  const pool = `${BASE}/positions/${assignment}?tab=view&kol=pool`
  const cards = `${BASE}/positions/${assignment}?tab=cards`

  say('建一个真红人（不是演练）+ 一个邮箱（接口只用来铺测试数据）')
  const handle = `deskrosa${Date.now() % 100000}`
  const detail = await api('/v1/kol/creators', {
    method: 'POST',
    body: JSON.stringify({
      display_name: 'Desk Rosa',
      channel: 'youtube',
      handle,
      followers: 31_000,
      language: 'en',
    }),
  })
  const creator_id = detail.creator.id
  await api(`/v1/kol/creators/${creator_id}/contacts`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'email', value: 'rosa@creator.example' }),
  })

  say('建合作卡 → 卡片流里点「不要」→ 这一行删掉')
  const dropped = await api('/v1/kol/collaborations', {
    method: 'POST',
    body: JSON.stringify({ creator_id, channel: 'youtube' }),
  })
  await page.goto(cards, { waitUntil: 'networkidle' })
  const collabCard = page.locator('[data-testid="deck-card"]').filter({ hasText: 'Desk Rosa' })
  await collabCard.first().waitFor({ timeout: 30_000 })
  await shoot(page, 'collab-card')
  await collabCard.first().locator('[data-action="reject"]').first().click()
  await page.locator('[data-testid="deck-panel-reject"] textarea').first().fill('先不谈')
  await page.locator('[data-testid="deck-panel-reject"] button').first().click()
  await settle(page, 2500)
  const afterReject = await api('/v1/kol/collaborations?channel=youtube')
  must(
    !afterReject.rows.some((r) => r.id === dropped.collaboration.id),
    '点了「不要」，这条合作还在库里',
  )
  console.log('  ✓ 点「不要」之后那一行没了')

  say('再建一条合作 → 点「同意」→ 生效（不再标「等你点头」）')
  const kept = await api('/v1/kol/collaborations', {
    method: 'POST',
    body: JSON.stringify({ creator_id, channel: 'youtube' }),
  })
  await page.goto(cards, { waitUntil: 'networkidle' })
  const keepCard = page.locator('[data-testid="deck-card"]').filter({ hasText: 'Desk Rosa' })
  await keepCard.first().waitFor({ timeout: 30_000 })
  await keepCard.first().locator('[data-action="approve"]').first().click()
  await settle(page, 3000)

  say('红人详情：「一句话介绍我们」从品牌档案预填 → 起草开发信')
  await page.goto(pool, { waitUntil: 'networkidle' })
  const row = page.locator(`[data-testid="kol-library-row"][data-creator="${creator_id}"]`).first()
  await row.waitFor({ timeout: 30_000 })
  await row.click()
  await page.locator('[data-testid="kol-creator-detail"]').first().waitFor({ timeout: 20_000 })
  await settle(page, 1500)
  const pitch = await page.locator('[data-testid="kol-outreach-pitch"]').first().inputValue()
  console.log(`  一句话介绍（预填）：「${pitch}」`)
  if (pitch.trim() === '')
    await page.locator('[data-testid="kol-outreach-pitch"]').first().fill('We make desk chargers.')
  const product = page.locator('[data-testid="kol-outreach-product"]').first()
  if ((await product.inputValue()).trim() === '') await product.fill('the NordVolt 65W charger')
  await shoot(page, 'creator-detail-prefilled')
  await page.locator('[data-testid="kol-outreach-go"]').first().click()
  await page.locator('[data-testid="kol-outreach-draft"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  await shoot(page, 'outreach-drafted')

  say('卡片流：开发信卡卡面直接看得见正文 → 点「发送」')
  await page.goto(cards, { waitUntil: 'networkidle' })
  const mail = page
    .locator('[data-testid="deck-card"]')
    .filter({ hasText: '开发信' })
    .filter({ hasText: 'Desk Rosa' })
    .first()
  await mail.waitFor({ timeout: 30_000 })
  must(
    (await mail.locator('[data-testid="kol-outreach-body"]').count()) > 0,
    '开发信卡卡面上看不到正文',
  )
  await shoot(page, 'outreach-card')
  await mail.locator('[data-action="approve"]').first().click()
  // 批准后有 2 分钟取消窗口：demo 里时钟是真的，等执行器那一拍
  let sent
  for (let i = 0; i < 60; i += 1) {
    const xs = await api(`/v1/kol/exchanges?creator_id=${creator_id}`)
    sent = xs?.rows?.find((x) => x.direction === 'out')
    if (sent !== undefined) break
    await settle(page, 5000)
  }
  must(sent !== undefined, '批了开发信，往来里没有我们发出去的那一封（没真发）')
  must(typeof sent.mail_message_id === 'string', '发出去的那一封没有 Message-ID（没读回）')
  const collabs = await api('/v1/kol/collaborations?channel=youtube')
  const mine = collabs.rows.find((r) => r.id === kept.collaboration.id)
  must(mine?.stage === 'contacted', `发出去之后合作阶段是 ${mine?.stage}，应为「已建联」`)
  const records = await api('/v1/outbound/records')
  must(
    (records ?? []).some((r) => r.kind === 'kol_outreach'),
    '发出记录里没有这封开发信',
  )
  console.log('  ✓ 经替身邮箱发出、读回、记了往来，合作进「已建联」，发出记录有一行')
  await page.goto(`${BASE}/positions/${assignment}?tab=view&kol=threads`, {
    waitUntil: 'networkidle',
  })
  await settle(page, 1500)
  await shoot(page, 'threads-after-send')

  say('岗位页 + 岗位设置：定时任务按职责合成一行（不露 cron）、记忆全空只一行')
  await page.goto(`${BASE}/positions/${assignment}`, { waitUntil: 'networkidle' })
  await settle(page, 1500)
  await shoot(page, 'position')
  await page.goto(`${BASE}/positions/${assignment}?tab=settings`, { waitUntil: 'networkidle' })
  await settle(page, 2000)
  const schedules = page.locator('[data-testid="settings-schedules"]').first()
  if ((await schedules.count()) > 0) {
    const text = await schedules.innerText()
    must(!/cron\s/.test(text), `定时任务里还露着 cron：${text.slice(0, 200)}`)
  }
  await shoot(page, 'settings')
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  let failed
  let pageForFailure
  try {
    await waitForDemo(log)
    const token = await login()
    const me = await (
      await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()
    const hit = me.data.assignments.find((a) => a.role_id === 'kol.youtube' && a.revoked_at == null)
    must(hit !== undefined, 'demo 里没有 kol.youtube 这条职责的分配')
    const ctx = { api: apiOf(token, hit.id), assignment: hit.id }
    browser = await chromium.launch({ headless: !flag('--headed') })
    for (const scheme of ['light', 'dark']) {
      theme = scheme
      const context = await browser.newContext({
        viewport: { width: 1360, height: 900 },
        colorScheme: scheme,
      })
      await context.addInitScript((t) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
        } catch {
          /* 写不进就走 demo 自动登录 */
        }
      }, token)
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      pageForFailure = page
      console.log(`\n==== ${scheme} ====`)
      await run(page, ctx)
      await context.close()
    }
    console.log(`\n✅ 主线走通了，${shots.length} 张截图在 ${SHOTS}`)
  } catch (err) {
    failed = err
    console.error(`\n❌ 第 ${step} 步没走通：${err instanceof Error ? err.message : String(err)}`)
    if (!(err instanceof StepError)) console.error(err)
    try {
      await pageForFailure?.screenshot({ path: join(SHOTS, 'wp416-FAILED.png'), fullPage: true })
    } catch {
      /* 浏览器没了就算了 */
    }
  } finally {
    await browser?.close()
    if (!flag('--keep')) child.kill('SIGTERM')
  }
  process.exit(failed === undefined ? 0 : 1)
}

await main()
