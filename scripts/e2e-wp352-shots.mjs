#!/usr/bin/env node
/**
 * WP352（决策 931）助理一条长对话截图，可重跑出处（不联网、不接真 AI、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），模型用 demo 自带的「Agents 工坊（用积分）」替身
 * （`cloud-ai-stand-in.ts`：会出话题小结、会翻旧账）。用接口说几段话，中间拨合成时钟（跨天、隔几小时）、
 * 点一次「换个话题」，再开页面拍：
 *
 * 1. `1-thread-light` / `1-thread-dark`：长对话（日期分隔、话题之间的淡线 + 一行小结）；
 * 2. `2-thread-full`：整条对话从头到尾（元素截图）；
 * 3. `3-search`：顶部搜索「退货」的命中；
 * 4. `4-search-jump`：点命中跳到那条、亮一下；
 * 5. `5-recalled`：问「上周说的退货期限」→ 助理翻旧账，回复下面「出处」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp352-shots.mjs [--port 4452]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp352')

const args = process.argv.slice(2)
const at = args.indexOf('--port')
const PORT = Number(at >= 0 ? args[at + 1] : '4452')
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
    now: Date.parse('2026-10-14T01:30:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  const HOUR = 3_600_000
  try {
    let owner = await login(OWNER)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${owner}` } })).json()
    ).data
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner').id

    // 「Agents 工坊（用积分）」关联上（demo 的替身云，示例邮箱，不出网）
    await call(owner, ownerAsg, 'POST', '/v1/cloud/account/link', { email: 'boss@example.com' })
    for (let i = 0; i < 50; i += 1) {
      const acct = await call(owner, ownerAsg, 'GET', '/v1/cloud/account')
      if (acct.linked === true) break
      await new Promise((r) => setTimeout(r, 200))
    }
    // 启用那一条（同设置页「启用」：没有 key，凭据是关联账号拿到的工作区令牌）
    await call(owner, ownerAsg, 'PUT', '/v1/models/providers/agentsws', {
      kind: 'agentsws_cloud',
      model: 'deepseek-flash',
    }).catch((e) => console.error(`  ⚠️ 启用云模型：${e.message}`))
    const models = await call(owner, ownerAsg, 'GET', '/v1/free-chat/models')
    const model = (models.choices.find((c) => c.official) ?? models.choices[0])?.id
    console.log(`  模型：${model ?? '（没有）'}`)

    const thread = await call(owner, ownerAsg, 'GET', '/v1/free-chat/thread')
    const say = async (text) => {
      const res = await fetch(`${BASE}/v1/free-chat/sessions/${thread.session.id}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner}`,
          'x-assignment': ownerAsg,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text, ...(model === undefined ? {} : { model }) }),
      })
      await res.text()
    }
    // 拨合成时钟；拨过一天登录会过期，拨完重新登录一次
    const later = async (ms) => {
      demo.world.clock.advance(ms)
      owner = await login(OWNER)
    }
    // 第一天：退货口径
    await say('退货期限以后统一定 30 天，包邮门槛 99 元')
    await later(5 * 60_000)
    await say('退货运费谁出？质量问题我们出，其它买家出')
    // 第二天：派活
    await later(24 * HOUR)
    await say('让网站运营把店里的草稿商品检查一遍')
    await later(10 * 60_000)
    await say('各岗位今天在做什么？')
    // 隔了三小时：新品起名；之后手动换个话题
    await later(3 * HOUR)
    await say('帮我想三个 USB-C 充电器的新品名字')
    await later(20 * 60_000)
    await call(owner, ownerAsg, 'POST', '/v1/free-chat/thread/topic')
    await say('今天有什么要我处理的？')
    // 第三天：翻旧账
    await later(22 * HOUR)
    await say('上周说的退货期限是多少来着')
    await new Promise((r) => setTimeout(r, 1500)) // 等后台小结出完

    const open = async (theme, height = 900) => {
      const context = await browser.newContext({
        viewport: { width: 1360, height },
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
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await page.getByTestId('free-chat-messages').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(800)
      return { context, page }
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      // 滚到第一个话题分隔那里（淡线 + 一行小结 + 下面换了一天的日期都在一屏里）
      await page.evaluate(() => {
        const el = document.querySelectorAll('[data-testid="thread-topic"]')[0]
        el?.scrollIntoView({ block: 'center' })
      })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `1-thread-${theme}.png`) })
      console.log(`  📷 1-thread-${theme}.png`)
      await context.close()
    }
    {
      // 整条对话：把窗口拉高到一屏装得下
      const { context, page } = await open('light', 3200)
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="free-chat-messages"]')?.parentElement
          ?.parentElement
        if (el) el.scrollTop = 0
      })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, '2-thread-full.png') })
      console.log('  📷 2-thread-full.png')
      await context.close()
    }

    {
      const { context, page } = await open('light')
      await page.getByTestId('assistant-search').click()
      await page.getByTestId('assistant-search-input').fill('退货')
      await page.getByTestId('assistant-search-hit').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, '3-search.png') })
      console.log('  📷 3-search.png')
      await page.getByTestId('assistant-search-hit').filter({ hasText: '包邮' }).first().click()
      await page.waitForTimeout(900)
      await page.screenshot({ path: join(SHOTS, '4-search-jump.png') })
      console.log('  📷 4-search-jump.png')
      await context.close()
    }

    {
      const { context, page } = await open('light')
      const refs = page.getByTestId('assistant-recalled')
      await refs
        .last()
        .waitFor({ timeout: 10_000 })
        .catch(() => console.error('  ⚠️ 没看到「出处」'))
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, '5-recalled.png') })
      console.log('  📷 5-recalled.png')
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
