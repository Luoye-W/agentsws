#!/usr/bin/env node
/**
 * WP249：「自家版待处理」快捷视图与版务审批卡的截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）。demo 里「Reddit 官方号浏览器通道」是内存替身
 * （`demoOldReddit`：打开即登录、队列里各类都有一两条），**不起浏览器、不连 reddit.com**。
 * 给老板加一条「自家版运营」，登记自家版 r/nordvolt，体检官方号，然后拍：
 *
 * - 快捷视图（亮 / 暗、1440 / 1024）；
 * - 点一条「移除」（附版规）出卡之后，上面「要你处理」里那张版务卡；
 * - 封禁那一下的菜单。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp249-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp249')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
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

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
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
    const token = await login()
    let me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    if (!me.assignments.some((a) => a.role_id === 'social.reddit'))
      await api(token, owner, 'POST', '/v1/assignments', {
        person_id: me.person.id,
        role_id: 'social.reddit',
        ranges: [{ kind: 'brand', id: me.workspace.id }],
      })
    me = await api(token, undefined, 'GET', '/v1/me')
    const social = me.assignments.find((a) => a.role_id === 'social.reddit').id
    await api(token, social, 'POST', '/v1/social/accounts', {
      channel: 'reddit',
      handle: 'r/nordvolt',
      display_name: 'r/nordvolt',
      url: 'https://www.reddit.com/r/nordvolt/',
      external_id: 'nordvolt',
      own_subreddit: true,
    })
    const checked = await api(token, social, 'POST', '/v1/social/reddit-browser/check')
    console.log(`  官方号：${checked.state} ${checked.username ?? ''}`)

    browser = await chromium.launch({ headless: true })
    const contextOf = async (width, dark) => {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: dark ? 'dark' : 'light',
      })
      await context.addInitScript(
        ([t, theme]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', theme)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, dark ? 'dark' : 'light'],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const shotOf = async (locator, name) => {
      await locator.page().waitForTimeout(400)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }
    const openQuick = async (page) => {
      await page.goto(`${BASE}/positions/${social}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.locator('[data-testid="work-quick"][data-quick="quick:modqueue:social.reddit"]').click()
      await page.waitForSelector('[data-testid="own-sub-item"]', { timeout: 20_000 })
      await page.waitForTimeout(600)
      return page.locator('[data-testid="work-quick-view"]')
    }

    for (const [width, dark] of [
      [1440, false],
      [1440, true],
      [1024, false],
    ]) {
      const { context, page } = await contextOf(width, dark)
      const panel = await openQuick(page)
      await shotOf(panel, `queue-${width}-${dark ? 'dark' : 'light'}`)
      await context.close()
    }

    // 移除出卡（附建议引用的那条版规）→ 上面「要你处理」里那张卡
    {
      const { context, page } = await contextOf(1440, false)
      const panel = await openQuick(page)
      const spam = panel.locator('[data-testid="own-sub-item"][data-id="t3_q1spam"]')
      await spam.locator('[data-testid="own-sub-remove"]').click()
      await spam.locator('[data-testid="own-sub-staged"]').waitFor()
      await shotOf(spam, 'item-staged')
      // 封禁菜单
      const rude = panel.locator('[data-testid="own-sub-item"][data-id="t1_q2rude"]')
      await rude.locator('[data-testid="own-sub-ban"]').click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(SHOTS, 'ban-menu.png') })
      console.log('  📷 ban-menu.png')
      await page.keyboard.press('Escape')
      await context.close()
    }
    for (const dark of [false, true]) {
      const { context, page } = await contextOf(1440, dark)
      await page.goto(`${BASE}/positions/${social}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.waitForTimeout(1500)
      const card = page
        .locator('[data-testid="deck-card"], [data-slot="deck-card"], article')
        .filter({ hasText: 'spam' })
        .first()
      if ((await card.count()) > 0) await shotOf(card, `card-${dark ? 'dark' : 'light'}`)
      await page.screenshot({ path: join(SHOTS, `position-with-card-${dark ? 'dark' : 'light'}.png`) })
      console.log(`  📷 position-with-card-${dark ? 'dark' : 'light'}.png`)
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
