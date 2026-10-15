#!/usr/bin/env node
/**
 * WP344：官网上用的工作台截图（首屏、「怎么干活」那一段、岗位页三张），从当前代码的演示世界重拍。
 * 产物进 `apps/site/src/assets/app/`，官网构建时由 astro:assets 压成多尺寸。
 *
 * ```
 * pnpm exec tsc -b apps/cli apps/workstation          # 演示世界与工作台要先编好
 * pnpm -F @agentsws/workstation exec vite build
 * node apps/site/scripts/app-shots.mjs [--port 4398]  # 自己起一个 demo，拍完即停
 * node apps/site/scripts/app-shots.mjs --attach 4399  # 或者连一个已经在跑的 demo
 * ```
 *
 * 演示世界没接模型：「回答就是图表」那张照 scripts/e2e-wp336-shots.mjs 的做法，拦下岗位入口的回包，
 * 换成服务端会回的那种形状（genui 那块用契约里同一份 `filterGenuiSpec` 现过滤）。
 * 只听 127.0.0.1；不碰 4317 / 4480。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const OUT = join(ROOT, 'apps/site/src/assets/app')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const ATTACH = value('--attach', undefined)
const PORT = Number(ATTACH ?? value('--port', '4398'))
if (PORT === 4317 || PORT === 4480) throw new Error('4317 / 4480 是别人的端口，换一个')
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
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（120 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()).data
}

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}

async function api(token, owner, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(owner === undefined ? {} : { 'x-assignment': owner }),
    },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

/** 「回答就是图表」：店里的商品问答（与 WP336 截图同一份演示数）。 */
const PRODUCTS = {
  zh: [
    ['USB-C 65W 充电器', 129, 340, '在卖'],
    ['GaN 旅行转换头', 89, 120, '在卖'],
    ['编织数据线 2m', 22.5, 860, '在卖'],
    ['10000mAh 充电宝', 59, 210, '在卖'],
  ],
}
const QUESTION = '这周店里卖得怎么样'
const LEAD = '这周 126 单，销售额 $9,840，比上周多 9%。数据线卖得最多。'
const RAW = {
  items: [
    {
      type: 'grid',
      cols: 3,
      items: [
        { type: 'stat', label: '订单', value: '126', delta: '+12%' },
        { type: 'stat', label: '销售额', value: '$9,840', delta: '+9%' },
        { type: 'stat', label: '转化', value: '3.4%', delta: '+0.3' },
      ],
    },
    {
      type: 'chart',
      kind: 'bars',
      horizontal: true,
      data: PRODUCTS.zh.map(([label, , stock]) => ({ label, value: stock })),
    },
    { type: 'table', columns: ['商品', '价格', '库存', '状态'], rows: PRODUCTS.zh },
  ],
}

async function quickAnswer(page, asg, filterGenuiSpec) {
  const answer = {
    lead: LEAD,
    components: [{ kind: 'genui', spec: filterGenuiSpec(RAW).spec }],
    sources: ['店里的商品列表', '最近的订单'],
  }
  await page.route('**/v1/positions/*/matters', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (json.data?.mode === 'quick')
      json.data.answer = { ...json.data.answer, outcome: 'answered', text: LEAD, ...answer }
    await route.fulfill({ response: res, json })
  })
  await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle', timeout: 120_000 })
  const box = page.locator('[data-testid="position-entry-input"]')
  await box.waitFor({ timeout: 30_000 })
  await box.click()
  await box.fill(QUESTION)
  await box.press('Enter')
  await page.waitForSelector('[data-testid="quick-answer"][data-state="done"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="answer-genui"]', { timeout: 30_000 })
  await page.unroute('**/v1/positions/*/matters')
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { filterGenuiSpec } = await import(join(ROOT, 'packages/contracts/dist/index.js'))
  mkdirSync(OUT, { recursive: true })
  const demo = ATTACH === undefined ? startDemo() : undefined
  let browser
  try {
    await waitForDemo(demo?.log ?? [])
    const token = await login()
    const me = await api(token, undefined, '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const instances = (await api(token, owner, '/v1/positions')).instances ?? []
    const asgOf = (id) => {
      const p = instances.find((x) => x.position_id === id)
      return p?.roles.find((r) => r.my_assignment_id !== undefined)?.my_assignment_id
    }

    browser = await chromium.launch({ headless: true })
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 820 },
        deviceScaleFactor: 1,
        colorScheme: scheme,
        reducedMotion: 'reduce',
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
      page.on('pageerror', (e) => console.error(`  页面报错：${e.message}`))
      const snap = async (name) => {
        await page.waitForTimeout(600)
        await page.screenshot({ path: join(OUT, `${name}.png`) })
        console.log(`  ${name}.png`)
      }

      // ① 首屏：工作台首页（卡片流）
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 })
      await snap(`home-${scheme}`)

      // ② 「怎么干活」：岗位页上问一句，回答是数字卡 + 图表 + 表格
      const web = asgOf('web-ops')
      if (web !== undefined) {
        await quickAnswer(page, web, filterGenuiSpec)
        await snap(`answer-${scheme}`)
      } else console.error('  演示世界里没有网站运营岗位，跳过回答那张')

      // ③ 岗位页三张（只拍浅色）
      if (scheme === 'light') {
        for (const [id, name] of [
          ['customer-care', 'role-support'],
          ['kol-marketing', 'role-kol'],
          ['b2b', 'role-b2b'],
        ]) {
          const asg = asgOf(id)
          if (asg === undefined) {
            console.error(`  演示世界里没有 ${id}，跳过`)
            continue
          }
          await page.setViewportSize({ width: 1360, height: 760 })
          await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
          await snap(name)
        }
      }
      await context.close()
    }
  } finally {
    await browser?.close()
    demo?.child.kill('SIGTERM')
  }
}

await main()
