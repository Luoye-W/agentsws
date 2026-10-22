#!/usr/bin/env node
/**
 * WP473（docs/116 §6 D）：设置 → AI →「花费」那一块，浅 / 深各拍一张（不联网、不接真 AI、不碰 4317）。
 *
 * demo 本身全程不叫模型（事件日志里不许有 `model.*`，demo 的测试钉着），所以这里在**本进程**起一个 demo 之后，
 * 用它自己的模型网关（stub 来源）照各功能平时的写法调几次：岗位运行、客服聊天窗、邮件自动回、SEO、助理——
 * stub 来源会模拟缓存（同一段系统提示第二次起算命中），于是表里有命中的、也有没命中的行。
 * 跑完即停，不落盘。
 *
 * ```
 * npx tsc -b apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp473-shots.mjs [--port 4804] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp473'))
const PORT = Number(argOf('--port') ?? '4804') || 4804
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', { email })
  return (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
}

/** 照各功能平时的写法调几次 stub 模型（固定说明在系统提示里的，第二次起命中）。 */
async function seedUsage(gateway, workspace_id) {
  const persona = '你是售后客服岗位。'.repeat(60)
  const skills = '# skills\n- customer-care (open/always)'
  const chatRules = '你是网站聊天窗里的客服。短、具体、不承诺钱。'.repeat(40)
  const assistantRules = '你是这个工作区的助理，帮老板派活、查进度。'.repeat(50)
  const meta = (run_id, purpose = 'run') => ({
    workspace_id,
    assignment_id: 'asg_demo',
    role_id: 'dtc.support',
    run_id,
    purpose,
  })
  const calls = [
    // 岗位运行：静态前缀之后打断点；同一职责第二次起命中
    ...['run_k3x9a1', 'run_k3x9a2', 'run_k3x9a3'].map((id, i) => ({
      messages: [
        { role: 'system', content: persona },
        { role: 'system', content: skills },
        { role: 'user', content: `第 ${i + 1} 件：客人要退货` },
      ],
      cache_breakpoints: [2],
      meta: meta(id),
    })),
    // 客服聊天窗：规矩在系统提示里
    ...[1, 2, 3, 4].map((n) => ({
      messages: [
        { role: 'system', content: chatRules },
        { role: 'user', content: `访客第 ${n} 句：到哪了？` },
      ],
      meta: meta(`run_chat_ses_demo_${n}`),
    })),
    // 邮件自动回、SEO：只发一条用户消息（没有可命中的固定开头）
    { messages: [{ role: 'user', content: '信：能退吗？' }], meta: meta('run_email_auto_m1_1') },
    { messages: [{ role: 'user', content: '写一段商品页初稿' }], meta: meta('run_seo_c1') },
    // 助理：同一段每轮开头一样
    ...[1, 2].map((n) => ({
      messages: [
        { role: 'system', content: assistantRules },
        { role: 'user', content: `第 ${n} 轮：今天有什么要我定的？` },
      ],
      meta: { ...meta(`fchat_turn_${n}`, 'free_chat'), cache_scope: 'assistant_segment:seg_demo' },
    })),
  ]
  for (const req of calls) await gateway.complete(req)
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
    now: Date.parse('2026-10-22T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    await seedUsage(demo.server.models, demo.world.workspace_id)
    const owner = await login(OWNER)
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
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
      await page.goto(`${BASE}/settings/models`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('settings-dialog').waitFor({ timeout: 90_000 })
      const fold = page.getByTestId('models-costs')
      await fold.waitFor({ timeout: 90_000 })
      await fold.evaluate((el) => {
        el.setAttribute('open', '')
      })
      const table = page.getByTestId('model-usage')
      await table.waitFor({ timeout: 90_000 })
      await table.scrollIntoViewIfNeeded()
      await page.waitForTimeout(1200)
      const rows = await page.getByTestId('model-usage-row').allTextContents()
      console.log(`  [${theme}] ${rows.length} 行：${rows.join(' | ')}`)
      await table.locator('..').screenshot({ path: join(SHOTS, `after-${theme}-usage.png`) })
      console.log(`  📷 after-${theme}-usage.png`)
      // 悬停问号：说明在 tooltip 里
      await table.locator('[data-hint]').first().hover()
      await page.waitForTimeout(800)
      await page
        .getByTestId('settings-dialog')
        .screenshot({ path: join(SHOTS, `after-${theme}-usage-hint.png`) })
      console.log(`  📷 after-${theme}-usage-hint.png`)
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
    process.exit(2)
  },
)
