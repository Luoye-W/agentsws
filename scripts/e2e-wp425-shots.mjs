#!/usr/bin/env node
/**
 * WP425：自己的 AI 优先、用不了再用工坊积分——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317 / 4590）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界，内存里，跑完即停），再起一个本机替身「自己的 AI」
 * （`--own-port`，只回 429 = 额度用完）。用 Playwright：
 *
 * **端到端**：关联演示工坊账号 → 接上「自己的 AI」并设成默认 → 设置里「AI 来源」：主用是它、备用是工坊积分、开关默认开 →
 * 助理对话里问一句：这一轮用工坊积分答完，回复上方照实一行「你的 … 额度用完了，这一轮用工坊积分」→
 * 关掉开关再问：照实停下，出「用工坊积分接着做」那张卡 → 点它：开关打开、这一轮重答成功。
 * 不通过就退出码 1。
 *
 * **截图**（`--out` 目录；审稿截图放私有仓，别提交进公开仓）：
 * 1. `1-settings-light` / `1-settings-dark`：设置 → 模型「AI 来源」那一处；
 * 2. `2-switched-light` / `2-switched-dark`：助理对话里切到工坊积分那一行；
 * 3. `3-off-card-light` / `3-off-card-dark`：开关关着时的那张卡；
 * 4. `4-credits-light`：账号与积分页那一句。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp425-shots.mjs [--port 4580] [--own-port 4581] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp425'))
const PORT = Number(argOf('--port') ?? '4580') || 4580
const OWN_PORT = Number(argOf('--own-port') ?? '4581') || 4581
for (const p of [PORT, OWN_PORT])
  if (p === 4317 || p === 4590) throw new Error(`别用 ${p}（那是本机正在用的服务）`)
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(600)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

/** 本机替身「自己的 AI」：模型清单照回，对话一律 429（额度用完）。 */
function ownAiStandIn() {
  let calls = 0
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5' }] }))
      return
    }
    calls += 1
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'You exceeded your current quota.' } }))
  })
  return { server, calls: () => calls }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const own = ownAiStandIn()
  await new Promise((r) => own.server.listen(OWN_PORT, '127.0.0.1', r))
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-19T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const link = await api(undefined, undefined, 'POST', '/v1/auth/magic-link', { email: OWNER })
    const token = (
      await api(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token })
    ).session_token
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    for (let i = 0; i < 60; i += 1) {
      if ((await api(token, owner, 'GET', '/v1/cloud/account')).linked === true) break
      await sleep(250)
    }
    // 接上「自己的 AI」（本机替身；钥匙是这一次现编的演示值）并设成默认
    await api(token, owner, 'PUT', '/v1/models/providers/own', {
      kind: 'openai_compatible',
      label: 'OpenAI',
      base_url: `http://127.0.0.1:${OWN_PORT}/v1`,
      model: 'gpt-5.5',
      api_key: 'sk-demo-wp425-not-a-real-key',
      price_in: 0,
      price_out: 0,
      price_source: 'manual',
    })
    const defaults = await api(token, owner, 'PUT', '/v1/models/defaults', {
      default: 'own/gpt-5.5',
    })
    check(
      defaults.ai_source?.backup?.available === true &&
        defaults.ai_source?.fallback_to_cloud === true &&
        defaults.ai_source?.own?.some((o) => o.provider_id === 'own'),
      '设置「AI 来源」：主用是自己的、备用工坊积分、开关默认开',
    )

    const open = async (theme) => {
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
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }

    // ① 设置 → 模型「AI 来源」
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/settings/models`, { waitUntil: 'networkidle' })
      const section = page.getByTestId('model-ai-source')
      const shown = await section
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') check(shown, '设置里出「AI 来源」那一处')
      if (shown) {
        await section.scrollIntoViewIfNeeded()
        await shot(page, `1-settings-${theme}`)
      }
      await context.close()
    }

    /** 助理对话里说一句，等这一轮答完（或停下）。 */
    const say = async (page, text) => {
      const input = page.getByTestId('free-chat-input')
      await input.waitFor({ timeout: 20_000 })
      await input.fill(text)
      await page.getByTestId('free-chat-send').click()
      await page
        .locator('[data-testid="free-chat-assistant"][data-live="false"]')
        .last()
        .waitFor({ timeout: 30_000 })
      await page.waitForTimeout(800)
    }

    // ② 切到工坊积分那一行
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      const before = own.calls()
      await say(page, '帮我写一句给老客户的感谢话，短一点')
      const line = page.getByTestId('free-chat-source-switch').last()
      const lineShown = await line
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') {
        check(own.calls() > before, '先打了自己的 AI（回 429）')
        check(lineShown, '对话里照实一行「这一轮用工坊积分」')
        if (lineShown)
          check(
            (await line.innerText()).includes('额度用完了，这一轮用工坊积分'),
            '那一行说的是额度用完',
          )
        check(
          (await page.getByTestId('free-chat-reply').last().count()) > 0,
          '这一轮用工坊积分答完了',
        )
      }
      await shot(page, `2-switched-${theme}`)
      await context.close()
    }

    // ③ 开关关着：照实停下 + 「用工坊积分接着做」那张卡
    await api(token, owner, 'PUT', '/v1/models/defaults', { fallback_to_cloud: false })
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      await say(page, '再写一句，换个说法')
      const card = page.getByTestId('free-chat-backup-card').last()
      const cardShown = await card
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') {
        check(cardShown, '开关关着：出「用工坊积分接着做」那张卡')
        const error = await page.getByTestId('free-chat-error').last().innerText()
        check(error.includes('关着'), '停下的那一句说清开关关着')
      }
      await shot(page, `3-off-card-${theme}`)
      if (theme === 'dark' && cardShown) {
        // 点卡：开关打开、这一轮重答
        await page.getByTestId('free-chat-backup-use').last().click()
        await page.waitForTimeout(500)
        await page
          .locator('[data-testid="free-chat-assistant"][data-live="false"]')
          .last()
          .waitFor({ timeout: 30_000 })
        const after = await api(token, owner, 'GET', '/v1/models/defaults')
        check(after.ai_source?.fallback_to_cloud === true, '点卡之后开关打开了')
        const switched = await page
          .getByTestId('free-chat-source-switch')
          .last()
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false)
        check(switched, '重答这一轮用工坊积分接着做了')
      }
      await context.close()
    }

    // ④ 账号与积分页那一句
    {
      const { context, page } = await open('light')
      await page.goto(`${BASE}/settings/account`, { waitUntil: 'networkidle' })
      const note = page.getByTestId('credits-own-ai-note')
      const shown = await note
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      check(shown, '积分页说清：用自己的 AI 不扣 AI 那部分，别的付费服务照常')
      if (shown) {
        await note.scrollIntoViewIfNeeded()
        await shot(page, '4-credits-light')
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
    own.server.close()
  }
  if (failed) process.exit(1)
  console.log('全部通过')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
