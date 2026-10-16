#!/usr/bin/env node
/**
 * WP350（决策 900）「我的助理」一次拆成多份——截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），模型用 demo 自带的「Agents 工坊（用积分）」替身
 * （`cloud-ai-stand-in.ts`：附了资料 / 提到会议记录时按岗位拆，用的是 `stubFanoutDraft` 那一份替身拆法）。拍：
 *
 * 1. `1-plan-light` / `1-plan-dark`：附一份 .md 周会记录 →「我打算这样分」方案卡（按岗位分组、归属待定能挑）；
 * 2. `2-plan-edit`：点「改一下」——每条可勾掉 / 改归属 / 改文字；
 * 3. `3-summary`：「就这样」之后的汇总卡（几个岗位几件事、几条知识待确认）+ 同一批回报聚在一起；
 * 4. `4-position-pending`：某岗位第三栏「知识」最上面「待你确认」那几条；
 * 5. `5-notes-card`：卡片流里「要记的 N 条」确认卡。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp350-shots.mjs [--port 4450]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp350')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4450')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
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

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-assignment': assignment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
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
    now: Date.parse('2026-10-15T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${owner}` } })).json()
    ).data
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner').id
    const orgs = await call(owner, ownerAsg, 'GET', '/v1/orgs')
    console.log(`  模式：${orgs[0]?.mode ?? '（读不到）'}`)

    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 900 },
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
      return { context, page }
    }

    // 先把「Agents 工坊（用积分）」启用（demo 里关联的是云替身，不出网）
    {
      const { context, page } = await open('light')
      // 关联账号（demo 的替身云：发「登录信」后替身自己点链接，示例邮箱，不出网）
      await call(owner, ownerAsg, 'POST', '/v1/cloud/account/link', { email: 'boss@example.com' })
      for (let i = 0; i < 50; i += 1) {
        const acct = await call(owner, ownerAsg, 'GET', '/v1/cloud/account')
        if (acct.linked === true) break
        await new Promise((r) => setTimeout(r, 200))
      }
      await page.goto(`${BASE}/settings`, { waitUntil: 'load' })
      const enable = page.getByTestId('model-cloud-enable')
      await enable.waitFor({ timeout: 20_000 }).catch(() => undefined)
      if ((await enable.count()) > 0) {
        await enable.click()
        await page.getByTestId('model-cloud-disable').waitFor({ timeout: 20_000 })
      }
      await context.close()
    }

    // 这个人的岗位（会议记录按这些岗位名写，替身拆法按名字认）
    const state = await call(owner, ownerAsg, 'GET', '/v1/free-chat/assistant')
    const names = state.targets.map((x) => x.name)
    console.log(`  岗位：${names.join('、')}`)
    const [a, b, c] = [
      names[0] ?? '网站运营',
      names[1] ?? '客服',
      names[2] ?? names[0] ?? '社媒运营',
    ]
    const notes = [
      '# 10-16 周会',
      `- ${a}：把 A 商品的卖点整理一版，周五前`,
      `- ${b}：整理一版退货话术`,
      `- ${c}：下周发两条新品帖`,
      '- 这件事要有人跟进',
      `- ${b}记住：退货期统一 30 天`,
      `- ${a}记住：运费一律满 50 包邮`,
      '- 品牌语气统一偏轻松',
      '- 我喜欢周报用表格',
    ].join('\n')
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const notesDir = mkdtempSync(join(tmpdir(), 'wp350-shots-'))
    const notesPath = join(notesDir, '10-16 周会纪要.md')
    writeFileSync(notesPath, notes)

    let sessionUrl = ''
    let notesCard = ''
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await page.getByTestId('free-chat-model').click({ timeout: 20_000 })
      await page.getByTestId('free-chat-model-option').filter({ hasText: 'Agents' }).first().click()
      await page.getByTestId('free-chat-doc-input').setInputFiles(notesPath)
      await page.getByTestId('free-chat-doc').first().waitFor({ timeout: 10_000 })
      await page.getByTestId('free-chat-input').fill('这是今天的周会记录，帮我分下去')
      await page.getByTestId('free-chat-send').click()
      await page.getByTestId('fanout-card').waitFor({ timeout: 30_000 })
      await page.waitForTimeout(800)
      await page.screenshot({ path: join(SHOTS, `1-plan-${theme}.png`) })
      console.log(`  📷 1-plan-${theme}.png`)
      if (theme === 'light') {
        sessionUrl = page.url()
        await page.getByTestId('fanout-edit').click()
        await page.waitForTimeout(400)
        await page.getByTestId('fanout-card').screenshot({ path: join(SHOTS, '2-plan-edit.png') })
        console.log('  📷 2-plan-edit.png')
        // 待定那条交给第一个岗位，然后「就这样」
        const pick = page.locator('[data-owner="unsure"] [data-testid="fanout-item-owner"]').first()
        if ((await pick.count()) > 0) await pick.selectOption({ index: 1 })
        await page.getByTestId('fanout-accept').click()
        await page.getByTestId('fanout-summary').waitFor({ timeout: 30_000 })
        await page
          .getByTestId('assistant-report-batch')
          .first()
          .waitFor({ timeout: 60_000 })
          .catch(() => console.error('  ⚠️ 一分钟内没等到回报'))
        await page.waitForTimeout(800)
        notesCard = (await page.getByTestId('fanout-summary-confirm').getAttribute('href')) ?? ''
        await page.screenshot({ path: join(SHOTS, '3-summary.png'), fullPage: false })
        console.log('  📷 3-summary.png')
      }
      await context.close()
    }
    rmSync(notesDir, { recursive: true, force: true })

    // 某岗位第三栏「知识」：待你确认
    {
      const { context, page } = await open('light')
      const target = state.targets.find((x) => x.name === b) ?? state.targets[0]
      const asg = me.assignments.find((x) => target?.duties.some((d) => d.role_id === x.role_id))
      await page.goto(`${BASE}/positions/${asg?.id ?? ''}`, { waitUntil: 'networkidle' })
      await page.getByTestId('rail-icon-settings').click({ timeout: 20_000 })
      await page.getByTestId('settings-tab-knowledge').click({ timeout: 10_000 })
      await page.getByTestId('rail-knowledge-pending').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, '4-position-pending.png') })
      console.log('  📷 4-position-pending.png')
      await context.close()
    }

    // 卡片流里「要记的 N 条」确认卡
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}${notesCard}`, { waitUntil: 'networkidle' })
      const card = page.getByTestId('deck-layout-assistant-notes').first()
      await card.waitFor({ timeout: 20_000 }).catch(() => console.error('  ⚠️ 首页没找到确认卡'))
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, '5-notes-card.png') })
      console.log('  📷 5-notes-card.png')
      await context.close()
    }
    void sessionUrl
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
