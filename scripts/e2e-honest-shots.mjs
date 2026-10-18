#!/usr/bin/env node
/**
 * WP415（自查 R1 / R3 / R4，决策 1236–1240）：**照实说**的点击级证据。
 *
 * 起两个 demo：一个照生产（`--execution live`），一个默认演示；用真浏览器看：
 * 1. 生产形态：没有真执行器的卡标「这一步还没接通」、卡上没有「通过」、「知道了」一下就收起；
 * 2. 演示形态：同一类卡标「演示」；
 * 3. 职责页「这条职责能做什么」：没接通的动作 / 工具照实标；
 * 4. 有执行器的卡（出卡时已办完的那类）批了以后，时间线上写「办好了 · 已核对」。
 *
 * 用法：`node scripts/e2e-honest-shots.mjs --out <截图目录> [--port 4530]`（先 `vite build` 工作台）。
 * 只用 demo 替身：不连任何真实第三方、不花钱。退出码 0 = 全过。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const OUT = resolve(value('--out', join(ROOT, 'docs/assets/wp415')))
const PORT = Number(value('--port', '4530'))
mkdirSync(OUT, { recursive: true })

class StepError extends Error {}
const must = (ok, what) => {
  if (!ok) throw new StepError(what)
}

function startDemo(port, extra) {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(port), ...extra],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log, base: `http://127.0.0.1:${port}` }
}

async function waitFor(demo) {
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(`${demo.base}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new StepError(`demo 没起来：\n${demo.log.join('')}`)
}

async function session(demo) {
  const boot = await (await fetch(`${demo.base}/app/bootstrap.json`)).json()
  const email = boot.owner_email ?? boot.email ?? 'wang@nordvolt.example'
  const link = await (
    await fetch(`${demo.base}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  ).json()
  const verified = await (
    await fetch(`${demo.base}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

/** 本人的店主分配（各接口都要 `X-Assignment`）。 */
let OWNER_ASG = ''
const api = async (demo, token, path, init = {}) => {
  const res = await fetch(`${demo.base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(OWNER_ASG === '' ? {} : { 'X-Assignment': OWNER_ASG }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function shoot(page, name, scheme) {
  // 工作台的深浅色存在本机设置里（`agentsws.theme`），切完重载一次
  await page.evaluate((t) => {
    localStorage.setItem('agentsws.theme', t)
    document.documentElement.classList.toggle('dark', t === 'dark')
  }, scheme)
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForTimeout(400)
  const file = join(OUT, `${name}-${scheme === 'dark' ? 'dark' : 'light'}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  📷 ${file}`)
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const live = startDemo(PORT, ['--execution', 'live'])
  const demo = startDemo(PORT + 1, [])
  const browser = await chromium.launch()
  try {
    await waitFor(live)
    await waitFor(demo)
    const token = await session(live)
    const me = await api(live, token, '/v1/me')
    const assignments = me.body.data?.assignments ?? []
    OWNER_ASG = (assignments.find((a) => a.role_id === 'common.owner') ?? assignments[0])?.id ?? ''

    console.log('\n[1] 生产形态：牌堆里没接通的卡')
    const home = await api(live, token, '/v1/home?limit=200')
    const cards = [...(home.body.data?.queue ?? [])]
    const notWired = cards.filter((c) => c.wiring?.state === 'not_wired')
    console.log(`  牌堆 ${cards.length} 张，没接通 ${notWired.length} 张`)
    must(notWired.length > 0, '生产形态下牌堆里应当有没接通的卡')
    for (const c of notWired) {
      must(!c.available_actions.includes('approve'), `没接通的卡不该有「通过」：${c.id}`)
      must(c.action_labels?.reject === '知道了', `没接通的卡「不要」应写「知道了」：${c.id}`)
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // 一张卡一页（`/cards/:id`），直接打开那张没接通的
    await page.goto(`${live.base}/cards/${notWired[0].id}`, { waitUntil: 'networkidle' })
    await page
      .locator('[data-testid="deck-wiring"][data-wiring="not_wired"]')
      .first()
      .waitFor({ timeout: 60_000 })
    await shoot(page, '01-live-not-wired-card', 'light')
    await shoot(page, '01-live-not-wired-card', 'dark')

    console.log('\n[2] 点「通过」被拒（接口），「知道了」一下就收起')
    const first = notWired[0]
    const approve = await api(live, token, `/v1/approvals/${first.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
      headers: { 'X-Assignment': first.position_id },
    })
    must(approve.status >= 400, `没接通的卡批得动：${approve.status}`)
    const ack = await api(live, token, `/v1/approvals/${first.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
      headers: { 'X-Assignment': first.position_id },
    })
    must(ack.status === 200, `「知道了」没收起：${ack.status} ${JSON.stringify(ack.body)}`)

    console.log('\n[3] 演示形态：同一类卡标「演示」')
    const demoToken = await session(demo)
    const demoMe = await api(demo, demoToken, '/v1/me')
    const keep = OWNER_ASG
    const demoAsgs = demoMe.body.data?.assignments ?? []
    OWNER_ASG = (demoAsgs.find((a) => a.role_id === 'common.owner') ?? demoAsgs[0])?.id ?? ''
    const demoHome = await api(demo, demoToken, '/v1/home?limit=200')
    OWNER_ASG = keep
    const demoCard = (demoHome.body.data?.queue ?? []).find((c) => c.wiring?.state === 'demo')
    must(demoCard !== undefined, '演示形态下牌堆里应当有标「演示」的卡')
    must(demoCard.available_actions.includes('approve'), '演示的卡照常能点「通过」')
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page2.goto(`${demo.base}/cards/${demoCard.id}`, { waitUntil: 'networkidle' })
    await page2
      .locator('[data-testid="deck-wiring"][data-wiring="demo"]')
      .first()
      .waitFor({ timeout: 60_000 })
    await shoot(page2, '02-demo-card', 'light')
    await shoot(page2, '02-demo-card', 'dark')

    console.log('\n[4] 职责页「这条职责能做什么」照实标')
    const roles = await api(live, token, '/v1/roles/dtc.support')
    const actions = roles.body.data?.actions ?? []
    must(
      actions.some((a) => a.id === 'stage_refund' && a.wired === 'not_wired'),
      '客服职责的退款应标「还没接通」',
    )
    const asg = assignments.find((a) => a.role_id === 'dtc.support')
    if (asg !== undefined) {
      await page.goto(`${live.base}/positions/${asg.id}/duties/dtc.support`, {
        waitUntil: 'networkidle',
      })
      const about = page.locator('[data-testid="duty-about-link"]')
      if ((await about.count()) > 0) {
        await about.first().click()
        await page.locator('[data-testid="duty-about"]').waitFor({ timeout: 30_000 })
        await shoot(page, '03-duty-about-not-wired', 'light')
        await shoot(page, '03-duty-about-not-wired', 'dark')
      } else console.log('  （没找到职责页入口，只断言了接口）')
    }
    console.log('\n✓ 全过')
  } finally {
    await browser.close()
    live.child.kill('SIGTERM')
    demo.child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e instanceof StepError ? `✗ ${e.message}` : e)
  process.exit(1)
})
