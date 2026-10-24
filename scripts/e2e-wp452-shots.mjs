#!/usr/bin/env node
/**
 * WP452（docs/109 §5.2 #12–16、§6.3）投放第二批技能：端到端走一遍 + 截图（不联网、不接真 AI、不碰 4317、
 * 不碰任何真广告后台；demo 的落地页是 WP381 现编的那几页）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时）：
 *
 * 1. 建「投放」（Meta / Google）；担上网站运营（落地页对不上的交给它）；品牌档案「卖的是」填实物；
 * 2. 在 Meta 那条职责里说四句（stub 剧本照话走工具，数只从话里抽）：体检 / 算保本线 / 广告和落地页对一遍 / 读实验结果；
 * 3. 截图（浅 / 深）：
 *    - `1-ads-experiment-card`：中栏「保留 / 停 / 再测」卡；
 *    - `2-ads-rail-blocks`：右栏投放那几块（体检三态、保本线、广告与落地页、素材疲劳）；
 *    - `3-brand-offering`：设置里品牌档案「卖的是」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp452-shots.mjs --out <私有仓>/docs/assets/wp452 [--port 5094]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '5094'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(value('--out', join(ROOT, 'docs/assets/wp452')))
const DEBUG = process.env.WP452_DEBUG
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
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
const check = (ok, what) => {
  if (!ok) throw new Error(`✗ ${what}`)
  console.log(`  ✓ ${what}`)
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

/** 在 Meta 那条职责里说一句（当一件任务开；stub 跑完再回）。 */
async function say(token, meta, title) {
  const out = await call(token, meta, 'POST', `/v1/positions/${meta}/matters`, {
    title,
    role_id: 'ads.meta',
    mode: 'task',
  })
  await sleep(2500)
  return out
}

