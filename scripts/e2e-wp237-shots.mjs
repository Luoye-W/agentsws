#!/usr/bin/env node
/**
 * WP237：合并岗位之后「走哪条职责」的截图，可重跑出处。
 *
 * 起一个 demo，调成 Luoye 真机那样（王岚手上 pr.reddit + social.reddit、老分配），公司页把公共关系
 * 并进社媒运营 → 自建「Reddit 运营」。然后：
 *
 * 1. `wp237-tie-autorun`：交给它「帮我做一份 Reddit 调研」→ 打平不问人，按「Reddit 运营」开跑；
 *    时间线上那一句「……要换成「Reddit 营销」点这里」下面就是「换成」按钮；
 * 2. `wp237-choice-card`：真拿不准（一个判据词都没命中）→ 选择卡，按钮是「走「Reddit 运营」」「走「Reddit 营销」」；
 * 3. `wp237-choice-matter`：同一件事的事项页——标题下与时间线上都是「走 X」。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp237-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp237')

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

async function shot(page, name, fullPage = false) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage })
  console.log(`  📷 ${name}.png`)
}

async function api(token, owner, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(owner === undefined ? {} : { 'x-assignment': owner }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

/**
 * 把演示世界调成 Luoye 真机那样的「老工作区」：所有人手上干活的分配撤掉（演示世界在内存里，关掉就没了），
 * 王岚只留公共关系里的 `pr.reddit`，再按职责（不按岗位、不写安放）分一条 `social.reddit`；
 * 李默留一条客服，让「你们的岗位」里不只有王岚一个人。
 */
async function makeOldWorkspace(token) {
  const me = await api(token, undefined, 'GET', '/v1/me')
  const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
  const keep = new Set([`${me.person.id}/pr.reddit`])
  const members = await api(token, owner, 'GET', `/v1/workspaces/${me.workspace.id}/members`)
  for (const m of members) {
    const support = m.assignments.find((a) => a.role_id === 'dtc.support')
    if (m.person_id !== me.person.id && support !== undefined)
      keep.add(`${m.person_id}/dtc.support`)
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

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    await makeOldWorkspace(token)
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const merged = await api(token, owner, 'POST', '/v1/org/positions/pr/merge', {
      into: 'social-media',
    })
    const position = merged.created
    console.log(`  合并成岗位：${position}`)
    const tie = await api(token, owner, 'POST', `/v1/positions/${position}/matters`, {
      title: '帮我做一份 Reddit 调研，看看大家怎么评价我们',
    })
    console.log(`  打平：${tie.reason}`)
    const ask = await api(token, owner, 'POST', `/v1/positions/${position}/matters`, {
      title: '你好',
    })
    console.log(`  拿不准：${ask.reason}（卡 ${ask.approval_item_id}）`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ① 打平自动开跑的时间线
    await page.goto(`${BASE}/matters/${tie.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-route-options"]')
    await shot(page, 'wp237-tie-autorun', true)

    // ② 选择卡：在那条职责的岗位页牌堆里
    const mine = me.assignments.find((a) => a.role_id === 'social.reddit')
    const reddit = (await api(token, undefined, 'GET', '/v1/me')).assignments.find(
      (a) => a.role_id === 'social.reddit',
    )
    const asg = (reddit ?? mine)?.id
    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    const found = await page
      .waitForSelector('[data-testid="deck-route-choice"]', { timeout: 15_000 })
      .catch(() => undefined)
    if (found === undefined) {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="deck-route-choice"]', { timeout: 15_000 })
    }
    await page.locator('[data-testid="deck-route-choice"]').scrollIntoViewIfNeeded()
    await shot(page, 'wp237-choice-card')

    // ③ 同一件事的事项页
    await page.goto(`${BASE}/matters/${ask.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-route-go"]')
    await shot(page, 'wp237-choice-matter', true)
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
