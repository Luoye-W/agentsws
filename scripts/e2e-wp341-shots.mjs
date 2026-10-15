#!/usr/bin/env node
/**
 * WP341（决策 847）：genui 完全融合的截图，可重跑出处。起一个 demo（演示世界，端口默认 4397，拍完即停）：
 *
 * 1. `wp341-old-genui`：WP336 的画法（同一个问题、同一份数；按钮 / 图片 / 链接被滤掉）——拷自 `docs/assets/wp336/wp336-new-genui.png`；
 * 2. `wp341-new-genui` / `-dark`：同一个问题，现在按钮（接着问）、外部图片「点开看 · 域名」、链接都在；
 * 3. `wp341-form-prompts`：线程里 AI 给了一张表——在对话里勾 5 条 prompt、选尺寸、填日期；
 * 4. `wp341-form-submitted`：点「就这 5 条」→ 对话里多了一条人话摘要（数据段给 AI，不显示），AI 接着做；
 * 5. `wp341-settings-image-hosts`：设置里「直接显示图片的网站」那一行（849 白名单）。
 *
 * 演示世界没接模型：同 WP336 的脚本，拦下岗位入口 / 事项的回包，把 AI 那条换成服务端会回的形状
 * （genui 那块用契约同一份 `filterGenuiSpec` 现过滤）。处理器那一半由 `apps/workstation/test/wp341-genui-full.test.tsx` 钉住。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp341-shots.mjs [--port 4397]
 * ```
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp341')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4397'))
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

/** 同 WP336 那一份数；WP341 起按钮 / 图片 / 链接留着。 */
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
    { type: 'image', src: 'https://cdn.example.com/banner.png', alt: '首页横幅' },
    {
      type: 'row',
      items: [
        {
          type: 'button',
          label: '哪件卖得最好',
          action: 'say:这周哪件卖得最好？',
          tone: 'primary',
        },
        { type: 'button', label: '给充电站补货', action: 'say:帮我给桌面充电站补货' },
      ],
    },
  ],
}

const PROMPTS = ['夏日海边', '城市夜景', '森林晨雾', '雪山日出', '复古咖啡馆', '霓虹街头']
const RAW_FORM = {
  items: [
    { type: 'text', content: '我按店里的主推款写了 6 条出图 prompt，挑 5 条：' },
    ...PROMPTS.map((p) => ({ type: 'checkbox', group: 'prompts', label: p })),
    {
      type: 'grid',
      cols: 2,
      items: [
        {
          type: 'select',
          id: 'size',
          label: '尺寸',
          options: ['1:1', '9:16', '16:9'],
          selected: 1,
        },
        { type: 'input', id: 'when', label: '哪天发', inputType: 'date' },
      ],
    },
    { type: 'submit', label: '就这 5 条', groups: ['prompts'] },
  ],
}

const genuiAnswer = (lead, raw) => ({
  lead,
  components: [{ kind: 'genui', spec: filterGenuiSpec(raw).spec }],
  sources: ['店里的商品列表', '最近的订单'],
  raw,
})

const blockOf = (a) => [a.lead, '', '```dsh-ui', JSON.stringify(a.raw), '```'].join('\n')

/** 岗位入口问一句 → 当场回答换成给定的那一份；事项里第一条 AI 回话也换成同一段（只换那一条）。 */
async function quick(page, asg, question, answer) {
  const { raw: _raw, ...shown } = answer
  await page.route('**/v1/positions/*/matters', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (json.data?.mode === 'quick') {
      json.data.answer = { ...json.data.answer, outcome: 'answered', text: answer.lead, ...shown }
      const id = json.data.matter.id
      let first
      await page.route(`**/v1/matters/${id}`, async (r) => {
        const got = await r.fetch()
        const view = await got.json()
        for (const e of view.data.timeline)
          if (e.kind === 'agent_message' && (first === undefined || first === e.id)) {
            first = e.id
            e.text = blockOf(answer)
          }
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
  copyFileSync(
    join(ROOT, 'docs/assets/wp336/wp336-new-genui.png'),
    join(SHOTS, 'wp341-old-genui.png'),
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

      await quick(page, asg, QUESTION, genuiAnswer(LEAD, RAW_GENUI))
      await page.waitForSelector('[data-testid="answer-genui"] table')
      await page.waitForSelector('[data-testid="genui-media-gate"]')
      await page.hover('[data-testid="answer-genui"] a')
      await shot(page, scheme === 'light' ? 'wp341-new-genui' : 'wp341-new-genui-dark', true)
      if (scheme === 'light') {
        await quick(
          page,
          asg,
          '帮我写几条出图的 prompt',
          genuiAnswer('写好了 6 条，挑 5 条：', RAW_FORM),
        )
        await page.click('[data-testid="quick-answer-continue"]')
        await page.waitForURL(/\/matters\//, { timeout: 30_000 })
        const block = page.locator('[data-testid="matter-reply"] [data-testid="answer-genui"]')
        await block.waitFor({ timeout: 30_000 })
        for (const p of PROMPTS.slice(0, 5)) await block.getByLabel(p).check()
        await block.locator('input[type="date"]').fill('2026-10-20')
        await shot(page, 'wp341-form-prompts')
        await block.getByRole('button', { name: /就这 5 条/u }).click()
        await page.waitForSelector('[data-testid="matter-bubble"]:has-text("就这 5 条：")', {
          timeout: 30_000,
        })
        await page.waitForTimeout(1500)
        await shot(page, 'wp341-form-submitted')
        // 849：设置里那一行（点过一次「以后这个网站的图都直接显示」之后）
        await api(token, owner, 'POST', '/v1/settings/image-hosts', { host: 'cdn.example.com' })
        await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle', timeout: 120_000 })
        const hosts = page.locator('[data-testid="settings-image-hosts"]')
        await hosts.waitFor({ timeout: 30_000 })
        await hosts.scrollIntoViewIfNeeded()
        await page.waitForTimeout(400)
        await hosts.screenshot({ path: join(SHOTS, 'wp341-settings-image-hosts.png') })
        console.log('  📷 wp341-settings-image-hosts.png')
        // 删掉，深色那一轮照旧拍「点开看」
        await api(token, owner, 'DELETE', '/v1/settings/image-hosts/cdn.example.com')
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
