#!/usr/bin/env node
/**
 * WP381：网站 / 商品体检与 AI 来源流量的截图，可重跑出处（不联网、不接 AI、不连真实店、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停）：店铺是 demo 自带的假店（替身授权），网页是 demo 里
 * 现编的几页（`apps/cli/src/demo.ts` 的 `DEMO_SITE_HEALTH_PAGES`），渲染后那一份也是替身。拍浅 / 深两套：
 *
 * 1. `1-store-health-<theme>`：网站运营岗位的体检四块（商品信息、ChatGPT 购物、AI 爬虫、不开 JS）；
 * 2. `2-content-ai-traffic-<theme>`：SEO 与 GEO职责的「AI 带来的访问与成交」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp381-shots.mjs [--port 4481]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp381')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4481')
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

async function shoot(browser, token, theme, path, blockIds, name) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
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
  const first = page.locator(`[data-block-id="${blockIds[0]}"]`)
  // WP372 / WP375：报表块在右栏「报表」卡里——「⋮」打开面板、展开报表卡、「显示更多」、加宽
  if ((await page.getByTestId('rail-cards').count()) === 0)
    await page.getByTestId('rail-toggle').click()
  const card = page.getByTestId('rail-card-reports')
  await card.waitFor({ timeout: 20_000 })
  if ((await card.getAttribute('data-open')) !== 'true')
    await page.getByTestId('rail-card-toggle-reports').click()
  await page.getByTestId('rail-card-more-reports').click()
  await page.getByTestId('reports-panel').waitFor({ timeout: 20_000 })
  await page.getByTestId('rail-panel-wide').click()
  // 体检块属于岗位层看板（数字一排下面「看图表」展开整块）
  await page
    .getByText(theme === 'dark' ? '岗位层' : '岗位层', { exact: true })
    .first()
    .click()
  await page.getByTestId('data-charts-toggle').first().waitFor({ timeout: 20_000 })
  const toggles = page.getByTestId('data-charts-toggle')
  for (let i = 0; i < (await toggles.count()); i += 1)
    if ((await toggles.nth(i).getAttribute('aria-expanded')) !== 'true')
      await toggles.nth(i).click()
  await first.waitFor({ timeout: 30_000 }).catch(async (err) => {
    if (process.env.WP381_DEBUG !== undefined) {
      await page.screenshot({
        path: join(process.env.WP381_DEBUG, `${name}-${theme}-debug.png`),
        fullPage: true,
      })
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('[data-block-id]')]
            .map((e) => e.getAttribute('data-block-id'))
            .join(' '),
        ),
      )
    }
    throw err
  })
  await page.waitForTimeout(1200)
  // 报表面板自己会滚：把第一块滚到面板顶上，拍整个窗口（左边是职责页，右边是报表）
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
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-17T09:00:00Z'),
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
    const content = await ensureAssignment(token, owner, me, 'dtc.seo')
    await authorizeShop(token, store)
    const view = await call(token, store, 'POST', '/v1/site-health/run', {})
    console.log(
      `  体检：${view.run?.status} · 爬虫 ${view.run?.crawlers.length} · 商品不一致 ${view.run?.products.issues.length} · 派出 ${view.run?.dispatched?.matter_id ?? '没有'} · 备注 ${JSON.stringify(view.run?.notes)}`,
    )
    console.log(`  AI 来源流量：${JSON.stringify(view.ai_traffic?.rows)}`)
    for (const theme of ['light', 'dark']) {
      await shoot(
        browser,
        token,
        theme,
        `/positions/${encodeURIComponent(store)}/duties/dtc.store`,
        [
          'site.health.products',
          'site.health.chatgpt',
          'site.health.crawlers',
          'site.health.raw_html',
        ],
        '1-store-health',
      )
      await shoot(
        browser,
        token,
        theme,
        `/positions/${encodeURIComponent(content)}/duties/dtc.seo`,
        ['seo.ai_traffic'],
        '2-content-ai-traffic',
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
