#!/usr/bin/env node
/**
 * WP241：岗位页 v2 截图（对照 `docs/design/position/shots/`），可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317），调成 Luoye 真机那样：王岚手上 pr.reddit + social.reddit，
 * 公共关系并进社媒运营 → 自建「Reddit 运营」，关联 Agents 工坊账号（Reddit 取数走接口中台）。
 *
 * 先拍「空岗位」（拆出一个只有自家版运营、什么都没做过的岗位），再往「Reddit 运营」里放几件事
 * （交给它的事、你的待办、定时任务），拍主稿各状态与设置页。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp241-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp241')

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

/** 同 WP238：撤掉演示世界里别的干活分配，王岚只留 pr.reddit，再按职责分一条 social.reddit。 */
async function makeOldWorkspace(token) {
  const me = await api(token, undefined, 'GET', '/v1/me')
  const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
  const keep = new Set([`${me.person.id}/pr.reddit`])
  const members = await api(token, owner, 'GET', `/v1/workspaces/${me.workspace.id}/members`)
  for (const m of members) {
    const support = m.assignments.find((a) => a.role_id === 'dtc.support')
    if (m.person_id !== me.person.id && support !== undefined) keep.add(`${m.person_id}/dtc.support`)
    for (const a of m.assignments) {
      if (a.role_id.startsWith('common.') || keep.has(`${m.person_id}/${a.role_id}`)) continue
      await api(token, owner, 'DELETE', `/v1/assignments/${a.assignment_id}`)
    }
  }
  await api(token, owner, 'POST', '/v1/assignments', {
    person_id: me.person.id,
    role_id: 'social.reddit',
    ranges: [],
  })
}

