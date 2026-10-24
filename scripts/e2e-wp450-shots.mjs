#!/usr/bin/env node
/**
 * WP450：编辑日历（第三栏三格）与「一组主题」卡（中栏）的截图，可重跑出处（不联网、不接 AI、不连真实店、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停）。搜索结果、官方数据接口（关键词概况、外链）、最近发布的文章
 * 都换成替身：搜索结果与外链是 `@agentsws/seo-core` 的合成样本（`plan-samples.ts`，录好的回包形状），网页是 demo 里现编的
 * 几页（含一份过时的 llms.txt）。拍浅 / 深两套：
 *
 * 1. `1-cluster-card-<theme>`：中栏「一组主题」卡（总页 + 分页、哪天写、回头改哪页、凭什么分成一组）；
 * 2. `2-calendar-<theme>`：批了之后第三栏「编辑日历 · 日历」（按天、最近发布「改写成社媒稿」）；
 * 3. `3-backlinks-<theme>`：「外链」那一格（来源域名变化、要看的、锚文本、可疑来源、竞品差距已交公关）；
 * 4. `4-llms-<theme>`：「llms.txt」那一格（体检判过时、生成的那份、交建站）；
 * 5. `5-rail-card-<theme>`：卡片列那张「编辑日历」卡（第三栏收着时）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp450-shots.mjs [--port 5090] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
/** 截图放哪（审稿截图放私有仓，别提交进公开仓：`--out <私有仓>/docs/assets/wp450`）。 */
const SHOTS = resolve(
  argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, 'docs/assets/wp450'),
)
const at = argv.indexOf('--port')
const PORT = Number(at >= 0 ? argv[at + 1] : '5090')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = 'nordvolt.myshopify.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call(undefined, undefined, 'POST', '/v1/auth/magic-link', { email })
  return (await call(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token }))
    .session_token
}

async function ensureAssignment(token, owner, me, role_id) {
  const hit = me.assignments.find((a) => a.role_id === role_id && a.revoked_at === undefined)
  if (hit !== undefined) return hit.id
  return (
    await call(token, owner, 'POST', '/v1/assignments', {
      person_id: me.person.id,
      role_id,
      ranges: [],
    })
  ).id
}

/** 店铺授权（demo 替身：装 CLI → 填店 → 授权）。体检要它读商品。 */
async function authorizeShop(token, store) {
  const q = `/v1/shop-admin?roles=dtc.store`
  let view = await call(token, store, 'GET', q)
  if (view.state === 'no_cli') {
    await call(token, store, 'POST', '/v1/shop-admin/run', {
      action: 'install',
      roles: ['dtc.store'],
    })
    for (let i = 0; i < 90 && view.state === 'no_cli'; i += 1) {
      await sleep(1000)
      view = await call(token, store, 'GET', q)
    }
  }
  if (view.state === 'no_store')
    view = await call(token, store, 'PUT', '/v1/shop-admin/store', {
      store: SHOP,
      roles: ['dtc.store'],
    })
  if (view.state !== 'authorized')
    await call(token, store, 'POST', '/v1/shop-admin/run', {
      action: 'authorize',
      roles: ['dtc.store'],
    })
  for (let i = 0; i < 90 && view.state !== 'authorized'; i += 1) {
    await sleep(1000)
    view = await call(token, store, 'GET', q)
  }
}

async function open(browser, token, theme, path) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1.5,
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
    [token, theme],
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  return { page, context }
}

