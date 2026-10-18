#!/usr/bin/env node
/**
 * WP387：「让工坊替你建」Google 提醒的截图（可重跑；不联网、不接 AI、不连真 Google、不碰 4317）。
 *
 * 在本进程里起一个服务进程（临时数据目录，跑完删掉），托管工作台构建产物。一个人用（①），持有「信息监控」：
 *
 * 1. `1-card-<theme>`：配置卡上确认过 4 条竞品提醒 → 「要在你的 Google 账号里建 4 条提醒」那张卡（每条可勾掉、一次确认）；
 * 2. `2-connections-<theme>`：建完之后右侧面板「连接」卡里 Google 提醒那一行（替身：3 条 RSS 链接经信息监控「先拉一次」存成监控源，
 *    feed 是录好的样本；上一趟的收尾一句是替身记下的）。
 *
 * 「建的过程」（运行中的浏览器）要真浏览器、真 Google 账号，这里拍不出——留给真机验收。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp387-shots.mjs [--port 4487] [--out <目录>]
 * ```
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(flag('--port', '4487'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(flag('--out', join(ROOT, 'docs/assets/wp387')))
mkdirSync(SHOTS, { recursive: true })
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@voltride.example'
const ATOM = readFileSync(
  join(ROOT, 'packages/pr-core/test/fixtures/google-alerts-3.atom.xml'),
  'utf8',
)
const FEED = (n) => `https://www.google.com/alerts/feeds/00000000000000000000/${1000 + n}`
const PLAN = [
  ['Aventon', '"Aventon" -job'],
  ['Rad Power', '"Rad Power Bikes"'],
  ['Lectric', '"Lectric eBikes"'],
  ['Super73', '"Super73"'],
]

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))
const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp387-shots-'))
const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  dbDir: dataDir,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  env: { AGENTSWS_OWNER_EMAIL: OWNER },
  mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  // 录好的 Google 提醒 feed（标题换成那一条的名字）；别的地址一律 404
  feedFetch: async (url) => {
    const n = PLAN.findIndex((_p, i) => FEED(i) === url)
    const body = n < 0 ? '' : ATOM.replace('Google Alert - Super73', `Google Alert - ${PLAN[n][0]}`)
    return { ok: n >= 0, status: n >= 0 ? 200 : 404, text: async () => body }
  },
})

const call = async (method, path, body, assignment) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (assignment !== undefined) {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', assignment)
  }
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function shoot(browser, token, theme, go, name) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    colorScheme: theme,
  })
  await context.addInitScript(
    ([t, th]) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', th)
      } catch {}
    },
    [token, theme],
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  await go(page)
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
  console.log(`  ✓ ${name}-${theme}.png`)
  await context.close()
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await server.identity.renamePerson(server.bootstrap.person.id, '岚岚')
  const ws = server.bootstrap.workspace.id
  const duty = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: 'pr.monitoring',
  })
  const brand = await server.brands.forWorkspace(ws)
  const now = new Date().toISOString()
  for (const [i, [label, query]] of PLAN.entries())
    brand.prWatchStore.putPlanItem({
      id: `mp_${i + 1}`,
      workspace_id: ws,
      group: 'competitor',
      label,
      query,
      language: 'en',
      region: 'US',
      competitor: label,
      why: '品牌档案里的主要竞品',
      selected: true,
      status: 'planned',
      created_at: now,
      updated_at: now,
    })
  const built = await call('POST', '/v1/pr/watch/alerts/build', undefined, duty.id)
  console.log(`  出卡：${JSON.stringify(built)}`)

  const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
  const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
  const browser = await chromium.launch({ headless: true })
  const toCard = async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page
      .getByText('先跳过')
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    await page.getByText('公共关系').first().click()
    await page.waitForLoadState('networkidle')
    const card = page.locator('[data-testid="deck-google-alerts"]').first()
    await card.waitFor({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded().catch(() => undefined)
  }
  for (const theme of ['light', 'dark']) await shoot(browser, token, theme, toCard, '1-card')

  // 替身：浏览器读回了前 3 条的 RSS 链接（勾掉了 Super73），经信息监控「先拉一次」存成监控源
  for (let i = 0; i < 3; i++)
    await brand.prWatch.addLinks({ links: FEED(i), plan_item_id: `mp_${i + 1}`, via: 'browser' })
  brand.prWatchStore.setKv('alerts_build_jobs', [
    {
      change_id: 'chg_demo',
      op: 'create',
      lines: [],
      status: 'done',
      summary: '建好 3 条，RSS 链接已读回，正在先拉一次。',
      created_at: now,
      updated_at: now,
    },
  ])
  // 右侧面板「连接」卡里的 Google 提醒那一行（展开：汇总一句 + 每条 + 两个按钮 + 上一趟一句收尾）
  const toConnections = async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page
      .getByText('先跳过')
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    await page.getByText('公共关系').first().click()
    await page.waitForLoadState('networkidle')
    if ((await page.getByTestId('rail-cards').count()) === 0)
      await page.getByTestId('rail-overflow').click()
    const card = page.getByTestId('rail-card-connections')
    await card.waitFor({ timeout: 20_000 })
    if ((await card.getAttribute('data-open')) !== 'true')
      await page.getByTestId('rail-card-toggle-connections').click()
    await card.getByText('Google Alerts').first().click()
    const box = page.locator('[data-testid="prwatch-sources"]').first()
    await box.waitFor({ timeout: 30_000 })
    await page.locator('[data-testid="palerts"]').first().waitFor({ timeout: 30_000 })
    await box.scrollIntoViewIfNeeded().catch(() => undefined)
  }
  for (const theme of ['light', 'dark'])
    await shoot(browser, token, theme, toConnections, '2-connections')
  await browser.close()
}

try {
  await main()
} finally {
  await server.close().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
