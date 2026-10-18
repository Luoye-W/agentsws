#!/usr/bin/env node
/**
 * WP393（docs/104 一期 A）：店铺管理「竞品动向」截图，可重跑出处（不联网、不接 AI、不碰 4317）。
 *
 * 起一个 demo（演示世界；竞品是三家 `.example` 替身店、进料口是替身、自家店是替身），浅 / 深各拍一套：
 *
 * 1. `1-plan-card-<theme>`：店铺管理里一句「帮我盯一下竞品的上新和价格」→ 方案卡（盯哪几家、每家走哪条路、什么算要紧）；
 * 2. 点「就这样」→ 先读一次当底子（不报上新）、配好对标款；再读一次（替身开关：Jackery 整店再降一成）；
 * 3. `2-report-changes-<theme>`：右栏报表卡里的竞品变化表（「降价 N%，比你的 PowerHub 1000 便宜 $N」）；
 * 4. `3-daily-brief-<theme>`：店铺管理日报里的「竞品动向」那一段；
 * 5. 把一家店改坏（替身开关文件）再读一次 → `4-connection-red-<theme>`：连接卡亮红点、日报写「这家没读到」。
 *
 * ```
 * npx tsc -b
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp393-shots.mjs --out <截图目录> [--port 4393]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp393'))
const PORT = Number(argOf('--port') ?? '4393') || 4393
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const KNOBS = join(mkdtempSync(join(tmpdir(), 'wp393-')), 'competitors.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startDemo() {
  writeFileSync(KNOBS, '{}')
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTSWS_DEMO_COMPETITORS: KNOBS },
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
    await sleep(500)
  }
  throw new Error(`demo 没起来（120 秒）：\n${log.join('')}`)
}

async function api(token, assignment, method, path, body) {
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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function login() {
  const link = await api(undefined, undefined, 'POST', '/v1/auth/magic-link', { email: OWNER })
  return (await api(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token }))
    .session_token
}

async function ensureAssignment(token, owner, me, role_id) {
  const hit = me.assignments.find((a) => a.role_id === role_id && a.revoked_at === undefined)
  if (hit !== undefined) return hit.id
  return (
    await api(token, owner, 'POST', '/v1/assignments', {
      person_id: me.person.id,
      role_id,
      ranges: [],
    })
  ).id
}

/** 打开右栏、展开某张卡；回那张卡。 */
async function openRailCard(page, id) {
  if ((await page.getByTestId('rail-cards').count()) === 0) {
    // WP412：面板由右上角专门的开关开（干活的页默认就开着）
    const toggle = page.getByTestId('rail-toggle')
    if ((await toggle.count()) > 0) await toggle.click()
  }
  const card = page.getByTestId(`rail-card-${id}`)
  await card.waitFor({ timeout: 20_000 })
  if ((await card.getAttribute('data-open')) !== 'true')
    await page.getByTestId(`rail-card-toggle-${id}`).click()
  return card
}

/** 店铺授权（demo 替身：装 CLI → 填店 → 授权；日报那张表挂在「店铺后台」上，连上才出）。 */
async function authorizeShop(token, store) {
  const q = '/v1/shop-admin?roles=dtc.store'
  let view = await api(token, store, 'GET', q)
  if (view.state === 'no_cli') {
    await api(token, store, 'POST', '/v1/shop-admin/run', {
      action: 'install',
      roles: ['dtc.store'],
    })
    for (let i = 0; i < 90 && view.state === 'no_cli'; i += 1) {
      await sleep(1000)
      view = await api(token, store, 'GET', q)
    }
  }
  if (view.state === 'no_store')
    view = await api(token, store, 'PUT', '/v1/shop-admin/store', {
      store: 'nordvolt.myshopify.com',
      roles: ['dtc.store'],
    })
  if (view.state !== 'authorized')
    await api(token, store, 'POST', '/v1/shop-admin/run', {
      action: 'authorize',
      roles: ['dtc.store'],
    })
  for (let i = 0; i < 90 && view.state !== 'authorized'; i += 1) {
    await sleep(1000)
    view = await api(token, store, 'GET', q)
  }
  console.log(`  店铺授权：${view.state}`)
}

/** 右栏「报表」卡 → 显示更多 → 加宽；看板里「看图表」全展开（日报那张表在里面）。 */
async function openReports(page) {
  await openRailCard(page, 'reports')
  const more = page.getByTestId('rail-card-more-reports')
  if ((await more.count()) > 0) {
    await more.click()
    await page
      .getByTestId('reports-panel')
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined)
    const wide = page.getByTestId('rail-panel-wide')
    if ((await wide.count()) > 0) await wide.click()
  }
  await page.waitForTimeout(800)
}

