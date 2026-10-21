#!/usr/bin/env node
/**
 * WP335（docs/99 O3）：AI 回答监测界面的截图，可重跑出处（不联网、不接 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），往这个品牌的 `geo.sqlite` 里写四周**现编**的
 * 回答与引用（NordVolt 与两个竞品，域名都是 `.example` 或公开大站名，没有任何真实店铺数据），再拍：
 *
 * 1. `1-geo-board`：「SEO 与 GEO」职责页最上面的看板（数字 ×4、趋势、方格、关注词排名、被引用最多的站、对比）；
 * 2. `2-geo-answer`：点方格一格 → 第三栏「一条回答」（折叠、高亮、编号引用、时间线）；
 * 3. `3-geo-answer-compare`：勾上「和上周比」；
 * 4. `4-geo-watch-settings`：「设定 → 关注设置」；
 * 5. `5-geo-watch-card`：设定卡点「改」之后（卡自己的页面 `/cards/<卡号>`）；
 * 6. `6-brand-category`：设置页「这个品牌」多出的「品类」一格。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp335-shots.mjs [--port 4435]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp335')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4435')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const CONTENT = 'li@nordvolt.example'

/** 搜索数据替身（官方那一档）：只为让面板认「接上了」；这一轮不真问（历史是下面直接写进去的）。 */
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
    fetched_at: '2026-10-12T00:00:00Z',
    source: 'official',
  }),
  aiAnswers: async () => [],
})

