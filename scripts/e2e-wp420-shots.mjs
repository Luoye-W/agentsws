#!/usr/bin/env node
/**
 * WP420（自查 ads-amazon）投放与 Amazon 运营补通：端到端走一遍 + 截图（不联网、不接真 AI、不碰 4317、
 * 不碰任何真广告后台或 Amazon；读页、广告库全是 demo 替身）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时 + 替身读页），先打接口、再用 Playwright 点界面：
 *
 * **投放**：照推荐建「投放」→ 看板 `GET /v1/ads/overview` 出数（今天花费 / 总闸 / 广告系列）→ 改出价、换素材
 * 不出卡（照实说还没接通）→ 改预算出卡（插件没连：回执带连接、卡上一行「批了先排队」）→ 岗位上问「今天花了多少」，
 * stub 剧本查数并给越线的那条出止损卡 → 岗位页右栏「报表」里的投放看板、连接卡里插件那两行、改预算卡（截图）。
 *
 * **Amazon 运营**：照推荐建「Amazon 运营」→ 面板上改自家 ASIN（`PUT /v1/amazon-listing/own`）→ 体检 → 问「看看我的 Listing」
 * stub 剧本看体检结果（不再出客服回信卡）→ Amazon 客服不算 Amazon 运营的（左栏不出两份）→ 体检块与体检卡（截图）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp420-shots.mjs --out <截图目录> [--port 4555]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4555'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp420-shots')))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

let assignment
async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(token === undefined || assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', undefined, { email })
  return (await call('POST', '/v1/auth/verify', undefined, { token: link.token })).session_token
}

const check = (ok, what) => {
  if (!ok) throw new Error(`✗ ${what}`)
  console.log(`  ✓ ${what}`)
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(600)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

async function build(owner, text, template) {
  const own = assignment
  const out = await call('POST', '/v1/onboarding/suggest', owner, { text })
  const plan = out.positions.find((p) => p.template_id === template)
  check(plan !== undefined, `推荐划分出 ${template}`)
  await call('POST', '/v1/onboarding/apply', owner, {
    position_ids: [],
    role_ids: [],
    positions: [plan],
  })
  assignment = own
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const { DEMO_OWN_ASINS } = await import(
    pathToFileURL(join(ROOT, 'apps/cli/dist/demo-amazon-listing.js')).href
  )
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-19T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = await call('GET', '/v1/me', owner)
    assignment = (me.assignments ?? []).find((a) => a.role_id === 'common.owner')?.id

    // ── 投放 ───────────────────────────────────────────────────────────────
    console.log('投放')
    await build(owner, '我们在 Meta 和 Google 上投广告', 'ads')
    const me2 = await call('GET', '/v1/me', owner)
    const meta = (me2.assignments ?? []).find((a) => a.role_id === 'ads.meta')?.id
    check(meta !== undefined, '负责人担着 Meta Ads')
    assignment = meta
    const ov = await call('GET', '/v1/ads/overview', owner)
    check(
      typeof ov.spend_today === 'number' && ov.spend_today > 0 && ov.campaigns.length >= 2,
      `看板出数：今天花了 ${ov.spend_today}、${ov.campaigns.length} 条广告系列、总闸还剩 ${ov.spend_gate.remaining}`,
    )
    const bid = await call('POST', '/v1/ads/campaigns/cmp_demo_meta_2/bid', owner, { value: 3 })
    check(bid.staged === false && /还没接通/.test(bid.message), '改出价不出卡，照实说还没接通')
    const swap = await call('POST', '/v1/ads/ads/ad_demo_1/creative', owner, {
      primary_text: '换一版更短的文案。',
    })
    check(
      swap.staged === false && /改广告/.test(swap.message),
      '换素材不出卡，指去「改广告」那条路',
    )
    const ask = await call('POST', `/v1/positions/${meta}/matters`, owner, {
      title: '今天花了多少？总闸还剩多少？哪条广告系列花得最多？',
      role_id: 'ads.meta',
      mode: 'chat',
    })
    const textOf = (a) =>
      typeof a === 'string' ? a : typeof a?.text === 'string' ? a.text : JSON.stringify(a ?? '')
    const answer = textOf(ask.answer)
    if (process.env.WP420_DEBUG === '1') console.log(JSON.stringify(ask).slice(0, 1500))
    check(
      /今天一共花了/.test(answer),
      `问「今天花了多少」：stub 剧本查数（${answer.split('\n')[0]}）`,
    )
    check(/止损/.test(answer), '越线的那条：剧本出了止损卡（或照实说了没出成）')
    const budget = await call('POST', '/v1/ads/campaigns/cmp_demo_meta_2/budget', owner, {
      value: 330,
      reason: '老客回购好',
    })
    check(budget.staged === true, '改预算出卡')
    check(
      budget.needs_connection === 'extension' && /排队/.test(budget.message ?? ''),
      '插件没连：回执带连接、说清批了先排队',
    )

    // ── Amazon 运营 ────────────────────────────────────────────────────────
    console.log('Amazon 运营')
    await build(owner, '我们在 Amazon 美国站卖户外电源', 'amazon-ops')
    const me3 = await call('GET', '/v1/me', owner)
    const store = (me3.assignments ?? []).find((a) => a.role_id === 'amz.store')?.id
    check(store !== undefined, '负责人担着亚马逊店铺运营')
    assignment = store
    const own = await call('PUT', '/v1/amazon-listing/own', owner, {
      value: DEMO_OWN_ASINS.map((a) => a.asin).join('，'),
    })
    check(own.ok === true, '在 Amazon 运营面板上改自家 ASIN（不用内容与搜索的权限）')
    const view0 = await call('GET', '/v1/amazon-listing', owner)
    check((view0.own ?? []).length === 3, '面板上看得到自家三个 ASIN')
    const run = await call('POST', '/v1/amazon-listing/run', owner)
    check(
      (run.run?.items ?? []).every((i) => i.status === 'checked'),
      '体检三个 ASIN 都读到了',
    )
    const look = await call('POST', `/v1/positions/${store}/matters`, owner, {
      title: '看看我的 Listing 有什么问题',
      role_id: 'amz.store',
      mode: 'chat',
    })
    const said = textOf(look.answer)
    check(
      /体检了 3 个 ASIN/.test(said) && !/回复草稿|收件人/.test(said),
      `「看看我的 Listing」：${said}`,
    )
    const listed = await call('GET', '/v1/positions', owner)
    const amzPos = (listed.instances ?? []).find((p) => p.position_id === 'amazon-ops')
    const support = amzPos?.roles.find((r) => r.role_id === 'amz.support')
    check(
      support === undefined || support.my_assignment_id === undefined,
      'Amazon 客服不算 Amazon 运营的（左栏不出两份）',
    )
    const conns = await call('GET', `/v1/positions/${store}/connections`, owner)
    check(
      !(conns.missing_required ?? []).some((k) => /email|mail/u.test(k)),
      `Amazon 运营页不再冒「还缺必需的连接：邮箱」（缺：${(conns.missing_required ?? []).join('、') || '无'}）`,
    )

    // ── 截图 ───────────────────────────────────────────────────────────────
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1800 },
        colorScheme: theme,
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      // 投放岗位页
      const adsNav = page.getByTestId('nav-position').filter({ hasText: '投放' }).first()
      await adsNav.waitFor({ timeout: 30_000 })
      await adsNav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      await page.waitForTimeout(1500)
      // 改预算卡：在岗位页「要你处理」那副牌里，往后翻到它（第一张多半是插件连接卡）
      const change = page.getByTestId('ads-change-body').first()
      for (let i = 0; i < 4 && (await change.count()) === 0; i++) {
        const next = page.getByTestId('deck-next').first()
        if ((await next.count()) === 0 || !(await next.isEnabled())) break
        await next.click()
        await page.waitForTimeout(600)
      }
      if ((await change.count()) > 0) {
        await change.scrollIntoViewIfNeeded()
        const main = (await page.getByTestId('ads-change-main').first().textContent()) ?? ''
        check(/日预算 \$300 → \$330/.test(main), `改预算卡一行：${main}（${theme}）`)
        check(
          (await page.getByTestId('ads-change-queue-note').count()) > 0,
          `卡底一行「批了先排队」（${theme}）`,
        )
        await shot(page, `ads-1-budget-card-${theme}`, change.locator('xpath=../../..'))
      } else console.log('  （牌堆里没翻到改预算卡，跳过这张截图）')
      const entry = page.getByTestId('ad-creative-entry-open').first()
      await entry.waitFor({ timeout: 20_000 })
      await entry.click()
      const overview = page.getByTestId('ads-overview').first()
      await overview.waitFor({ timeout: 30_000 })
      const spend = (await page.getByTestId('ads-overview-spend').first().textContent()) ?? ''
      check(/\$\d/.test(spend), `右栏「报表」里投放看板出数：${spend}（${theme}）`)
      await shot(page, `ads-2-overview-${theme}`, overview)
      await shot(page, `ads-3-position-${theme}`)
      // Amazon 运营岗位页
      const amzNav = page.getByTestId('nav-position').filter({ hasText: 'Amazon 运营' }).first()
      await amzNav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'load' })
      const block = page.getByTestId('alst-block').first()
      await block.waitFor({ timeout: 60_000 })
      check(
        ((await page.getByTestId('alst-own-list').first().textContent()) ?? '').includes(
          'B0DEMONV01',
        ),
        `体检块上看得到自家 ASIN（${theme}）`,
      )
      await shot(
        page,
        `amz-1-listing-block-${theme}`,
        page.locator('[data-block="listing"]').first(),
      )
      await page.getByTestId('alst-asin').first().click()
      const card = page.getByTestId('alst-card').first()
      await card.waitFor({ timeout: 10_000 })
      check(
        (await card.getByTestId('alst-design').count()) <= 1,
        `体检卡：需求单按钮只在卡底一个（${theme}）`,
      )
      await card.scrollIntoViewIfNeeded()
      await shot(page, `amz-2-listing-card-${theme}`, card)
      await shot(page, `amz-3-position-${theme}`)
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
