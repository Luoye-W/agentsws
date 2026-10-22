#!/usr/bin/env node
/**
 * WP468（决策 1478 / 1479）：截图 + 端到端核对，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（店主身上挂着红人营销五条职责，那几条分配都**没有** `event_log.read`），用 Playwright：
 *
 * 1. 到红人营销岗位交一件事（demo 的替身运行时跑一遍，不开真浏览器）；
 * 2. 往**这次运行**的事件日志里补两段 ego 脚本的记录（替身运行时不调浏览器，这两行是演示数据，
 *    只为让面板有东西可画——权限判定走的是真的那条路）；
 * 3. 事项页第三栏「浏览器」：能看到（不再是「这条职责的分配上没有 event_log.read」），
 *    请求带的是跑这次运行的那条红人分配；同一次运行拿别的红人分配去读 → 403；
 * 4. 设置 → 浏览器：选 ego 时顶上那句换成「ego 不按网站名单拦，只留记录」——ego 只在个人用法里出现，
 *    所以这一步另起一个全新的本机服务进程（临时数据目录、端口 PORT+1）；ego 那一项要本机装了 ego 才选得了。
 *
 * 浅 / 深各一套截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓）。不通过就退出码 1。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp468-shots.mjs [--port 4768] [--out <目录>]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'out/wp468'))
const PORT = Number(argOf('--port') ?? '4768') || 4768
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const TASK = '看看 YouTube 上最近有哪些智能眼镜的开箱视频，挑三个值得联系的频道'

async function call(method, path, { body, token, assignment } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, data: json.data, json }
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页内跳转（React Router 认 popstate）。 */
async function go(page, path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForTimeout(1200)
}

async function openBrowserRail(page) {
  const icon = page.getByTestId('rail-icon-browser')
  if ((await icon.count()) > 0) await icon.first().click()
  else {
    await page.getByTestId('rail-overflow').click()
    await page.getByTestId('rail-menu-browser').click()
  }
}

/**
 * 设置页那句：ego 只在 ① 个人用法里出现，demo 是三个人的公司——另起一个全新的本机服务进程
 * （临时数据目录、端口 PORT+1，用完按它自己的 PID 停掉）。ego 那一项要本机装了 ego 才选得了。
 */
