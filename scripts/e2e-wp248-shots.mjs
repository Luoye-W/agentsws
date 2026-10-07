#!/usr/bin/env node
/**
 * WP248：决策 79 / 82 / 83 改过的那几处界面截图（demo 端口默认 4399，不联网）。
 *
 * 起一个 demo，浏览器侧把服务端回的那几格换成要拍的样子（形状就是服务端真回的——
 * `apps/server/test/wp248-small.test.ts` 用真服务进程把这几条路走过一遍），再拍：
 *
 * 1. `position-header` / `position-overdue`：岗位页页头「今天 N 个待办（M 个已过期）」，点了筛「今天及已过期」，
 *    过期那条标红；
 * 2. `board-queue-dialog`：看板上把待办拖到「排着的」，弹出选日期（默认明天上午）；
 * 3. `home-overdue`：首页「今天 N 个待办（M 个已过期）」+ 到期清单里过期那条标红；
 * 4. `settings-brand-facts`：设置页公司档案「这个品牌」一节的一句话介绍 / 客服邮箱 / 币种。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp248-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp248')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4399'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const NOW = Date.now()
const AT = new Date(NOW).toISOString()
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()
const hoursLater = (n) => new Date(NOW + n * 3_600_000).toISOString()

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

/** 把服务端回的 `data` 换掉（别的照走 demo）。 */
async function patchGet(page, pattern, patch) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...json, data: patch(json.data) }),
    })
  })
}

async function shot(page, name, locator) {
  await page.waitForTimeout(400)
  await (locator ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

const todo = (over) => ({
  id: 'td_x',
  schema_version: 1,
  workspace_id: 'ws_demo',
  title: '待办',
  owner: 'per_demo',
  horizon: 'today',
  source: 'manual',
  status: 'open',
  cards: [],
  runs: [],
  created_at: AT,
  updated_at: AT,
  ...over,
})

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    const me = await (
      await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()
    const mine = (me.data?.assignments ?? []).find((a) => a.revoked_at === undefined)
    const positions = await (
      await fetch(`${BASE}/v1/positions`, {
        headers: { authorization: `Bearer ${token}`, 'x-assignment': mine?.id ?? '' },
      })
    ).json()
    if (positions.data === undefined) throw new Error(`拿不到岗位：${JSON.stringify(positions)}`)
    const first = positions.data.positions[0]
    const asg = first.position_id
    const role = { role_id: first.role_id, role_name: first.role_name, assignment_id: asg }
    const item = (over) => ({
      kind: 'todo',
      role_id: role.role_id,
      role_name: role.role_name,
      assignment_id: asg,
      status: 'open',
      group: 'doing',
      cards: 0,
      card_ids: [],
      source: 'you',
      updated_at: AT,
      movable: true,
      ...over,
    })
    const work = (data) => ({
      ...data,
      generated_at: AT,
      items: [
        item({
          id: 'todo:t_late',
          ref_id: 't_late',
          title: '回版主私信：问 flair 规则',
          status: 'doing',
          due_at: daysAgo(2),
          overdue: true,
        }),
        item({
          id: 'todo:t_today',
          ref_id: 't_today',
          title: '把本周问答帖的草稿过一遍',
          due_at: hoursLater(3),
        }),
        item({
          id: 'matter:m_run',
          kind: 'matter',
          ref_id: 'm_run',
          matter_id: 'm_run',
          title: '整理本周 r/SmartGlasses 热帖',
          movable: false,
          progress: '在读第 3 页',
        }),
        item({
          id: 'todo:t_wait',
          ref_id: 't_wait',
          title: '等设计给新版横幅',
          status: 'blocked',
          group: 'waiting',
        }),
      ],
      counts: {
        ...data.counts,
        doing: 3,
        stuck: 0,
        queued: 0,
        waiting: 1,
        done: 0,
        todos_today: 2,
        todos_overdue: 1,
      },
      duties: [role],
    })

    // ── 1. 岗位页：页头 + 列表里过期那条 ─────────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/positions/*/work', work)
      await page.goto(`${BASE}/positions/${encodeURIComponent(asg)}`, {
        waitUntil: 'networkidle',
      })
      await page.waitForSelector('[data-testid="work-overdue"]')
      await shot(page, 'position-header', page.locator('[data-testid="position-header"]'))
      // 点页头「今天 N 个待办」→ 工作筛「今天及已过期」
      await page.click('[data-testid="status-today"]')
      const section = page.locator('[data-testid="work-section"]')
      await section.scrollIntoViewIfNeeded()
      await shot(page, 'position-overdue', section)
      await page.close()
    }

    // ── 2. 看板：拖到「排着的」→ 选日期 ──────────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/positions/*/work', work)
      await page.goto(`${BASE}/positions/${encodeURIComponent(asg)}`, {
        waitUntil: 'networkidle',
      })
      await page.click('[data-testid="work-view-board"]')
      const card = page.locator('[data-testid="work-board-card"][data-id="todo:t_late"]')
      await card.waitFor()
      await card.dragTo(page.locator('[data-testid="work-board-column"][data-group="queued"]'))
      await page.waitForSelector('[data-testid="work-queue-dialog"]')
      await shot(page, 'board-queue-dialog')
      await page.close()
    }

    // ── 3. 首页：今天 N 个待办（M 个已过期） ─────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/home*', (data) => ({
        ...data,
        today: {
          ...(data.today ?? { timeline: [] }),
          due: {
            todos: [
              todo({ id: 'td_late', title: '回版主私信：问 flair 规则', due: daysAgo(2) }),
              todo({ id: 'td_today', title: '把本周问答帖的草稿过一遍', due: hoursLater(3) }),
            ],
            cards_waiting: data.today?.due?.cards_waiting ?? 0,
            overdue_ids: ['td_late'],
          },
        },
      }))
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="today-overdue"]')
      await shot(page, 'home-header', page.locator('[data-testid="home-header"]'))
      const due = page.locator('[data-testid="today-due"]')
      await due.scrollIntoViewIfNeeded()
      await shot(page, 'home-overdue', page.locator('[data-testid="today"]'))
      await page.close()
    }

    // ── 4. 设置页：这个品牌的三格 ─────────────────────────────────────
    {
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await patchGet(page, '**/v1/onboarding/state', (data) => ({
        ...data,
        profile: {
          ...(data.profile ?? {
            legal_name: 'Nordvolt GmbH',
            discoverable: true,
            vertical: 'goods',
            storefront_platform: 'shopify',
            set_at: AT,
          }),
          brand_name: data.brand_name ?? 'Nordvolt',
          one_liner: '给露营和自驾准备的便携储能电源',
          support_email: 'support@nordvolt.example',
          currency: 'EUR',
        },
      }))
      await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
      const facts = page.locator('[data-testid="profile-brand-facts"]')
      await facts.waitFor()
      await page.locator('[data-testid="profile-brand-block"]').scrollIntoViewIfNeeded()
      await shot(page, 'settings-brand-facts', page.locator('[data-testid="profile-brand-block"]'))
      await page.close()
    }
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
