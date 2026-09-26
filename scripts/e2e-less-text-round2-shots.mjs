#!/usr/bin/env node
/**
 * WP157（界面减字第二轮）：前后对比截图的可重跑出处。存到 `docs/assets/wp157/<tag>-*.png`。
 *
 * 拍这几处（派工单点名的）：
 *
 * 1. `<tag>-connections-cards.png`：连接页「可以连接」那一格（provider 卡）；
 * 2. `<tag>-connections-extension.png`：连接页「浏览器插件」一节（生成了配对码之后）；
 * 3. `<tag>-im-channels.png`：消息渠道页；
 * 4. `<tag>-chat-window.png`：网站聊天窗设置页；
 * 5. `<tag>-position-<id>.png`：岗位页（客服、红人营销两个岗位的第一屏）；
 * 6. `<tag>-command-help.png`、`<tag>-help-conn.png`（只有 after 有）：⌘K 里搜「Google」出教程、
 *    回车在右栏打开「Google 家的几个连接」。
 *
 * **不联网、不用真账号**：全走 demo（合成数据）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-less-text-round2-shots.mjs --tag before|after [--port 4446]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp157')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4446'))
const TAG = value('--tag', 'after')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

async function shoot(locator, name) {
  await locator.scrollIntoViewIfNeeded()
  await locator.page().waitForTimeout(400)
  await locator.screenshot({ path: join(SHOTS, `${TAG}-${name}.png`) })
  console.log(`  📷 ${TAG}-${name}.png`)
}

async function page(context, path, ready) {
  const p = await context.newPage()
  p.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await p.locator(ready).first().waitFor({ timeout: 20_000 })
  return p
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 连接页
    const conn = await page(context, '/connections', '[data-testid="provider-card"]')
    const cards = conn.locator('[data-testid="provider-card"]').first().locator('xpath=../..')
    await shoot(cards, 'connections-cards')
    const ext = conn.locator('[data-testid="extension-section"]')
    await conn.click('[data-testid="extension-generate"]')
    await conn.locator('[data-testid="extension-code"]').waitFor()
    await shoot(ext, 'connections-extension')
    await conn.close()

    // ② 消息渠道
    const im = await page(context, '/im-channels', 'h1')
    await im.waitForTimeout(500)
    await im.screenshot({ path: join(SHOTS, `${TAG}-im-channels.png`), fullPage: true })
    console.log(`  📷 ${TAG}-im-channels.png`)
    await im.close()

    // ③ 网站聊天窗
    const chat = await page(context, '/chat-window', '[data-testid="chat-window-page"]')
    await chat.waitForTimeout(500)
    await shoot(chat.locator('[data-testid="chat-window-page"]'), 'chat-window')
    await chat.close()

    // ④ 岗位页：客服、红人营销
    const home = await page(context, '/', '[data-testid="nav-position-row"]')
    for (const [name, id] of [
      ['客服', 'customer-care'],
      ['红人营销', 'kol'],
    ]) {
      const link = home
        .locator('[data-testid="nav-position-row"]', { hasText: name })
        .first()
        .locator('a')
        .first()
      const href = await link.getAttribute('href')
      if (href === null) continue
      const pos = await page(context, href, 'main')
      await pos.waitForTimeout(1200)
      await pos.screenshot({ path: join(SHOTS, `${TAG}-position-${id}.png`) })
      console.log(`  📷 ${TAG}-position-${id}.png`)
      await pos.close()
    }
    await home.close()

    // ⑤ ⌘K 搜教程 → 右栏打开（改之前没有，跳过）
    const k = await page(context, '/', 'main')
    await k.keyboard.press('Meta+k')
    const input = k.locator('[cmdk-input]')
    if ((await input.count()) > 0) {
      await input.fill('Google')
      await k.waitForTimeout(400)
      const help = k.locator('[data-testid="command-help"]')
      if ((await help.count()) > 0) {
        await k.screenshot({ path: join(SHOTS, `${TAG}-command-help.png`) })
        console.log(`  📷 ${TAG}-command-help.png`)
        await help.first().click()
        await k.locator('[data-testid="help-panel"]').waitFor({ timeout: 10_000 })
        await k.waitForTimeout(600)
        await k.screenshot({ path: join(SHOTS, `${TAG}-help-conn.png`) })
        console.log(`  📷 ${TAG}-help-conn.png`)
      }
    }
    await k.close()
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
