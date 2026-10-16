#!/usr/bin/env node
/**
 * WP351（决策 906）：左栏学 Claude 收紧 + 「助理」改名 + 聊天窗拆开 + 更新进度显示——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4451，不碰 4317）。更新按钮用替身桥（window.agentsws.update，同 wp218-shots），
 * 状态由脚本推——按钮、文案、图标都是真的工作台代码。不填 key、不关联账号、不发请求出去。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp351-shots.mjs [--port 4451] [--tag after|before]
 * ```
 *
 * before：左栏（浅 / 深）+ 首页整页 + 老「聊天窗」页。
 * after：左栏（浅 / 深）、悬停岗位出「>」、首页整页、「消息」里的网站聊天、消息渠道里的「网站聊天窗」、
 * 账号菜单设置组、更新三阶段（正在下载… / 正在准备新版… / 重启并更新）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp351')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4451') || 4451
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
  return res.json()
}

/** 替身更新桥：状态由脚本推（`window.__pushUpdate`）。 */
function updateBridge() {
  let current = { state: 'idle' }
  const listeners = new Set()
  window.__pushUpdate = (s) => {
    current = s
    for (const l of listeners) l(s)
  }
  window.agentsws = {
    ...(window.agentsws ?? {}),
    platform: 'win32',
    version: '0.2.0-beta.6',
    update: {
      status: async () => current,
      onChange: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      download: async () => current,
      install: async () => 'cancelled',
    },
  }
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
    const me = (
      await (
        await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${session}` } })
      ).json()
    ).data
    const chat = me.assignments.find((a) => a.role_id === 'dtc.live-chat')

    browser = await chromium.launch({ headless: true })
    const open = async ({ width = 1280, height = 800, theme = 'light', bridge = false } = {}) => {
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
      if (bridge) await context.addInitScript(updateBridge)
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const ready = (page) =>
      page.locator('[data-testid="account-toggle"]').waitFor({ timeout: 30_000 })
    const shot = async (page, name, target) => {
      await page.waitForTimeout(600)
      const path = join(SHOTS, `${name}.png`)
      if (target === undefined) await page.screenshot({ path })
      else await page.locator(target).first().screenshot({ path })
      console.log(`  ✓ ${name}.png`)
    }

    // 1. 左栏（浅 / 深）+ 首页整页
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ theme })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await shot(page, `${TAG}-sidebar-${theme}`, 'aside')
      await shot(page, `${TAG}-home-${theme}`)
      await context.close()
    }

    if (TAG !== 'after') {
      // 老「聊天窗」页（改后它跳到消息里的网站聊天）
      const { context, page } = await open()
      await page.goto(`${BASE}/chat-window`, { waitUntil: 'networkidle' })
      await ready(page)
      await shot(page, 'before-chat-window')
      await context.close()
      return
    }

    // 1bis. 展开一个岗位：职责不缩进（浅 / 深）
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ theme })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      const row = page.locator('[data-testid="nav-position-row"]').first()
      await row.hover()
      await row.locator('[data-testid="nav-position-toggle"]').click()
      await page.mouse.move(600, 400)
      await shot(page, `after-sidebar-expanded-${theme}`, 'aside')
      await context.close()
    }

    // 2. 悬停岗位行：名字右边出「>」
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ theme })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.locator('[data-testid="nav-position-row"]').first().hover()
      await shot(page, `after-sidebar-hover-${theme}`, 'aside')
      await context.close()
    }

    // 3. 「消息」里的网站聊天（老 /chat-window 跳过来）
    {
      const { context, page } = await open()
      if (chat !== undefined) {
        // 演示世界里开一段访客对话，好让列表里有东西（只在本机 demo 里）
        const s = await post('/v1/chat/sessions', {}, session, chat.id).catch(() => undefined)
        if (s?.data?.id === undefined) console.warn('  ⚠️ 开访客对话没成：', JSON.stringify(s))
        const id = s?.data?.id
        if (id !== undefined)
          await post(
            `/v1/chat/sessions/${id}/messages`,
            { text: 'Hi, does the X200 charger work in the EU?' },
            session,
            chat.id,
          ).catch(() => undefined)
        if (id !== undefined)
          await post(`/v1/chat/sessions/${id}/advance`, {}, session, chat.id).catch(() => undefined)
      }
      await page.goto(`${BASE}/chat-window`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.locator('[data-testid="site-chat"]').waitFor({ timeout: 30_000 })
      const first = page.locator('[data-testid="chat-conversation"]').first()
      await first.waitFor({ timeout: 15_000 }).catch(() => undefined)
      if ((await first.count()) > 0) {
        await shot(page, 'after-messages-site-chat-list')
        await first.click()
        await page.locator('[data-testid="site-chat-band"]').waitFor({ timeout: 15_000 })
      }
      await shot(page, 'after-messages-site-chat')
      await context.close()
    }

    // 4. 消息渠道里的「网站聊天窗」
    {
      const { context, page } = await open({ height: 1400 })
      await page.goto(`${BASE}/im-channels`, { waitUntil: 'networkidle' })
      await ready(page)
      const card = page.locator('[data-testid="im-site-chat"]')
      await card.waitFor({ timeout: 30_000 })
      await card.scrollIntoViewIfNeeded()
      await shot(page, 'after-im-site-chat', '[data-testid="im-site-chat"]')
      await context.close()
    }

    // 5. 账号菜单设置组展开
    {
      const { context, page } = await open()
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      await page.click('[data-testid="account-toggle"]')
      await page.click('[data-testid="account-group-settings-toggle"]')
      await shot(page, 'after-account-settings')
      await context.close()
    }

    // 6. 更新三阶段（替身桥推状态）
    {
      const { context, page } = await open({ bridge: true })
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await ready(page)
      const steps = [
        [
          'after-update-1-downloading',
          { state: 'downloading', version: '0.2.0-beta.9', percent: 0, source: 'primary' },
        ],
        [
          'after-update-2-preparing',
          {
            state: 'downloading',
            version: '0.2.0-beta.9',
            percent: 92,
            phase: 'prepare',
            source: 'primary',
          },
        ],
        ['after-update-3-ready', { state: 'ready', version: '0.2.0-beta.9', source: 'primary' }],
      ]
      for (const [name, s] of steps) {
        await page.evaluate((x) => window.__pushUpdate(x), s)
        await shot(page, name, '[data-testid="rail-bottom"]')
      }
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
