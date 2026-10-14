#!/usr/bin/env node
/**
 * WP329：Reddit「发出去」卡的截图（可重跑）。
 *
 * 在本进程里起一个服务进程（临时数据目录，跑完删掉），托管工作台构建产物，不联网、不接 AI、不碰 4317、
 * 不碰真 Reddit。一个人用（①）：持有「自家版运营」，从「待处理」里一条评论（收件箱回复）起草 → 出卡。
 * 帖子与评论全是现编的（品牌叫 BlueLamp，版块 r/bluelamp）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp329-shots.mjs [--port 4429]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp329')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4429')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@bluelamp.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))

const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp329-shots-'))
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
  const duty = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: 'social.reddit',
  })
  const target = {
    kind: 'reply',
    subreddit: 'bluelamp',
    parent_fullname: 't1_c1',
    permalink: '/r/bluelamp/comments/abc/charging_time/c1/',
    post_title: 'How long does a full charge take?',
    parent_author: 'maple_tree',
    parent_text: 'Thanks! Does it still work while charging? I read it at night.',
    inbox_type: 'comment_reply',
    source: { type: 'reddit_watch_item', id: 'rw_demo' },
  }
  const draft = await post('/v1/social/reddit/draft', { target }, duty.id)
  console.log(`  起草：${draft.source}`)
  await post(
    '/v1/social/reddit/stage',
    {
      target,
      text: 'Hi maple_tree, yes — it works while plugged in, so night reading is fine. A full charge takes about 90 minutes.',
      reason: '对方追问我们的回复（需跟进）',
    },
    duty.id,
  )

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
  // 新装的空品牌首页是初始化设置：先跳过，去岗位页（卡在那条职责的卡片流里）
  await page.getByText('先跳过').click({ timeout: 5_000 }).catch(() => undefined)
  await page.getByText('社媒运营').first().click()
  await page.waitForLoadState('networkidle')
  const card = page.locator('[data-testid="deck-reddit-write"]').first()
  await card.waitFor({ timeout: 30_000 }).catch(async (e) => {
    await page.screenshot({ path: join(process.env.SHOT_DEBUG ?? dataDir, 'debug.png') })
    throw e
  })
  await card.scrollIntoViewIfNeeded().catch(() => undefined)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, 'reddit-write-card.png') })
  console.log('  ✓ reddit-write-card.png')
  await browser.close()
}

try {
  await main()
} finally {
  await server.close().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
