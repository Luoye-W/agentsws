#!/usr/bin/env node
/**
 * WP289（决策 293 / 307 / 313 / 318）截图，可重跑出处。
 *
 * 进程内起服务（内存档，端口默认 4489，不碰 4317）+ 云替身（不出网、不花钱），拍完即停。
 * 王岚（发起人）+ 林峰（②，只做 B2B）。
 *
 * 1. 王岚「同事」tab 点「请他离开」：框里列出林峰会一起断开的个人连接；
 * 2. 林峰设置 → 账号：余额 / 本月合计 / 充值档看得到，充值档只摆着，没有明细与增值服务卡；
 * 3–4. 素材库：默认不显示遮罩；点「遮罩」签才看到；
 * 5–6. 聊天窗：教 AI 旁「以后都这样」开着 → 教完回执一行；
 * 7. 那张「以后都这样」卡在客服岗位页「要你处理」（与卡片指导同一张）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build && npx tsc -b
 * node scripts/e2e-wp289-shots.mjs [--port 4489]
 * ```
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp289')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4489')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const WANG = 'wang@nordvolt.example'
const LIN = 'lin@nordvolt.example'

const { createServer, cloudStandIn, CLOUD_STAND_IN_BASE_URL, SECRETS_KEY_ENV } = await import(
  join(ROOT, 'apps/server/dist/index.js')
)
const { encodePng } = await import(join(ROOT, 'packages/model-gateway/dist/index.js'))

const standIn = cloudStandIn({ autoLinkAfterMs: 0 })
const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  env: {
    AGENTSWS_OWNER_EMAIL: WANG,
    AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL,
    [SECRETS_KEY_ENV]: randomBytes(32).toString('hex'),
  },
  cloudFetch: (input, init) => standIn.fetch(input, init),
  mdns: () => ({ reason: '截图不开局域网' }),
})

const ws = () => server.bootstrap.workspace.id
const owner = () => server.bootstrap.person.id
const raw = async (method, path, { body, token, assignment, form } = {}) => {
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
      ...(form === undefined ? {} : { body: form }),
    }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
const call = (method, path, opts) => raw(method, path, opts)
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
/** 一张纯色块图（`tags` 给 mask 就是遮罩）。 */
const upload = (name, rgb, tags) => {
  const w = 160
  const h = 120
  const px = new Uint8Array(h * (w * 3 + 1))
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = y * (w * 3 + 1) + 1 + x * 3
      px[i] = rgb[0]
      px[i + 1] = rgb[1]
      px[i + 2] = rgb[2]
    }
  const form = new FormData()
  form.append('file', new Blob([encodePng(w, h, px, 'rgb')]), name)
  if (tags !== undefined) form.append('tags', tags)
  return raw('POST', '/v1/brand-assets/upload', { form })
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
  await giveB2b(owner())
  const wangToken = await login(WANG)
  await call('POST', '/v1/cloud/account/link', { body: { email: WANG } })
  await standIn.settled()

  // 林峰进来 = ②；只做 B2B；接两只邮箱，私人那只标「个人」
  const invite = await call('POST', '/v1/invites')
  await post('/v1/memberships/requests', { code: invite.code, name: '林峰', email: LIN })
  const linCard = (await call('GET', '/v1/approvals?lane=mine')).find(
    (i) => i.kind === 'membership',
  )
  await call('POST', `/v1/approvals/${linCard.id}/decide`, { body: { action: 'approve' } })
  const lin = server.identity.personByEmail(LIN).id
  const linB2b = await giveB2b(lin)
  const linToken = await login(LIN)
  const asLin = { token: linToken, assignment: linB2b }
  await connectMail(asLin, 'linfeng@private.example', 'person')
  await connectMail(asLin, 'sales@nordvolt.example', 'workspace')

  // 素材库：两张图 + 一张遮罩
  await upload('desk.png', [196, 170, 140])
  await upload('bowl.png', [225, 29, 46])
  await upload('mask.png', [0, 0, 0], 'mask')

  // 聊天窗：王岚做网站客服（教 AI 要 customer.stage），开一条沙盒会话
  const support = server.roles.assignments.create({
    person_id: owner(),
    workspace_id: ws(),
    role_id: 'dtc.support',
    granted_by: owner(),
    ranges: [{ kind: 'brand', id: ws() }],
  })
  const session = await call('POST', '/v1/chat/sessions', { assignment: support.id })
  await call('POST', `/v1/chat/sessions/${session.id}/messages`, {
    assignment: support.id,
    body: { text: 'Can I get a refund of $80 for the glass bowl?' },
  }).catch(() => undefined)

  const browser = await chromium.launch({ headless: true })
  try {
    await shoot(browser, { wangToken, linToken, supportId: support.id })
  } finally {
    await browser.close()
  }
}

async function shoot(browser, { wangToken, linToken, supportId }) {
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
  const shot = async (target, name) => {
    const page = 'page' in target ? target.page() : target
    await page.waitForTimeout(500)
    await target.screenshot({ path: join(SHOTS, `${name}.png`) })
    console.log(`  ✓ ${name}.png`)
  }

  // 1. 请他离开：框里列出林峰的个人连接
  {
    const page = await open(wangToken, '/org')
    await page.getByRole('tab', { name: '同事' }).click()
    await page.getByTestId('colleague-remove').first().click()
    await page.getByTestId('leave-personal').waitFor({ timeout: 20_000 })
    await shot(page, '1-remove-confirm')
    await page.context().close()
  }

  // 2. 林峰设置 → 账号：只读积分卡
  {
    const page = await open(linToken, '/settings/credits')
    const panel = page.getByTestId('credits-panel')
    await panel.waitFor({ timeout: 20_000 })
    await page.getByTestId('credits-balance').waitFor({ timeout: 20_000 })
    await page.getByTestId('credits-tier').first().waitFor({ timeout: 20_000 })
    await panel.scrollIntoViewIfNeeded()
    await shot(panel, '2-credits-readonly')
    await page.context().close()
  }

  // 3–4. 素材库：默认没有遮罩；点「遮罩」才有
  {
    const page = await open(wangToken, '/brand-assets')
    await page.getByTestId('brand-assets-grid').locator('img').first().waitFor({ timeout: 20_000 })
    await shot(page, '3-assets-default')
    await page.getByTestId('brand-assets-filters').getByText('遮罩').click()
    await page.waitForTimeout(800)
    await shot(page, '4-assets-mask-filter')
    await page.context().close()
  }

  // 5–6. 聊天窗：「以后都这样」开着教 → 回执
  {
    const page = await open(wangToken, '/chat-window')
    await page.getByTestId('chat-conversation').first().click()
    await page.getByTestId('chat-teach-input').fill('退款超过 50 美元先问我，别直接答应')
    await page.getByTestId('chat-teach-always').click()
    const view = page.getByTestId('chat-conversation-view')
    await shot(view, '5-chat-teach-always')
    await page.getByTestId('chat-teach-send').click()
    await page.getByTestId('chat-teach-rule-receipt').waitFor({ timeout: 20_000 })
    await shot(view, '6-chat-teach-receipt')
    await page.context().close()
  }

  // 7. 客服岗位页「要你处理」：同一张「以后都这样」卡（记进规矩 / 不用）
  {
    const page = await open(wangToken, `/positions/${supportId}`)
    const card = page.locator('[data-testid="deck-card"]', { hasText: '以后都这样' }).first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    await shot(page, '7-rule-card')
    await page.context().close()
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await server.close()
  })
