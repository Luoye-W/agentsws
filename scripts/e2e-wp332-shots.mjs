#!/usr/bin/env node
/**
 * WP332（决策 762）：社媒岗位页「没发出去」提醒条的截图（可重跑）。
 *
 * 在本进程里起一个服务进程（临时数据目录，跑完删掉），托管工作台构建产物，不联网、不接 AI、不碰 4317、
 * 不碰真 Reddit。一个人用（①）：持有「官方版块」；一条批过的回复交给替身插件，插件回「你点了停止」→
 * 岗位页顶上出一行「没发出去 · 原因 · 再填一次 · 收起」。帖子与评论全是现编的（品牌 BlueLamp，r/bluelamp）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp332-shots.mjs [--port 4432]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp332')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4432')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@bluelamp.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))

const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp332-shots-'))
const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  dbDir: dataDir,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  env: { AGENTSWS_OWNER_EMAIL: OWNER },
  mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
})

const post = async (path, body, assignment) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (assignment !== undefined) {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', assignment)
  }
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await server.identity.renamePerson(server.bootstrap.person.id, '蓝蓝')
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: 'social.reddit',
  })
  // 一条批过的回复交给替身插件；插件领走、回「你点了停止」
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  await brand.adsActions.next(['reddit'], 0)
  await brand.redditWrites.send({
    approval_item_id: 'ap_demo',
    write: {
      kind: 'reply',
      parent: 't1_c1',
      permalink: '/r/bluelamp/comments/abc/charging_time/c1/',
    },
    text: 'Hi maple_tree, yes — it works while plugged in, so night reading is fine.',
    subreddit: 'bluelamp',
    record: {
      source_key: 'approval:ap_demo',
      channel: 'reddit',
      action: 'reply',
      kind: 'reddit_write',
      content: 'Hi maple_tree',
    },
    label: '回复 maple_tree（Reddit · r/bluelamp）',
  })
  const job = (await brand.adsActions.next(['reddit'], 0)).job
  brand.adsActions.result(job.id, {
    outcome: 'stopped',
    message: '你点了停止，已停下。',
    step: 6,
    reads: {},
  })

  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const token = (await post('/v1/auth/verify', { token: link.token })).session_token
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript((t) => {
    try {
      window.localStorage.setItem('agentsws.session_token', t)
      window.localStorage.setItem('agentsws.theme', 'light')
    } catch {}
  }, token)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page
    .getByText('先跳过')
    .click({ timeout: 5_000 })
    .catch(() => undefined)
  await page.getByText('社媒运营').first().click()
  await page.waitForLoadState('networkidle')
  const row = page.locator('[data-testid="reddit-write-notice-row"]').first()
  await row.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(400)
  await page.screenshot({
    path: join(SHOTS, 'reddit-write-notice.png'),
    clip: { x: 0, y: 0, width: 1280, height: 420 },
  })
  console.log('  ✓ reddit-write-notice.png')
  await page.getByTestId('reddit-write-refill').click()
  await row.waitFor({ state: 'detached', timeout: 10_000 })
  console.log('  ✓ 点「再填一次」后提醒收起')
  await browser.close()
}

try {
  await main()
} finally {
  await server.close().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
