#!/usr/bin/env node
/**
 * WP370（Luoye 10-17）：AI 钮的思考程度、显示名、能力小标；设置里自定义接口「也在 AI 钮里显示」——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4470，不碰 4317）。演示世界没登录 ChatGPT 订阅、也没接自己的模型，所以**只在浏览器这一侧**
 * 把几条只读接口换成示意数据（`/v1/free-chat/models` AI 钮清单、`/v1/cloud/credits` 余额、`/v1/models/providers`
 * 已接的那一条）：不填任何 key、不登录任何账号、不发任何请求出去。思考档取自官方 pi-ai 订阅目录（gpt-5.5）。
 *
 * 拍：
 * 1. 岗位页 AI 钮展开（选了 ChatGPT 订阅 · GPT-5.5，底下「思考：快 / 标准 / 深度」）：浅色 / 深色；
 * 2. 选了「深度」之后的钮（「ChatGPT 订阅 · GPT-5.5 · 深度」）；
 * 3. 设置 → 模型：改一条自定义接口，「也在 AI 钮里显示」勾选清单。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp370-shots.mjs [--port 4470]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp370')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4470') || 4470
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const CREDITS = {
  linked: true,
  balance: { available: 96.059, low_balance: false, low_balance_threshold: 10 },
  can_topup: true,
  can_view_usage: true,
}
const THINK_SUB = {
  options: [
    { level: 'fast', effort: 'low' },
    { level: 'standard', effort: 'medium' },
    { level: 'deep', effort: 'high' },
  ],
  default: 'medium',
}
const THINK_DS = {
  options: [
    { level: 'fast', effort: 'low' },
    { level: 'standard', effort: 'high' },
    { level: 'deep', effort: 'max' },
  ],
  default: 'high',
}
const sub = (id, name, vision = 'ok') => ({
  id: `openai-codex/${id}`,
  label: 'ChatGPT 订阅',
  official: false,
  vision,
  group: 'subscription',
  vendor: 'openai',
  price: { kind: 'subscription' },
  name,
  context_window: id.includes('spark') ? 128_000 : 272_000,
  native_search: true,
  thinking: THINK_SUB,
})
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
      id: 'agentsws/qwen3.8-max',
      label: 'Agents 工坊（用积分）',
      official: true,
      vision: 'ok',
      group: 'workshop',
      vendor: 'qwen',
      price: { kind: 'rate', rate: 1.6, source: 'stats' },
    },
    sub('gpt-5.5', 'GPT-5.5'),
    sub('gpt-5.6-sol', 'GPT-5.6 Sol'),
    sub('gpt-6-sol', 'GPT-6 Sol'),
    sub('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 'no'),
    {
      id: 'deepseek-account/deepseek-flash',
      label: 'DeepSeek 账号',
      official: false,
      vision: 'ok',
      group: 'own',
      vendor: 'deepseek',
      price: { kind: 'own_key' },
      name: 'DeepSeek-V4.1-Flash',
      thinking: THINK_DS,
    },
    {
      id: 'relay/claude-sonnet-4.5',
      label: '我的中转站',
      official: false,
      vision: 'unchecked',
      group: 'own',
      vendor: 'anthropic',
      price: { kind: 'own_key' },
    },
  ],
  default: 'openai-codex/gpt-5.5',
  rate_base: { model: 'deepseek-v4-pro', fallback: false },
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}
const PROVIDERS = [
  {
    id: 'relay',
    kind: 'openai_compatible',
    label: '我的中转站',
    base_url: 'https://relay.example.com/v1',
    model: 'claude-sonnet-4.5',
    region: 'global',
    has_key: true,
    active: true,
    models: ['claude-sonnet-4.5', 'gpt-4.1', 'gemini-2.5-pro', 'qwen3.8-max', 'kimi-k3', 'glm-5.3'],
    picker_models: ['gpt-4.1', 'gemini-2.5-pro'],
    last_listing: {
      ok: true,
      models: [
        'claude-sonnet-4.5',
        'gpt-4.1',
        'gemini-2.5-pro',
        'qwen3.8-max',
        'kimi-k3',
        'glm-5.3',
      ],
      checked_at: '2026-10-17T08:00:00.000Z',
    },
  },
]

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
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`  console: ${m.text().slice(0, 500)}`)
      })
      await page.route(/\/v1\/cloud\/credits(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: CREDITS, trace_id: 'tr_shot' } }),
      )
      await page.route(/\/v1\/free-chat\/models(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, json: { data: MODELS, trace_id: 'tr_shot' } }),
      )
      // 已接的那几条：照真回包，只把示意的那一条自定义接口接在后面（模板等照旧）
      await page.route(/\/v1\/models\/providers(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const response = await route.fetch()
        const json = await response.json()
        json.data.providers = [...(json.data.providers ?? []), ...PROVIDERS]
        return route.fulfill({ response, json })
      })
      return { context, page }
    }
    const shot = async (target, name, clip) => {
      await target.waitForTimeout?.(600)
      await target.screenshot({ path: join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
      console.log(`  ✓ ${name}.png`)
    }

    // 1–2. 岗位页：AI 钮展开（浅 / 深）；选「深度」之后的钮
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ width: 1280, height: 900, theme })
      await page.goto(`${BASE}/positions/${duty.id}`, { waitUntil: 'networkidle' })
      const pick = page.locator('[data-testid="position-handoff"] [data-testid="model-pick"]')
      await pick.waitFor({ timeout: 30_000 }).catch(async (e) => {
        await page.screenshot({ path: join(SHOTS, `debug-${theme}.png`) })
        console.error(`  url=${page.url()}`)
        console.error(`  body=${(await page.locator('body').innerText()).slice(0, 2000)}`)
        throw e
      })
      await pick.scrollIntoViewIfNeeded()
      await pick.click()
      await page.locator('[data-testid="model-pick-menu"]').waitFor()
      await page.mouse.move(0, 0)
      await shot(page, `model-picker-thinking-${theme}`)
      if (theme === 'light') {
        await page.locator('[data-testid="model-pick-thinking-deep"]').click()
        await page.keyboard.press('Escape')
        await page.mouse.move(0, 0)
        const box = await page.locator('[data-testid="position-handoff"]').boundingBox()
        await shot(
          page,
          'model-button-deep-light',
          box === null
            ? undefined
            : {
                x: Math.max(0, box.x - 8),
                y: Math.max(0, box.y - 8),
                width: box.width + 16,
                height: box.height + 16,
              },
        )
      }
      await context.close()
    }

    // 3. 设置 → 模型：改那条自定义接口，「也在 AI 钮里显示」
    {
      const { context, page } = await open({ width: 1280, height: 1000, theme: 'light' })
      await page.goto(`${BASE}/settings?tab=models`, { waitUntil: 'networkidle' })
      const row = page.locator('[data-testid="model-row"][data-id="relay"]')
      await row.waitFor({ timeout: 30_000 })
      await row.getByRole('button', { name: '改' }).click()
      const field = page.locator('[data-testid="model-picker-models"]')
      await field.waitFor()
      await field.scrollIntoViewIfNeeded()
      const top = await row.boundingBox()
      const end = await field.boundingBox()
      await shot(
        page,
        'settings-picker-models-light',
        top === null || end === null
          ? undefined
          : {
              x: Math.max(0, top.x - 16),
              y: Math.max(0, top.y - 16),
              width: top.width + 32,
              height: end.y + end.height - top.y + 32,
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