/** 日报那张表在岗位层的数据看板里（「看图表」全展开）。 */
async function openPositionBoard(page) {
  await page.getByText('岗位层', { exact: true }).first().click()
  await page
    .getByTestId('data-charts-toggle')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined)
  const toggles = page.getByTestId('data-charts-toggle')
  for (let i = 0; i < (await toggles.count()); i += 1)
    if ((await toggles.nth(i).getAttribute('aria-expanded')) !== 'true')
      await toggles.nth(i).click()
}

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
    const store = await ensureAssignment(token, owner, me, 'dtc.store')
    await api(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    await authorizeShop(token, store)

    const cardOf = async (matter, kind) => {
      for (let i = 0; i < 240; i += 1) {
        const view = await api(token, store, 'GET', `/v1/matters/${matter}`)
        const ids = view.timeline.map((e) => e.approval_item_id).filter(Boolean)
        for (const id of ids.reverse()) {
          const card = await api(token, store, 'GET', `/v1/approvals/${id}`)
          if (card.kind === kind) return card
        }
        await sleep(250)
      }
      const view = await api(token, store, 'GET', `/v1/matters/${matter}`)
      throw new Error(
        `等不到 ${kind} 卡：\n${view.timeline.map((e) => `  ${e.kind} ${e.text}`).join('\n')}`,
      )
    }
    const watchView = () => api(token, store, 'GET', '/v1/competitor-watch')
    const waitRuns = async (n) => {
      for (let i = 0; i < 240; i += 1) {
        const v = await watchView()
        if (v.last_run?.finished_at !== undefined && (v.runs_count ?? n) >= n) return v
        await sleep(500)
      }
      return watchView()
    }

    // ① 一句话 → 方案卡
    const asked = await api(token, store, 'POST', `/v1/positions/${store}/matters`, {
      title: '帮我盯一下竞品的上新和价格',
      role_id: 'dtc.store',
    })
    const matter = asked.matter.id
    const plan = await cardOf(matter, 'setup_request')
    console.log(`  方案卡：${plan.title}`)

    browser = await chromium.launch({ headless: true })
    const pageFor = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
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
    const shot = async (page, locator, name) => {
      await page.waitForTimeout(800)
      try {
        await locator.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
      } catch {
        await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' })
      }
      console.log(`  📷 ${name}.png`)
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await pageFor(theme)
      await page.goto(`${BASE}/matters/${matter}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="matter-setup-card"]', { timeout: 30_000 })
      const steps = page.locator('[data-testid="setup-plan-steps"] summary').last()
      if ((await steps.count()) > 0) await steps.click()
      await shot(page, page.locator('main'), `1-plan-card-${theme}`)
      const edit = page.locator('[data-testid="setup-plan-edit"]').last()
      if ((await edit.count()) > 0) await edit.click()
      await shot(
        page,
        page.locator('[data-testid="matter-setup-card"]').last(),
        `1b-plan-edit-${theme}`,
      )
      if (theme === 'dark') {
        // ② 就这样 → 先读一次当底子（不报上新）
        const fold = page.locator('[data-testid="setup-plan-fold"]').last()
        if ((await fold.count()) > 0) await fold.click()
        await page.locator('[data-testid="setup-plan-accept"]').last().click()
        for (let i = 0; i < 120; i += 1) {
          const c = await api(token, store, 'GET', `/v1/approvals/${plan.id}`)
          if (c.state !== 'pending') break
          await sleep(250)
        }
      }
      await context.close()
    }
    let v = await waitRuns(1)
    console.log(
      `  底子：${JSON.stringify(v.last_run?.parts?.map((p) => [p.label, p.status, p.changes]))}`,
    )
    // ③ 再读一次：Jackery 整店再降一成（替身开关；不管 demo 开机时有没有先读过，这一次都比得出降价）
    writeFileSync(KNOBS, JSON.stringify({ 'jackery.example': { price_factor: 0.9 } }))
    await api(token, store, 'POST', '/v1/competitor-watch/run', {})
    v = await watchView()
    console.log(`  第二次：${v.last_run?.changes} 条变化`)
    const changes = await api(token, store, 'GET', '/v1/competitor-watch/changes')
    console.log(
      `  变化：${JSON.stringify((changes.rows ?? changes.changes ?? changes).slice?.(0, 3))}`,
    )

    const duty = `${BASE}/positions/${encodeURIComponent(store)}/duties/dtc.store`
    for (const theme of ['light', 'dark']) {
      const { context, page } = await pageFor(theme)
      await page.goto(duty, { waitUntil: 'networkidle' })
      await openReports(page)
      const table = page.getByTestId('competitor-changes').first()
      await table.waitFor({ timeout: 20_000 }).catch(() => undefined)
      await shot(page, page, `2-report-changes-${theme}`)
      await openPositionBoard(page)
      const brief = page.locator('[data-block-id="store.daily_report"]').last()
      await brief.waitFor({ timeout: 20_000 }).catch(() => undefined)
      await brief
        .getByText('竞品动向')
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined)
      await brief.scrollIntoViewIfNeeded().catch(() => undefined)
      await shot(page, (await brief.count()) > 0 ? brief : page, `3-daily-brief-${theme}`)
      await context.close()
    }

    // ⑤ 一家店改坏 → 连接卡亮红点、日报写「这家没读到」
    writeFileSync(
      KNOBS,
      JSON.stringify({
        'jackery.example': { price_factor: 0.9 },
        'bluetti.example': { broken: true },
      }),
    )
    await api(token, store, 'POST', '/v1/competitor-watch/run', {})
    for (const theme of ['light', 'dark']) {
      const { context, page } = await pageFor(theme)
      await page.goto(duty, { waitUntil: 'networkidle' })
      const conn = await openRailCard(page, 'connections')
      await conn.scrollIntoViewIfNeeded().catch(() => undefined)
      await shot(page, page, `4-connection-red-${theme}`)
      await openReports(page)
      await openPositionBoard(page)
      const brief = page.locator('[data-block-id="store.daily_report"]').last()
      await brief.waitFor({ timeout: 20_000 }).catch(() => undefined)
      await brief
        .getByText('竞品动向')
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined)
      await brief.scrollIntoViewIfNeeded().catch(() => undefined)
      await shot(page, (await brief.count()) > 0 ? brief : page, `5-daily-brief-failed-${theme}`)
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
