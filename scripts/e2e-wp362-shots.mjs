#!/usr/bin/env node
/**
 * WP362（Luoye 10-16）：ChatGPT 订阅能选来干活 + 输入框 AI 钮学 Proma——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4462，不碰 4317）。演示世界没登录 ChatGPT 订阅、也没关联工坊账号，所以**只在浏览器这一侧**
 * 把几条只读接口换成示意数据（`/v1/free-chat/models` 已接的模型与消耗速率、`/v1/cloud/credits` 余额、
 * `/v1/models/defaults` 默认模型下拉）：不填任何 key、不登录任何账号、不发任何请求出去。
 * 示意数据里的消耗速率取自开源仓的样例价目（`SAMPLE_PRICING_CATALOG`），不是官方价。
 *
 * 拍：
 * 1. 岗位页输入框左下角的 AI 钮（选了 ChatGPT 订阅：「ChatGPT 订阅 · gpt-5.5」）；
 * 2. AI 钮展开：浅色 / 深色各一张（搜索框、三组、每行右边那一格）；
 * 3. 设置 → 模型「默认模型」下拉里的订阅那几项（把下拉摊开拍）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp362-shots.mjs [--port 4462]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp362')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4462') || 4462
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const CREDITS = {
  linked: true,
  balance: { available: 96.059, low_balance: false, low_balance_threshold: 10 },
  can_topup: true,
  can_view_usage: true,
}
const cloud = (model, vendor, price, vision = 'ok') => ({
  id: `agentsws/${model}`,
  label: 'Agents 工坊（用积分）',
  official: true,
  vision,
  group: 'workshop',
  vendor,
  price,
})
const rate = (r, source = 'list_price') => ({ kind: 'rate', rate: r, source })
const SUB = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-5.3-codex-spark']
const MODELS = {
  choices: [
    cloud('deepseek-flash', 'deepseek', rate(0.3, 'stats')),
    cloud('deepseek-v4-pro', 'deepseek', rate(1, 'stats'), 'no'),
    cloud('deepseek-v4-flash-0731', 'deepseek', { kind: 'free' }, 'no'),
    cloud('qwen3.8-max', 'qwen', rate(1.6, 'stats')),
    cloud('glm-5.3', 'zhipu', rate(0.9)),
    cloud('kimi-k3', 'moonshot', rate(1.3, 'stats')),
    cloud('MiniMax-M2.5', 'minimax', rate(0.4)),
    cloud('gpt-5.6-sol', 'openai', rate(4.2)),
    ...SUB.map((m) => ({
      id: `openai-codex/${m}`,
      label: 'ChatGPT 订阅',
      official: false,
      vision: m.includes('spark') ? 'no' : 'ok',
      group: 'subscription',
      vendor: 'openai',
      price: { kind: 'subscription' },
    })),
    {
      id: 'deepseek/deepseek-flash',
      label: 'DeepSeek 官方 · 官方 API 接口连接',
      official: false,
      vision: 'no',
      group: 'own',
      vendor: 'deepseek',
      price: { kind: 'own_key' },
    },
  ],
  default: 'openai-codex/gpt-5.5',
  rate_base: { model: 'deepseek-v4-pro', fallback: false },
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}
const DEFAULTS = {
  default: 'openai-codex/gpt-5.5',
  by_purpose: {},
  budget: {},
  choices: [
    { id: 'agentsws/deepseek-flash', label: 'Agents 工坊（用积分）（deepseek-flash）' },
    { id: 'agentsws/qwen3.8-max', label: 'Agents 工坊（用积分）（qwen3.8-max）' },
    ...SUB.map((m) => ({ id: `openai-codex/${m}`, label: `ChatGPT 订阅（${m}）` })),
    { id: 'deepseek/deepseek-flash', label: 'DeepSeek 官方 · 官方 API 接口连接（deepseek-flash）' },
  ],
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
      await page.route(/\/v1\/models\/defaults(\?.*)?$/, (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, json: { data: DEFAULTS, trace_id: 'tr_shot' } })
          : route.continue(),
      )
      return { context, page }
    }
    const shot = async (target, name, clip) => {
      await target.waitForTimeout?.(600)
      await target.screenshot({ path: join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
      console.log(`  ✓ ${name}.png`)
    }

    // 1–2. 岗位页：AI 钮（订阅）+ 展开（浅色 / 深色）
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ width: 1280, height: 860, theme })
      await page.goto(`${BASE}/positions/${duty.id}`, { waitUntil: 'networkidle' })
      const pick = page.locator('[data-testid="position-handoff"] [data-testid="model-pick"]')
      await pick.waitFor({ timeout: 30_000 })
      await pick.scrollIntoViewIfNeeded()
      if (theme === 'light') await shot(page, 'model-button-subscription-light')
      await pick.click()
      await page.locator('[data-testid="model-pick-menu"]').waitFor()
      await page.mouse.move(0, 0)
      await shot(page, `model-picker-${theme}`)
      await context.close()
    }

    // 3. 设置 → 模型：默认模型下拉里的订阅那几项（下拉摊开）
    {
      const { context, page } = await open({ width: 1280, height: 860, theme: 'light' })
      await page.goto(`${BASE}/settings?tab=models`, { waitUntil: 'networkidle' })
      const select = page.locator('[data-testid="model-default-select"]')
      await select.waitFor({ timeout: 30_000 })
      await select.evaluate((el) => {
        el.setAttribute('size', String(Math.min(el.options.length, 10)))
      })
      await select.scrollIntoViewIfNeeded()
      const box = await page.locator('[data-testid="model-defaults"]').boundingBox()
      await shot(
        page,
        'settings-default-model-subscription',
        box === null
          ? undefined
          : {
              x: Math.max(0, box.x - 16),
              y: Math.max(0, box.y - 16),
              width: box.width + 32,
              height: Math.min(box.height + 32, 520),
            },
      )
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
