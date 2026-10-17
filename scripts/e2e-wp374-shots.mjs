#!/usr/bin/env node
/**
 * WP374（决策 980）：设置里「Anthropic 兼容（自定义）」那张卡、填表单，以及 AI 钮里中转站那一组——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4474，不碰 4317）。卡与表单是 demo 服务端真给的模板；AI 钮清单**只在浏览器这一侧**
 * 换成示意数据（`/v1/free-chat/models`，中转站那一组的名字 / 上下文 / 思考档取自官方 pi-ai 的 anthropic 目录），
 * 不填任何 key、不登录任何账号、不发任何请求出去。
 *
 * 拍：
 * 1. 设置 → 模型 →「加一个」：Anthropic 兼容那张卡打开表单（浅 / 深）；
 * 2. 岗位页 AI 钮展开：「我的 Claude 中转站」一组（Claude Sonnet 4.5 带思考三档，中转站自己起名的不带）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp374-shots.mjs [--port 4474]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp374')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4474') || 4474
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const CREDITS = {
  linked: true,
  balance: { available: 96.059, low_balance: false, low_balance_threshold: 10 },
  can_topup: true,
  can_view_usage: true,
}
const THINK_CLAUDE = {
  options: [
    { level: 'fast', effort: 'low' },
    { level: 'standard', effort: 'medium' },
    { level: 'deep', effort: 'high' },
  ],
  default: 'medium',
}
const MODELS = {
  choices: [
    {
      id: 'agentsws/deepseek-flash',
      label: 'Agents 工坊（用积分）',
      official: true,
      vision: 'ok',
      group: 'workshop',
      vendor: 'deepseek',
      price: { kind: 'rate', rate: 0.3, source: 'stats' },
    },
    {
      id: 'my-relay/claude-sonnet-4-5',
      label: '我的 Claude 中转站',
      official: false,
      vision: 'ok',
      group: 'own',
      vendor: 'anthropic',
      price: { kind: 'own_key' },
      name: 'Claude Sonnet 4.5 (latest)',
      context_window: 1_000_000,
      thinking: THINK_CLAUDE,
    },
    {
      id: 'my-relay/claude-haiku-4-5-20251001',
      label: '我的 Claude 中转站',
      official: false,
      vision: 'ok',
      group: 'own',
      vendor: 'anthropic',
      price: { kind: 'own_key' },
      name: 'Claude Haiku 4.5',
      context_window: 200_000,
      thinking: THINK_CLAUDE,
    },
    {
      id: 'my-relay/relay-claude-special',
      label: '我的 Claude 中转站',
      official: false,
      vision: 'unchecked',
      group: 'own',
      price: { kind: 'own_key' },
    },
  ],
  default: 'my-relay/claude-sonnet-4-5',
  rate_base: { model: 'deepseek-v4-pro', fallback: false },
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}

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

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const session = (
      await post('/v1/auth/verify', {
        token: (await post('/v1/auth/magic-link', { email: OWNER })).data.token,
      })
    ).data.session_token
    const meRes = await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${session}` } })
    const me = (await meRes.json()).data
    const duty = me.assignments.find(
      (a) => a.role_id !== 'common.owner' && a.role_id !== 'common.member',
    )

    browser = await chromium.launch({ headless: true })
    const open = async ({ width, height, theme }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [session, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.route(/\/v1\/cloud\/credits(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: CREDITS, trace_id: 'tr_shot' } }),
      )
      await page.route(/\/v1\/free-chat\/models(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: MODELS, trace_id: 'tr_shot' } }),
      )
      return { context, page }
    }
    const shot = async (page, name, box) => {
      await page.waitForTimeout(600)
      await page.screenshot({
        path: join(SHOTS, `${name}.png`),
        ...(box === null || box === undefined
          ? {}
          : {
              clip: {
                x: Math.max(0, box.x - 12),
                y: Math.max(0, box.y - 12),
                width: box.width + 24,
                height: box.height + 24,
              },
            }),
      })
      console.log(`  ✓ ${name}.png`)
    }

    // 1. 设置 → 模型：Anthropic 兼容那张卡打开表单（浅 / 深）
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ width: 1280, height: 1100, theme })
      await page.goto(`${BASE}/settings?tab=models`, { waitUntil: 'networkidle' })
      const card = page.locator(
        '[data-testid="model-template"][data-vendor="anthropic-compatible"]',
      )
      await card.waitFor({ timeout: 30_000 })
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: '填 API key' }).click()
      const form = card.locator('[data-testid="model-form"]')
      await form.waitFor()
      await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await page.mouse.move(0, 0)
      await shot(page, `settings-anthropic-card-${theme}`, await card.boundingBox())
      await context.close()
    }

    // 2. 岗位页 AI 钮展开：中转站那一组
    {
      const { context, page } = await open({ width: 1280, height: 900, theme: 'light' })
      await page.goto(`${BASE}/positions/${duty.id}`, { waitUntil: 'networkidle' })
      const pick = page.locator('[data-testid="position-handoff"] [data-testid="model-pick"]')
      await pick.waitFor({ timeout: 30_000 })
      await pick.scrollIntoViewIfNeeded()
      await pick.click()
      await page.locator('[data-testid="model-pick-menu"]').waitFor()
      await page.mouse.move(0, 0)
      await shot(page, 'model-picker-relay-light')
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
