#!/usr/bin/env node
/**
 * WP398（docs/106 §13 A8）Amazon 词库：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。demo 里联想词是录好的替身、
 * Listing 文本是现编的几条（`apps/cli/src/demo-amazon-keywords.ts`），不起浏览器、不连 Amazon。
 *
 * **端到端**：照推荐建「Amazon 运营」→ `POST /v1/amazon-keywords/refresh` → 词表里有联想词、竞品、自家三种来源；
 * 差距词按竞品数排、写明「没有搜索量」；他牌名标出来。不通过就退出码 1。
 *
 * **截图**（浅 / 深各一张）：`1-block-*` 岗位页「词库」块（差距那一行点开）、`2-panel-*` 第三栏词表、
 * `3-other-brand-*` 词表筛「他牌名」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp398-shots.mjs --out <截图目录> [--port 4498]
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
const PORT = Number(value('--port', '4498'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
// 截图不进开源仓（10-18 起讨论与验收材料在私有仓）：给 --out，不给就落到系统临时目录
const SHOTS = resolve(value('--out', join(tmpdir(), 'agentsws-wp398-shots')))
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
    assignment = (me2.assignments ?? []).find((a) => a.role_id === 'amz.store')?.id
    check(assignment !== undefined, '负责人担着亚马逊店铺运营')

    // ── 刷新词库：联想词（录好的）+ 竞品 / 自家 Listing 拆词 + 差距 ──
    const r = await call('POST', '/v1/amazon-keywords/refresh', owner, {})
    check(
      r.refresh.autocomplete.status === 'ok' && r.refresh.autocomplete.read === 27,
      `联想词读了一批 27 页（种子词 ${r.refresh.autocomplete.seed}）`,
    )
    const src = r.view.by_source
    check(
      src.autocomplete > 0 && src.competitor_listing > 0 && src.own_listing > 0,
      `三种来源都有：${JSON.stringify(src)}`,
    )
    const gap = r.view.gaps[0]
    const counts = gap.terms.map((t) => t.competitors)
    check(
      counts.every((c, i) => i === 0 || counts[i - 1] >= c),
      `差距词按竞品数排：${gap.terms
        .slice(0, 4)
        .map((t) => `${t.term}(${t.competitors})`)
        .join('、')}`,
    )
    check(r.view.sort_note.zh === '没有搜索量，按竞品里出现的次数排', '卡上写明没有搜索量')
    const others = await call('GET', '/v1/amazon-keywords/list?other_brand=true', owner)
    check(
      others.items.length > 0 && others.items.every((k) => k.other_brand !== undefined),
      `他牌名标出来：${others.items.map((k) => k.term).join('、')}`,
    )

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
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const nav = page.getByTestId('nav-position').filter({ hasText: 'Amazon 运营' }).first()
      await nav.waitFor({ timeout: 20_000 })
      await nav.click()
      await page.waitForURL(/\/positions\/[^/?]+/, { timeout: 20_000 })
      await page.goto(`${page.url().split('?')[0]}?tab=view`, { waitUntil: 'networkidle' })
      const block = page.locator('[data-testid="amzops-block"][data-block="keywords"]')
      await block.getByTestId('amzkw-summary').waitFor({ timeout: 20_000 })
      check(
        true,
        `「词库」块：${await block.getByTestId('amzkw-summary').textContent()}（${theme}）`,
      )
      await block.getByTestId('amzkw-gap-toggle').first().click()
      await block.getByTestId('amzkw-gap-list').first().waitFor()
      const note = await block.getByTestId('amzkw-sort-note').first().textContent()
      check(note === '没有搜索量，按竞品里出现的次数排', '差距那一行点开：写明没有搜索量')
      await block.scrollIntoViewIfNeeded()
      await shot(page, `1-block-${theme}`, block)
      await block.getByTestId('amzkw-open').click()
      const panel = page.getByTestId('amzkw-panel')
      await panel.getByTestId('amzkw-row').first().waitFor({ timeout: 20_000 })
      const sources = await panel
        .getByTestId('amzkw-source')
        .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-source')))])
      check(
        ['autocomplete', 'competitor_listing', 'own_listing'].every((s) => sources.includes(s)),
        `词表来源列对得上：${sources.join(', ')}`,
      )
      await shot(page, `2-panel-${theme}`)
      await panel.locator('[data-testid="amzkw-filter"][data-filter="other_brand"]').click()
      await panel.getByTestId('amzkw-other-brand').first().waitFor()
      await shot(page, `3-other-brand-${theme}`, panel)
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