async function openPanel(page) {
  if ((await page.getByTestId('rail-cards').count()) === 0)
    await page.getByTestId('rail-toggle').click()
  const card = page.getByTestId('rail-card-seo-plan')
  await card.waitFor({ timeout: 30_000 })
  if ((await card.getAttribute('data-open')) !== 'true')
    await page.getByTestId('rail-card-toggle-seo-plan').click()
  await page.waitForTimeout(800)
  return card
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const core = await import(pathToFileURL(join(ROOT, 'packages/seo-core/dist/index.js')).href)
  const serp = core.planSampleSerp()
  const paa = serp['usb c charger'].people_also_ask
  const stand = core.standInSearchData({ serp })
  // 样本里没有的词：没有结果（分组时照实排除）；品类词那一次带「大家还问」
  const searchData = {
    ...stand,
    serp: async (q) => {
      const r = await stand.serp(q)
      return r.items.length > 0 ? r : { ...r, people_also_ask: paa, credits: 0.2 }
    },
  }
  const data = {
    capabilities: async () => ({
      at: '2026-10-22T00:00:00.000Z',
      capabilities: [
        {
          id: 'seo.backlink_summary',
          label_zh: '外链概况',
          label_en: 'Backlink summary',
          group: 'seo',
          mode: 'sync',
          unit: 'call',
          credits_per_unit: 0.88,
          available: true,
          input: [],
        },
        {
          id: 'seo.backlinks',
          label_zh: '外链列表',
          label_en: 'Backlinks',
          group: 'seo',
          mode: 'sync',
          unit: 'row',
          credits_per_unit: 0.01,
          available: true,
          input: [],
        },
      ],
    }),
    call: async (capability, input) => {
      if (capability === 'seo.keyword_overview') return core.PLAN_SAMPLE_OVERVIEW
      if (capability === 'seo.backlink_summary') return core.BACKLINK_SAMPLE_SUMMARY
      const comp = core.BACKLINK_SAMPLE_COMPETITORS.get(String(input.input.target))
      return comp ?? core.BACKLINK_SAMPLE_ROWS
    },
  }
  const post = {
    change_id: 'chg_demo_post',
    title: 'How to choose a USB-C charger for your laptop',
    url: 'https://nordvolt.example/blogs/guide/how-to-choose-a-usb-c-charger',
    published_at: '2026-10-20T09:00:00.000Z',
    body: '<p>Most 13-inch laptops charge fine at 65W.</p><h2>Check the wattage</h2><p>Look for the watt number on your laptop brick first.</p><h2>Look for GaN</h2><p>GaN chargers run cooler and are smaller.</p><h2>One cable or two</h2><p>A 2-port charger covers a laptop and a phone.</p>',
  }
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-22T09:00:00Z'),
    searchDataFor: () => searchData,
    seoPlanDataFor: () => data,
    seoPublishedFor: async () => [post],
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const token = await login(OWNER)
    const me = await call(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    await call(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    const state = await call(token, owner, 'GET', '/v1/onboarding/state')
    await call(token, owner, 'PUT', '/v1/workspace/profile', {
      legal_name: state.profile?.legal_name ?? 'NordVolt Gear Ltd.',
      domain: 'nordvolt.example',
      // 主题簇的种子词（品类）与 llms.txt 的一句话介绍
      subcategory: 'usb c charger',
      one_liner: 'USB-C chargers, cables and power banks for desk and travel.',
    })
    const store = await ensureAssignment(token, owner, me, 'dtc.store')
    // 交出去的事项要有人接：建站（网页模板）、公关（新闻稿）、社媒（X / LinkedIn / TikTok）、内容与博客
    for (const r of [
      'site.shopify-theme',
      'pr.press',
      'social.x',
      'social.linkedin',
      'social.tiktok',
      'dtc.content',
    ])
      await ensureAssignment(token, owner, me, r)
    await authorizeShop(token, store)
    const liToken = await login('li@nordvolt.example')
    const liMe = await call(liToken, undefined, 'GET', '/v1/me')
    const liSeo = liMe.assignments.find((a) => a.role_id === 'dtc.seo' && !a.revoked_at)?.id
    if (liSeo === undefined) throw new Error('李默名下没有 SEO 与 GEO')
    const health = await call(liToken, liSeo, 'POST', '/v1/site-health/run', {})
    console.log(`  体检 llms.txt：${JSON.stringify(health.run?.llms_txt)}`)
    const planned = await call(liToken, liSeo, 'POST', '/v1/seo/clusters/plan', {})
    console.log(
      `  一组主题：${planned.approval_item_id ?? planned.skipped} · ${JSON.stringify(planned.cost)} · ${JSON.stringify(planned.notes)}`,
    )
    if (process.env.WP450_DEBUG !== undefined)
      console.log(stand.calls.map((c) => c.key).join(' | '))
    const path = `/positions/${encodeURIComponent(liSeo)}/duties/dtc.seo`
    for (const theme of ['light', 'dark']) {
      const { page, context } = await open(browser, liToken, theme, path)
      const body = page.getByTestId('seo-cluster-card').first()
      await body.waitFor({ timeout: 60_000 })
      await page
        .getByTestId('seo-cluster-overlap')
        .first()
        .evaluate((el) => {
          el.open = true
        })
      await page.waitForTimeout(800)
      const box = page.locator('[data-testid="deck-card"]', { has: body }).first()
      await ((await box.count()) > 0 ? box : body).screenshot({
        path: join(SHOTS, `1-cluster-card-${theme}.png`),
      })
      console.log(`  📷 1-cluster-card-${theme}.png`)
      await context.close()
    }
    // 批整组（卡底那排「就这样」= 原样批）
    const card = await call(
      liToken,
      liSeo,
      'GET',
      `/v1/approvals/${encodeURIComponent(planned.approval_item_id)}`,
    )
    const decided = await call(
      liToken,
      liSeo,
      'POST',
      `/v1/approvals/${encodeURIComponent(planned.approval_item_id)}/decide`,
      {
        action: 'approve',
        version: card.version,
        via: 'workstation',
      },
    )
    console.log(`  批：${decided?.state ?? JSON.stringify(decided).slice(0, 200)}`)
    await sleep(500)
    const cal = await call(liToken, liSeo, 'GET', '/v1/seo/calendar')
    console.log(`  日历：${cal.entries.length} 篇 · 等批 ${JSON.stringify(cal.pending ?? [])}`)
    const bl = await call(liToken, liSeo, 'PUT', '/v1/seo/backlinks', {
      competitors: ['voltpeak.example', 'chargely.example'],
    })
    console.log(`  外链设置：${JSON.stringify(bl.estimate)}`)
    const run = await call(liToken, liSeo, 'POST', '/v1/seo/backlinks/run', {})
    console.log(
      `  外链体检：${run.status} · ${run.issues.length} 条 · 差距 ${run.gap.length} · 交公关 ${run.handed_to_pr?.matter_id}`,
    )
    const llms = await call(liToken, liSeo, 'POST', '/v1/seo/llms-txt', { handoff: true })
    console.log(
      `  llms.txt：${llms.draft?.sections.map((s) => `${s.title}:${s.links}`).join(' ')} · 交建站 ${llms.handed_to_site?.matter_id}`,
    )
    const rp = await call(liToken, liSeo, 'POST', '/v1/seo/repurpose', {
      change_id: post.change_id,
      channels: ['x', 'linkedin', 'short_video'],
    })
    console.log(
      `  社媒稿：${rp.drafts.length} 份 · ${rp.matters.length} 件事 · 跳过 ${JSON.stringify(rp.skipped)}`,
    )
    for (const theme of ['light', 'dark']) {
      const { page, context } = await open(browser, liToken, theme, path)
      const railCard = await openPanel(page)
      await page.waitForTimeout(1200)
      await railCard.screenshot({ path: join(SHOTS, `5-rail-card-${theme}.png`) })
      console.log(`  📷 5-rail-card-${theme}.png`)
      await page.getByTestId('rail-card-open-seo-plan').click()
      const panel = page.getByTestId('seo-plan-panel')
      await panel.waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1500)
      await page.screenshot({ path: join(SHOTS, `2-calendar-${theme}.png`) })
      console.log(`  📷 2-calendar-${theme}.png`)
      await page.getByTestId('seo-plan-tab-backlinks').click()
      await page.getByTestId('seo-plan-backlinks').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(SHOTS, `3-backlinks-${theme}.png`) })
      console.log(`  📷 3-backlinks-${theme}.png`)
      await page.getByTestId('seo-plan-tab-llms').click()
      await page.getByTestId('seo-plan-llms').waitFor({ timeout: 30_000 })
      await page.getByTestId('seo-plan-llms-how').evaluate((el) => {
        el.open = true
      })
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(SHOTS, `4-llms-${theme}.png`) })
      console.log(`  📷 4-llms-${theme}.png`)
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