async function post(path, body, token, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
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

const WEEKS = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']
const PLATFORMS = ['chatgpt', 'gemini', 'claude', 'google_ai_overview']
const PROMPTS = [
  'What is the best power bank for long flights?',
  'Which portable charger do travel bloggers recommend?',
  'Best power bank for camping trips?',
  'Anker or Belkin for a travel power bank?',
  'Is NordVolt a good power bank brand?',
]
/** 一格提没提到我们（越往后的周提到得越多；Claude 起步慢）。 */
const mentioned = (p, pl, w) =>
  (p * 7 + pl * 3 + w * 5) % 10 < 3 + w + (pl === 2 ? -1 : 0) || p === 4
const SITES = [
  ['reddit.com', 'forum', 'Best power bank for travel? : r/onebag'],
  ['travelgear.example', 'media', 'The 7 best travel power banks, tested'],
  ['nordvolt.example', 'ours', 'NordVolt Air 10000 — flight-safe power bank'],
  ['anker.com', 'competitor', 'Anker PowerCore 10000'],
  ['youtube.com', 'video', 'Power bank showdown for frequent flyers'],
  ['amazon.com', 'marketplace', 'Portable chargers — best sellers'],
]

function seed(store, ids, competitors) {
  const anker = competitors.find((c) => c.name === 'Anker')?.id ?? 'c_anker'
  const belkin = competitors.find((c) => c.name === 'Belkin')?.id ?? 'c_belkin'
  WEEKS.forEach((week, w) => {
    const run = `run_geo_${week}`
    const cells = PROMPTS.length * PLATFORMS.length
    store.startRun({
      id: run,
      kind: 'geo',
      trigger: 'scheduled',
      period: week,
      status: 'done',
      planned: cells,
      answered: cells,
      credits: 0,
      started_at: `${week}T08:30:00Z`,
      finished_at: `${week}T08:45:00Z`,
    })
    PROMPTS.forEach((text, p) => {
      PLATFORMS.forEach((platform, pl) => {
        const id = `ans_${week}_${p}_${pl}`
        const failed = w === 3 && p === 2 && platform === 'claude'
        const ours = mentioned(p, pl, w)
        const rank = ours ? 1 + ((p + pl + w) % 3) : undefined
        const pick = [0, 1, 3, 4, 5].filter((_, k) => (k + p + pl + w) % 3 !== 0).slice(0, 3)
        if (ours && (p + w) % 2 === 0) pick.splice(1, 0, 2)
        const cites = pick.map((k, i) => {
          const [domain, site_kind, title] = SITES[k]
          return {
            answer_id: id,
            position: i + 1,
            url: `https://${domain}/p/${p}`,
            url_norm: `https://${domain}/p/${p}`,
            domain,
            title,
            where: i === pick.length - 1 ? 'listed' : 'inline',
            site_kind,
          }
        })
        const lead = ours
          ? `For ${text.toLowerCase().includes('camping') ? 'camping' : 'travel'}, **NordVolt Air 10000** is a solid pick: light, flight-safe and charges a phone about three times [1].`
          : 'Most travellers go with a 10,000 mAh pack that fits airline rules [1].'
        const md = failed
          ? ''
          : `${rank === 1 || !ours ? lead : 'Anker PowerCore 10000 is the safe default [1].'}\n\n${
              ours && rank !== 1
                ? 'NordVolt Air 10000 is a lighter alternative that many reviewers like [2].'
                : 'Anker PowerCore 10000 is also popular and easy to find [2].'
            }${(p + w) % 2 === 0 ? '\n\nBelkin BoostCharge is worth a look if you want a cable built in.' : ''}`
        store.recordAnswer(
          {
            id,
            run_id: run,
            prompt_id: ids[p],
            prompt_text: text,
            asked_text: text,
            platform,
            model: platform === 'claude' ? 'claude-sonnet-5' : 'web',
            via:
              platform === 'claude'
                ? 'model_api'
                : platform === 'google_ai_overview'
                  ? 'serp'
                  : 'web_ui',
            market: 'US',
            language: 'en',
            status: failed ? 'failed' : 'ok',
            answer_md: md,
            answer_hash: id,
            fetched_at: `${week}T09:0${pl}:00Z`,
            credits: platform === 'claude' ? 3.6 : 0.2,
          },
          failed ? [] : cites,
          failed
            ? []
            : [
                {
                  answer_id: id,
                  entity: 'ours',
                  name_snapshot: 'NordVolt',
                  mentioned: ours,
                  cited: ours && cites.some((c) => c.site_kind === 'ours'),
                  ...(ours ? { rank, alias_hit: 'NordVolt Air', first_offset: 10 } : {}),
                  ...(ours
                    ? {
                        sentiment: 'positive',
                        sentiment_quote:
                          'NordVolt Air 10000 is a solid pick: light, flight-safe and charges a phone about three times',
                      }
                    : {}),
                  rules_version: 1,
                },
                {
                  answer_id: id,
                  entity: anker,
                  name_snapshot: 'Anker',
                  mentioned: true,
                  cited: cites.some((c) => c.site_kind === 'competitor'),
                  rank: ours && rank === 1 ? 2 : 1,
                  rules_version: 1,
                },
                {
                  answer_id: id,
                  entity: belkin,
                  name_snapshot: 'Belkin',
                  mentioned: (p + w) % 2 === 0,
                  cited: false,
                  ...((p + w) % 2 === 0 ? { rank: 3 } : {}),
                  rules_version: 1,
                },
              ],
        )
      })
    })
    const rankRun = `run_rank_${week}`
    store.startRun({
      id: rankRun,
      kind: 'rank',
      trigger: 'scheduled',
      period: week,
      status: 'done',
      planned: 3,
      answered: 3,
      credits: 0.3,
      started_at: `${week}T08:30:00Z`,
    })
    const kws = [
      ['nordvolt', 1, true],
      ['travel power bank', 14 - w * 2, true],
      ['flight safe power bank', w < 2 ? undefined : 19 - w * 2, false],
    ]
    for (const [keyword, rank, aio] of kws)
      store.recordRank({
        run_id: rankRun,
        keyword,
        market: 'US',
        device: 'mobile',
        ...(rank === undefined ? {} : { rank, url: 'https://nordvolt.example/products/air' }),
        serp_features: { ai_overview: aio, people_also_ask: true, shopping: true, video: false },
        aio_mentions_us: aio && w >= 2,
        aio_cites_us: false,
        fetched_at: `${week}T09:00:00Z`,
      })
  })
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const search = searchStandIn()
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-15T09:00:00Z'),
    searchDataFor: () => search,
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const li = await login(CONTENT)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${li}` } })).json()
    ).data
    const content = me.assignments.find(
      (a) => a.role_id === 'dtc.seo' && a.revoked_at === undefined,
    )
    const positionId = content.position_id ?? content.id
    // 关注设置：两个竞品、五条问题、四家 AI、三个关注词（走界面用的同一条接口）
    let view = await call(li, content.id, 'PUT', '/v1/seo/watch', {
      brand_aliases: ['NordVolt', 'NordVolt Air'],
      competitors: [
        { id: 'c_anker', name: 'Anker', aliases: ['PowerCore'], domains: ['anker.com'] },
        { id: 'c_belkin', name: 'Belkin', aliases: ['BoostCharge'], domains: ['belkin.com'] },
      ],
      platforms: PLATFORMS,
      prompt_limit: 5,
      keywords: [
        { keyword: 'nordvolt', branded: true, enabled: true },
        { keyword: 'travel power bank', branded: false, enabled: true },
        { keyword: 'flight safe power bank', branded: false, enabled: true },
      ],
      add_prompts: PROMPTS.map((text) => ({ text, selected: true })),
    })
    const all = [...view.watch.prompts, ...view.watch.prompt_candidates]
    const ids = PROMPTS.map((text) => all.find((q) => q.text === text)?.id)
    view = await call(li, content.id, 'PUT', '/v1/seo/watch', { select: ids })
    const ws = content.workspace_id ?? demo.server.bootstrap.workspace.id
    const store = await (await demo.server.brands.forWorkspace(ws)).seoService.geoHistory()
    seed(store, ids, view.watch.competitors)
    const card = await call(li, content.id, 'POST', '/v1/seo/watch/strategy', { card: true })

    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, li)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/positions/${encodeURIComponent(positionId)}/duties/dtc.seo`, {
      waitUntil: 'networkidle',
    })
    const board = page.locator('[data-testid="geo-board"]')
    await board.locator('[data-testid="geo-grid"]').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    await board.screenshot({ path: join(SHOTS, '1-geo-board.png') })
    console.log('  📷 1-geo-board.png')

    await page.locator('[data-testid="geo-cell"][data-state="mentioned"]').first().click()
    await page.locator('[data-testid="geo-answer"]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, '2-geo-answer.png') })
    console.log('  📷 2-geo-answer.png')
    await page.locator('[data-testid="geo-answer-compare"] input').check()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '3-geo-answer-compare.png') })
    console.log('  📷 3-geo-answer-compare.png')

    await page.locator('[data-testid="geo-open-settings"]').click()
    await page.locator('[data-testid="geo-watch-settings"]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, '4-geo-watch-settings.png') })
    console.log('  📷 4-geo-watch-settings.png')

    if (card.approval_item_id !== undefined) {
      await page.goto(`${BASE}/cards/${card.approval_item_id}`, { waitUntil: 'networkidle' })
      await page.locator('[data-testid="deck-geo-watch-edit"]').click({ timeout: 20_000 })
      await page.locator('[data-testid="deck-geo-watch-form"]').waitFor()
      await page.waitForTimeout(400)
      await page
        .locator('[data-testid="deck-card"]')
        .first()
        .screenshot({ path: join(SHOTS, '5-geo-watch-card.png') })
      console.log('  📷 5-geo-watch-card.png')
    }
    await context.close()

    // 设置页「这个品牌」：品类一格（店主）
    const owner = await login(OWNER)
    const ownerMe = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${owner}` } })).json()
    ).data
    const ownerAsg = ownerMe.assignments.find((a) => a.role_id === 'common.owner').id
    const state = await call(owner, ownerAsg, 'GET', '/v1/onboarding/state')
    await call(owner, ownerAsg, 'PUT', '/v1/workspace/profile', {
      legal_name: state.profile?.legal_name ?? 'NordVolt Gear Ltd.',
      one_liner: 'Flight-safe power banks for frequent travellers',
      category: 'power bank',
    })
    const oc = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await oc.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      } catch {
        /* 同上 */
      }
    }, owner)
    const op = await oc.newPage()
    await op.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const facts = op.locator('[data-testid="profile-brand-facts"]')
    await facts.waitFor({ timeout: 20_000 })
    await facts.scrollIntoViewIfNeeded()
    await op.waitForTimeout(400)
    await facts.screenshot({ path: join(SHOTS, '6-brand-category.png') })
    console.log('  📷 6-brand-category.png')
    await oc.close()
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
