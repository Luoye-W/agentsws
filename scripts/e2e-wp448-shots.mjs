#!/usr/bin/env node
/**
 * WP448：技术体检、改版回归、抢词三块的截图，可重跑出处（不联网、不接 AI、不连真实店、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停）：网页是 demo 里现编的几页（`apps/cli/src/demo.ts`），
 * 跳转、页面速度、Search Console 都是替身。先体检一次、比一次改版回归（存基线），再用 demo 专用的
 * `demoSiteRedesign()`「换一套主题」再比一次（首页被设成 noindex、商品页结构化数据没了），拍浅 / 深两套：
 *
 * 1. `1-seo-report-tech-<theme>`：报表「SEO 与 AI 搜索」里的「技术体检」「改版回归」；
 * 2. `2-seo-report-cannibalization-<theme>`：同一份报表往下的「两页抢同一组词」；
 *
 * 首页告警区那张「改版回归：…严重问题」卡只核接口（`GET /v1/home` 的 `alerts`）：WP438 首页重排后告警区还没挂回界面。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp448-shots.mjs [--port 4704] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
/** 截图放哪（审稿截图放私有仓，别提交进公开仓：`--out <私有仓>/docs/assets/wp448`）。 */
const SHOTS = resolve(
  argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, 'docs/assets/wp448'),
)

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4704')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = 'nordvolt.myshopify.com'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

/** 店铺授权（demo 替身：装 CLI → 填店 → 授权，过一会儿像在浏览器里点了批准）。 */
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
  if (view.state !== 'authorized') throw new Error(`店铺授权没成：${view.state}`)
}

async function shoot(browser, token, theme, path, blockIds, name, reportName) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1500 },
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
  // 报表块在右栏「报表」卡的「显示更多」那个面板里（同 WP446 的截图）
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
  if (process.env.WP448_DEBUG !== undefined)
    await page.screenshot({
      path: join(process.env.WP448_DEBUG, `${name}-${theme}-panel.png`),
      fullPage: true,
    })
  // WP438 起整块报表在「报表」那几行里：点含这几块的那一份（SEO 与 AI 搜索 / 网站体检），第三栏开整份报表
  if (reportName !== undefined) {
    await panel.getByText(reportName, { exact: true }).first().click()
    await page.getByTestId('report-page').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(2500)
  }
  const first = page.getByTestId('report-page').getByText(blockIds[0], { exact: true }).first()
  await first.waitFor({ timeout: 60_000 }).catch(async (err) => {
    if (process.env.WP448_DEBUG !== undefined)
      await page.screenshot({
        path: join(process.env.WP448_DEBUG, `${name}-${theme}-debug.png`),
        fullPage: true,
      })
    throw err
  })
  await page.waitForTimeout(1500)
  await first.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  console.log(`  📷 ${name}-${theme}.png`)
  await context.close()
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo, demoSiteRedesign } = await import(
    pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href
  )
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-22T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const token = await login(OWNER)
    const me = await call(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    await call(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    // 体检查的是公司档案里填的网站（demo 里的网页是按路径现编的，哪个域名都一样）
    const state = await call(token, owner, 'GET', '/v1/onboarding/state')
    await call(token, owner, 'PUT', '/v1/workspace/profile', {
      legal_name: state.profile?.legal_name ?? 'NordVolt Gear Ltd.',
      domain: 'nordvolt.example',
    })
    const store = await ensureAssignment(token, owner, me, 'dtc.store')
    const seo = await ensureAssignment(token, owner, me, 'dtc.seo')
    // 建站有人担：技术体检的清单才交得出去
    await ensureAssignment(token, owner, me, 'site.shopify-build')
    await authorizeShop(token, store)
    const view = await call(token, seo, 'POST', '/v1/site-health/run', {})
    console.log(
      `  技术体检：${view.run?.tech?.issues.length ?? '没跑'} 条 · 交出 ${JSON.stringify(view.run?.tech?.dispatched?.map((d) => d.owner))} · 备注 ${JSON.stringify(view.run?.notes)}`,
    )
    const base = await call(token, seo, 'POST', '/v1/site-health/drift', {})
    console.log(`  改版回归（基线）：${base.drift?.last?.status} · ${base.drift?.last?.pages} 页`)
    demoSiteRedesign()
    const after = await call(token, seo, 'POST', '/v1/site-health/drift', {})
    demoSiteRedesign({ restore: true })
    console.log(
      `  改版回归（换主题后）：${after.drift?.last?.findings.map((f) => `${f.severity}:${f.rule}`).join(' ')}`,
    )
    // 严重的那几条在首页接口的告警区里有一张卡（WP438 首页重排后告警区还没挂回界面，这里只核接口）
    const home = await call(token, seo, 'GET', '/v1/home')
    const alert = (home.alerts ?? []).find((c) => String(c.title).startsWith('改版回归：'))
    console.log(
      `  首页告警：${alert === undefined ? '没有' : `${alert.title} → ${alert.detail?.payload?.open_path}`}`,
    )
    // demo 里担「SEO 与 GEO」的是运营李默（报告卡发给担这条职责的人）：用他的身份跑一轮、拍他看到的报表
    const liToken = await login('li@nordvolt.example')
    const liMe = await call(liToken, undefined, 'GET', '/v1/me')
    const liSeo = liMe.assignments.find((a) => a.role_id === 'dtc.seo' && !a.revoked_at)?.id
    if (liSeo === undefined) throw new Error('李默名下没有 SEO 与 GEO')
    // 现在跑一轮每日 SEO（Search Console 是 demo 的替身那一周）：每周抢词随这一轮算、严重的进今天 5 件事
    const daily = await call(liToken, liSeo, 'POST', '/v1/seo/run', { what: 'daily' })
    console.log(`  每日 SEO：${JSON.stringify(daily).slice(0, 160)}`)
    const cann = await call(liToken, liSeo, 'GET', '/v1/blocks/seo.cannibalization/data')
    console.log(`  抢词块：${JSON.stringify(cann.payload.rows).slice(0, 300)}`)
    for (const theme of ['light', 'dark']) {
      await shoot(
        browser,
        liToken,
        theme,
        `/positions/${encodeURIComponent(liSeo)}/duties/dtc.seo`,
        ['技术体检'],
        '1-seo-report-tech',
        'SEO 与 AI 搜索',
      )
      await shoot(
        browser,
        liToken,
        theme,
        `/positions/${encodeURIComponent(liSeo)}/duties/dtc.seo`,
        ['两页抢同一组词'],
        '2-seo-report-cannibalization',
        'SEO 与 AI 搜索',
      )
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
