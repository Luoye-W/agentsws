#!/usr/bin/env node
/**
 * WP276（docs/95 §4 / §6.2）：② 同事互联的截图（可重跑）。
 *
 * 在本进程里起一个**内存档**服务进程（不联网、不接 AI、不碰 4317），托管工作台构建产物，
 * 用接口把两个人、岗位、一件事铺好，再用真浏览器分别以两个人的身份拍：
 *
 * 1. `1-together-entry`：① 一个人时「岗位与品牌」页右上「和同事一起用」点开之后；
 * 2. `2-team-colleagues`：② 林峰（不是发起人）看到的团队页「同事」tab；
 * 3. `3-handoff-dialog`：王岚在事项里「⋯ → 交给同事」——同事下拉带忙闲 + 一句留言；
 * 4. `4-handoff-card`：林峰首页那张「王岚想把「…」交给你」的卡；
 * 5. `5-matter-accepted`：林峰点了「接下」之后事项时间线（「林峰 接下了」）；
 * 6. `6-peer-change-notice`：林峰改了 B2B 业务的角色定位，王岚收到的「知道了 / 撤回」卡（+ 首页那行交接通知）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp276-shots.mjs [--port 4476]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp276')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4476')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const WANG = 'wang@nordvolt.example'
const LIN = 'lin@nordvolt.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))

const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  env: { AGENTSWS_OWNER_EMAIL: WANG },
})

const ws = () => server.bootstrap.workspace.id
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
const giveB2b = async (person_id) => {
  const granted = await call('POST', '/v1/assignments', {
    body: { person_id, position_id: 'b2b', ranges: [{ kind: 'brand', id: ws() }] },
  })
  return granted.find((a) => a.role_id === 'b2b.sales').assignment_id
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  // 品牌档案 + 王岚的 B2B 岗位（不走首次设置）
  await call('PUT', '/v1/workspace/profile', {
    body: { legal_name: '深圳诺伏特科技有限公司', brand_name: 'NordVolt', discoverable: false },
  })
  await server.identity.renamePerson(server.bootstrap.person.id, '王岚')
  const wangB2b = await giveB2b(server.bootstrap.person.id)
  const wangToken = await login(WANG)

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
  const shot = async (page, name) => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
    console.log(`  ✓ ${name}.png`)
  }

  // ① 一个人：「和同事一起用」
  {
    const page = await open(wangToken, '/org')
    await page.getByTestId('together-entry').click()
    await page.getByTestId('together-panel').waitFor()
    await page.getByTestId('invite-create').click()
    await page.getByTestId('invite-row').waitFor()
    await shot(page, '1-together-entry')
    await page.context().close()
  }

  // 第二个人进来（卡上同意 = ②）；再来一个申请等着
  const invite = await call('POST', '/v1/invites')
  await post('/v1/memberships/requests', { code: invite.code, name: '林峰', email: LIN })
  const queue = await call('GET', '/v1/approvals?lane=mine')
  const linCard = queue.find((i) => i.kind === 'membership')
  await call('POST', `/v1/approvals/${linCard.id}/decide`, { body: { action: 'approve' } })
  const lin = server.identity.personByEmail(LIN).id
  const linB2b = await giveB2b(lin)
  const linToken = await login(LIN)
  await post('/v1/memberships/requests', {
    code: invite.code,
    name: '陈一',
    email: 'chen@nordvolt.example',
  })

  // ② 林峰看团队页「同事」
  {
    const page = await open(linToken, '/org')
    await page
      .getByRole('tab', { name: '同事' })
      .waitFor({ timeout: 15_000 })
      .catch(async (e) => {
        await page.screenshot({ path: join(SHOTS, '_debug.png') })
        console.error(await page.locator('body').innerText())
        throw e
      })
    await page.getByRole('tab', { name: '同事' }).click()
    await page.getByTestId('colleagues-tab').waitFor()
    await shot(page, '2-team-colleagues')
    await page.context().close()
  }

  // 王岚手上一件事：交给林峰
  const made = await call('POST', '/v1/matters', {
    assignment: wangB2b,
    body: { kind: 'project', title: 'Volthaus 65W 充电器报价跟进' },
  })
  const matter = made.matter.id
  await call('POST', '/v1/todos', {
    assignment: wangB2b,
    body: {
      title: '周五前回 Volthaus 第二版报价',
      matter_id: matter,
      due: '2026-10-10T10:00:00.000Z',
    },
  })
  {
    const page = await open(wangToken, `/matters/${matter}`)
    await page.getByTestId('matter-menu').click()
    await page.getByTestId('matter-handoff').click()
    await page.getByTestId('handoff-person').first().click()
    await page.getByTestId('handoff-note').fill('我这周出差，你熟这个客户')
    await shot(page, '3-handoff-dialog')
    await page.getByTestId('handoff-send').click()
    await page.getByTestId('matter-handoff-waiting').waitFor()
    await page.context().close()
  }

  // 林峰首页那张卡 → 接下
  {
    const page = await open(linToken, '/')
    const card = page.locator('[data-testid="deck-card"][data-kind="claim"]').first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    await shot(page, '4-handoff-card')
    await card.getByTestId('deck-handoff').getByRole('button').first().click()
    await page.waitForTimeout(800)
    await page.goto(`${BASE}/matters/${matter}`, { waitUntil: 'networkidle' })
    await page.getByTestId('matter-header').waitFor()
    await shot(page, '5-matter-accepted')
    await page.context().close()
  }

  // 林峰改了 B2B 业务的角色定位 → 王岚收「知道了 / 撤回」
  await call('PUT', '/v1/personas', {
    token: linToken,
    assignment: linB2b,
    body: {
      kind: 'role',
      id: 'b2b.sales',
      zh: '你是这家店的外贸业务员：口气稳，报价先看毛利，再看账期。',
    },
  })
  {
    const page = await open(wangToken, '/')
    const notice = page.locator('[data-testid="deck-card"]', { hasText: '林峰改了' }).first()
    await notice.waitFor({ timeout: 30_000 })
    await notice.scrollIntoViewIfNeeded()
    await shot(page, '6-peer-change-notice')
    await page.context().close()
  }

  await browser.close()
}

try {
  await main()
} finally {
  await server.close()
}
