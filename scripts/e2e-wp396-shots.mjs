#!/usr/bin/env node
/**
 * WP396（docs/106 §13）自家 Listing 体检：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317、不碰 Amazon）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时 + 替身读页），用 Playwright：
 *
 * **端到端**：照推荐建「Amazon 运营」→ 关注设置写上三个演示 ASIN（`B0DEMO…`，编的）→ `POST /v1/amazon-listing/run`
 * → 每个 ASIN 一份结果、每处问题带规则出处 → 岗位页右侧「报表」里「Listing 体检」块显示摘要 → 点开一个 ASIN
 * 出体检卡（卡底那一句在）→ 点「向设计岗下需求单」→ 设计岗收到一张来自亚马逊店铺运营的需求单。不通过就退出码 1。
 *
 * **截图**（浅 / 深各一张）：`1-block-*` 面板摘要；`2-card-*` 体检卡。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp396-shots.mjs --out <截图目录> [--port 4496]
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
const PORT = Number(value('--port', '4496'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
// 截图不进开源仓（10-18 起讨论与验收材料在私有仓）：给 --out，不给就落到系统临时目录
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp396-shots')))
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
  await page.waitForTimeout(500)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
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
    now: Date.parse('2026-10-18T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = await call('GET', '/v1/me', owner)
    assignment = (me.assignments ?? []).find((a) => a.role_id === 'common.owner')?.id
    const amz = await call('POST', '/v1/onboarding/suggest', owner, {
      text: '我们在 Amazon 美国站卖户外电源',
    })
    const plan = amz.positions.find((p) => p.template_id === 'amazon-ops')
    check(plan !== undefined, '推荐划分出 Amazon 运营')
    await call('POST', '/v1/onboarding/apply', owner, {
      position_ids: [],
      role_ids: [],
      positions: [plan],
    })
    const me2 = await call('GET', '/v1/me', owner)
    const store = (me2.assignments ?? []).find((a) => a.role_id === 'amz.store')?.id
    const content = (me2.assignments ?? []).find((a) => a.role_id === 'dtc.seo')?.id
    check(store !== undefined, '负责人担着亚马逊店铺运营')
    // 自家 ASIN：唯一一份在关注设置（WP392 `brand_amazon`）
    assignment = content ?? assignment
    await call('PUT', '/v1/seo/watch', owner, { brand_amazon: DEMO_OWN_ASINS })
    assignment = store
    const out = await call('POST', '/v1/amazon-listing/run', owner)
    const items = out.run?.items ?? []
    check(items.length === 3 && items.every((i) => i.status === 'checked'), '三个 ASIN 各一份结果')
    check(
      items.every((i) => i.issues.every((x) => x.source.title !== '')) &&
        items.some((i) => i.issues.length > 0),
      `每处问题带规则出处（共 ${out.run.summary.issues} 处）`,
    )
    const view = await call('GET', '/v1/amazon-listing', owner)
    check(view.footer.zh.includes('连上 Amazon 店铺后能查到更多'), '卡底那一句在')

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 2200 },
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
      const nav = page.getByTestId('nav-position').filter({ hasText: 'Amazon 运营' }).first()
      await nav.waitFor({ timeout: 20_000 })
      await nav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'load' })
      const block = page.getByTestId('alst-block')
      await block.waitFor({ timeout: 60_000 }).catch(async (e) => {
        await page.screenshot({ path: join(tmpdir(), 'wp396-e2e-fail.png') })
        throw e
      })
      const summary = (await page.getByTestId('alst-summary').textContent()) ?? ''
      check(/3 个 ASIN · \d+ 处问题/.test(summary), `面板摘要：${summary.slice(0, 40)}（${theme}）`)
      await block.scrollIntoViewIfNeeded()
      await shot(page, `1-block-${theme}`, page.locator('[data-block="listing"]'))
      await page.getByTestId('alst-asin').first().click()
      const card = page.getByTestId('alst-card').first()
      await card.waitFor({ timeout: 10_000 })
      check(
        ((await page.getByTestId('alst-footer').first().textContent()) ?? '').includes(
          '连上 Amazon 店铺后能查到更多',
        ),
        '体检卡底部固定那一句',
      )
      await card.scrollIntoViewIfNeeded()
      await shot(page, `2-card-${theme}`, card)
      if (theme === 'light') {
        await page.getByTestId('alst-design').first().click()
        await page.getByText('已下单给设计岗').first().waitFor({ timeout: 10_000 })
        const reqs = await call('GET', '/v1/design/requests', owner)
        check(
          (reqs.rows ?? []).some((r) => r.from_role_id === 'amz.store'),
          '设计岗收到一张来自亚马逊店铺运营的需求单',
        )
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
