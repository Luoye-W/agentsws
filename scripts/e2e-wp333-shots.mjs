#!/usr/bin/env node
/**
 * WP333（决策 584）：卡片链接页 `/cards/<卡号>` 的截图（可重跑）。
 *
 * 在本进程里起一个服务进程（临时数据目录，跑完删掉），托管工作台构建产物，不联网、不接 AI、不碰 4317：
 *
 * 1. `1-card-page`：个人微信卡片里那条链接打开——就是那一张卡（一封待审的客服回信）；
 * 2. `2-card-page-settled`：同一张点过之后再开——卡还能看，状态签是「已处理」、没有按钮；
 * 3. `3-card-page-missing`：卡号不对——一句人话 + 回首页。
 *
 * 卡上全是现编的假内容，不放任何真实客户数据。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp333-shots.mjs [--port 4433]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp333')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4433')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@bluelamp.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))

const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp333-shots-'))
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

const ws = server.bootstrap.workspace.id
const me = server.bootstrap.person.id

const call = async (method, path, body, assignment) => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', assignment ?? server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
const post = async (path, body) =>
  (
    await (
      await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    ).json()
  ).data

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await call('PUT', '/v1/workspace/profile', {
    legal_name: '小蓝灯科技（示例）',
    brand_name: 'BlueLamp',
    discoverable: false,
  })
  await server.identity.renamePerson(me, '蓝蓝')
  const support = server.roles.assignments.create({
    person_id: me,
    workspace_id: ws,
    role_id: 'dtc.support',
    granted_by: me,
    ranges: [{ kind: 'store', id: 'store_main' }],
  })
  const item = await server.txn.approvals.create({
    workspace_id: ws,
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: 'dtc.support',
    subject: { object: { type: 'thread', id: 'thr_demo_1' } },
    dedupe_key: `${ws}:outbound_draft:thr_demo_1`,
    title: '回复 Mia：小蓝灯什么时候到',
    summary: '客户问物流；订单已发出，按记录回预计到达时间。',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_demo_1' },
      body: {
        subject: 'Re: Where is my lamp?',
        text: 'Hi Mia,\n\nYour order #1042 shipped on Oct 13 and should arrive by Oct 17.\n\nBest,\nBlueLamp',
      },
    },
    evidence: {
      run_id: 'run_demo_1',
      source_events: [],
      provenance: {
        seen: [
          { type: 'customer', id: 'cus_demo_1' },
          { type: 'thread', id: 'thr_demo_1' },
        ],
      },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent', assignment_id: support.id },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: me, via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    context: { thread_participants: ['cus_demo_1'], verified_contacts: ['cus_demo_1'] },
  })
  console.log(`  卡：${item.state}`)
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const token = (await post('/v1/auth/verify', { token: link.token })).session_token

  const browser = await chromium.launch({ headless: true })
  const shot = async (name, path, ready) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      } catch {
        /* 写不进去就算了 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    await page.locator(`[data-testid="${ready}"]`).first().waitFor({ timeout: 30_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
    console.log(`  ✓ ${name}.png`)
    await context.close()
  }
  try {
    // 个人微信里那条链接的样子：`/cards/<卡号>?brand=<品牌>`
    await shot('1-card-page', `/cards/${item.id}?brand=${ws}`, 'deck-card')
    // 用本人的会话点「发送」（决定凭据是发给本人的）
    const res = await fetch(`${BASE}/v1/approvals/${item.id}/decide`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Assignment': support.id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'approve', version: item.revision }),
    })
    if (!res.ok) throw new Error(`decide → ${res.status} ${await res.text()}`)
    await shot('2-card-page-settled', `/cards/${item.id}`, 'deck-card')
    await shot('3-card-page-missing', '/cards/itm_nope', 'card-page-missing')
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  await server.close()
  rmSync(dataDir, { recursive: true, force: true })
}
