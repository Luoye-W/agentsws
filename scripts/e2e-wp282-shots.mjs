#!/usr/bin/env node
/**
 * WP282（决策 281 / 286–290）：按人看积分的截图（可重跑）。存到 `docs/assets/wp282/`。
 *
 * 在本进程里起一个服务进程（临时目录，用完删掉；不联网、不接 AI、不碰 4317），云是替身
 * （`cloud-stand-in`，数字是合成的，不真扣钱），托管工作台构建产物：
 *
 * 1. `1-peers-team-credits`：② 林峰（不是发起人）看团队页「同事」——名单下面每个人这个月的积分
 *    （三块 + 次数），陈一没用过补 0 行，「没标注」单独一行；
 * 2. `2-peers-settings-credits`：同一个人在设置 → 账号里看到的同一块；
 * 3. `3-company-member-self`：开了公司模式（③）之后普通成员陈一在设置 → 账号里只看到自己；
 * 4. `4-company-owner-all`：③ 里老板王岚看全员。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * pnpm exec tsc -b
 * node scripts/e2e-wp282-shots.mjs [--port 4482]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp282')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4482')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const WANG = 'wang@nordvolt.example'
const LIN = 'lin@nordvolt.example'
const CHEN = 'chen@nordvolt.example'

const { createServer, cloudStandIn, CLOUD_STAND_IN_BASE_URL, SECRETS_KEY_ENV } = await import(
  join(ROOT, 'apps/server/dist/index.js')
)

const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp282-shots-'))
const standIn = cloudStandIn({ autoLinkAfterMs: 0 })
const server = await createServer({
  dbDir: dir,
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  // 只给这一个进程用的随机库钥（临时目录，跑完删）
  env: {
    AGENTSWS_OWNER_EMAIL: WANG,
    AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL,
    [SECRETS_KEY_ENV]: 'e'.repeat(64),
  },
  cloudFetch: (input, init) => standIn.fetch(input, init),
})

const call = async (method, path, { body, token, assignment } = {}) => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${token ?? server.bootstrap.internalToken}`)
  const asg = assignment ?? server.bootstrap.ownerAssignment.id
  if (asg !== '') headers.set('X-Assignment', asg)
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
const post = async (path, body) => {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return (await res.json()).data
}
const login = async (email) => {
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}
const join2 = async (code, name, email) => {
  await post('/v1/memberships/requests', { code, name, email })
  const queue = await call('GET', '/v1/approvals?lane=mine')
  const card = queue.find((i) => i.kind === 'membership' && JSON.stringify(i).includes(name))
  await call('POST', `/v1/approvals/${card.id}/decide`, { body: { action: 'approve' } })
  return server.identity.personByEmail(email).id
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await call('PUT', '/v1/workspace/profile', {
    body: { legal_name: '深圳诺伏特科技有限公司', brand_name: 'NordVolt', discoverable: false },
  })
  await server.identity.renamePerson(server.bootstrap.person.id, '王岚')
  const wang = server.bootstrap.person.id
  const wangToken = await login(WANG)

  // 关联云（替身：发信之后自己点链接）
  await call('POST', '/v1/cloud/account/link', { body: { email: WANG } })
  await standIn.settled()

  // 两位同事进来 → ②
  const invite = await call('POST', '/v1/invites')
  const lin = await join2(invite.code, '林峰', LIN)
  await join2(invite.code, '陈一', CHEN)
  const linToken = await login(LIN)
  const chenToken = await login(CHEN)

  // 这个月的合成用量：王岚、林峰有，陈一没有（本机补 0 行）；月费没带归属 → 没标注
  standIn.seedAllocation({
    usage: [
      { member_id: lin, bucket: 'ai', credits: 18.4, calls: 96 },
      { member_id: lin, bucket: 'data', credits: 6.2, calls: 31 },
      { member_id: wang, bucket: 'ai', credits: 9.6, calls: 52 },
      { member_id: wang, bucket: 'data', credits: 2.4, calls: 12 },
      { member_id: wang, bucket: 'other', credits: 30, calls: 1 },
      { bucket: 'ai', credits: 4.1, calls: 20 },
    ],
  })

  const browser = await chromium.launch({ headless: true })
  const open = async (token, path) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
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
    return page
  }
  const shot = async (page, name, target) => {
    await page.waitForTimeout(400)
    if (target === undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
    else await target.screenshot({ path: join(SHOTS, `${name}.png`) })
    console.log(`  ✓ ${name}.png`)
  }

  try {
    // ② 林峰：团队页「同事」
    {
      const page = await open(linToken, '/org')
      await page.getByRole('tab', { name: '同事' }).click({ timeout: 20_000 })
      const tab = page.getByTestId('colleagues-tab')
      await tab.getByTestId('member-credits').waitFor({ timeout: 20_000 })
      await tab.getByTestId('member-credits').scrollIntoViewIfNeeded()
      await shot(page, '1-peers-team-credits')
      await page.goto(`${BASE}/settings/credits`, { waitUntil: 'networkidle' })
      const box = page.getByTestId('member-credits')
      await box.waitFor({ timeout: 20_000 })
      await box.scrollIntoViewIfNeeded()
      await shot(page, '2-peers-settings-credits')
      await page.context().close()
    }

    // ③ 开公司模式：王岚是老板，林峰、陈一是普通成员
    const orgs = await call('GET', '/v1/orgs')
    await call('PUT', `/v1/orgs/${orgs[0].id}/mode`, {
      body: { mode: 'company', legal_name: '深圳诺伏特科技有限公司', boss: wang, admins: [] },
    })
    {
      const page = await open(chenToken, '/settings/credits')
      const box = page.getByTestId('member-credits')
      await box.waitFor({ timeout: 20_000 })
      if ((await box.getAttribute('data-scope')) !== 'self') throw new Error('③ 普通成员不该看全员')
      await box.scrollIntoViewIfNeeded()
      await shot(page, '3-company-member-self')
      await page.context().close()
    }
    {
      const page = await open(wangToken, '/settings/credits')
      const box = page.getByTestId('member-credits')
      await box.waitFor({ timeout: 20_000 })
      if ((await box.getAttribute('data-scope')) !== 'all') throw new Error('③ 老板该看全员')
      await shot(page, '4-company-owner-all', box)
      await page.context().close()
    }
  } finally {
    await browser.close()
  }
}

try {
  await main()
} finally {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
}
// 替身与浏览器的残留句柄会让进程挂着不退：拍完就走
process.exit(process.exitCode ?? 0)
