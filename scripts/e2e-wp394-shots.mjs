#!/usr/bin/env node
/**
 * WP394（docs/104 一期 B）Amazon 竞品对标款：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时 + Amazon 前台 / 云端替身 `apps/cli/src/demo-amazon.ts`，
 * 编的 ASIN，内存里，跑完即停），用 Playwright：
 *
 * **端到端**：建好「Amazon 运营」→ 自家两款写进关注设置 → 在岗位里说「帮我盯 Amazon 上的竞品」→ 方案卡列出每家几款、
 * 各对标自家哪款 → 点「就这样」→ 先读一次当底子 → 再读一次（替身里 Jackery 那款降价）→ 变化表里一条改价、
 * 价格是美元、带「比你的 … 便宜 $N」。不通过就退出码 1。
 *
 * **截图**（浅 / 深各一张）：`1-plan-card-*` 对标款方案卡；`2-competitors-*` 面板「竞品动向」块；
 * `3-changes-*` 报表卡里的竞品变化表。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp394-shots.mjs --out <截图目录> [--port 4496]
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
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp394-shots')))
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
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-19T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me0 = await call('GET', '/v1/me', owner)
    assignment = (me0.assignments ?? []).find((a) => a.role_id === 'common.owner')?.id
    const sug = await call('POST', '/v1/onboarding/suggest', owner, {
      text: '我们在 Amazon 美国站卖户外电源',
    })
    const plan = sug.positions.find((p) => p.template_id === 'amazon-ops')
    check(plan !== undefined, '推荐划分出 Amazon 运营')
    await call('POST', '/v1/onboarding/apply', owner, {
      position_ids: [],
      role_ids: [],
      positions: [plan],
    })
    const me = await call('GET', '/v1/me', owner)
    const amz = (me.assignments ?? []).find((a) => a.role_id === 'amz.store')?.id
    check(amz !== undefined, '有亚马逊店铺运营那条分配')
    // 自家两款写进关注设置那一格（和 WP396 同一格；demo 里是编的 ASIN）
    // 关注设置那一格要「内容与搜索」那条分配来写（demo 里负责人自己担着）
    assignment = (me.assignments ?? []).find((a) => a.role_id === 'dtc.content')?.id ?? amz
    await call('GET', '/v1/seo/watch', owner).catch(() => undefined)
    await call('PUT', '/v1/seo/watch', owner, {
      brand_amazon: [
        { marketplace: 'US', asin: 'B0DEMONV01', label: 'Trail Power 1000' },
        { marketplace: 'US', asin: 'B0DEMONV02', label: 'Trail Power 300' },
      ],
    })
    assignment = amz
    const opened = await call('POST', `/v1/positions/${amz}/matters`, owner, {
      title: '帮我盯 Amazon 上的竞品：先挑几款对标款，说说它们的价格、评分和排名',
      role_id: 'amz.store',
    })
    const matter = opened.matter.id
    let card
    for (let i = 0; i < 160 && card === undefined; i += 1) {
      const view = await call('GET', `/v1/matters/${matter}`, owner)
      for (const id of view.timeline
        .map((e) => e.approval_item_id)
        .filter(Boolean)
        .reverse()) {
        const c = await call('GET', `/v1/approvals/${id}`, owner)
        if (c.kind === 'setup_request' && c.state === 'pending') card = c
      }
      if (card === undefined) await new Promise((r) => setTimeout(r, 250))
    }
    check(card !== undefined, '出了对标款方案卡')

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
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
      if (
        theme === 'light' ||
        (await call('GET', `/v1/approvals/${card.id}`, owner)).state === 'pending'
      ) {
        await page.goto(`${BASE}/matters/${matter}`, { waitUntil: 'networkidle' })
        const setup = page.locator('[data-testid="matter-setup-card"]').first()
        await setup.waitFor({ timeout: 30_000 })
        const text = (await setup.textContent()) ?? ''
        check(
          /B0DEMOJK01/.test(text) && /B0DEMONV0/.test(text),
          `方案卡列出对标款、各对标自家哪款（${theme}）`,
        )
        await shot(page, `1-plan-card-${theme}`, setup)
        if (theme === 'dark') {
          await setup.getByTestId('setup-plan-accept').first().click()
          // 存下先读一次当底子；再读一次（替身里 Jackery Explorer 1000 v2 降价）
          for (let i = 0; i < 80; i += 1) {
            const v = await call('GET', '/v1/competitor-watch', owner)
            if (v.sources.some((s) => s.kind === 'amazon_asin' && s.status === 'ok')) break
            await new Promise((r) => setTimeout(r, 250))
          }
          await call('POST', '/v1/competitor-watch/run', owner)
          const ch = await call('GET', '/v1/competitor-watch/changes?limit=50', owner)
          const drop = ch.changes.find((c) => c.kind === 'price' && c.product_key === 'B0DEMOJK01')
          check(drop !== undefined && drop.currency === 'USD', '变化表里一条改价，价格是美元')
          check(drop?.vs_own !== undefined, `带和自家对标款比的差价：${drop?.text?.zh ?? ''}`)
        }
      }
      await context.close()
    }
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 同上 */
          }
        },
        [owner, theme],
      )
      const page = await context.newPage()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const nav = page.getByTestId('nav-position').filter({ hasText: 'Amazon 运营' }).first()
      await nav.waitFor({ timeout: 20_000 })
      await nav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'networkidle' })
      const block = page.locator('[data-testid="amzops-block"][data-block="competitors"]')
      await block.waitFor({ timeout: 20_000 })
      await page.getByTestId('amzcw-change').first().waitFor({ timeout: 20_000 })
      const text = (await block.textContent()) ?? ''
      check(
        /便宜/.test(text) && !/apify|keepa/i.test(text),
        `竞品动向块里有「比你便宜」那一句（${theme}）`,
      )
      await block.scrollIntoViewIfNeeded()
      await shot(page, `2-competitors-${theme}`, block)
      const table = page.getByTestId('competitor-changes').first()
      if (await table.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await table.scrollIntoViewIfNeeded()
        await shot(page, `3-changes-${theme}`, table)
      } else await shot(page, `3-changes-${theme}`)
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
