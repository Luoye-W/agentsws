#!/usr/bin/env node
/**
 * WP291（决策 356）：岗位入口三分的截图，可重跑出处。起一个 demo（演示世界，端口默认 4391，拍完即停）：
 *
 * 1. `wp291-quick-table`：问「店里有哪些商品」→ 输入框下面当场答：一句话 + 商品表格 + 依据；
 * 2. `wp291-quick-metric`：问「今天卖得怎么样」→ 一句话 + 数字；
 * 3. `wp291-continue-thread`：点「接着聊」→ 进会话线程，一问一答都在、表格照样画；
 * 4. `wp291-task-thread`：「上架一个草稿商品」→ 发出去直接进任务线程，头一句「记成了任务，按「X」做」。
 *
 * 演示世界没接模型（stub 运行时只回一句话、不出 ```answer 段），所以前两张拦下岗位入口的回包、把回答换成契约里
 * 那种「一句话 + 组件」（商品取演示店铺里的），拍的是真界面怎么画它；判断与组件的服务端那一半由
 * `apps/server/test/wp291-entry-three-way.test.ts` 钉住。第 4 张是演示世界原样（没接模型按规则判成任务）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp291-shots.mjs [--port 4391]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp291')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4391'))
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


const TABLE_ANSWER = {
  lead: '店里现在有 6 件商品，5 件在卖、1 件是草稿。',
  components: [
    {
      kind: 'table',
      columns: ['商品', '价格', '库存', '状态'],
      rows: [
        ['USB-C 65W 充电器', 129, 340, '在卖'],
        ['GaN 旅行转换头', 89, 120, '在卖'],
        ['编织数据线 2m', 22.5, 860, '在卖'],
        ['MagSafe 车载支架', 45, 75, '在卖'],
        ['10000mAh 充电宝', 59, 210, '在卖'],
        ['桌面充电站（新品）', 159, 0, '草稿'],
      ],
    },
  ],
  sources: ['店里的商品列表'],
}
const METRIC_ANSWER = {
  lead: '今天到现在 18 单，比昨天同一时间多一成多。',
  components: [
    {
      kind: 'metric',
      items: [
        { label: '今天订单', value: 18, unit: '单', delta_pct: 12.5 },
        { label: '销售额', value: 2380, unit: '美元', delta_pct: 9.1 },
        { label: '客单价', value: 132.2, unit: '美元', delta_pct: -3 },
      ],
    },
  ],
  sources: ['最近的订单'],
}

/** 把回答换成「一句话 + 组件」（契约那种形状），连同线程里那段话一起换，界面前后一致。 */
const blockOf = (a) =>
  [a.lead, '', '```answer', JSON.stringify({ components: a.components }), '```'].join('\n')

async function quick(page, asg, question, answer) {
  await page.route('**/v1/positions/*/matters', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (json.data?.mode === 'quick') {
      json.data.answer = { ...json.data.answer, outcome: 'answered', text: answer.lead, ...answer }
      const id = json.data.matter.id
      await page.route(`**/v1/matters/${id}`, async (r) => {
        const got = await r.fetch()
        const view = await got.json()
        for (const e of view.data.timeline)
          if (e.kind === 'agent_message') e.text = blockOf(answer)
        await r.fulfill({ response: got, json: view })
      })
    }
    await route.fulfill({ response: res, json })
  })
  await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
  const box = page.locator('[data-testid="position-entry-input"]')
  await box.waitFor({ timeout: 30_000 })
  await box.click()
  await box.fill(question)
  await box.press('Enter')
  await page.waitForSelector('[data-testid="quick-answer"][data-state="done"]', { timeout: 60_000 })
  await page.unroute('**/v1/positions/*/matters')
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
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const mine = await api(token, owner, 'GET', '/v1/positions')
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

    // 2. 数字回答（先拍，免得表格那条的「接着聊」把页面带走）
    await quick(page, asg, '今天卖得怎么样', METRIC_ANSWER)
    await shot(page, 'wp291-quick-metric')

    // 1. 表格回答 + 依据展开
    await quick(page, asg, '店里有哪些商品', TABLE_ANSWER)
    await page.click('[data-testid="quick-answer-basis"]')
    await shot(page, 'wp291-quick-table')

    // 3. 接着聊 → 会话线程（一问一答都在）
    await page.click('[data-testid="quick-answer-continue"]')
    await page.waitForURL(/\/matters\//, { timeout: 20_000 })
    await page.waitForSelector('[data-testid="answer-table"]', { timeout: 20_000 })
    await shot(page, 'wp291-continue-thread')

    // 4. 交一件事 → 直接进任务线程
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    const box = page.locator('[data-testid="position-entry-input"]')
    await box.click()
    await box.fill('上架一个草稿商品')
    await box.press('Enter')
    await page.waitForURL(/\/matters\//, { timeout: 30_000 })
    await page.waitForSelector('[data-sys="route"]', { timeout: 20_000 })
    await page.waitForTimeout(2500)
    await shot(page, 'wp291-task-thread')
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
