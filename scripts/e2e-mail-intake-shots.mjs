#!/usr/bin/env node
/**
 * WP167（docs/63 §D「收信一个入口」）：三张截图的可重跑出处。存到 `docs/assets/wp167/`。
 *
 * 1. `mailbox-switches.png`：连接页那只邮箱卡——三个开关 + 只读的「接管」；
 * 2. `mailbox-switches-shadow.png`：同一张卡，影子模式打开（卡上醒目标「只看不动」）；
 * 3. `messages-pending.png`：「消息」页左栏的「待确认」一格 + 那一栏（「这是客服 / 不是」）。
 *
 * **demo 里没有连着的邮箱**（没有 IMAP 服务器，也不许去连真邮箱），所以连接页上那条邮箱连接与
 * 它的开关是**浏览器侧替身**（只改 `GET /v1/connections` 多一行、开关那两条路由），别的照走 demo。
 * 「待确认」那一封是 demo 种进消息库的真数据（`seedMessages` 的 m109），走的是真路由。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-mail-intake-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp167')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

const MAIL = {
  id: 'conn_demo_mail',
  service: 'imap_smtp',
  service_label: '任意邮箱（IMAP / SMTP）',
  alias: 'default',
  ownership: 'workspace',
  status: 'active',
  identity: { display_name: 'hello@luminous-lab.example' },
  credential_store: 'local_vault',
  data_sources: [],
  last_tested_at: new Date().toISOString(),
  last_test: { ok: true, reason: 'ok', checked_at: new Date().toISOString() },
}

/** 浏览器侧替身：连接清单多一条邮箱，开关两条路由存一份在内存里。 */
async function standIns(page) {
  let switches = {
    connection_id: MAIL.id,
    shadow_mode: false,
    move: true,
    mark_read: true,
    takeover: true,
  }
  await page.route('**/v1/connections', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    const list = body?.data?.connections ?? []
    body.data = { ...(body.data ?? {}), connections: [MAIL, ...list] }
    await route.fulfill({ response: res, json: body })
  })
  await page.route(`**/v1/connections/${MAIL.id}/mailbox-switches`, async (route) => {
    if (route.request().method() === 'PUT') {
      switches = { ...switches, ...JSON.parse(route.request().postData() ?? '{}') }
    }
    await route.fulfill({ json: { data: switches } })
  })
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await standIns(page)

    // ①② 连接页那只邮箱卡
    await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    const row = page.locator('[data-testid="connection-row"][data-service="imap_smtp"]')
    await row.waitFor({ timeout: 20_000 })
    await row.locator('[data-testid="mailbox-switches"]').waitFor()
    await row.scrollIntoViewIfNeeded()
    await row.screenshot({ path: join(SHOTS, 'mailbox-switches.png') })
    console.log('  📷 mailbox-switches.png')
    await row.locator('[data-testid="mailbox-switch-shadow_mode"]').click()
    await row.locator('[data-testid="mailbox-shadow-badge"]').waitFor()
    await page.waitForTimeout(300)
    await row.screenshot({ path: join(SHOTS, 'mailbox-switches-shadow.png') })
    console.log('  📷 mailbox-switches-shadow.png')

    // ③ 消息页的「待确认」
    const mail = await context.newPage()
    mail.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await mail.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
    await mail.locator('[data-testid="messages-pending"]').click()
    await mail
      .locator('[data-testid="messages-pending-actions"]')
      .first()
      .waitFor({ timeout: 20_000 })
    await mail.waitForTimeout(300)
    await mail.locator('[data-testid="messages-page"]').screenshot({
      path: join(SHOTS, 'messages-pending.png'),
    })
    console.log('  📷 messages-pending.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
