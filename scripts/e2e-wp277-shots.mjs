#!/usr/bin/env node
/**
 * WP277（docs/95 §3.4–§3.6）：③ 开公司模式的截图（可重跑）。
 *
 * 在本进程里起一个**内存档**服务进程（不联网、不接 AI、不碰 4317），托管工作台构建产物；王岚（发起人）+
 * 林峰（同事），先是 ② 同事互联：
 *
 * 1. `0-team-entry`：② 团队页底部那一行「开公司模式…」（只有发起人看得到）；
 * 2. `1-wizard-1-legal` / `1-wizard-2-boss` / `1-wizard-3-admins`：向导三步；
 * 3. `2-colleague-card`：林峰首页那张「王岚把这里改成了公司模式」（知道了 / 我要退出）；
 * 4. `3-company-page`：开了以后王岚的公司页（负责人卡、店铺组与产品线、底部「回到同事互联…」）；
 * 5. `4-close-confirm`：回到同事互联的确认；
 * 6. `5-mode-notice`：降回之后林峰首页那一行通知。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp277-shots.mjs [--port 4477]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp277')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4477')
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
  await call('PUT', '/v1/workspace/profile', {
    body: { legal_name: '深圳诺伏特科技有限公司', brand_name: 'NordVolt', discoverable: false },
  })
  await server.identity.renamePerson(server.bootstrap.person.id, '王岚')
  await giveB2b(server.bootstrap.person.id)
  const wangToken = await login(WANG)

  // 林峰贴码申请、王岚在卡上同意 = ②
  const invite = await call('POST', '/v1/invites')
  await post('/v1/memberships/requests', { code: invite.code, name: '林峰', email: LIN })
  const queue = await call('GET', '/v1/approvals?lane=mine')
  const linCard = queue.find((i) => i.kind === 'membership')
  await call('POST', `/v1/approvals/${linCard.id}/decide`, { body: { action: 'approve' } })
  const lin = server.identity.personByEmail(LIN).id
  await giveB2b(lin)
  const linToken = await login(LIN)

  const browser = await chromium.launch({ headless: true })
  try {
    await shoot(browser, wangToken, linToken)
  } finally {
    await browser.close()
  }
}

async function shoot(browser, wangToken, linToken) {
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

  // ② 王岚的团队页底部一行 → 向导三步
  {
    const page = await open(wangToken, '/org')
    const entry = page.getByTestId('company-open-entry')
    await entry.waitFor({ timeout: 20_000 })
    await entry.scrollIntoViewIfNeeded()
    await shot(page, '0-team-entry', { fullPage: true })
    await entry.click()
    await page.getByTestId('company-wizard').waitFor()
    await shot(page, '1-wizard-1-legal')
    await page.getByTestId('company-next').click()
    await shot(page, '1-wizard-2-boss')
    await page.getByTestId('company-next').click()
    await page.getByTestId('company-admin').first().click()
    await shot(page, '1-wizard-3-admins')
    // 林峰先不当管理员（截图里点亮给人看是哪一格），真开的时候取消
    await page.getByTestId('company-admin').first().click()
    await page.getByTestId('company-open').click()
    await page.getByTestId('company-wizard').waitFor({ state: 'detached' })
    await page.context().close()
  }

  // 林峰首页：知道了 / 我要退出
  {
    const page = await open(linToken, '/')
    // 只有一个岗位的人落在岗位页；那张卡挂的是底座职责，在首页
    await page.getByRole('link', { name: '首页' }).click()
    const card = page.locator('[data-testid="deck-card"]', { hasText: '改成了公司模式' }).first()
    await card.waitFor({ timeout: 30_000 }).catch(async (e) => {
      await page.screenshot({ path: join(SHOTS, '_debug.png') })
      const org = server.organizations.organizationOf(ws())
      console.error(
        'mode',
        org?.mode,
        'lin queue',
        JSON.stringify(
          (
            await server.txn.approvals.queue({
              workspace_id: ws(),
              person_id: server.identity.personByEmail(LIN).id,
              lane: 'mine',
            })
          ).map((i) => [i.kind, i.title, i.state]),
        ),
      )
      throw e
    })
    await page.waitForTimeout(800)
    await card.scrollIntoViewIfNeeded().catch(() => undefined)
    await shot(page, '2-colleague-card')
    await page.context().close()
  }

  // 王岚的公司页 + 回到同事互联的确认
  {
    const page = await open(wangToken, '/org')
    await page.getByRole('tab', { name: '店铺组与产品线' }).waitFor({ timeout: 20_000 })
    await shot(page, '3-company-page', { fullPage: true })
    await page.getByTestId('company-close-entry').click()
    await page.getByTestId('company-close-dialog').waitFor()
    await shot(page, '4-close-confirm')
    await page.getByTestId('company-close-confirm').click()
    await page.getByTestId('company-close-dialog').waitFor({ state: 'detached' })
    await page.context().close()
  }

  // 降回之后林峰首页那一行
  {
    const page = await open(linToken, '/')
    await page.getByRole('link', { name: '首页' }).click()
    await page.getByTestId('mode-notice').waitFor({ timeout: 20_000 })
    await shot(page, '5-mode-notice')
    await page.context().close()
  }
}

try {
  await main()
} finally {
  await server.close()
  // 服务进程里还有懒起的定时器挂着：拍完就走，不等它们
  process.exit(process.exitCode ?? 0)
}
