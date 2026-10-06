#!/usr/bin/env node
/**
 * WP238：岗位页两处快修的前后对比截图，可重跑出处。
 *
 * 起一个 demo，调成 Luoye 真机那样（王岚手上 pr.reddit + social.reddit，公共关系并进社媒运营 →
 * 自建「Reddit 运营」），并关联 Agents 工坊账号（demo 的云替身 1.5 秒后自动点链接）——
 * Reddit 取数于是走接口中台。然后拍三张：
 *
 * 1. `wp238-<tag>-position-top`：岗位页顶部（「连上这 N 个就能开工」那张卡在不在）；
 * 2. `wp238-<tag>-position-view`：岗位页「面板」（Reddit 那一节是催「去连接」还是一行灰字）；
 * 3. `wp238-<tag>-duty-overview`：职责页「概览」（权限声明是不是还摊在外面、空状态占不占大卡）；
 * 4. `wp238-after-duty-advanced`：点开「高级 · 这条职责能做什么」之后（只有修过的界面有）。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp238-shots.mjs --tag after [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp238')

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
  const tag = value('--tag', 'after')
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
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    const merged = await api(token, owner, 'POST', '/v1/org/positions/pr/merge', {
      into: 'social-media',
    })
    console.log(`  合并成岗位：${merged.created}`)
    // 关联 Agents 工坊账号（云替身过 1.5 秒自己点链接）→ Reddit 取数走接口中台
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    await new Promise((r) => setTimeout(r, 2500))
    const account = await api(token, owner, 'GET', '/v1/cloud/account')
    console.log(`  关联：${account.linked === true ? '已关联' : JSON.stringify(account)}`)

    const reddit = (await api(token, undefined, 'GET', '/v1/me')).assignments.find(
      (a) => a.role_id === 'social.reddit',
    )
    const asg = reddit.id
    // 挂上这个品牌（Luoye 真机上岗位是挂了品牌的；不挂的话面板只剩「还没分配店铺」那一张）
    await api(token, owner, 'PUT', `/v1/assignments/${asg}`, {
      ranges: [{ kind: 'brand', id: me.workspace.id }],
    })

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

    await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="position-page"]')
    await page.waitForTimeout(1200)
    await shot(page, `wp238-${tag}-position-top`)

    await page.goto(`${BASE}/positions/${asg}?tab=view`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
    await shot(page, `wp238-${tag}-position-view`, true)

    await page.goto(`${BASE}/positions/${asg}/duties/social.reddit`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="duty-page"]')
    await page.waitForTimeout(1200)
    await shot(page, `wp238-${tag}-duty-overview`, true)

    // 修过之后：权限声明收在「高级」里，点开看人话（修之前没有这个开关，跳过）
    const toggle = page.locator('[data-testid="duty-advanced-toggle"]')
    if ((await toggle.count()) > 0) {
      await toggle.click()
      await page.waitForSelector('[data-testid="duty-advanced-body"]')
      await shot(page, `wp238-${tag}-duty-advanced`, true)
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
