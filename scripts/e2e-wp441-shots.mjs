#!/usr/bin/env node
/**
 * WP441（docs/108 §5.1 / §5.6）：消息规则——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 模型，内存里，跑完即停），用 Playwright 查：
 * 右栏「规则」里有三条演示消息规则和系统规则「今天的简报」；顶上一句话 → 「要建这条规则吗」（试跑命中几封、
 * 会改掉去向的几封）→ 点「建」→ 清单多一条；同一张卡也在首页卡片流里（「建」在卡身里）；类型胶囊弹层写按哪条规则
 * 处理、能「这封不该归它」「在对话里改」；今天的简报按规则分组。明暗各一套。不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓）：
 * proposal-{light,dark}、list-{light,dark}、card-{light,dark}、why-{light,dark}、digest-{light,dark}。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp441-shots.mjs [--port 4696] --out <目录>
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
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(tmpdir(), 'agentsws-wp441-shots'))
const PORT = Number(argOf('--port') ?? '4696') || 4696
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
    now: Date.parse('2026-10-22T09:00:00Z'),
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
    const openPanel = async (page, panel, testId) => {
      await page.goto(`${BASE}/messages?panel=${panel}`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId(testId).waitFor({ timeout: 30_000 })
    }
    const propose = async (page, sentence) => {
      const input = page.getByTestId('message-rule-input')
      await input.fill(sentence)
      const res = page.waitForResponse((r) =>
        r.url().includes('/v1/messages/message-rules/propose'),
      )
      await page.getByTestId('message-rule-propose').click()
      const body = await (await res).json().catch(() => ({}))
      const box = page.getByTestId('rule-proposal')
      await box.waitFor({ timeout: 30_000 })
      return { box, card_id: body?.data?.card_id }
    }

    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme} ──`)
      const { context, page } = await open(theme)

      // 规则清单：三条演示消息规则 + 系统规则
      await openPanel(page, 'rules', 'message-rules-panel')
      await page.getByTestId('message-rule-item').first().waitFor({ timeout: 20_000 })
      const groups = await page
        .getByTestId('message-rules-group')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))
      console.log(`  组：${groups.join(' / ')}`)
      check(
        groups.includes('message') && groups.includes('system'),
        '有「消息规则」与「系统规则」两组',
      )
      const before = await page.getByTestId('message-rule-item').count()

      // 一句话 → 要建吗
      const sentence =
        theme === 'light'
          ? 'kraft-boxes.example 发来的报价都交给 B2B、进简报'
          : 'shipfast.example 的账单都打个标签、别烦我'
      const { box, card_id } = await propose(page, sentence)
      check(typeof card_id === 'string', `出了「要建这条规则吗」卡（${card_id}）`)
      const trial = await box.getByTestId('rule-proposal-trial').innerText()
      console.log(`  试跑：${trial.replace(/\s+/g, ' ').slice(0, 80)}`)
      check(/过去 30 天会命中 [1-9]/.test(trial), '试跑命中几封（不是 0）')
      if (theme === 'light')
        check(
          (await box.getByTestId('rule-proposal-changed').count()) === 1,
          '「会改掉去向的」单列出来',
        )
      await shot(page, `proposal-${theme}`)

      // 同一张卡也在卡片流里（首页「要你定」点进来的那一页；「建」在卡身里）
      await page.goto(`${BASE}/cards/${encodeURIComponent(card_id ?? '')}`, {
        waitUntil: 'load',
        timeout: 90_000,
      })
      const card = page.getByTestId('deck-rule-proposal').first()
      await card.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await card.count()) > 0, '卡片页是同一个样子')
      if ((await card.count()) > 0) {
        await card.scrollIntoViewIfNeeded()
        await shot(page, `card-${theme}`)
        await card.getByTestId('rule-proposal-build').click()
        await card.getByTestId('rule-proposal-decided').waitFor({ timeout: 20_000 })
        check(true, '卡身里点「建」')
      }

      // 回到清单：多一条
      await openPanel(page, 'rules', 'message-rules-panel')
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="message-rule-item"]').length === n + 1,
        before,
        { timeout: 20_000 },
      )
      check(true, `清单多了一条（${before} → ${before + 1}）`)
      await page.getByTestId('message-rule-hits').first().click()
      await shot(page, `list-${theme}`)

      // 类型胶囊：为什么这样处理
      await page.goto(
        `${BASE}/messages?view=all&thread=${encodeURIComponent('<demo-m103@mail.example>')}`,
        {
          waitUntil: 'load',
          timeout: 60_000,
        },
      )
      const ai = page.getByTestId('mail-ai')
      await ai.waitFor({ timeout: 30_000 })
      if ((await ai.getAttribute('data-open')) !== 'true')
        await page.getByTestId('mail-ai-toggle').click()
      await page.getByTestId('kind-chip').first().click()
      await page.getByTestId('kind-rule-why').waitFor({ timeout: 10_000 })
      const head = await page.getByTestId('kind-popover-head').innerText()
      console.log(`  胶囊：${head}`)
      check(
        head.includes('供应商来信') && head.includes('另有 1 条'),
        '弹层写按哪条规则、另有几条也命中',
      )
      await shot(page, `why-${theme}`)

      // 今天的简报
      await openPanel(page, 'digest', 'message-digest-panel')
      const total = await page.getByTestId('message-digest-total').getAttribute('data-total')
      check(Number(total) >= 3, `简报里 ${total} 封`)
      check((await page.getByTestId('message-digest-group').count()) >= 2, '按规则分组')
      await shot(page, `digest-${theme}`)
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
  console.log('WP441 截图走完')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
