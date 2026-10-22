#!/usr/bin/env node
/**
 * WP463（docs/111 §3）：**ego 浏览器真机联调**——点击级证据，每步一张截图。
 *
 * 前提（都要真的）：
 * - 这台电脑上装了 ego 并完成了首次引导（`ego-browser skill` 跑得通）；
 * - 一个本机档的服务进程已经在跑（独立数据目录、端口不碰 4317），配好了模型
 *   （例如环境变量 `DEEPSEEK_API_KEY`）；工作台构建产物由它一起服务；
 * - 这个工作区里有一个岗位，挂着一条 `browser_scope` 非空的职责（脚本用 `--position` 指它）。
 *
 * 步骤（除了登录拿会话，全部是点界面）：
 *
 * 1. 设置 → 浏览器：ego 那一项显示「已装好 · 版本号」；
 * 2. 选 ego → 保存；
 * 3. 到那个岗位，交一件事：「用 ego 打开 https://example.com，读一下网页标题告诉我」；
 * 4. 等这次运行跑完，事项页右栏「浏览器」面板：执行器 ego + 每段脚本那一行；
 * 5. 读运行记录（事件日志）核对：`tool.call{ego_run}` 里有脚本原文、`progress{ego_run}` 在。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node scripts/e2e-wp463-ego-real.mjs --base http://127.0.0.1:4716 --position <岗位分配 id> --shots <目录>
 * ```
 *
 * 只打开 example.com 这类公开页面；不碰任何登录态、不在 ego 里做写操作。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const BASE = value('--base', 'http://127.0.0.1:4716')
const POSITION = value('--position', '')
const SHOTS = resolve(value('--shots', join(ROOT, 'out/wp463')))
const EMAIL = value('--email', 'owner@localhost')
const TASK =
  '用 ego 浏览器打开 https://example.com ，读一下这个网页的标题，告诉我标题是什么。看完别关那个页面，留着给我看。'

let n = 0
const say = (text) => console.log(`\n[${String(++n).padStart(2, '0')}] ${text}`)
const must = (ok, what) => {
  if (!ok) throw new Error(`没过：${what}`)
  console.log(`  ✓ ${what}`)
}
async function shoot(page, name) {
  const file = join(SHOTS, `wp463-${String(n).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  📷 ${file}`)
}

/** 页内跳转（React Router 认 popstate），不丢「先跳过」那一记。 */
async function go(page, path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForTimeout(1500)
}

async function post(path, body, token, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
    body: JSON.stringify(body),
  })
  return (await res.json()).data
}
async function get(path, token, assignment) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-assignment': assignment },
  })
  return (await res.json()).data
}

