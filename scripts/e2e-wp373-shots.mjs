#!/usr/bin/env node
/**
 * WP373（Luoye 10-17）：思考程度成了 AI 钮右边的独立小钮；选的模型用不了亮小黄点（977）；换了模型插一句（978）——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4473，不碰 4317）。演示世界没登录订阅、也没接自己的模型，所以**只在浏览器这一侧**把几条只读接口
 * 换成示意数据（`/v1/free-chat/models` AI 钮清单、`/v1/cloud/credits` 余额、事项详情里的 `model`、事项时间线）：
 * 不填任何 key、不登录任何账号、不发任何请求出去。档位取自官方目录（订阅 gpt-5.5 三档、DeepSeek 四档、pi-ai 里只声明 off + high 的 gpt-5-pro）。
 *
 * 拍：
 * 1. 岗位页输入框：AI 钮 + 右边「标准」小钮、点开三档（浅 / 深）；
 * 2. 换成只支持开 / 关的模型：小钮变成开关；
 * 3. 换成工坊积分（没声明档位）：没有小钮；
 * 4. 事项页：这件事原来选的模型用不了——AI 钮亮小黄点；时间线里换过模型的地方一行「上面是 X 答的，接下来用 Y」（浅 / 深）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp373-shots.mjs [--port 4473]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp373')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4473') || 4473
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
const THINK_TOGGLE = {
  options: [{ level: 'standard', effort: 'high' }],
  default: 'high',
  toggle: true,
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
      id: 'openai-codex/gpt-5.5',
      label: 'ChatGPT 订阅',
      official: false,
      vision: 'ok',
      group: 'subscription',
      vendor: 'openai',
      price: { kind: 'subscription' },
      name: 'GPT-5.5',
      context_window: 272_000,
      native_search: true,
      thinking: THINK_SUB,
    },
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
      id: 'relay/gpt-5-pro',
      label: '我的中转站',
      official: false,
      vision: 'ok',
      group: 'own',
      vendor: 'openai',
      price: { kind: 'own_key' },
      name: 'GPT-5 Pro',
      thinking: THINK_TOGGLE,
    },
  ],
  default: 'openai-codex/gpt-5.5',
  rate_base: { model: 'deepseek-v4-pro', fallback: false },
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}
/** 事项时间线（示意）：先用 DeepSeek 账号答，人换成 ChatGPT 订阅再问一句。 */
const timelineOf = (matter_id) => {
  const at = (m) => `2026-10-17T09:${String(m).padStart(2, '0')}:00.000Z`
  const ev = (id, kind, text, m, extra = {}) => ({
    id,
    matter_id,
    at: at(m),
    kind,
    text,
    actor:
      kind === 'human_message'
        ? { kind: 'person', id: 'per_shot' }
        : { kind: 'agent', id: 'asg_shot' },
    ...extra,
  })
  return {
    events: [
      ev('ev_1', 'human_message', '帮我把这周退货多的三个原因列一下', 1),
      ev(
        'ev_2',
        'agent_message',
        '这周退货主要是：尺码偏小（41%）、颜色和图不符（27%）、物流破损（18%）。',
        2,
        {
          model: 'deepseek-account/deepseek-flash',
        },
      ),
      ev('ev_3', 'human_message', '尺码偏小那条，给详情页写一段尺码提示', 5),
      ev(
        'ev_4',
        'agent_message',
        '建议加在尺码表上方：「这款偏小一码，平时穿 M 的选 L」。要我直接改详情页吗？',
        6,
        {
          model: 'openai-codex/gpt-5.5',
        },
      ),
    ],
    has_more: false,
  }
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
    const auth = { headers: { authorization: `Bearer ${session}` } }
    const me = (await (await fetch(`${BASE}/v1/me`, auth)).json()).data
    const duty = me.assignments.find(
      (a) => a.role_id !== 'common.owner' && a.role_id !== 'common.member',
    )
    // 事项列表按岗位取（一次请求一个分配）；找第一个有事项的
    let matter
    for (const a of me.assignments) {
      const res = await fetch(`${BASE}/v1/matters`, {
        headers: { ...auth.headers, 'x-assignment': a.id },
      })
      const body = await res.json()
      matter = body.data?.matters?.[0]
      if (matter !== undefined) break
    }
    if (matter === undefined) throw new Error('demo 里没有事项')

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
      // 事项：原来选的模型（示意：一个已经删掉的中转站模型）+ 换过模型的时间线
      await page.route(new RegExp(`/v1/matters/${matter.id}(\\?.*)?$`), async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const response = await route.fetch()
        const json = await response.json()
        const m = json.data.matter ?? json.data
        m.model = 'old-relay/gpt-4o-mini'
        // 默认那 20 条在详情里（`timeline`）
        json.data.timeline = timelineOf(matter.id).events
        return route.fulfill({ response, json })
      })
      return { context, page }
    }
    const clipOf = async (page, selector, pad = 10, extraTop = 0) => {
      const box = await page.locator(selector).first().boundingBox()
      if (box === null) return undefined
      return {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad - extraTop),
        width: box.width + pad * 2,
        height: box.height + pad * 2 + extraTop,
      }
    }
    const shot = async (page, name, clip) => {
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
      console.log(`  ✓ ${name}.png`)
    }
    const HANDOFF = '[data-testid="position-handoff"]'

    // 1–3. 岗位页输入框
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ width: 1280, height: 900, theme })
      await page.goto(`${BASE}/positions/${duty.id}`, { waitUntil: 'networkidle' })
      const think = page.locator(`${HANDOFF} [data-testid="model-pick-thinking"]`)
      await think.waitFor({ timeout: 30_000 })
      await think.scrollIntoViewIfNeeded()
      await think.click()
      await page.locator('[data-testid="model-pick-thinking-menu"]').waitFor()
      await page.mouse.move(0, 0)
      await shot(page, `thinking-levels-${theme}`, await clipOf(page, HANDOFF, 12, 150))
      await page.keyboard.press('Escape')
      if (theme === 'light') {
        // 2. 只支持开 / 关的模型
        await page.locator(`${HANDOFF} [data-testid="model-pick"]`).click()
        await page
          .locator('[data-testid="model-pick-option"][data-model="relay/gpt-5-pro"]')
          .click()
        await page.locator(`${HANDOFF} [data-testid="model-pick-thinking-switch"]`).waitFor()
        await page.mouse.move(0, 0)
        await shot(page, 'thinking-toggle-light', await clipOf(page, HANDOFF, 12))
        // 3. 工坊积分：没声明档位 → 没有小钮
        await page.locator(`${HANDOFF} [data-testid="model-pick"]`).click()
        await page
          .locator('[data-testid="model-pick-option"][data-model="agentsws/deepseek-flash"]')
          .click()
        await page.mouse.move(0, 0)
        await shot(page, 'thinking-none-light', await clipOf(page, HANDOFF, 12))
      }
      await context.close()
    }

    // 4. 事项页：小黄点 + 换模型那一行
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ width: 1280, height: 900, theme })
      await page.goto(`${BASE}/matters/${matter.id}`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="model-pick-stale"]').waitFor({ timeout: 30_000 })
      await page.locator('[data-testid="thread-model-switch"]').waitFor({ timeout: 30_000 })
      await page.mouse.move(0, 0)
      await shot(page, `matter-switch-stale-${theme}`)
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
