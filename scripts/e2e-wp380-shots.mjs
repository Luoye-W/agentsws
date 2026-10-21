#!/usr/bin/env node
/**
 * WP380：GEO 第二层的截图，可重跑出处（不联网、不接 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），往这个品牌的 `geo.sqlite` 里写三周**录好的样本**
 * （`@agentsws/seo-core` 的 GEO_SAMPLE_*：NordVolt 与两个竞品，`.example` 域名，没有任何真实店铺数据）
 * 与当时模型的判断，再拍（浅 / 深各一张）：
 *
 * 1. `1-quality-{light,dark}`：「SEO 与 GEO」看板最下面「说得对不对 · 比得过谁」那一块；
 * 2. `2-consistency-card-{light,dark}`：对外说法分派卡（官方事实对 demo 夹具页：结构化数据 → 建站、
 *    页面里的旧说法 → 公关——demo 店的自家域名是 shop.example，夹具页按站外页算）；
 * 3. `3-recheck-card-{light,dark}`：到期复查的建议卡（前 → 后、扩大）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp380-shots.mjs [--port 4380]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp380')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4380')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const CONTENT = 'li@nordvolt.example'

const seo = await import(pathToFileURL(join(ROOT, 'packages/seo-core/dist/index.js')).href)
const { GEO_SAMPLE_ANSWERS, parseInsightReply, promptId } = seo

/** 复查那一问到期重问时：四家都提到我们（演示「扩大」）。 */
const RECHECK_Q = 'Cheapest reliable power bank?'
const searchStandIn = () => ({
  status: async () => ({
    configured: true,
    route: 'official',
    platforms: ['chatgpt', 'gemini', 'google_ai_overview'],
    prices: { serp: 0.2, ai_answer: 0.2 },
  }),
  serp: async (q) => ({
    query: q,
    items: [],
    fetched_at: '2026-10-15T00:00:00Z',
    source: 'official',
  }),
  aiAnswers: async (p) =>
    p.platforms.map((platform) => ({
      platform,
      answer_excerpt: '',
      answer_markdown:
        p.question === RECHECK_Q
          ? 'NordVolt Air is the cheapest reliable pick right now; Anker costs a little more.'
          : 'Anker and Belkin are the usual picks.',
      citations: [],
      brand_mentioned: false,
      our_domain_cited: false,
      cited_urls: [],
      competitors_mentioned: [],
      fetched_at: '2026-10-15T09:00:00Z',
      source: 'official',
      credits: 0.2,
    })),
})

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-assignment': assignment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
async function login(email) {
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}

const WEEKS = ['2026-09-28', '2026-10-05', '2026-10-12']
const PROMPTS = [...new Set(GEO_SAMPLE_ANSWERS.map((s) => s.prompt))]