async function newPage(browser, token, theme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
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
  return { context, page }
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
    now: Date.parse('2026-10-24T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const token = await login(OWNER)
    const me = await call(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    // 品牌档案：网站 + 卖的是实物（决策 1399）
    const state = await call(token, owner, 'GET', '/v1/onboarding/state')
    const prof = await call(token, owner, 'PUT', '/v1/workspace/profile', {
      legal_name: state.profile?.legal_name ?? 'NordVolt Gear Ltd.',
      domain: 'nordvolt.example',
      offering: 'physical',
    })
    check(prof.offering === 'physical', '品牌档案「卖的是」存上了（实物）')
    const meta = await ensureAssignment(token, owner, me, 'ads.meta')
    await ensureAssignment(token, owner, me, 'ads.google')
    await ensureAssignment(token, owner, me, 'dtc.store')

    await say(token, meta, '把这个账户体检一遍')
    await say(
      token,
      meta,
      '帮我算保本 ROAS：客单价 39.9，毛利 45%，运费 4，手续费 3%，退货率 8%，想留利润 10%',
    )
    await say(
      token,
      meta,
      '把这条广告和落地页对一遍：https://nordvolt.example/products/rovella-storage-box 「Rovella 折叠收纳箱 $24.90，限时 8 折」「一只能折起来的收纳箱」',
    )
    const exp = await say(
      token,
      meta,
      '实验结果出来了：假设：标题带价格点击率更高，改了：只换标题，基准 21200/424，新版 21200/530，想看出提升 20%，日均 6000',
    )
    await sleep(3000)
    for (const id of ['ads.meta.audit', 'ads.meta.break_even_calc', 'ads.meta.landing']) {
      const blk = await call(token, meta, 'GET', `/v1/blocks/${id}/data?range=last_7d`)
      check(
        (blk?.payload?.rows ?? []).length > 0,
        `${id} 有数（${(blk?.payload?.rows ?? []).length} 行）`,
      )
    }
    const deck = await call(token, meta, 'GET', '/v1/approvals?state=pending')
    const items = deck.items ?? deck
    if (DEBUG !== undefined) {
      console.log(
        '  debug kinds',
        JSON.stringify((Array.isArray(items) ? items : []).map((i) => i.kind)),
      )
      const mid = exp?.matter?.id ?? exp?.id
      const tl = await call(token, meta, 'GET', `/v1/matters/${mid}/timeline`).catch((e) =>
        String(e),
      )
      console.log('  debug timeline', JSON.stringify(tl).slice(0, 3000))
    }
    check(
      Array.isArray(items) && items.some((i) => i.kind === 'ads_experiment_readout'),
      '中栏出了「保留 / 停 / 再测」卡',
    )

    for (const theme of ['light', 'dark']) {
      // ① 中栏的实验结果卡（Meta 那条职责页）
      {
        const { context, page } = await newPage(browser, token, theme)
        await page.goto(`${BASE}/positions/${meta}`, { waitUntil: 'networkidle' })
        const card = page.locator('[data-testid="deck-card"][data-kind="ads_experiment_readout"]')
        // 「要你处理」一次一张：往后翻到实验结果那张
        await page.getByTestId('deck-card').first().waitFor({ timeout: 60_000 })
        for (let i = 0; i < 6 && (await card.count()) === 0; i++) {
          const next = page.getByTestId('deck-next').first()
          if ((await next.count()) === 0 || (await next.isDisabled())) break
          await next.click()
          await page.waitForTimeout(800)
        }
        await card
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(async (e) => {
            if (DEBUG !== undefined)
              await page.screenshot({ path: join(DEBUG, `card-${theme}.png`), fullPage: true })
            throw e
          })
        await card.first().scrollIntoViewIfNeeded()
        await page.waitForTimeout(1200)
        await page.screenshot({ path: join(SHOTS, `1-ads-experiment-card-${theme}.png`) })
        console.log(`  📷 1-ads-experiment-card-${theme}.png`)
        await context.close()
      }
      // ② 右栏「报表」里投放那几块
      {
        const { context, page } = await newPage(browser, token, theme)
        await page.goto(`${BASE}/positions/${meta}`, { waitUntil: 'networkidle' })
        if ((await page.getByTestId('rail-cards').count()) === 0)
          await page.getByTestId('rail-toggle').click()
        const card = page.getByTestId('rail-card-reports')
        await card.waitFor({ timeout: 30_000 })
        if ((await card.getAttribute('data-open')) !== 'true')
          await page.getByTestId('rail-card-toggle-reports').click()
        await page.getByTestId('rail-card-more-reports').click()
        const panel = page.getByTestId('reports-panel')
        await panel.waitFor({ timeout: 30_000 })
        const wide = page.getByTestId('rail-panel-wide')
        if ((await wide.count()) > 0) await wide.first().click()
        await page.waitForTimeout(2000)
        if (DEBUG !== undefined)
          await page.screenshot({ path: join(DEBUG, `panel-${theme}.png`), fullPage: true })
        // 投放的几块在「投放总览」那一份报表里：点开它，第三栏开整份报表
        await panel.getByText('投放总览', { exact: true }).first().click()
        await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
        await page.waitForTimeout(2500)
        const first = page.getByTestId('report-page').getByText('账户体检', { exact: true }).first()
        await first.waitFor({ timeout: 60_000 }).catch(async (e) => {
          if (DEBUG !== undefined)
            await page.screenshot({ path: join(DEBUG, `report-${theme}.png`), fullPage: true })
          throw e
        })
        await first.evaluate((el) => el.scrollIntoView({ block: 'start' }))
        await page.waitForTimeout(1200)
        await page.screenshot({ path: join(SHOTS, `2-ads-rail-blocks-${theme}.png`) })
        console.log(`  📷 2-ads-rail-blocks-${theme}.png`)
        const landing = page
          .getByTestId('report-page')
          .getByText('广告与落地页', { exact: true })
          .first()
        if ((await landing.count()) > 0) {
          await landing.evaluate((el) => el.scrollIntoView({ block: 'start' }))
          await page.waitForTimeout(800)
          await page.screenshot({ path: join(SHOTS, `2b-ads-rail-landing-${theme}.png`) })
          console.log(`  📷 2b-ads-rail-landing-${theme}.png`)
        }
        await context.close()
      }
      // ③ 设置里品牌档案「卖的是」
      {
        const { context, page } = await newPage(browser, token, theme)
        await page.goto(`${BASE}/settings#company`, { waitUntil: 'networkidle' })
        const cell = page.getByTestId('brand-offering')
        await cell.waitFor({ timeout: 60_000 })
        await cell.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await page.waitForTimeout(1000)
        await page.screenshot({ path: join(SHOTS, `3-brand-offering-${theme}.png`) })
        console.log(`  📷 3-brand-offering-${theme}.png`)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
