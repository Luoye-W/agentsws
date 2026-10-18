#!/usr/bin/env node
/**
 * WP390（docs/105）：工坊服务——截图（浅 / 深各一张），可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里云是替身（示意服务目录；服务方是替身、自己往前走：
 * 报价 → 接单 → 要一次材料 → 交付），不连真云、不花真钱。关联（替身）工坊账号、给自己上网页模板职责，然后：
 *
 * 1. 「我想找个专业点的外包帮我重做网站」→ 回答末尾的推荐卡（工坊建站 · 起价 · 看看）；
 * 2. 另一件事里点「社媒互动」→ 价目单（勾两项、填数量与帖子链接，合计当场算）；
 * 3. 推荐卡上点「看看」→ AI 出需求单（填好）；提交 → 报价回来 → 下单卡（同意并支付）；
 * 4. 付了 → 服务方接单、问一句、要 Logo → 订单面板（在等你、消息、钱）；
 * 5. 回一句 → 第一段交付 → 验收卡（通过 / 要改 / 申请退款，几时自动通过）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsc -b
 * node scripts/e2e-wp390-shots.mjs [--port 4399] [--out <截图目录>]
 * ```
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
// 审稿截图不进公开仓（WP383）：默认写到私有仓旁边那份 agentsws-internal 的 docs/assets/wp390，`--out` 可改
// （主仓 ~/Documents/agentsws 的旁边，或 worktree ~/Documents/agentsws-wt/<名> 往上两层的旁边）
const INTERNAL = [join(ROOT, '../agentsws-internal'), join(ROOT, '../../agentsws-internal')].find(
  (d) => existsSync(d),
)
const SHOTS = resolve(
  argOf('--out') ?? join(INTERNAL ?? join(ROOT, '../agentsws-internal'), 'docs/assets/wp390'),
)
const PORT = Number(argOf('--port') ?? '4399') || 4399
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 演示多给 3000 积分，走得完一整单建站（报价 1200）
      env: { ...process.env, AGENTSWS_DEMO_SERVICE_CREDITS: '3000' },
    },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    let site = me.assignments.find((a) => a.role_id === 'site.shopify-theme')?.id
    if (site === undefined)
      site = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: 'site.shopify-theme',
          ranges: [],
        })
      ).id
    // 关联工坊账号（替身云：发信后一会儿像用户点了链接）
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    for (let i = 0; i < 60; i += 1) {
      if ((await api(token, owner, 'GET', '/v1/cloud/account')).linked === true) break
      await sleep(250)
    }
    const call = (method, path, body) => api(token, site, method, path, body)
    const timeline = async (m) => (await call('GET', `/v1/matters/${m}`)).timeline
    const waitTimeline = async (m, ok, what) => {
      for (let i = 0; i < 160; i += 1) {
        if (ok(await timeline(m))) return
        await sleep(250)
      }
      throw new Error(`等不到：${what}`)
    }
    const cardIn = async (m, form) => {
      for (let i = 0; i < 160; i += 1) {
        const ids = (await timeline(m)).map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await call('GET', `/v1/approvals/${id}`)
          if (card.payload?.form === form && card.state === 'pending') return card
        }
        await call('GET', '/v1/workshop-services/orders')
        await sleep(250)
      }
      throw new Error(`等不到 ${form} 卡`)
    }

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          if (window.localStorage.getItem('agentsws.theme') === null)
            window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [token],
    )
    const page = await context.newPage()
    // 机器忙时页面起得慢：放宽到两分钟
    page.setDefaultTimeout(120_000)
    page.setDefaultNavigationTimeout(120_000)
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const setTheme = (theme) =>
      page.evaluate((x) => window.localStorage.setItem('agentsws.theme', x), theme)
    /** 浅色拍一张、深色再拍一张（`prepare` 每次重开页面、走到要拍的那一刻，回要拍的那一块）。 */
    const both = async (name, prepare) => {
      for (const theme of ['light', 'dark']) {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
        await setTheme(theme)
        const target = await prepare()
        // 时间线最下面那张卡会被输入框盖住半截：滚到中间再拍
        await target.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => undefined)
        await page.waitForTimeout(500)
        await target.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
        console.log(`  📷 ${name}-${theme}.png`)
      }
      await setTheme('light')
    }

    // ① 推荐卡
    const m1 = (
      await call('POST', `/v1/positions/${site}/matters`, {
        title: '我想找个专业点的外包帮我重做网站',
        role_id: 'site.shopify-theme',
      })
    ).matter.id
    await waitTimeline(m1, (tl) => tl.some((e) => e.service_offer !== undefined), '推荐卡')
    await both('1-offer', async () => {
      await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="service-offer"]', { timeout: 30_000 })
      return page.locator('main')
    })

    // ② 价目单
    const m2 = (
      await call('POST', `/v1/positions/${site}/matters`, {
        title: '新帖子发出去没什么人互动',
        role_id: 'site.shopify-theme',
      })
    ).matter.id
    await waitTimeline(m2, (tl) => tl.some((e) => e.kind === 'agent_message'), '第二件事的回答')
    await call('POST', '/v1/workshop-services/start', {
      service_id: 'demo.engagement',
      matter_id: m2,
    })
    await cardIn(m2, 'service_menu')
    await both('2-menu', async () => {
      await page.goto(`${BASE}/matters/${m2}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="matter-service-card"]').last()
      await card.waitFor({ timeout: 30_000 })
      await card.locator('[data-testid="service-menu-pick-like"]').check()
      await card.locator('[data-testid="service-menu-qty-like"]').fill('50')
      await card
        .locator('[data-testid="service-menu-target-like-post_url"]')
        .fill('https://reddit.com/r/ebikes/comments/abc')
      await card.locator('[data-testid="service-menu-pick-comment"]').check()
      await card.locator('[data-testid="service-menu-qty-comment"]').fill('10')
      await card
        .locator('[data-testid="service-menu-target-comment-post_url"]')
        .fill('https://reddit.com/r/ebikes/comments/abc')
      return card
    })

    // ③ 需求单（推荐卡上点「看看」→ AI 出需求单）
    await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="service-offer-look"]')
    const req = await cardIn(m1, 'service_requirements')
    const answers = [
      { question_id: 'sell', answer: '电动自行车' },
      { question_id: 'market', answer: '美国' },
      { question_id: 'refs', answer: 'aventon.com' },
      { question_id: 'pages', answer: '首页 / 商品 / 关于我们 / 博客' },
      { question_id: 'assets', answer: '有商品图' },
    ]
    await both('3-requirements', async () => {
      await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="matter-service-card"]').last()
      await card.waitFor({ timeout: 30_000 })
      for (const a of answers)
        await card.locator(`[data-testid="service-req-${a.question_id}"]`).fill(a.answer)
      await card.locator('[data-testid="service-req-edit"]').click()
      return card
    })
    await call('POST', `/v1/approvals/${req.id}/decide`, {
      action: 'approve',
      via: 'workstation',
      edited_payload: { ...req.payload, answers },
    })

    // ④ 报价回来 → 下单卡
    const pay = await cardIn(m1, 'service_pay')
    await both('4-pay', async () => {
      await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="matter-service-card"]').last()
      await card.waitFor({ timeout: 30_000 })
      return card
    })
    await call('POST', `/v1/approvals/${pay.id}/decide`, { action: 'approve', via: 'workstation' })

    // ⑤ 订单面板（接单、问一句、要 Logo）
    let orderId
    for (let i = 0; i < 40; i += 1) {
      const list = await call('GET', '/v1/workshop-services/orders')
      // 本次这件事上的那一单（demo 目录里可能还留着上一次跑的单）
      const row = list.orders.find((o) => o.matter_id === m1)
      orderId = row?.order.id
      if (row?.order.status === 'waiting_user') break
      await sleep(300)
    }
    await both('5-order-panel', async () => {
      await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
      await page.click('[data-testid="account-toggle"]')
      await page.click('[data-testid="account-workshop-services"]')
      const row = page.locator(`[data-testid="service-order-row"][data-id="${orderId}"]`).first()
      await row.waitFor({ timeout: 30_000 })
      await row.click()
      await page.waitForSelector('[data-testid="service-order-panel"]', { timeout: 30_000 })
      return page.locator('[data-testid="rail-panel-frame"]')
    })

    // ⑥ 回一句 → 第一段交付 → 验收卡
    await call('POST', `/v1/workshop-services/orders/${orderId}/messages`, {
      text: 'Logo 原图发你邮箱了；首页放一段 15 秒的骑行视频。',
    })
    await cardIn(m1, 'service_acceptance')
    await both('6-acceptance', async () => {
      await page.goto(`${BASE}/matters/${m1}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="matter-service-card"]').last()
      await card.waitFor({ timeout: 30_000 })
      return card
    })
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
