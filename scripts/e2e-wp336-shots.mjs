#!/usr/bin/env node
/**
 * WP336（决策 810–812）：当场回答新旧两种画法的对比截图，可重跑出处。起一个 demo（演示世界，端口默认 4396，
 * 拍完即停），**同一个问题、同一份数**各拍一张：
 *
 * 1. `wp336-old-answer`：WP291 的 ```answer 画法（表格 + 数字）——回退开关 `AGENTSWS_QUICK_ANSWER_UI=answer` 时就是它；
 * 2. `wp336-new-genui`：```dsh-ui 经契约白名单过滤后交给 dsh-genui 渲染层（数字卡 + 表格 + 柱状图 + 提示）；
 *    模型那段里故意夹了按钮 / 图片 / 外链，截图里看不到它们；
 * 3. `wp336-new-funnel`：漏斗（echart 预设，本机打包的图表引擎）；
 * 4. `wp336-new-genui-dark`：第 2 张的深色；
 * 5. `wp336-thread-genui`：点「接着聊」进线程——同一段话里的 ```dsh-ui 由所有 AI 回话共用的正文渲染器就地画。
 *
 * 演示世界没接模型，所以同 WP291 的截图脚本：拦下岗位入口的回包，把回答换成服务端会回的那种形状
 * （genui 那块用契约同一份 `filterGenuiSpec` 现过滤）。服务端那一半由 `apps/server/test/wp336-genui-answer.test.ts` 钉住。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp336-shots.mjs [--port 4396]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp336')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4396'))
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

const { filterGenuiSpec } = await import(join(ROOT, 'packages/contracts/dist/index.js'))

const QUESTION = '店里有哪些商品，卖得怎么样'
const LEAD = '店里现在有 6 件商品，5 件在卖、1 件是草稿；今天 18 单。'
const PRODUCTS = [
  ['USB-C 65W 充电器', 129, 340, '在卖'],
  ['GaN 旅行转换头', 89, 120, '在卖'],
  ['编织数据线 2m', 22.5, 860, '在卖'],
  ['MagSafe 车载支架', 45, 75, '在卖'],
  ['10000mAh 充电宝', 59, 210, '在卖'],
  ['桌面充电站（新品）', 159, 0, '草稿'],
]

const OLD = {
  lead: LEAD,
  components: [
    {
      kind: 'metric',
      items: [
        { label: '在卖', value: 5, unit: '件' },
        { label: '今天订单', value: 18, unit: '单', delta_pct: 12.5 },
        { label: '销售额', value: 2380, unit: '美元', delta_pct: 9.1 },
      ],
    },
    { kind: 'table', columns: ['商品', '价格', '库存', '状态'], rows: PRODUCTS },
  ],
  sources: ['店里的商品列表', '最近的订单'],
}

/** 模型写的那段 ```dsh-ui（夹着按钮 / 图片 / 外链——过滤后看不到）。 */
const RAW_GENUI = {
  items: [
    {
      type: 'grid',
      cols: 3,
      items: [
        { type: 'stat', label: '在卖', value: '5 件' },
        { type: 'stat', label: '今天订单', value: '18 单', delta: '+12.5%' },
        { type: 'stat', label: '销售额', value: '$2,380', delta: '+9.1%' },
      ],
    },
    { type: 'table', columns: ['商品', '价格', '库存', '状态'], rows: PRODUCTS },
    {
      type: 'chart',
      kind: 'bars',
      horizontal: true,
      data: PRODUCTS.map(([label, , stock]) => ({ label, value: stock })),
    },
    {
      type: 'callout',
      tone: 'warning',
      title: '注意',
      content: '「桌面充电站」还是草稿、库存 0，[去后台](https://admin.example.com)上架前先补货。',
    },
    { type: 'button', label: '一键上架', action: 'publish' },
    { type: 'image', src: 'https://cdn.example.com/banner.png' },
    { type: 'link', label: '后台', href: 'https://admin.example.com' },
  ],
}

const RAW_FUNNEL = {
  items: [
    {
      type: 'echart',
      preset: 'funnel',
      title: '本周转化',
      data: [
        { label: '访问', value: 4200 },
        { label: '加购', value: 610 },
        { label: '下单', value: 230 },
        { label: '付款', value: 198 },
      ],
    },
    { type: 'callout', tone: 'info', content: '加购到下单掉得最多（38%），先看结账页。' },
  ],
}

const genuiAnswer = (lead, raw) => ({
  lead,
  components: [{ kind: 'genui', spec: filterGenuiSpec(raw).spec }],
  sources: ['店里的商品列表', '最近的订单'],
  raw,
})

const blockOf = (a) =>
  a.raw === undefined
    ? [a.lead, '', '```answer', JSON.stringify({ components: a.components }), '```'].join('\n')
    : [a.lead, '', '```dsh-ui', JSON.stringify(a.raw), '```'].join('\n')

async function quick(page, asg, question, answer) {
  const { raw: _raw, ...shown } = answer
  await page.route('**/v1/positions/*/matters', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (json.data?.mode === 'quick') {
      json.data.answer = { ...json.data.answer, outcome: 'answered', text: answer.lead, ...shown }
      const id = json.data.matter.id
      await page.route(`**/v1/matters/${id}`, async (r) => {
        const got = await r.fetch()
        const view = await got.json()
        for (const e of view.data.timeline) if (e.kind === 'agent_message') e.text = blockOf(answer)
        await r.fulfill({ response: got, json: view })
      })
    }
    await route.fulfill({ response: res, json })
  })
  await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle', timeout: 120_000 })
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
  mkdirSync(SHOTS, { recursive: true })
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
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 1100 },
        colorScheme: scheme,
      })
      await context.addInitScript(
        ([t, s]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', s)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, scheme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      const requests = []
      page.on('request', (r) => requests.push(r.url()))

      if (scheme === 'light') {
        await quick(page, asg, QUESTION, OLD)
        await page.waitForSelector('[data-testid="answer-table"]')
        await shot(page, 'wp336-old-answer', true)
      }
      await quick(page, asg, QUESTION, genuiAnswer(LEAD, RAW_GENUI))
      await page.waitForSelector('[data-testid="answer-genui"] table')
      await shot(page, scheme === 'light' ? 'wp336-new-genui' : 'wp336-new-genui-dark', true)
      if (scheme === 'light') {
        // 接着聊 → 线程里同一段话（带 ```dsh-ui）由正文渲染器就地画（所有 AI 回话同一份）
        await page.click('[data-testid="quick-answer-continue"]')
        await page.waitForURL(/\/matters\//, { timeout: 30_000 })
        await page.waitForSelector(
          '[data-testid="matter-reply"] [data-testid="answer-genui"] table',
          {
            timeout: 30_000,
          },
        )
        await shot(page, 'wp336-thread-genui')
        await quick(
          page,
          asg,
          '这周转化怎么样',
          genuiAnswer('这周访问 4200，付款 198，转化 4.7%。', RAW_FUNNEL),
        )
        await page.waitForSelector('[data-testid="answer-genui"] canvas', { timeout: 20_000 })
        await page.waitForTimeout(1200)
        await shot(page, 'wp336-new-funnel', true)
      }
      const outside = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:'))
      console.log(
        `  ${scheme}：页面发往别处的请求 ${outside.length} 个${outside.length === 0 ? '' : `：${outside.join(', ')}`}`,
      )
      await context.close()
    }
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
