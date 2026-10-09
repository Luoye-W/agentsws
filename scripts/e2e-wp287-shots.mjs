#!/usr/bin/env node
/**
 * WP287：岗位入口真机整改的截图，可重跑出处。
 *
 * 起一个 demo（演示世界），在岗位页输入框里发几句：
 *
 * 0. `wp287-position-page`：岗位页——输入框与事项页同一个，「要你处理」不再一堆复盘；
 * 1. `wp287-ask-thread`：问一句 → 直接进会话线程，回答在线程里（不进「工作」）；
 * 2. `wp287-task-thread` / `wp287-task-in-work`：交办 → 进线程、线程里一句「记成了任务」，岗位「工作」里有它；
 * 3. `wp287-settled-line`：一个判据词都没命中 → 按先后取，「按 X 做的 · 换一条」；
 * 4. `wp287-failed`：没跑成的样子（演示世界造不出真失败：拦下读取补两条运行时会写的事件，拍真界面）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp287-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp287')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
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
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
  console.log(`  📷 ${name}.png`)
}

async function api(token, owner, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(owner === undefined ? {} : { 'x-assignment': owner }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

/** 在岗位页的输入框里打一句、回车 → 应该直接进这件事的会话线程。 */
async function say(page, asg, text) {
  await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
  const box = page.locator('[data-testid="position-entry-input"]')
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await page.waitForURL(/\/matters\//, { timeout: 20_000 })
  await page
    .waitForSelector('[data-kind="agent_message"], [data-testid="matter-running"]', {
      timeout: 20_000,
    })
    .catch(() => undefined)
  await page.waitForTimeout(2500)
  return page.url().split('/matters/')[1]
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const mine = await api(token, undefined, 'GET', '/v1/positions')
    const instances = mine.instances ?? []
    const web = instances.find((p) => p.position_id === 'web-ops') ?? instances[0]
    const asg = web.roles.find((r) => r.my_assignment_id !== undefined).my_assignment_id
    console.log(`  岗位：${web.name.zh}（${asg}）`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // 0. 岗位页：输入框与事项页同一个（框内箭头发送、没有「交给它」按钮）；「要你处理」不再一堆复盘
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    await shot(page, 'wp287-position-page')

    // 1. 问一句：直接进线程，回答就在线程里；这是一段会话（不进「工作」）
    const asked = await say(page, asg, '现在店铺里有哪些产品')
    await shot(page, 'wp287-ask-thread')

    // 2. 交办：进线程，线程里一句「记成了任务」；岗位页「工作」里有它
    const task = await say(page, asg, '把 A 商品降价 10%')
    await shot(page, 'wp287-task-thread')
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    await page
      .locator('[data-testid="work-section"], [data-testid="position-work"]')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => undefined)
    await shot(page, 'wp287-task-in-work', true)

    // 3. 一个判据词都没命中的交办：按先后取，线程里一行「按 X 做的 · 换一条」
    await say(page, asg, '把上周的情况整理成一份清单')
    await shot(page, 'wp287-settled-line')

    // 4. 没跑成：真机那种「运行一启动就失败」演示世界造不出来——拦下这件事的读取，在时间线末尾
    //    补上运行时会写的那两条（摘要 + 「没跑成：…」带失败标记），拍的是真界面怎么画它
    await page.route(`**/v1/matters/${task}`, async (route) => {
      const res = await route.fetch()
      const json = await res.json()
      const at = new Date().toISOString()
      json.data.timeline.push(
        {
          id: 'mev_shot_digest',
          matter_id: task,
          at,
          kind: 'status',
          text: '这次没跑成',
          actor: { kind: 'agent', id: asg },
          run_id: 'run_shot',
          run_digest: { seconds: 1, outcome: 'failed', steps: [] },
        },
        {
          id: 'mev_shot_fail',
          matter_id: task,
          at,
          kind: 'status',
          text: '没跑成：工坊这边出错了，已记下，点重试或稍后再试',
          actor: { kind: 'system', id: 'runtime' },
          run_id: 'run_shot',
          failed: { code: 'internal', retryable: false },
        },
      )
      delete json.data.live
      await route.fulfill({ response: res, json })
    })
    await page.goto(`${BASE}/matters/${task}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-retry"]')
    await shot(page, 'wp287-failed')
    console.log(`  会话 ${asked}、任务 ${task}`)
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
