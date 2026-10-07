#!/usr/bin/env node
/**
 * WP255（决策 144）：「回复」框的截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4455，不碰 4317）。demo 里「Reddit 官方号浏览器通道」是内存替身
 * （打开即登录、队列里各类都有一两条），**不起浏览器、不连 reddit.com**；demo 没接真模型，
 * 所以「AI 起草」回的是模板并照实说「这次没用 AI」。拍：
 *
 * - 自家版待处理里一条点「回复」→「AI 起草」之后的框（亮 / 暗）；
 * - 写一句带承诺的话点「出卡」→ 被打回、原因就地显示；
 * - 社群线程列表（Discord「群里的帖子」快捷视图）里点「回复」起草（亮 / 暗、1024）；
 * - 出卡之后那一行，以及上面「要你处理」里那张回帖卡。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp255-shots.mjs [--port 4455]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp255')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4455'))
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
    for (const role_id of ['social.reddit', 'social.discord'])
      if (!me.assignments.some((a) => a.role_id === role_id))
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id,
          ranges: [{ kind: 'brand', id: me.workspace.id }],
        })
    me = await api(token, undefined, 'GET', '/v1/me')
    const reddit = me.assignments.find((a) => a.role_id === 'social.reddit').id
    const discord = me.assignments.find((a) => a.role_id === 'social.discord').id
    await api(token, reddit, 'POST', '/v1/social/accounts', {
      channel: 'reddit',
      handle: 'r/nordvolt',
      display_name: 'r/nordvolt',
      url: 'https://www.reddit.com/r/nordvolt/',
      external_id: 'nordvolt',
      own_subreddit: true,
    })
    await api(token, reddit, 'POST', '/v1/social/reddit-browser/check')

    // Discord：演示库里那个群上再进两条（判类由服务端做）
    const dc = (await api(token, discord, 'GET', '/v1/social/accounts?channel=discord')).rows[0]
    for (const [i, author, text] of [
      [
        1,
        'mika_desk',
        '新到的 140W 充电器给 MacBook 和 iPad 一起充完全不烫，桌面清爽多了，晒一张！',
      ],
      [2, 'jonas.k', 'Any chance the 3-port charger comes in white? Would love one for my setup.'],
    ])
      await api(token, discord, 'POST', '/v1/social/threads', {
        account_id: dc.id,
        external_id: `dc_wp255_${i}`,
        surface: 'thread',
        author_external_id: `u_wp255_${i}`,
        author_handle: author,
        text,
      })

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
    const openQuick = async (page, assignment, quick, rowSel) => {
      await page.goto(`${BASE}/positions/${assignment}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.locator(`[data-testid="work-quick"][data-quick="${quick}"]`).click()
      await page.waitForSelector(rowSel, { timeout: 20_000 })
      await page.waitForTimeout(600)
      return page.locator('[data-testid="work-quick-view"]')
    }
    const draftIn = async (row) => {
      await row.locator('[data-testid="reply-open"]').click()
      await row.locator('[data-testid="reply-draft"]').click()
      await row
        .locator('[data-testid="reply-template"], [data-testid="reply-warning"]')
        .first()
        .waitFor()
    }

    // ① 自家版待处理：一条点「回复」→「AI 起草」（demo 没接模型：模板 + 照实说）
    for (const dark of [false, true]) {
      const { context, page } = await contextOf(1440, dark)
      const panel = await openQuick(
        page,
        reddit,
        'quick:modqueue:social.reddit',
        '[data-testid="own-sub-item"]',
      )
      const row = panel.locator('[data-testid="own-sub-item"]').nth(1)
      await draftIn(row)
      await shotOf(row, `ownsub-reply-draft-${dark ? 'dark' : 'light'}`)
      if (!dark) await shotOf(panel, 'ownsub-reply-panel-light')
      await context.close()
    }

    // ② 承诺话术被打回：原因就地显示
    {
      const { context, page } = await contextOf(1440, false)
      const panel = await openQuick(
        page,
        reddit,
        'quick:modqueue:social.reddit',
        '[data-testid="own-sub-item"]',
      )
      const row = panel.locator('[data-testid="own-sub-item"]').nth(1)
      await row.locator('[data-testid="reply-open"]').click()
      await row
        .locator('[data-testid="reply-text"]')
        .fill('Sorry about that! We will refund you in full tomorrow, guaranteed.')
      await row.locator('[data-testid="reply-submit"]').click()
      await row.locator('[data-testid="reply-error"]').waitFor()
      await shotOf(row, 'ownsub-reply-rejected-light')
      await context.close()
    }

    // ③ 社群线程列表（Discord「群里的帖子」）：起草 → 改 → 出卡
    for (const [width, dark] of [
      [1440, false],
      [1440, true],
      [1024, false],
    ]) {
      const { context, page } = await contextOf(width, dark)
      const panel = await openQuick(
        page,
        discord,
        'quick:threads:social.discord',
        '[data-testid="social-thread"]',
      )
      const row = panel.locator('[data-testid="social-thread"]').filter({ hasText: 'mika_desk' })
      await draftIn(row)
      await shotOf(panel, `threads-${width}-${dark ? 'dark' : 'light'}`)
      await context.close()
    }
    {
      const { context, page } = await contextOf(1440, false)
      const panel = await openQuick(
        page,
        discord,
        'quick:threads:social.discord',
        '[data-testid="social-thread"]',
      )
      const row = panel.locator('[data-testid="social-thread"]').filter({ hasText: 'mika_desk' })
      await row.locator('[data-testid="reply-open"]').click()
      await row
        .locator('[data-testid="reply-text"]')
        .fill('谢谢晒图！桌面确实清爽，140W 同时充两台刚好～')
      await row.locator('[data-testid="reply-submit"]').click()
      await row.locator('[data-testid="reply-staged"]').waitFor()
      await shotOf(row, 'threads-reply-staged-light')
      await page.goto(`${BASE}/positions/${discord}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.waitForTimeout(1500)
      const card = page
        .locator('[data-testid="deck-card"], [data-slot="deck-card"], article')
        .filter({ hasText: 'mika_desk' })
        .first()
      if ((await card.count()) > 0) await shotOf(card, 'reply-card-light')
      await page.screenshot({ path: join(SHOTS, 'position-with-reply-card-light.png') })
      console.log('  📷 position-with-reply-card-light.png')
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