async function main() {
  if (POSITION === '')
    throw new Error('要 --position <岗位分配 id>（挂着 browser_scope 非空的职责）')
  mkdirSync(SHOTS, { recursive: true })
  const link = await post('/v1/auth/magic-link', { email: EMAIL })
  const token = (await post('/v1/auth/verify', { token: link.token })).session_token
  // 读运行记录 / 事件日志用老板那条分配（岗位上的职责分配没有 event_log.read）
  const me = await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  const owner = (await me.json()).data.assignments.find((a) => a.role_id === 'common.owner')?.id
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript((t) => {
    window.localStorage.setItem('agentsws.session_token', t)
    window.localStorage.setItem('agentsws.theme', 'light')
  }, token)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  try {
    say('设置 → 浏览器：ego 那一项探到了，显示版本号')
    await page.goto(`${BASE}/settings/web`, { waitUntil: 'networkidle' })
    // 全新数据目录会先进「初始化设置」：点「先跳过」（模型由服务进程的环境变量给）
    // 「先跳过」只记在这一页的内存里，所以之后都用页内跳转（不整页重载）
    if (page.url().includes('/onboarding')) {
      await page.getByText('先跳过').first().click()
      await page.waitForTimeout(1500)
      await go(page, '/settings/web')
    }
    const card = page.getByTestId('settings-browser')
    await card.waitFor({ timeout: 60_000 })
    const egoRow = page.getByTestId('browser-mode-ego')
    await egoRow.waitFor({ timeout: 30_000 })
    const status = page.getByTestId('browser-ego-status')
    await status.waitFor({ timeout: 30_000 })
    const statusText = (await status.textContent()) ?? ''
    must(/已装好/.test(statusText), `ego 显示「${statusText.trim()}」`)
    await egoRow.scrollIntoViewIfNeeded()
    await shoot(page, 'settings-ego-detected')

    say('点「ego」→ 保存')
    await egoRow.locator('input[type="radio"]').click()
    await page.getByTestId('browser-save').click()
    await page.getByTestId('browser-saved').waitFor({ timeout: 20_000 })
    must((await card.getAttribute('data-mode')) === 'ego', '保存后设置是 ego')
    await shoot(page, 'settings-ego-saved')

    say(`到岗位交一件事：「${TASK}」`)
    await go(page, `/positions/${POSITION}`)
    const input = page.getByTestId('position-entry-input')
    await input.waitFor({ timeout: 60_000 })
    await input.fill(TASK)
    await shoot(page, 'position-task-typed')
    await page.getByTestId('matter-send').click()
    await page.waitForURL(/\/matters\//, { timeout: 120_000 })
    const matterId = /\/matters\/([^/?#]+)/.exec(page.url())?.[1]
    must(matterId !== undefined, `开了一件事（${matterId}）`)

    say('等这次运行跑完（AI 调 ego_run，ego 里出现它的 Space）')
    let runId
    let done = false
    for (let i = 0; i < 180 && !done; i += 1) {
      const m = await get(`/v1/matters/${matterId}`, token, owner)
      runId = m?.timeline?.filter((e) => e.run_id !== undefined).at(-1)?.run_id ?? runId
      if (runId !== undefined) {
        const view = await get(`/v1/runs/${runId}/browser`, token, owner)
        done = view?.running === false
      }
      if (!done) await page.waitForTimeout(2000)
    }
    must(runId !== undefined && done, `运行跑完了（${runId}）`)
    await go(page, '/')
    await go(page, `/matters/${matterId}`)
    await shoot(page, 'matter-answer')

    say('右栏「浏览器」面板：执行器 ego + 每段脚本那一行')
    const icon = page.getByTestId('rail-icon-browser')
    if ((await icon.count()) > 0) await icon.first().click()
    else {
      await page.getByTestId('rail-overflow').click()
      await page.getByTestId('rail-menu-browser').click()
    }
    const panel = page.getByTestId('rail-browser')
    const noRead = page.getByText('event_log.read')
    await panel.or(noRead).first().waitFor({ timeout: 30_000 })
    if ((await panel.count()) > 0) {
      must((await panel.getAttribute('data-executor')) === 'ego', '面板说这次用的是 ego')
      const runs = await page.getByTestId('rail-browser-ego-run').allTextContents()
      must(runs.length > 0, `面板列出 ${runs.length} 段脚本：${runs.join(' | ').slice(0, 200)}`)
    } else {
      // 这条职责的分配上没有 event_log.read（职责模板的既有设定，不是 ego 的事）：面板照实说看不了，
      // 同一份投影改用老板那条分配读一遍
      console.log('  ⚠️ 这条职责的分配没有 event_log.read，面板看不了；改用老板的分配读同一份投影')
    }
    await shoot(page, 'rail-browser-ego')
    const view = await get(`/v1/runs/${runId}/browser`, token, owner)
    must(view?.executor === 'ego', '投影：执行器 ego')
    must((view?.ego_runs ?? []).length > 0, `投影：${view.ego_runs.length} 段脚本的那一行`)
    for (const r of view.ego_runs) console.log(`    · ${r.note.slice(0, 160)}`)

    say('运行记录里有脚本原文（tool.call{ego_run}）与 progress{ego_run}')
    const events = await get(
      `/v1/events?run=${runId}&types=tool.call,progress&limit=500`,
      token,
      owner,
    )
    const list = Array.isArray(events) ? events : (events?.events ?? [])
    const calls = list.filter((e) => e.type === 'tool.call' && e.payload?.tool === 'ego_run')
    const progress = list.filter((e) => e.type === 'progress' && e.payload?.step === 'ego_run')
    must(calls.length > 0, `tool.call{ego_run} ${calls.length} 条`)
    must(progress.length > 0, `progress{ego_run} ${progress.length} 条`)
    const scripts = calls.map((e) => String(e.payload?.input?.script ?? ''))
    must(
      scripts.some((s) => s.includes('example.com')),
      '脚本原文里有 example.com',
    )
    writeFileSync(
      join(SHOTS, 'wp463-run-record.json'),
      `${JSON.stringify({ run_id: runId, matter_id: matterId, scripts, progress: progress.map((e) => e.payload) }, null, 2)}\n`,
    )
    console.log(`\n全部通过。运行记录摘出：${join(SHOTS, 'wp463-run-record.json')}`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
