#!/usr/bin/env node
/**
 * WP430：AI 来源回退顺序——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317 / 4590）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界，内存里，跑完即停），再起两个本机替身：
 * 「自己的 AI ①」（`--own-port`，对话一律 429 = 额度用完）与「自己的 AI ②」（`--own2-port`，好好地回）。用 Playwright：
 *
 * **端到端**：关联演示工坊账号 → 接上 ① ② 两条，① 设成默认，② 测一次（测试通过才会被自动接上）→
 * 设置里「AI 来源」：自己的两条按顺序列、② 标成能接 → 拖动排序存得住 →
 * 助理对话里问一句：① 额度用完，这一轮用了 ② 答完，回复上方照实一行「你的 … 额度用完了，这一轮用了你的 …」，没走工坊积分。
 * 不通过就退出码 1。
 *
 * **截图**（`--out` 目录；审稿截图放私有仓，别提交进公开仓）：
 * 1. `1-order-light` / `1-order-dark`：设置 → 模型「AI 来源」那一处（可拖动的有序列表）；
 * 2. `2-own-switch-light` / `2-own-switch-dark`：助理对话里切到自己的另一条那一行。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp430-shots.mjs [--port 4604] [--own-port 4605] [--own2-port 4606] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp430'))
const PORT = Number(argOf('--port') ?? '4604') || 4604
const OWN_PORT = Number(argOf('--own-port') ?? '4605') || 4605
const OWN2_PORT = Number(argOf('--own2-port') ?? '4606') || 4606
for (const p of [PORT, OWN_PORT, OWN2_PORT])
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

/**
 * 本机替身「自己的 AI」：模型清单照回；`quota` = 对话一律 429（额度用完），否则好好地回一句（流式 / 非流式都认）。
 */
function standIn(name, quota) {
  let calls = 0
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: name }] }))
      return
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      calls += 1
      if (quota) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'You exceeded your current quota.' } }))
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        /* 不是 JSON 就当非流式 */
      }
      const text = '老客户您好，谢谢您一直以来的支持，有需要随时找我们。'
      const usage = { prompt_tokens: 12, completion_tokens: 20 }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
        )
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage,
        }),
      )
    })
  })
  return { server, calls: () => calls }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const own = standIn('gpt-5.5', true)
  const own2 = standIn('deepseek-chat', false)
  await new Promise((r) => own.server.listen(OWN_PORT, '127.0.0.1', r))
  await new Promise((r) => own2.server.listen(OWN2_PORT, '127.0.0.1', r))
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
    // 接上两条「自己的 AI」（本机替身；钥匙是这一次现编的演示值），① 设成默认
    await api(token, owner, 'PUT', '/v1/models/providers/own', {
      kind: 'openai_compatible',
      label: 'OpenAI',
      base_url: `http://127.0.0.1:${OWN_PORT}/v1`,
      model: 'gpt-5.5',
      api_key: 'sk-demo-wp430-not-a-real-key',
      price_in: 0,
      price_out: 0,
      price_source: 'manual',
    })
    await api(token, owner, 'PUT', '/v1/models/providers/mine2', {
      kind: 'openai_compatible',
      label: 'DeepSeek',
      base_url: `http://127.0.0.1:${OWN2_PORT}/v1`,
      model: 'deepseek-chat',
      api_key: 'sk-demo-wp430-second-not-real',
      price_in: 0,
      price_out: 0,
      price_source: 'manual',
    })
    // ② 测一次：文字那一步过了才会被自动接上（看不了图不要紧）
    const tested = await api(token, owner, 'POST', '/v1/models/providers/mine2/test')
    check(
      tested.steps?.some((s) => s.step === 'text' && s.ok) === true,
      `② 测试文字那一步过了（${tested.reason ?? ''}）`,
    )
    let defaults = await api(token, owner, 'PUT', '/v1/models/defaults', {
      default: 'own/gpt-5.5',
    })
    const order = (d) => (d.ai_source?.own ?? []).map((o) => o.provider_id).join(',')
    const ready = (d, id) => d.ai_source?.own?.find((o) => o.provider_id === id)?.ready
    check(order(defaults) === 'own,mine2', `「AI 来源」按顺序列（${order(defaults)}）`)
    check(ready(defaults, 'mine2') === true, '② 标成能被自动接上')
    defaults = await api(token, owner, 'PUT', '/v1/models/defaults', {
      source_order: ['mine2', 'own'],
    })
    check(order(defaults) === 'mine2,own', '排序存得住')
    defaults = await api(token, owner, 'PUT', '/v1/models/defaults', { source_order: [] })
    check(order(defaults) === 'own,mine2', '清空排序 = 回到默认次序')

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

    // ① 设置 → 模型「AI 来源」：可拖动的有序列表
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/settings/models`, { waitUntil: 'networkidle' })
      const section = page.getByTestId('model-ai-source')
      const shown = await section
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') {
        check(shown, '设置里出「AI 来源」那一处')
        const list = page.getByTestId('model-ai-source-own')
        check((await list.getAttribute('data-order')) === 'own,mine2', '界面上的顺序与服务端一致')
        check(
          (await page.getByTestId('model-ai-source-handle-mine2').count()) === 1,
          '每一条有拖动手柄',
        )
      }
      if (shown) {
        // int/1023：WP426 重做后，顺序列表和备用开关都在「正在用」下面那张小表（model-defaults）里
        const card = page.getByTestId('model-defaults')
        await card.scrollIntoViewIfNeeded()
        await shot(page, `1-order-${theme}`, card)
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

    // ② 切到自己的另一条那一行
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'networkidle' })
      const before = own.calls()
      const before2 = own2.calls()
      await say(page, '帮我写一句给老客户的感谢话，短一点')
      const line = page.getByTestId('free-chat-source-switch').last()
      const lineShown = await line
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (theme === 'light') {
        check(own.calls() > before, '先打了原选（回 429）')
        check(own2.calls() > before2, '再打了自己的第二条')
        check(lineShown, '对话里照实一行')
        if (lineShown) {
          const said = await line.innerText()
          check(said.includes('额度用完了，这一轮用了你的'), `那一行说清走到了哪一个（${said}）`)
        }
        check(
          (await page.getByTestId('free-chat-reply').last().count()) > 0,
          '这一轮用自己的第二条答完了',
        )
      }
      if (theme === 'dark') {
        // 下一轮先试原选：AI 钮回到原来选的那一个（不跟着切过去的那一条走），原选又被打了一次
        check(own.calls() > before, '下一轮先试原选（AI 钮没跟着切过去的那一条走）')
        check(
          (await page.getByTestId('free-chat-source-switch').count()) >= 2,
          '下一轮原选还是额度用完：又照实一行',
        )
      }
      await shot(page, `2-own-switch-${theme}`)
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
    own.server.close()
    own2.server.close()
  }
  if (failed) process.exit(1)
  console.log('全部通过')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