/** 三周录好的回答：前两周有几句说错（准确度从低往高走），判断照录好的回文。 */
function seed(store, facts, competitors) {
  const anker = competitors.find((c) => c.name === 'Anker')?.id ?? 'c_anker'
  const belkin = competitors.find((c) => c.name === 'Belkin')?.id ?? 'c_belkin'
  WEEKS.forEach((week, w) => {
    const run = `run_geo380_${week}`
    store.startRun({
      id: run,
      kind: 'geo',
      trigger: 'scheduled',
      period: week,
      status: 'done',
      planned: GEO_SAMPLE_ANSWERS.length,
      answered: GEO_SAMPLE_ANSWERS.length,
      credits: 0,
      started_at: `${week}T08:30:00Z`,
      finished_at: `${week}T08:45:00Z`,
    })
    // 第三周之前少一条「对」的（s5 那条还没提到我们），胜率与准确度往上走
    const list =
      w === 2 ? GEO_SAMPLE_ANSWERS : GEO_SAMPLE_ANSWERS.filter((s) => s.id !== 's1' || w > 0)
    for (const s of list) {
      const id = `ans380_${week}_${s.id}`
      const ours = s.text.includes('NordVolt')
      store.recordAnswer(
        {
          id,
          run_id: run,
          prompt_id: promptId(s.prompt),
          prompt_text: s.prompt,
          asked_text: s.prompt,
          platform: s.platform,
          model: s.platform === 'claude' ? 'claude-sonnet-5' : 'web',
          via: s.platform === 'claude' ? 'model_api' : 'web_ui',
          market: 'US',
          language: 'en',
          status: 'ok',
          answer_md: s.text,
          answer_hash: id,
          fetched_at: `${week}T09:00:00Z`,
          credits: 0.2,
        },
        [],
        [
          {
            answer_id: id,
            entity: 'ours',
            name_snapshot: 'NordVolt',
            mentioned: ours,
            cited: false,
            ...(ours ? { rank: 1 } : {}),
            rules_version: 1,
          },
          {
            answer_id: id,
            entity: anker,
            name_snapshot: 'Anker',
            mentioned: s.text.includes('Anker'),
            cited: false,
            rules_version: 1,
          },
          {
            answer_id: id,
            entity: belkin,
            name_snapshot: 'Belkin',
            mentioned: s.text.includes('Belkin'),
            cited: false,
            rules_version: 1,
          },
        ],
      )
      if (!ours) continue
      const got = parseInsightReply(s.reply, s.text, { mentioned: true, facts, rivals: s.rivals })
      store.setInsight({ answer_id: id, ...got, judged_at: `${week}T09:05:00Z` })
    }
  })
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-15T09:00:00Z'),
    searchDataFor: () => searchStandIn(),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    // 注：demo 店在监测里的自家域名是 shop.example（按 Search Console 页面认的），夹具页在 nordvolt.example，
    // 所以这里那张商品页按「站外页」归公关——真品牌里官网域名来自品牌档案，商品页归网站运营。
    const li = await login(CONTENT)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${li}` } })).json()
    ).data
    const content = me.assignments.find(
      (a) => a.role_id === 'dtc.seo' && a.revoked_at === undefined,
    )
    const positionId = content.position_id ?? content.id
    const view = await call(li, content.id, 'PUT', '/v1/seo/watch', {
      brand_aliases: ['NordVolt', 'NordVolt Air'],
      competitors: [
        { id: 'c_anker', name: 'Anker', aliases: [], domains: ['anker.com'] },
        { id: 'c_belkin', name: 'Belkin', aliases: [], domains: ['belkin.com'] },
      ],
      platforms: ['chatgpt', 'gemini', 'claude', 'google_ai_overview'],
      prompt_limit: 5,
      add_prompts: PROMPTS.map((text) => ({ text, selected: true })),
    })
    // 官方事实：先写旧说法、再改（旧的进 previous，演示「过时」）——人在这里改的不被档案盖
    await call(li, content.id, 'PUT', '/v1/seo/watch/facts', {
      facts: [
        { key: 'name', value: 'NordVolt' },
        { key: 'category', value: 'Trail Power 300' },
        { key: 'price', value: '$39–$59' },
        {
          key: 'selling_points',
          value: 'flight-safe 10000mAh, charges a phone three times, 180 g',
        },
        { key: 'markets', value: 'US, DE' },
      ],
    })
    const facts = await call(li, content.id, 'PUT', '/v1/seo/watch/facts', {
      facts: [
        { key: 'category', value: 'travel power bank' },
        { key: 'price', value: '$45–$69' },
      ],
    })
    const ws = content.workspace_id ?? demo.server.bootstrap.workspace.id
    const seoService = (await demo.server.brands.forWorkspace(ws)).seoService
    const store = await seoService.geoHistory()
    seed(store, facts, view.watch.competitors)
    // 对外说法：对 demo 店的首页与商品页（离线夹具）
    const cons = await call(li, content.id, 'POST', '/v1/seo/watch/consistency', {
      urls: ['https://nordvolt.example/products/trail-power-300'],
    })
    // 复查：一条已到期的（改之前那一问四家里 1 家提到我们）→ 现在重问 → 扩大
    store.saveRecheck({
      id: 'grc_demo',
      created_at: '2026-10-01T09:00:00Z',
      source: 'alert',
      change: '「最便宜靠谱的充电宝」那页加了价格对比小节',
      metric: 'mention_rate',
      prompt_ids: [promptId(RECHECK_Q)],
      due: '2026-10-15',
      before: { value: 0, n: 3, week: '2026-09-28' },
      status: 'waiting',
      owner: 'content',
    })
    store.saveRecheck({
      id: 'grc_wait',
      created_at: '2026-10-12T09:00:00Z',
      source: 'consistency',
      change: '对外说法改 2 处（建站、公关）',
      metric: 'accuracy',
      prompt_ids: PROMPTS.map((t) => promptId(t)),
      due: '2026-11-09',
      before: { value: 0.5, n: 6 },
      status: 'waiting',
      owner: 'content',
    })
    const [done] = await seoService.watchRecheckDue()
    console.log(`  品牌域名：${view.watch.brand.domains.join(', ')}`)
    const m = await call(li, content.id, 'GET', '/v1/seo/watch/metrics')
    console.log(
      `  看板：周 ${m.week}，方格 ${m.grid === undefined ? '无' : '有'}，判过的项 ${m.quality?.fields.length}`,
    )
    console.log(
      `  一致性 ${cons.findings.length} 处（卡 ${cons.card_id ?? '无'}）；复查 ${done?.advice ?? done?.status}`,
    )

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 2000 },
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
        [li, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${encodeURIComponent(positionId)}/duties/dtc.seo`, {
        waitUntil: 'networkidle',
      })
      // WP372 起职责自己的看板在右侧面板「报表」下半截：点小链接打开，再「显示更多」加宽
      // WP421：WP412 起这个链接收进「⋯ 这条职责能做什么」里——先打开那一页
      await page.getByTestId('duty-about-link').click({ timeout: 20_000 })
      await page.getByTestId('duty-boards-link').click({ timeout: 20_000 })
      const more = page.getByTestId('rail-card-more-reports')
      if ((await more.count()) > 0) await more.click()
      const wide = page.getByTestId('rail-panel-wide')
      if ((await wide.count()) > 0) await wide.first().click()
      const q = page.locator('[data-testid="geo-quality"]')
      await q.waitFor({ timeout: 30_000 }).catch(async (err) => {
        await page.screenshot({ path: join(SHOTS, `debug-${theme}.png`) })
        console.error(`  页面在 ${page.url()}`)
        throw err
      })
      await q.scrollIntoViewIfNeeded()
      await page.waitForTimeout(1200)
      await q.screenshot({ path: join(SHOTS, `1-quality-${theme}.png`) })
      console.log(`  📷 1-quality-${theme}.png`)
      if (cons.card_id !== undefined) {
        await page.goto(`${BASE}/cards/${cons.card_id}`, { waitUntil: 'networkidle' })
        await page.locator('[data-testid="deck-geo-consistency"]').waitFor({ timeout: 20_000 })
        await page.waitForTimeout(400)
        await page
          .locator('[data-testid="deck-card"]')
          .first()
          .screenshot({ path: join(SHOTS, `2-consistency-card-${theme}.png`) })
        console.log(`  📷 2-consistency-card-${theme}.png`)
      }
      if (done?.card_id !== undefined) {
        await page.goto(`${BASE}/cards/${done.card_id}`, { waitUntil: 'networkidle' })
        await page.locator('[data-testid="deck-geo-recheck"]').waitFor({ timeout: 20_000 })
        await page.waitForTimeout(400)
        await page
          .locator('[data-testid="deck-card"]')
          .first()
          .screenshot({ path: join(SHOTS, `3-recheck-card-${theme}.png`) })
        console.log(`  📷 3-recheck-card-${theme}.png`)
      }
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
