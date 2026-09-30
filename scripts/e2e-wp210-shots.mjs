#!/usr/bin/env node
/**
 * WP210：连接页与消息渠道页收拾之后的截图，可重跑。存到 `docs/assets/wp210/`。
 *
 * 1. `connections-top.png`：页头 + 顶部状态一行（✓ 连接器就绪）+ 已连上的两张卡（标题是账号本身）；
 * 2. `runtime-tooltip.png`：顶部状态的问号展开——fake-IP、信任名单（故意给一长串）都在里面，不溢出；
 * 3. `connections-available.png`：「可以连接」——每张卡只剩图标 + 名字 + 问号 + 按钮 + 看教程，
 *    图标都是各官网的 favicon；
 * 4. `available-hint.png`：「可以连接」标题旁那一个问号（安全承诺说一次）；
 * 5. `settings-diagnostics.png`：设置 → 诊断，没进来的信（系统打算怎么办 + 手动重投）；
 * 6. `im-channels.png`：消息渠道页（每张卡名字 + 问号 + 状态 + 主按钮）。
 *
 * 走 demo 的真界面；连接清单、连接器状态、死信三样用 `page.route` 换成**合成数据**
 * （demo 世界里没有已连上的邮箱，也没有 fake-IP 环境）——邮箱、店名都是 `.example` 假地址。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * node apps/cli/bin/agentsws.mjs demo --port 4417 &
 * node scripts/e2e-wp210-shots.mjs [--port 4417]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp210')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4417')
const BASE = `http://127.0.0.1:${PORT}`

const NOW = new Date().toISOString()
const RUNTIME = {
  state: 'ready',
  base_url: 'http://127.0.0.1:3000',
  reasons: [],
  checks: [],
  checked_at: NOW,
  secrets_vault: { available: true },
  egress: {
    fake_ip_detected: true,
    trusted_hosts: [
      'admin.shopify.com',
      'api.deepseek.com',
      'graph.facebook.com',
      'www.googleapis.com',
      'api.klaviyo.com',
      'api.aftership.com',
    ],
    detail: 'api.deepseek.com 解析到了保留网段地址 198.18.0.7',
  },
}
const CONNECTIONS = [
  {
    id: 'conn_mail_demo',
    service: 'imap_smtp',
    service_label: '任意邮箱（IMAP / SMTP）',
    alias: 'default',
    ownership: 'workspace',
    status: 'active',
    identity: { display_name: 'support@nordvolt.example' },
    credential_store: 'local_vault',
    data_sources: [],
    last_tested_at: '2026-09-30T01:00:00.000Z',
    last_test: { ok: true, reason: 'ok', checked_at: '2026-09-30T01:00:00.000Z' },
  },
  {
    id: 'conn_shop_demo',
    service: 'shopify_admin',
    service_label: 'Shopify 店铺',
    alias: 'nordvolt.myshopify.com',
    ownership: 'workspace',
    status: 'active',
    identity: { display_name: 'Nordvolt 官方店' },
    credential_store: 'openconnector',
    data_sources: ['shop'],
    last_tested_at: '2026-09-29T09:00:00.000Z',
    last_test: { ok: true, reason: 'ok', checked_at: '2026-09-29T09:00:00.000Z' },
  },
]
const DEAD_LETTERS = [
  {
    id: 'dl_demo_1',
    channel: 'email',
    from: 'Anna Keller',
    reason: 'retries_exhausted',
    attempts: 5,
    last_error: 'Unexpected token u in JSON',
    at: '2026-09-30T00:20:00.000Z',
    customer: true,
    auto_retry: { rounds: 1, gave_up: false, next_at: '2026-09-30T02:50:00.000Z' },
  },
  {
    id: 'dl_demo_2',
    channel: 'email',
    from: 'Shopify',
    reason: 'retries_exhausted',
    attempts: 5,
    at: '2026-09-28T03:00:00.000Z',
    customer: false,
    auto_retry: { rounds: 4, gave_up: true },
  },
]

const envelope = (data) => ({ data, trace_id: 'shot' })

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const fulfil = (body) => (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope(body)) })
    await page.route((url) => url.pathname === '/v1/connections/runtime', fulfil(RUNTIME))
    await page.route(
      (url) => url.pathname === '/v1/connections',
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        return fulfil({ connections: CONNECTIONS })(route)
      },
    )
    await page.route('**/v1/channels/dead-letters*', fulfil({ dead_letters: DEAD_LETTERS }))

    // ①② 顶部状态 + 已连上
    await page.goto(`${BASE}/connections`, { waitUntil: 'load' })
    await page.getByTestId('connection-row').first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(600)
    const top = await page.getByTestId('connections-page').boundingBox()
    const firstAvailable = await page.getByTestId('connection-directory').boundingBox()
    await page.screenshot({
      path: join(SHOTS, 'connections-top.png'),
      clip: { x: top.x - 8, y: top.y - 8, width: top.width + 16, height: firstAvailable.y - top.y },
    })
    console.log('  📷 connections-top.png')

    await page.getByTestId('runtime-detail').hover()
    await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 })
    await page.waitForTimeout(300)
    await page.screenshot({
      path: join(SHOTS, 'runtime-tooltip.png'),
      // 问号的浮层是以问号为中心往两边展开的，截图框从问号左边 360px 起，别把浮层切掉
      clip: { x: Math.max(0, top.x - 360), y: top.y - 8, width: top.width + 360, height: 360 },
    })
    console.log('  📷 runtime-tooltip.png')
    await page.mouse.move(0, 0)

    // ③④ 可以连接
    const available = page.getByTestId('provider-card').first().locator('xpath=../..')
    await available.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await available.screenshot({ path: join(SHOTS, 'connections-available.png') })
    console.log('  📷 connections-available.png')
    await page.getByTestId('connections-available-hint').hover()
    await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 })
    await page.waitForTimeout(300)
    const hintBox = await page.getByTestId('connections-available-hint').boundingBox()
    await page.screenshot({
      path: join(SHOTS, 'available-hint.png'),
      clip: {
        x: Math.max(0, hintBox.x - 200),
        y: Math.max(0, hintBox.y - 120),
        width: 760,
        height: 360,
      },
    })
    console.log('  📷 available-hint.png')

    // ⑤ 设置 → 诊断
    await page.goto(`${BASE}/settings#diagnostics`, { waitUntil: 'load' })
    const diag = page.getByTestId('settings-diagnostics')
    await diag.getByTestId('dead-letter').first().waitFor({ timeout: 30_000 })
    await diag.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await diag.screenshot({ path: join(SHOTS, 'settings-diagnostics.png') })
    console.log('  📷 settings-diagnostics.png')

    // ⑥ 消息渠道
    await page.goto(`${BASE}/im-channels`, { waitUntil: 'load' })
    await page.getByTestId('im-header-hint').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(600)
    const main = page.locator('main').first()
    await main.screenshot({ path: join(SHOTS, 'im-channels.png') })
    console.log('  📷 im-channels.png')
  } finally {
    await browser.close()
  }
}

await main()
