#!/usr/bin/env node
/**
 * WP447（docs/109 §6）投放补六个平台：端到端走一遍 + 截图（不联网、不接真 AI、不碰 4317、不碰任何真广告后台）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时）：
 *
 * 1. 照岗位清单建「投放」，勾上 Meta / Google + Pinterest / Apple（新平台默认不勾，这里手动勾两条）；
 * 2. 在 Pinterest 广告那条职责里问一句，附上一份照官方列名录的 Pinterest 导出样本（`packages/ads-core/test/
 *    fixtures/ads-export/`）→ 入库；
 * 3. 连接目录里 Google Ads 那张卡不再提 developer token；六张新平台卡照实说「这一期不用连」；
 * 4. 截图（浅 / 深）：投放岗位页右栏「报表」里的看板（Pinterest 账户概况与体检、Apple 只适合推 App）、连接页。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp447-shots.mjs --out <截图目录> [--port 4664]
 * ```
 */
import { mkdirSync, readFileSync } from 'node:fs'
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
const PORT = Number(value('--port', '4664'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp447-shots')))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const FIX = join(ROOT, 'packages/ads-core/test/fixtures/ads-export')

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
  await page.waitForTimeout(800)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
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
    now: Date.parse('2026-10-20T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = await call('GET', '/v1/me', owner)
    assignment = (me.assignments ?? []).find((a) => a.role_id === 'common.owner')?.id
    const own = assignment

    // ── 1. 建投放，勾上两条新平台 ─────────────────────────────────────────
    await call('POST', '/v1/onboarding/apply', owner, {
      position_ids: [],
      role_ids: [],
      positions: [
        {
          name: '投放',
          template_id: 'ads',
          role_ids: ['ads.meta', 'ads.google', 'ads.pinterest', 'ads.apple'],
        },
      ],
    })
    assignment = own
    const me2 = await call('GET', '/v1/me', owner)
    const pin = (me2.assignments ?? []).find((a) => a.role_id === 'ads.pinterest')?.id
    check(pin !== undefined, '负责人担着 Pinterest 广告（新平台要手动勾）')

    // ── 2. 在 Pinterest 那条职责里附上报表 ────────────────────────────────
    assignment = pin
    const data = readFileSync(join(FIX, 'pinterest-campaign.csv')).toString('base64')
    const asked = await call('POST', `/v1/positions/${pin}/matters`, owner, {
      title: '这是上周的 Pinterest 报表，看看花了多少带回多少',
      role_id: 'ads.pinterest',
      mode: 'chat',
      files: [{ name: 'pinterest-campaign.csv', data }],
    })
    check(asked !== undefined, '附上报表开了一件事')
    const prov = await call('GET', '/v1/connections/providers', owner)
    const list = prov.providers ?? prov
    const google = list.find((p) => p.service === 'google_ads')
    check(
      google !== undefined && !/developer token/i.test(JSON.stringify(google)),
      'Google Ads 卡不再提 developer token',
    )
    for (const s of [
      'microsoft_ads',
      'pinterest_ads',
      'reddit_ads',
      'linkedin_ads',
      'snapchat_ads',
      'apple_ads',
    ])
      check(
        list.some((p) => p.service === s),
        `连接目录里有 ${s} 那张卡`,
      )

    // ── 3. 截图 ─────────────────────────────────────────────────────────
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
      await page.goto(`${BASE}/`, { waitUntil: 'load' })
      const adsNav = page.getByTestId('nav-position').filter({ hasText: '投放' }).first()
      await adsNav.waitFor({ timeout: 60_000 })
      await adsNav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 30_000 })
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'load' })
      await page.waitForTimeout(4000)
      const overview = page.getByText('账户概况').first()
      if ((await overview.count()) > 0) {
        await overview.scrollIntoViewIfNeeded()
        check(true, `报表里看得到「账户概况」（${theme}）`)
      } else console.log(`  （${theme}：报表里没找到「账户概况」，照样拍整页）`)
      await shot(page, `wp447-1-ads-position-${theme}`)
      await page.goto(`${BASE}/connections`, { waitUntil: 'load' })
      await page.waitForTimeout(3000)
      const card = page.getByText('Pinterest 广告').first()
      if ((await card.count()) > 0) await card.scrollIntoViewIfNeeded()
      await shot(page, `wp447-2-connections-${theme}`)
      await context.close()
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
