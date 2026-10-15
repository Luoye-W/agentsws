#!/usr/bin/env node
/**
 * WP343（决策 334 / 859）「我的助理」截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），模型用 demo 自带的「Agents 工坊（用积分）」替身
 * （`cloud-ai-stand-in.ts`：说「让 X…」时调派活工具，问「今天有什么要我处理」时调只读工具）。拍：
 *
 * 1. `1-empty-light` / `1-empty-dark`：空状态（标题 + 一行说明 + 快捷问题）；
 * 2. `2-suggestions`：输入框下面的快捷问题（特写）；
 * 3. `3-mention`：输入框里打 `@` 弹出的岗位 / 职责；
 * 4. `4-dispatched`：「让网站运营…」→ 回复下面「已交给…」+ 那件事回来报的一句；
 * 5. `5-ask-cards`：问「今天有什么要我处理的？」（只读工具，照查到的答）；
 * 6. `6-peers`：同事 / 公司模式右上角「替我答同事」打开的样子。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp343-shots.mjs [--port 4443]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp343')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4443')
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

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await page.getByTestId('free-chat-empty').waitFor({ timeout: 20_000 })
      await page.getByTestId('assistant-suggestions').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, `1-empty-${theme}.png`) })
      console.log(`  📷 1-empty-${theme}.png`)
      if (theme === 'light') {
        await page
          .getByTestId('free-chat-empty')
          .screenshot({ path: join(SHOTS, '2-suggestions.png') })
        console.log('  📷 2-suggestions.png')
        await page.getByTestId('free-chat-input').click()
        await page.keyboard.type('@')
        await page.getByTestId('assistant-mention-menu').waitFor({ timeout: 10_000 })
        await page.waitForTimeout(300)
        await page.getByTestId('free-chat-empty').screenshot({ path: join(SHOTS, '3-mention.png') })
        console.log('  📷 3-mention.png')
        await page.keyboard.press('Escape')
        await page.getByTestId('free-chat-input').fill('')
      }
      await context.close()
    }

    // 派活：模型（替身）调派活工具 → 回复下面「已交给…」→ 那件事跑完 → 对话里报一句
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await page.getByTestId('free-chat-model').click({ timeout: 20_000 })
      await page.getByTestId('free-chat-model-option').filter({ hasText: 'Agents' }).first().click()
      await page.getByTestId('free-chat-input').fill('让网站运营把店里的草稿商品检查一遍')
      await page.getByTestId('free-chat-send').click()
      await page.getByTestId('assistant-dispatch-link').waitFor({ timeout: 30_000 })
      await page
        .getByTestId('assistant-report')
        .first()
        .waitFor({ timeout: 60_000 })
        .catch(() => console.error('  ⚠️ 一分钟内没等到回报'))
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, '4-dispatched.png') })
      console.log('  📷 4-dispatched.png')

      await page.getByTestId('free-chat-input').fill('今天有什么要我处理的？')
      await page.getByTestId('free-chat-send').click()
      await page.waitForTimeout(4000)
      await page.screenshot({ path: join(SHOTS, '5-ask-cards.png') })
      console.log('  📷 5-ask-cards.png')
      await context.close()
    }

    // 同事 / 公司模式：右上角「替我答同事」
    if (orgs[0]?.mode === 'solo' && orgs[0]?.id !== undefined)
      await call(owner, ownerAsg, 'PUT', `/v1/orgs/${orgs[0].id}/mode`, { mode: 'peers' })
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await page.getByTestId('assistant-peers').click({ timeout: 20_000 })
      await page.getByTestId('assistant-peers-sheet').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(800)
      await page.screenshot({ path: join(SHOTS, '6-peers.png') })
      console.log('  📷 6-peers.png')
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
