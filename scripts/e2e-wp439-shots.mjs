#!/usr/bin/env node
/**
 * WP439（docs/108 §5.1.5 / §5.7）：消息页右栏「规则」+ 回复建议按来信语言——端到端走一遍 + 截图，可重跑
 * （不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），用 Playwright 查：
 * 「你教过它」的「共 3 条规则 →」点了右栏开「规则」、三行、命中数；顶栏右边那颗也开它；删一条 → 回声带撤回、
 * 撤回回来；英文来信的三条建议是英文、中文来信是中文。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓）：rules-light / rules-dark / rules-deleted /
 * suggest-en / suggest-zh（浅色），以及窄窗 rules-narrow。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp439-shots.mjs [--port 4644] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp439'))
const PORT = Number(argOf('--port') ?? '4644') || 4644
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

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
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
    now: Date.parse('2026-10-21T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
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
    const shot = async (page, name) => {
      await page.waitForTimeout(1200)
      await page.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const openRules = async (page) => {
      await page.goto(`${BASE}/messages`, { waitUntil: 'load', timeout: 90_000 })
      const link = page.getByTestId('messages-taught-rules')
      await link.waitFor({ timeout: 30_000 })
      check((await link.innerText()).includes('3'), `「你教过它」写「${await link.innerText()}」`)
      await link.click()
      await page.getByTestId('message-rules-panel').waitFor({ timeout: 20_000 })
      await page.getByTestId('message-rule-row').first().waitFor({ timeout: 20_000 })
    }

    // ── 浅色：清单、删、撤回 ──
    {
      const { context, page } = await open('light')
      await openRules(page)
      const rows = page.getByTestId('message-rule-row')
      check((await rows.count()) === 3, `清单里 ${await rows.count()} 行（教过 3 个发件人）`)
      const hits = await page
        .getByTestId('message-rule-hits')
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-hits'))))
      console.log(`  命中数：${hits.join(' / ')}`)
      check(hits.join(',') === '12,4,3', '命中数按多到少：12 / 4 / 3')
      const groups = await page
        .getByTestId('message-rules-group')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))
      check(groups.join(',') === 'sender', '只有「你教过的发件人」一组（空组不画）')
      await shot(page, 'rules-light')

      await rows.nth(1).getByTestId('message-rule-delete').click()
      const echo = page.getByTestId('message-rules-echo')
      await echo.waitFor({ timeout: 10_000 })
      check((await echo.innerText()).includes('已删，下一封会重新判'), '删了回声「已删，下一封会重新判」')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="message-rule-row"]').length === 2,
        undefined,
        { timeout: 10_000 },
      )
      check(true, '删了当场少一行')
      await shot(page, 'rules-deleted')
      await page.getByTestId('message-rules-undo').click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="message-rule-row"]').length === 3,
        undefined,
        { timeout: 10_000 },
      )
      check(true, '撤回之后回到 3 行')

      // 顶栏右边那颗也开它（先收起再点）
      const btn = page.getByTestId('message-rules-open')
      check((await btn.count()) === 1, '顶栏右边有「规则」那颗')
      await btn.click()
      await page.waitForTimeout(400)
      check((await page.getByTestId('message-rules-panel').count()) === 0, '再点一次收起')
      await btn.click()
      await page.getByTestId('message-rules-panel').waitFor({ timeout: 10_000 })
      check(true, '顶栏那颗打开规则')

      // 回复建议：英文来信 → 英文；中文来信 → 中文
      const suggestions = async (thread) => {
        await page.goto(
          `${BASE}/messages?view=all&thread=${encodeURIComponent(thread)}`,
          { waitUntil: 'load', timeout: 60_000 },
        )
        const ai = page.getByTestId('mail-ai')
        await ai.waitFor({ timeout: 30_000 })
        if ((await ai.getAttribute('data-open')) !== 'true')
          await page.getByTestId('mail-ai-toggle').click()
        const first = page.getByTestId('rail-mail-suggestion').first()
        await first.waitFor({ timeout: 30_000 })
        return page.getByTestId('rail-mail-suggestion').allInnerTexts()
      }
      const en = await suggestions('<demo-m113@mail.example>')
      console.log(`  英文来信建议：${en.map((s) => s.replace(/\s+/g, ' ').slice(0, 50)).join(' | ')}`)
      check(
        en.length === 3 && en.every((s) => /[A-Za-z]{4,}/.test(s.split('\n').slice(1).join(' '))),
        '英文来信：三条建议是英文',
      )
      await shot(page, 'suggest-en')
      const zh = await suggestions('<demo-m115@mail.example>')
      check(
        zh.length === 3 && zh.every((s) => /[一-龥]/.test(s.split('\n').slice(1).join(''))),
        '中文来信：三条建议是中文',
      )
      await shot(page, 'suggest-zh')
      await context.close()
    }

    // ── 深色 ──
    {
      const { context, page } = await open('dark')
      await openRules(page)
      await shot(page, 'rules-dark')
      await context.close()
    }

    // ── 窄窗 ──
    {
      const { context, page } = await open('light', { width: 390, height: 844 })
      await openRules(page)
      await shot(page, 'rules-narrow')
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
  console.log('WP439 截图走完')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
