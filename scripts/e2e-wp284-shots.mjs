#!/usr/bin/env node
/**
 * WP284（决策 275 / 294）：「以后都这样」落成职责规矩 + ③ 没岗位的同事点关于自己的卡（截图，可重跑）。
 *
 * 在本进程里起一个**内存档**服务进程（不联网、不接 AI、不碰 4317），托管工作台构建产物。
 * 王岚一个人用（①），做「客服」岗位：
 *
 * 1. `1-policy-card`：她在一封回信上指导「以后都这样」之后，首页那张策略卡；
 * 2. `2-role-rules`：点了通过以后，岗位与品牌 → 客服 → 网站客服 那张职责规矩卡里多了一句（谁定的 · 来自哪张卡）；
 * 3. `3-role-rules-edit`：同一处点「改」；
 * 4. `4-role-panel`：网站客服的职责页，右栏「角色」面板里角色定位下面那一句；
 * 5. `5-company-member-card`：开了公司模式之后，没岗位的周宁首页那张「知道了 / 我要退出」（能点）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp284-shots.mjs [--port 4484]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp284')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4484')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const WANG = 'wang@nordvolt.example'
const ZHOU = 'zhou@nordvolt.example'
const RULE = '退款超过 50 美元先问我，别直接答应'

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
const owner = () => server.bootstrap.person.id
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

/** 一封待审的回信（网站客服的），发给王岚。 */
async function draft(supportAssignment) {
  return server.txn.approvals.create({
    workspace_id: ws(),
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: 'dtc.support',
    subject: { object: { type: 'thread', id: 'thr_anna' } },
    dedupe_key: `${ws()}:outbound_draft:thr_anna`,
    title: '回复 Anna 的退款',
    summary: '客户要退 80 美元',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_anna' },
      body: { subject: 'Refund', text: 'We will refund $80 right away.' },
    },
    evidence: {
      run_id: 'run_anna',
      source_events: [],
      provenance: {
        seen: [
          { type: 'customer', id: 'cus_anna' },
          { type: 'thread', id: 'thr_anna' },
        ],
      },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent', assignment_id: supportAssignment },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: owner(), via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    context: { thread_participants: ['cus_anna'], verified_contacts: ['cus_anna'] },
  })
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await call('PUT', '/v1/workspace/profile', {
    body: { legal_name: '深圳诺伏特科技有限公司', brand_name: 'NordVolt', discoverable: false },
  })
  await server.identity.renamePerson(owner(), '王岚')
  const granted = await call('POST', '/v1/assignments', {
    body: {
      person_id: owner(),
      position_id: 'customer-care',
      ranges: [{ kind: 'brand', id: ws() }],
    },
  })
  const support = granted.find((a) => a.role_id === 'dtc.support').assignment_id
  const card = await draft(support)
  const taught = await call('POST', `/v1/approvals/${card.id}/decide`, {
    assignment: support,
    body: { action: 'instruct', instruction: { scope: 'global_rule', text: RULE } },
  })
  const policyId = taught.instruction_proposal.approval_item_id
  const wangToken = await login(WANG)

  const browser = await chromium.launch({ headless: true })
  try {
    await shoot(browser, { wangToken, support, policyId })
  } finally {
    await browser.close()
  }
}

async function shoot(browser, { wangToken, support, policyId }) {
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
  const shot = async (page, name, opts = {}) => {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts })
    console.log(`  ✓ ${name}.png`)
  }

  // ① 首页那张「以后都这样」策略卡
  {
    const page = await open(wangToken, '/')
    const home = page.getByRole('link', { name: '首页' })
    if (await home.count()) await home.first().click()
    const card = page.locator('[data-testid="deck-card"]', { hasText: '以后都这样' }).first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded().catch(() => undefined)
    await shot(page, '1-policy-card')
    await page.context().close()
  }

  // 点了通过（与卡上「按提议改」同一条路）
  await call('POST', `/v1/approvals/${policyId}/decide`, {
    assignment: support,
    body: { action: 'approve', selected_option_id: 'after' },
  })

  // ② 岗位与品牌 → 客服 → 网站客服的职责规矩
  {
    const page = await open(wangToken, '/org')
    const position = page.locator('[data-testid="position-card"][data-position="customer-care"]')
    await position.waitFor({ timeout: 20_000 })
    await position.getByTestId('position-duties-toggle').click()
    const duty = position.locator('[data-testid="position-duty"]', { hasText: '网站客服' }).first()
    await duty.getByTestId('position-duty-detail').click()
    const rules = page.getByTestId('role-rules').first()
    await rules.getByTestId('role-rule').first().waitFor({ timeout: 20_000 })
    await rules.scrollIntoViewIfNeeded()
    await shot(page, '2-role-rules')
    await rules.getByTestId('role-rule-edit').first().click()
    await rules.getByTestId('role-rule-editor').waitFor()
    await shot(page, '3-role-rules-edit')
    await page.context().close()
  }

  // ③ 职责页右栏「角色」面板
  {
    const page = await open(wangToken, `/positions/${support}/duties/dtc.support`)
    const tab = page.getByRole('button', { name: '角色' })
    if (await tab.count())
      await tab
        .first()
        .click()
        .catch(() => undefined)
    const panel = page.getByTestId('role-panel').first()
    await panel.waitFor({ timeout: 20_000 }).catch(() => undefined)
    await page.getByTestId('role-rules').first().waitFor({ timeout: 20_000 })
    await page.getByTestId('role-rules').first().scrollIntoViewIfNeeded()
    await shot(page, '4-role-panel')
    await page.context().close()
  }

  // ④ 开公司模式；没岗位的周宁点得了那张「知道了 / 我要退出」
  {
    const invitation = await call('POST', `/v1/workspaces/${ws()}/invitations`, {
      body: { email: ZHOU, name: '周宁' },
    })
    const token = invitation.url.slice(invitation.url.lastIndexOf('/') + 1)
    await post(`/v1/invitations/${token}/accept`, {})
    const org = server.organizations.organizationOf(ws())
    await call('PUT', `/v1/orgs/${org.id}/mode`, {
      body: { mode: 'company', legal_name: '深圳诺伏特科技有限公司' },
    })
    const zhouToken = await login(ZHOU)
    const page = await open(zhouToken, '/')
    const home = page.getByRole('link', { name: '首页' })
    if (await home.count()) await home.first().click()
    const card = page.locator('[data-testid="deck-card"]', { hasText: '公司模式' }).first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded().catch(() => undefined)
    await shot(page, '5-company-member-card')
    await page.context().close()
  }
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await server.close()
  // 服务进程里还有懒起的定时器挂着：拍完就走，不等它们
  process.exit(process.exitCode ?? 0)
}
