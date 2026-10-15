#!/usr/bin/env node
/**
 * WP334（决策 724 / 725 / 726）：连接卡第二轮——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4434，不碰 4317）。全程**不提交任何凭据、不点扫码**（那两步会连真的企业微信 / 微信），只拍卡：
 *
 * 1. 负责人「先连上企业微信，再把今天的待办发到群里」→ AI 自己要卡（`request_setup`）→ 事项里出**连接卡**，
 *    卡里就是企业微信那张本机原生表单；
 * 2. 同一张卡在卡片流里；
 * 3. 「先扫码绑上微信」→ 连接卡里是扫码那一块（条款风险一行）；
 * 4. 「先填好公司档案」→ **配置卡**（公司档案那几格）；
 * 5. 顶栏「还没接模型」→ 第三栏「接模型」连接卡（与开工向导第 ① 步同一个件），不跳设置页。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsc -b
 * node scripts/e2e-wp334-shots.mjs [--port 4434]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp334')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4434') || 4434
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [token],
    )
    const page = await context.newPage()
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => undefined)
    })
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shotOf = async (locator, name) => {
      await page.waitForTimeout(600)
      try {
        await locator.screenshot({
          path: join(SHOTS, `${name}.png`),
          animations: 'disabled',
          timeout: 30_000,
        })
        console.log(`  📷 ${name}.png`)
      } catch (e) {
        // 卡片流里的卡一直在动（轮询刷新）：拍不稳就整页拍一张
        await page.screenshot({
          path: join(SHOTS, `${name}.png`),
          animations: 'disabled',
          timeout: 120_000,
        })
        console.log(`  📷 ${name}.png（整页：${String(e).split('\n')[0]}）`)
      }
    }
    const cardOf = async (matter, kind) => {
      for (let i = 0; i < 120; i += 1) {
        const view = await api(token, owner, 'GET', `/v1/matters/${matter}`)
        const ids = view.timeline.map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await api(token, owner, 'GET', `/v1/approvals/${id}`)
          if (card.kind === kind && card.state === 'pending') return card
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      const view = await api(token, owner, 'GET', `/v1/matters/${matter}`)
      console.log(
        `  等不到 ${kind} 卡：\n${view.timeline.map((e) => `  ${e.kind} ${e.text}`).join('\n')}`,
      )
      return undefined
    }
    const ask = (title) =>
      api(token, owner, 'POST', `/v1/positions/${owner}/matters`, {
        title,
        role_id: 'common.owner',
      })

    // ① AI 自己要卡：企业微信（卡里是本机原生表单）
    const a = await ask('先连上企业微信，再把今天的待办发到群里')
    if ((await cardOf(a.matter.id, 'connect_request')) !== undefined) {
      await page.goto(`${BASE}/matters/${a.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-setup-card"] [data-testid="wecom-form"]', {
        timeout: 30_000,
      })
      await shotOf(page.locator('main'), '1-wecom-card-in-matter')
      // ② 同一张卡在卡片流里
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const deck = page.locator('[data-testid="deck-card"][data-kind="connect_request"]').first()
      if (await deck.isVisible({ timeout: 10_000 }).catch(() => false))
        await shotOf(deck, '2-wecom-card-deck')
    }

    // ③ 微信扫码（不点扫码：那一步会去连真的微信）
    const b = await ask('先扫码绑上微信，以后日报发我微信')
    if ((await cardOf(b.matter.id, 'connect_request')) !== undefined) {
      await page.goto(`${BASE}/matters/${b.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-setup-card"] [data-service="im:wechat"]', {
        timeout: 30_000,
      })
      await shotOf(page.locator('main'), '3-wechat-card-in-matter')
    }

    // ④ 公司档案配置卡
    const c = await ask('先填好公司档案，再写落地页文案')
    if ((await cardOf(c.matter.id, 'setup_request')) !== undefined) {
      await page.goto(`${BASE}/matters/${c.matter.id}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-setup-card"] [data-testid="setup-fields"]', {
        timeout: 30_000,
      })
      await shotOf(page.locator('main'), '4-profile-setup-card')
    }

    // ⑤ 顶栏「还没接模型」→ 第三栏「接模型」连接卡
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const chip = page.locator('[data-testid="no-model-chip"]')
    if (await chip.isVisible({ timeout: 8000 }).catch(() => false)) {
      await chip.click()
      if (
        await page
          .waitForSelector('[data-testid="connect-panel"] [data-testid="onboarding-ai"]', {
            timeout: 30_000,
          })
          .catch(() => null)
      )
        await shotOf(page, '5-rail-model-card')
    } else console.log('  （demo 里已经接了模型，没有「还没接模型」，跳过第三栏那一张）')
    await context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
