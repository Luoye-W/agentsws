#!/usr/bin/env node
/**
 * WP235：公司页「你们的岗位 / 可以加的岗位（模板）」、合并对话框、合并后左栏的截图，可重跑出处。
 *
 * 起一个 demo，调成 Luoye 真机上那样的老工作区（老分配、没有安放行）：王岚在公共关系里只做
 * `pr.reddit`、在社媒运营里只做 `social.reddit`（李默留一条客服）。然后用真浏览器：
 *
 * 1. `wp235-org-ours`：公司页「岗位」——上面「你们的岗位」（卡上写谁在做、手上哪几条），下面折叠的模板；
 * 2. `wp235-org-templates`：展开「可以加的岗位（模板）」；
 * 3. `wp235-org-merge-dialog`：「公共关系」合并到「社媒运营」，名字预填「Reddit 运营」；
 * 4. `wp235-org-merged`：合并回执（另建了岗位「Reddit 运营」，模板没动）；
 * 5. `wp235-nav-after-merge`：合并后的左栏——只剩「Reddit 运营」，不再有公共关系 / 社媒运营。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp235-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

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

    // ① 公司页「岗位」：你们的岗位在上，模板收在下面
    await page.goto(`${BASE}/org`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: '岗位' }).click()
    await page.waitForSelector('[data-testid="positions-ours"] [data-testid="position-card"]')
    const ours = page.locator('[data-testid="positions-ours"]')
    const pr = ours.locator('[data-testid="position-card"][data-position="pr"]')
    await shot(page, 'wp235-org-ours', true)

    // ② 展开模板那一块
    await page.locator('[data-testid="positions-templates"] > summary').click()
    await page.locator('[data-testid="positions-templates"]').scrollIntoViewIfNeeded()
    await shot(page, 'wp235-org-templates')
    await page.locator('[data-testid="positions-templates"] > summary').click()

    // ③ 合并对话框：公共关系 → 社媒运营，名字预填「Reddit 运营」
    await pr.locator('[data-testid="position-merge"]').click()
    await pr.locator('[data-testid="position-merge-target"]').selectOption('social-media')
    await pr.scrollIntoViewIfNeeded()
    const name = await pr.locator('[data-testid="position-merge-name"]').inputValue()
    console.log(`  合并后名字预填：${name}`)
    await shot(page, 'wp235-org-merge-dialog')

    // ④ 合并 → 回执
    await pr.locator('[data-testid="position-merge-go"]').click()
    await page.waitForSelector('[data-testid="positions-reshaped"]', { timeout: 30_000 })
    await page.locator('[data-testid="positions-reshaped"]').scrollIntoViewIfNeeded()
    await shot(page, 'wp235-org-merged')

    // ⑤ 左栏：只剩「Reddit 运营」
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="main-nav"]')
    await page.waitForTimeout(1200)
    await shot(page, 'wp235-nav-after-merge')
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
