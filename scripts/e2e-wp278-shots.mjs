#!/usr/bin/env node
/**
 * WP278（决策 276 / 277 / 278 / 284）：② 同事互联收尾的截图（可重跑）。
 *
 * 在本进程里起一个**内存档**服务进程（不联网、不接 AI、不碰 4317），托管工作台构建产物；王岚（发起人）+
 * 林峰（同事，只做 B2B 一个岗位）：
 *
 * 1. `1-base-card-on-position`：有人贴码申请一起用——那张卡挂在底座职责上，林峰（只有一个岗位，首页就是
 *    岗位页）在岗位页「要你处理」里看得到；
 * 2. `2-initiator-give`：王岚「同事」tab 自己那一行「把发起人交给…」→ 挑一位同事；
 * 3. `3-initiator-waiting`：交出去之后那一行「等 林峰 接 · 撤回」；
 * 4. `4-initiator-card`：林峰岗位页上那张「王岚想把发起人交给你」（接下 / 不接）；
 * 5. `5-position-offer`：王岚岗位卡上「请同事一起做」发出去之后「等 X 接 · 撤回」；
 * 6. `6-connections-personal`：林峰连接页，自己接的那条有「个人」开关；
 * 7. `7-leave-confirm`：林峰点「退出」——框里列出会一起断开的个人连接（共用的留下）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp278-shots.mjs [--port 4478]
 * ```
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp278')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4478')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const WANG = 'wang@nordvolt.example'
const LIN = 'lin@nordvolt.example'

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))
const { SECRETS_KEY_ENV } = await import(join(ROOT, 'apps/server/dist/secret-store.js'))

const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  // 内存档的本机凭据库要一把钥匙：这一次现生成，进程一停就没了
  env: { AGENTSWS_OWNER_EMAIL: WANG, [SECRETS_KEY_ENV]: randomBytes(32).toString('hex') },
  mdns: () => ({ reason: '截图不开局域网' }),
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
/** 连一只邮箱（连不上的地址：试连一定失败，也不等 DNS；凭据进内存档的本机凭据库）。 */
const connectMail = (as, email, ownership) =>
  call('POST', '/v1/connections/imap_smtp/submit', {
    ...as,
    body: {
      alias: email,
      ownership,
      fields: {
        email,
        password: `demo-${randomBytes(4).toString('hex')}`,
        imap_host: '127.0.0.1',
        imap_port: '1',
        smtp_host: '127.0.0.1',
        smtp_port: '2',
      },
    },
  })

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

  // 林峰贴码申请、王岚在卡上同意 = ②；林峰只做 B2B（一个岗位：首页就是岗位页）
  const invite = await call('POST', '/v1/invites')
  await post('/v1/memberships/requests', { code: invite.code, name: '林峰', email: LIN })
  const queue = await call('GET', '/v1/approvals?lane=mine')
  const linCard = queue.find((i) => i.kind === 'membership')
  await call('POST', `/v1/approvals/${linCard.id}/decide`, { body: { action: 'approve' } })
  const lin = server.identity.personByEmail(LIN).id
  const linB2b = await giveB2b(lin)
  const linToken = await login(LIN)
  const asLin = { token: linToken, assignment: linB2b }

  // 林峰接两只邮箱：自己的那只标「个人」，公司那只共用
  await connectMail(asLin, 'linfeng@private.example', 'person')
  await connectMail(asLin, 'sales@nordvolt.example', 'workspace')

  const browser = await chromium.launch({ headless: true })
  try {
    await shoot(browser, { wangToken, linToken, lin, linB2b })
  } finally {
    await browser.close()
  }
}

async function shoot(browser, { wangToken, linToken, lin, linB2b }) {
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
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts })
    console.log(`  ✓ ${name}.png`)
  }
  const deckCard = (page, text) =>
    page.locator('[data-testid="deck-card"]', { hasText: text }).first()

  // 1. 有人申请一起用：卡挂在底座职责上，林峰的岗位页看得到
  const invite = await call('POST', '/v1/invites')
  await post('/v1/memberships/requests', {
    code: invite.code,
    name: '陈一',
    email: 'chen@nordvolt.example',
  })
  {
    const page = await open(linToken, `/positions/${linB2b}`)
    const card = deckCard(page, '陈一')
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    await shot(page, '1-base-card-on-position')
    await page.context().close()
  }
  // 王岚先不让陈一进（这张卡收掉，后面几张图里只有要拍的那张）
  const chenCard = (await call('GET', '/v1/approvals?lane=mine')).find(
    (i) => i.kind === 'membership',
  )
  await call('POST', `/v1/approvals/${chenCard.id}/decide`, {
    body: { action: 'reject', reason: '先不加人' },
  })

  // 2–3. 王岚「同事」tab：把发起人交给… → 等 林峰 接 · 撤回
  {
    const page = await open(wangToken, '/org')
    await page.getByRole('tab', { name: '同事' }).click()
    const give = page.getByTestId('initiator-give')
    await give.waitFor({ timeout: 20_000 })
    await give.click()
    await page.getByTestId('initiator-pick').waitFor()
    await shot(page, '2-initiator-give')
    await page.getByTestId('initiator-pick').getByRole('button', { name: '林峰' }).click()
    await page.getByTestId('initiator-waiting').waitFor({ timeout: 20_000 })
    await shot(page, '3-initiator-waiting')
    await page.context().close()
  }

  // 4. 林峰岗位页：王岚想把发起人交给你
  {
    const page = await open(linToken, `/positions/${linB2b}`)
    const card = deckCard(page, '想把发起人交给你')
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    await shot(page, '4-initiator-card')
    await page.context().close()
  }

  // 5. 王岚岗位卡：请同事一起做（发出去之后「等 X 接 · 撤回」）——请林峰也做一个他没做的岗位
  const positions = await call('GET', '/v1/org/positions')
  const target = positions.find(
    (p) => p.id !== 'owner' && !p.holders.some((h) => h.person_id === lin),
  )
  if (target !== undefined) {
    // 王岚自己先做上这个岗位（岗位页「我们的岗位」里才有它），再请林峰一起做
    await call('POST', '/v1/assignments', {
      body: {
        person_id: server.bootstrap.person.id,
        position_id: target.id,
        ranges: [{ kind: 'brand', id: ws() }],
      },
    })
    await call('POST', `/v1/org/positions/${target.id}/offer`, { body: { person_id: lin } })
    const page = await open(wangToken, '/org')
    await page.getByRole('tab', { name: '岗位' }).click()
    const line = page.getByTestId('peer-offers').first()
    await line.waitFor({ timeout: 20_000 }).catch(async (e) => {
      await page.screenshot({ path: join(SHOTS, '_debug.png'), fullPage: true })
      throw e
    })
    await line.scrollIntoViewIfNeeded()
    await page.mouse.wheel(0, -120)
    await shot(page, '5-position-offer')
    await page.context().close()
  }

  // 6. 林峰连接页：自己接的那条有「个人」开关
  {
    const page = await open(linToken, '/connections')
    await page.getByTestId('connection-personal').first().waitFor({ timeout: 20_000 })
    await shot(page, '6-connections-personal')
    await page.context().close()
  }

  // 7. 林峰点「退出」：框里列出会一起断开的个人连接
  {
    const page = await open(linToken, '/org')
    await page.getByRole('tab', { name: '同事' }).click()
    await page.getByTestId('team-leave').click()
    await page.getByTestId('leave-personal').waitFor({ timeout: 20_000 })
    await shot(page, '7-leave-confirm')
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