const iso = (offsetHours) => new Date(Date.now() + offsetHours * 3_600_000).toISOString()

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
    await makeOldWorkspace(token)
    let me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const merged = await api(token, owner, 'POST', '/v1/org/positions/pr/merge', {
      into: 'social-media',
    })
    const positionId = merged.created
    console.log(`  合并成岗位：${positionId}`)
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    await new Promise((r) => setTimeout(r, 2500))
    me = await api(token, undefined, 'GET', '/v1/me')
    const pr = me.assignments.find((a) => a.role_id === 'pr.reddit').id
    const social = me.assignments.find((a) => a.role_id === 'social.reddit').id
    for (const a of [pr, social])
      await api(token, owner, 'PUT', `/v1/assignments/${a}`, {
        ranges: [{ kind: 'brand', id: me.workspace.id }],
      })

    browser = await chromium.launch({ headless: true })
    const contextOf = async (width, dark) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
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
    const shot = async (page, name, fullPage = true) => {
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
      console.log(`  📷 ${name}.png`)
    }
    const open = async (page, path) => {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="position-page"]')
      await page.waitForTimeout(1500)
    }

    // ── 空岗位：先拍（这时候还没往里放任何事）。临时建一个只装「自家版运营」的岗位不现实（会把
    //    social.reddit 挪走），所以直接拍 Reddit 运营这一刻——演示世界里它下面还什么都没有。
    {
      const { context, page } = await contextOf(1440, false)
      await open(page, `/positions/${social}`)
      await shot(page, 'empty-1440-light')
      await context.close()
      const dark = await contextOf(1440, true)
      await open(dark.page, `/positions/${social}`)
      await shot(dark.page, 'empty-1440-dark')
      await dark.context.close()
    }

    // ── 往岗位里放几件事 ──
    const matters = [
      ['近视求助帖的回帖', 'pr.reddit'],
      ['「召回」传言怎么应对', 'pr.reddit'],
      ['盯 10-07 那篇评测帖的评论', 'pr.reddit'],
      ['5 条重点帖的回应口径', 'pr.reddit'],
      ['整理 r/INMO 版规', 'social.reddit'],
    ]
    const opened = []
    for (const [title, role_id] of matters)
      opened.push(
        await api(token, social, 'POST', `/v1/positions/${positionId}/matters`, { title, role_id }),
      )
    const closeMe = opened.at(-1)?.matter.id
    if (closeMe !== undefined)
      await api(token, social, 'POST', `/v1/matters/${closeMe}/close`, { unfinished: 'keep' }).catch(
        () => undefined,
      )
    const todo = async (assignment, title, due) =>
      (
        await api(token, assignment, 'POST', '/v1/todos', {
          title,
          ...(due === undefined ? {} : { due }),
          collision: 'force',
          distinct_reason: '演示',
        })
      ).todo
    await todo(pr, '私信 r/SmartGlasses 版主：能否挂官方 flair', iso(3))
    const waiting = await todo(pr, 'r/augmentedreality 能否发官方帖', iso(-20))
    await api(token, pr, 'PUT', `/v1/todos/${waiting.id}`, { status: 'blocked' })
    const waiting2 = await todo(social, '固件 2.1 续航投诉 3 条（等客服回）', iso(26))
    await api(token, social, 'PUT', `/v1/todos/${waiting2.id}`, { status: 'blocked' })
    const done = await todo(social, '找 5 个适合我们的版', iso(-60))
    await api(token, social, 'POST', `/v1/todos/${done.id}/done`)
    await api(token, social, 'POST', '/v1/schedules', {
      title: 'r/INMO 入群审核',
      trigger: { kind: 'interval', every_ms: 7_200_000 },
    })
    await api(token, pr, 'POST', '/v1/schedules', {
      title: '扫一遍 Reddit 上提到 INMO 的帖子',
      trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    })
    await new Promise((r) => setTimeout(r, 3000))
    const work = await api(token, social, 'GET', `/v1/positions/${positionId}/work`)
    writeFileSync(join(SHOTS, 'work-sample.json'), `${JSON.stringify(work.counts, null, 2)}\n`)
    console.log(`  工作：${JSON.stringify(work.counts)}`)

    // ── 主稿：明暗 × 1440 / 1024 ──
    for (const [width, dark] of [
      [1440, false],
      [1440, true],
      [1024, false],
      [1024, true],
    ]) {
      const { context, page } = await contextOf(width, dark)
      await open(page, `/positions/${social}`)
      await shot(page, `list-${width}-${dark ? 'dark' : 'light'}`)
      if (width === 1440 && !dark) {
        for (const v of ['board', 'calendar', 'table']) {
          await page.click(`[data-testid="work-view-${v}"]`)
          await shot(page, `list-view-${v}`)
        }
        await page.click('[data-testid="work-view-list"]')
        await page.click('[data-testid="work-filter"]')
        await shot(page, 'list-filter-open', false)
        await page.keyboard.press('Escape')
        const quick = page.locator('[data-testid="work-quick"]').first()
        if ((await quick.count()) > 0) {
          await quick.click()
          await shot(page, 'list-quick-schedule')
        }
        await page.click('[data-testid="work-view-list"]')
        await page.click('[data-testid="data-charts-toggle"]')
        await page.click('[data-testid="position-entry-input"]')
        await shot(page, 'list-focus-charts')
        await page.click('[role="tab"]:has-text("记录")')
        await shot(page, 'list-tab-records')
        await page.click('[role="tab"]:has-text("设置")')
        await shot(page, 'settings-1440-light')
        await page.click('[data-testid="settings-connections-more"]').catch(() => undefined)
        await page.click('[data-testid="settings-dev-toggle"]')
        await shot(page, 'settings-advanced-dev')
      }
      if (width === 1440 && dark) {
        await page.click('[data-testid="work-view-board"]')
        await shot(page, 'list-view-board-dark')
        await page.click('[data-testid="work-view-calendar"]')
        await shot(page, 'list-view-calendar-dark')
        await page.click('[data-testid="work-view-list"]')
        await page.click('[role="tab"]:has-text("设置")')
        await shot(page, 'settings-1440-dark')
      }
      if (width === 1024 && !dark) {
        await page.click('[role="tab"]:has-text("设置")')
        await shot(page, 'settings-1024-light')
      }
      await context.close()
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