async function settingsShots(browser) {
  const port = PORT + 1
  const base = `http://127.0.0.1:${port}`
  const dataDir = mkdtempSync(join(tmpdir(), 'wp468-solo-'))
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      AGENTSWS_PORT: String(port),
      AGENTSWS_DATA_DIR: dataDir,
      AGENTSWS_STATIC_DIR: join(ROOT, 'apps/workstation/dist'),
    },
    stdio: 'ignore',
  })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i += 1) {
      up = await fetch(`${base}/v1/health`).then(
        (r) => r.ok,
        () => false,
      )
      if (!up) await sleep(500)
    }
    check(up, `全新的本机服务进程起来了（${base}，PID ${child.pid}）`)
    const at = async (path, body) =>
      (
        await (
          await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json()
      ).data
    const link = await at('/v1/auth/magic-link', { email: 'owner@localhost' })
    const token = (await at('/v1/auth/verify', { token: link.token })).session_token
    for (const theme of ['light', 'dark']) {
      console.log(`── 设置页 · ${theme}`)
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      })
      await context.addInitScript(
        ([t, th]) => {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
        },
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${base}/settings/web`, { waitUntil: 'networkidle' })
      // 全新数据目录先进「初始化设置」：点「先跳过」，之后页内跳转（「先跳过」只记在这一页的内存里）
      if (page.url().includes('/onboarding')) {
        await page.getByText('先跳过').first().click()
        await page.waitForTimeout(1500)
        await go(page, '/settings/web')
      }
      const card = page.getByTestId('settings-browser')
      await card.waitFor({ timeout: 60_000 })
      const summary = page.getByTestId('settings-browser-summary')
      check(
        ((await summary.textContent()) ?? '').includes('只能打开它职责里写的那几个网站'),
        '没选 ego 时：原来那句',
      )
      const ego = page.getByTestId('browser-mode-ego')
      await ego.waitFor({ timeout: 30_000 }).catch(() => undefined)
      if ((await ego.count()) === 0) {
        check(false, '设置页没有 ego 那一项')
      } else {
        await page.getByTestId('browser-ego-status').waitFor({ timeout: 30_000 })
        const radio = ego.locator('input[type="radio"]')
        if (await radio.isDisabled()) check(false, '本机没装 ego，ego 那一项选不了，拍不到那一句')
        else {
          await radio.click()
          await page.waitForTimeout(300)
          check(
            ((await summary.textContent()) ?? '').includes('ego 不按网站名单拦，只留记录'),
            '选 ego 时：「ego 不按网站名单拦，只留记录」',
          )
          await card.scrollIntoViewIfNeeded()
          await page.screenshot({ path: join(SHOTS, `${theme}-2-settings-ego-summary.png`) })
        }
      }
      await context.close()
    }
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port: PORT, quiet: true })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const link = await call('POST', '/v1/auth/magic-link', { body: { email: OWNER } })
    const token = (await call('POST', '/v1/auth/verify', { body: { token: link.data.token } })).data
      .session_token
    const me = (await call('GET', '/v1/me', { token })).data
    const mine = me.assignments.filter((a) => a.revoked_at === undefined)
    const kol = mine.find((a) => a.role_id === 'kol.youtube')
    check(kol !== undefined, '店主身上挂着 kol.youtube（红人营销岗位）')

    // ── 1. 红人岗位上交一件事，等替身运行跑完 ────────────────────────────────
    console.log('── 红人岗位交一件事')
    let matterId
    let runId
    let ranBy
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      await context.addInitScript((t) => {
        window.localStorage.setItem('agentsws.session_token', t)
        window.localStorage.setItem('agentsws.theme', 'light')
      }, token)
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${kol.id}`, { waitUntil: 'networkidle' })
      const input = page.getByTestId('position-entry-input')
      await input.waitFor({ timeout: 60_000 })
      await input.fill(TASK)
      await page.getByTestId('matter-send').click()
      // 岗位入口先给一个「顺手答」的卡（没接 AI 时也是）：点「当成任务做」才开成一件事、起一次运行
      const asTask = page.getByText('当成任务做')
      await asTask.or(page.locator('body[data-never]')).first().waitFor({ timeout: 30_000 })
      if (!page.url().includes('/matters/') && (await asTask.count()) > 0)
        await asTask.first().click()
      await page.waitForURL(/\/matters\//, { timeout: 120_000 })
      matterId = /\/matters\/([^/?#]+)/.exec(page.url())?.[1]
      check(matterId !== undefined, `开了一件事（${matterId}）`)
      for (let i = 0; i < 90 && ranBy === undefined; i += 1) {
        const m = (await call('GET', `/v1/matters/${matterId}`, { token, assignment: kol.id })).data
        const line = m?.timeline?.find((e) => e.run_id !== undefined && e.actor?.kind === 'agent')
        if (line !== undefined) {
          runId = line.run_id
          ranBy = line.actor.id
        } else await sleep(1000)
      }
      await context.close()
    }
    const ranByRole = mine.find((a) => a.id === ranBy)?.role_id
    check(
      runId !== undefined && ranByRole?.startsWith('kol.') === true,
      `这次运行（${runId}）是红人那条分配跑的（${ranByRole}）`,
    )

    // ── 2. 补两段 ego 脚本的记录（演示数据：替身运行时不开浏览器）────────────
    const ws = demo.world.workspace_id
    const actor = { kind: 'agent', id: ranBy, run_id: runId }
    const correlation = { trace_id: `trc_run_${runId}`, run_id: runId }
    const add = (type, payload) =>
      demo.server.kernel.eventLog.append({
        schema_version: 1,
        workspace_id: ws,
        type,
        actor,
        correlation,
        payload,
      })
    await add('tool.call', {
      call_id: 'c_wp468_1',
      tool: 'ego_run',
      input: { script: 'const s = await taskSpace("youtube unboxing"); …' },
    })
    await add('progress', {
      step: 'ego_run',
      note: '退出码 0 · 2.4 秒 · { channels: 12, picked: ["@techunboxed", "@gadgetlab", "@lensdaily"] }',
    })
    await add('tool.call', {
      call_id: 'c_wp468_2',
      tool: 'ego_run',
      input: { script: 'await page.goto("https://www.youtube.com/@gadgetlab/videos") …' },
    })
    await add('progress', {
      step: 'ego_run',
      note: '退出码 0 · 1.8 秒 · { latest: "Smart glasses unboxing", views: "48K" }',
    })

    // ── 3. 服务端那一层：自己的能读、别的分配不能读 ─────────────────────────
    const own = await call('GET', `/v1/runs/${runId}/browser`, { token, assignment: ranBy })
    check(own.status === 200 && own.data?.executor === 'ego', '跑这次运行的那条红人分配：200，能读')
    const other = mine.find((a) => a.role_id.startsWith('kol.') && a.id !== ranBy)
    if (other !== undefined) {
      const res = await call('GET', `/v1/runs/${runId}/browser`, { token, assignment: other.id })
      check(
        res.status === 403,
        `同岗位另一条红人分配（${other.role_id}）去读：${res.status}（应 403）`,
      )
    }

    // ── 4. 第三栏「浏览器」+ 设置页那句，浅 / 深各一套 ─────────────────────
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      })
      await context.addInitScript(
        ([t, th]) => {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
        },
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      const seen = []
      page.on('response', (r) => {
        if (/\/v1\/runs\/[^/]+\/browser$/.test(new URL(r.url()).pathname))
          seen.push({ status: r.status(), assignment: r.request().headers()['x-assignment'] })
      })
      await page.goto(`${BASE}/positions/${kol.id}`, { waitUntil: 'networkidle' })
      await go(page, `/matters/${matterId}`)
      await openBrowserRail(page)
      const panel = page.getByTestId('rail-browser')
      await panel.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await panel.count()) > 0, '第三栏「浏览器」画出来了（没被权限挡住）')
      check(
        (await page.getByText('event_log.read').count()) === 0,
        '没有「这条职责的分配上没有 event_log.read」那句',
      )
      const runs = await page.getByTestId('rail-browser-ego-run').allTextContents()
      check(runs.length === 2, `列出 ${runs.length} 段 ego 脚本`)
      check(
        seen.length > 0 && seen.every((s) => s.status === 200 && s.assignment === ranBy),
        `面板的请求带的是跑这次运行的那条分配（${seen.map((s) => `${s.status}/${s.assignment}`).join(', ')}）`,
      )
      await page.screenshot({ path: join(SHOTS, `${theme}-1-rail-browser-kol.png`) })
      await context.close()
    }
  } finally {
    await demo.close()
  }
  try {
    await settingsShots(browser)
  } finally {
    await browser.close()
  }
  console.log(failed ? '\n有没过的。' : `\n全部通过。截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e)
  process.exit(1)
})
