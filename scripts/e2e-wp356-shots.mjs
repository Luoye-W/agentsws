#!/usr/bin/env node
/**
 * WP356（决策 923）：设置改成弹出大面板 + 设置项重新梳理——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4456，不碰 4317）。不填 key、不关联账号、不发请求出去。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp356-shots.mjs [--port 4456] [--tag after|before]
 * ```
 *
 * before：老设置页三个 tab、连接、消息渠道、岗位与品牌、账号菜单「设置」组。
 * after：每一组至少一张、搜索命中、窄窗口（800×560）、深色、账号菜单。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp356')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4456') || 4456
const TAG = argOf('--tag') ?? 'after'
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
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const session = (
      await post('/v1/auth/verify', {
        token: (await post('/v1/auth/magic-link', { email: OWNER })).data.token,
      })
    ).data.session_token

    browser = await chromium.launch({ headless: true })
    const open = async ({ width = 1280, height = 800, theme = 'light' } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [session, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const ready = (page) =>
      page.locator('[data-testid="account-toggle"]').waitFor({ timeout: 30_000 })
    const shot = async (page, name, target) => {
      await page.waitForTimeout(800)
      const path = join(SHOTS, `${name}.png`)
      if (target === undefined) await page.screenshot({ path })
      else await page.locator(target).first().screenshot({ path })
      console.log(`  ✓ ${name}.png`)
    }

    if (TAG === 'before') {
      const pages = [
        ['before-settings-general', '/settings'],
        ['before-settings-account', '/settings?tab=account'],
        ['before-settings-plugins', '/settings?tab=plugins'],
        ['before-connections', '/connections'],
        ['before-im-channels', '/im-channels'],
        ['before-org', '/org'],
      ]
      for (const [name, path] of pages) {
        const { context, page } = await open({ height: 2000 })
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
        await ready(page)
        await shot(page, name)
        await context.close()
      }
      const { context, page } = await open()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.click('[data-testid="account-toggle"]')
      await page.click('[data-testid="account-group-settings-toggle"]')
      await shot(page, 'before-account-menu')
      await context.close()
      return
    }

    const dialog = '[data-testid="settings-dialog"]'
    const waitDialog = (page) => page.locator(dialog).waitFor({ timeout: 30_000 })

    // 1. 从首页按 ⌘, 打开（背后是原页面）
    {
      const { context, page } = await open()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.keyboard.press('Meta+Comma')
      await waitDialog(page)
      await shot(page, 'after-1-general')
      await context.close()
    }

    // 2. 每一组一张（直接用地址打开，背后是首页）
    const sections = [
      ['after-2-account', '/settings/account'],
      ['after-3-memory', '/settings/memory'],
      ['after-4-privacy', '/settings/privacy'],
      ['after-5-models', '/settings/models'],
      ['after-6-web', '/settings/web'],
      ['after-7-runs', '/settings/runs'],
      ['after-8-profile', '/settings/profile'],
      ['after-9-positions', '/settings/positions'],
      ['after-10-connections', '/connections'],
      ['after-11-channels', '/im-channels'],
      ['after-12-data-apis', '/settings/data-apis'],
      ['after-13-background', '/settings/background'],
      ['after-14-extension', '/settings/extension'],
      ['after-15-diagnostics', '/settings/diagnostics'],
      ['after-16-shortcuts', '/settings/shortcuts'],
      ['after-17-brands', '/org?tab=brands'],
      ['after-18-mode', '/settings/mode'],
      ['after-19-team', '/org?tab=colleagues'],
      ['after-19b-notifications', '/settings/notifications'],
    ]
    for (const [name, path] of sections) {
      const { context, page } = await open()
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      await waitDialog(page)
      await shot(page, name)
      await context.close()
    }

    // 3. 搜索：打「归档」→ 命中「自动归档」→ 点了跳过去并高亮
    {
      const { context, page } = await open()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.keyboard.press('Meta+Comma')
      await waitDialog(page)
      await page.fill('[data-testid="settings-search"]', '归档')
      await shot(page, 'after-20-search')
      await page.locator('[data-testid="settings-search-hit"]').first().click()
      await page.waitForTimeout(300)
      await shot(page, 'after-21-search-jump')
      await context.close()
    }

    // 4. 窄窗口 800×560、深色
    {
      const { context, page } = await open({ width: 800, height: 560 })
      await page.goto(`${BASE}/settings/general`, { waitUntil: 'networkidle' })
      await waitDialog(page)
      await shot(page, 'after-30-narrow')
      await context.close()
    }
    {
      const { context, page } = await open({ theme: 'dark' })
      await page.goto(`${BASE}/settings/models`, { waitUntil: 'networkidle' })
      await waitDialog(page)
      await shot(page, 'after-31-dark')
      await context.close()
    }

    // 5. 账号菜单 + ⌘K 搜设置项
    {
      const { context, page } = await open()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.click('[data-testid="account-toggle"]')
      await shot(page, 'after-40-account-menu')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Meta+k')
      await page.keyboard.type('自动记忆')
      await shot(page, 'after-41-palette')
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
