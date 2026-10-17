#!/usr/bin/env node
/**
 * WP375（决策 1035）右侧面板照 Claude 桌面版修整：端到端走一遍 + 截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright：
 *
 * **端到端**：进岗位 → 进职责 → 右上角「⋮」打开面板 →「对话」卡「+ 新对话」→ 写一句回车 →
 * 服务端真的开出一件事（`/v1/work/rail` 里查得到）。不通过就退出码 1。
 *
 * **截图**（`docs/assets/wp375/`）：
 * 1. `1-panel-light` / `1-panel-dark`：宽窗，职责页 + 右侧面板（默认展开对话、计划）；
 * 2. `2-cards-light` / `2-cards-dark`：只拍面板那一栏（对照 Claude 那几张卡的间距、字号、圆角）；
 * 3. `3-hover-light` / `3-hover-dark`：鼠标停在一张收起的卡上——最右的摘要让位、六点手柄出来；
 * 4. `4-topbar`：顶栏特写——只有三个工具 +「⋮」，「⋮」上亮汇总点。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp375-shots.mjs [--port 4475]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp375')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4475')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}

async function get(token, path, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

/** WP375（决策 1035）：右上角没有卡片图标了——「⋮」打开面板，卡没展开就点它的标题行。 */
const openCard = async (page, id) => {
  if ((await page.getByTestId('rail-cards').count()) === 0)
    await page.getByTestId('rail-overflow').click()
  const card = page.getByTestId(`rail-card-${id}`)
  await card.waitFor({ timeout: 20_000 })
  if ((await card.getAttribute('data-open')) !== 'true')
    await page.getByTestId(`rail-card-toggle-${id}`).click()
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
    now: Date.parse('2026-10-17T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  let failed = false
  try {
    const owner = await login(OWNER)
    const open = async (theme, viewport = { width: 1440, height: 900 }) => {
      const context = await browser.newContext({ viewport, colorScheme: theme })
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
      return { context, page }
    }

    // ── 端到端：进岗位 → 进职责 →「⋮」→「对话」卡新对话 → 发一条 ──
    let dutyUrl = ''
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const position = page.getByTestId('nav-position').first()
      await position.waitFor({ timeout: 20_000 })
      await position.click()
      await page.waitForURL(/\/positions\/[^/]+$/, { timeout: 20_000 })
      const row = page.getByTestId('nav-position-row').first()
      // 当前岗位默认展开；岗位那一份晚到一拍时先等一下，真没展开才点箭头（别把展开的又点收起）
      const shown = await row
        .getByTestId('nav-duties')
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (!shown) await row.getByTestId('nav-position-toggle').click()
      await row.getByTestId('nav-duty').first().click()
      await page.waitForURL(/\/duties\//, { timeout: 20_000 })
      dutyUrl = page.url()
      const asg = /\/positions\/([^/]+)\/duties\/([^/?]+)/.exec(dutyUrl)
      const before = await get(owner, '/v1/work/rail?limit=20', asg?.[1])
      const count = (rail) =>
        rail.positions.flatMap((p) => p.duties.flatMap((d) => d.matters)).length
      await openCard(page, 'conversations')
      await page.getByTestId('conv-card').waitFor({ timeout: 20_000 })
      await page.getByTestId('conv-new').click()
      const sentence = '把这周要发的三条内容列个清单'
      await page.getByTestId('conv-compose-input').fill(sentence)
      await page.getByTestId('conv-compose-input').press('Enter')
      await page.waitForURL(/\/positions\/[^/]+(\?.*)?$|\/matters\//, { timeout: 20_000 })
      let ok = false
      for (let i = 0; i < 60 && !ok; i += 1) {
        const after = await get(owner, '/v1/work/rail?limit=20', asg?.[1])
        const titles = after.positions.flatMap((p) =>
          p.duties.flatMap((d) => d.matters.map((m) => m.title)),
        )
        ok = count(after) > count(before) || titles.includes(sentence)
        if (!ok) await page.waitForTimeout(500)
      }
      if (ok) console.log(`  ✅ 端到端：在「${asg?.[2]}」右侧面板开了新对话，服务端开出了那件事`)
      else {
        failed = true
        console.error('  ❌ 端到端：发出去之后服务端没开出事项')
      }
      await context.close()
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(dutyUrl, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-overflow').click()
      await page.getByTestId('rail-cards').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(800)
      await shot(page, `1-panel-${theme}`)
      await shot(page, `2-cards-${theme}`, page.getByTestId('rail-panel-frame'))
      // 鼠标停在一张收起的卡上（有摘要的那张最能看出「摘要让位、手柄出来」）
      await page.getByTestId('rail-card-connections').hover()
      await shot(page, `3-hover-${theme}`, page.getByTestId('rail-panel-frame'))
      if (theme === 'light') {
        await page.mouse.move(10, 10)
        await shot(page, '4-topbar', page.getByTestId('top-bar'))
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
