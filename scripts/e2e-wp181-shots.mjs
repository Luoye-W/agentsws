#!/usr/bin/env node
/**
 * WP181：右栏「定时任务」——截图的可重跑出处（不联网、不下载、替身模型）。
 *
 * 在本进程里起一个 demo（`createDemo`），官方插件层放在一个临时目录里、把「自动化任务」选进来
 * （与设置 → 官方插件批过之后一样，不跑 pnpm），然后在事项里跟 AI 说两句要提醒的话（stub 运行时调官方
 * `schedule_create`），拍到 `docs/assets/wp181/`：
 *
 * 1. `schedules-panel.png`：右栏定时任务——这件事的在前；会往外发的那条标「等你批」；
 * 2. `schedules-panel-edit.png`：点开一条，「重复 + 时间 + 周几」，改了才出保存条。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp181-shots.mjs [--port 4481]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp181')
const SCHEDULE = '@deepseek-ai/dsh-experimental-schedule-bundle'

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 ? args[i + 1] : '4481')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function login(email) {
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
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
  if (!res.ok) throw new Error(`${method} ${path} 没成：${res.status} ${await res.text()}`)
  return (await res.json()).data
}

/** 开一件事、说一句话（stub 运行时看到「提醒 / 每天 / 每周」就调官方 `schedule_create`）。 */
async function say(token, asg, title, text) {
  const { matter } = await call(token, asg, 'POST', '/v1/matters', { kind: 'conversation', title })
  await call(token, asg, 'POST', `/v1/matters/${matter.id}/messages`, { text })
  return matter.id
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { shippedBundleBackend } = await import(
    pathToFileURL(join(ROOT, 'packages/dsh-adapter/dist/official-plugins.js')).href
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  // 插件层：本脚本自己建的临时目录，拍完删掉
  const layer = mkdtempSync(join(tmpdir(), 'agentsws-wp181-shots-'))
  const backend = await shippedBundleBackend({ dir: join(layer, 'official-plugins') })
  await backend.select(SCHEDULE, '0.2.0-rc.1')
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    officialPlugins: { backend },
  })
  await demo.server.listen()
  let browser
  try {
    const owner = await login(OWNER)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${owner}` } })).json()
    ).data
    const asg = me.assignments.find((a) => a.role_id === 'common.owner').id
    const here = await say(owner, asg, '每天看一眼订单', '每天早上 9 点提醒我看昨天的订单')
    await call(owner, asg, 'POST', `/v1/matters/${here}/messages`, {
      text: '工作日下午 3 点半提醒我看库存',
    })
    await say(owner, asg, '老客户问候', '每周一、三 10 点半给老客户群发邮件问好')

    browser = await chromium.launch({ headless: true })
    // 按公司所在时区看（与工作区档案同一个；不同时频率那一行会多标一个时区，官方也是这么做的）
    const context = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
    })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* demo 自动登录兜底 */
      }
    }, owner)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/matters/${here}`, { waitUntil: 'networkidle' })
    await page.click('[data-testid="rail-icon-schedules"]')
    const panel = page.locator('[data-testid="rail-panel-frame"]')
    await page.waitForSelector('[data-testid="rail-schedules"]', { timeout: 20_000 })
    await page.waitForTimeout(300)
    await panel.screenshot({ path: join(SHOTS, 'schedules-panel.png') })
    console.log('  📷 schedules-panel.png')

    // 「每天 9 点」那一条改成每周一、五：点开 → 每周 → 勾周一（原来那天是下一次的周几）
    await page
      .locator('[data-testid="rail-schedule-row"]', { hasText: '每天早上' })
      .locator('button')
      .first()
      .click()
    await page.click('[data-testid="rail-schedule-repeat-weekly"]')
    await page.click('[data-testid="rail-schedule-day-1"]')
    await page.waitForSelector('[data-testid="rail-schedule-savebar"]')
    await panel.screenshot({ path: join(SHOTS, 'schedules-panel-edit.png') })
    console.log('  📷 schedules-panel-edit.png')
  } finally {
    await browser?.close()
    await demo.close()
    rmSync(layer, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
