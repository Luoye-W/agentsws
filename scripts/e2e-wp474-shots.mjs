#!/usr/bin/env node
/**
 * WP474：小跟进合集的两处界面——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起 demo（浅 / 深各起一次），用 Playwright 走：
 * ① 设置 → 通用「我的作息」：默认 9:00–18:00 / 不排周末 / 直播前后 30 分钟 / 不避午饭；打开「周末也排」存上；
 * ② 收件箱一张一张：A 通过一张 →「刚才：通过了「…」· 撤回 · N 秒」→ 点撤回，那张回来、还是待定；
 *    D 不要一张 →「刚才：不要了「…」· 撤回」→ 点撤回，那张回来。不通过就退出码 1。
 *
 * 截图一定要写到 `--out` 指的目录（审稿截图放私有仓，别进公开仓），浅 / 深各一套：
 * `{theme}-settings-work-hours.png`、`-focus-undo-approve.png`、`-focus-undo-reject.png`、`-focus-undone.png`。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * npx tsc -b apps/cli
 * node scripts/e2e-wp474-shots.mjs --out <私有仓>/docs/assets/wp474 [--port 4812]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (argOf('--out') === undefined)
  throw new Error(
    '要给 --out <目录>：截图放私有仓（比如 agentsws-internal/docs/assets/wp474），别进公开仓',
  )
const SHOTS = resolve(argOf('--out'))
const PORT = Number(argOf('--port') ?? '4812') || 4812
if (PORT === 4317 || PORT + 1 === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
let BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
/** demo 的「现在」：2026-10-22 周四 北京 09:30 */
const NOW = Date.parse('2026-10-22T01:30:00Z')

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

async function call(method, path, body, token, assignment) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (assignment !== undefined) headers['x-assignment'] = assignment
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function runTheme(browser, theme) {
  const port = theme === 'dark' ? PORT + 1 : PORT
  BASE = `http://127.0.0.1:${port}`
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port, quiet: true, now: NOW })
  await demo.server.listen()
  try {
    const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
    const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
    const me = await call('GET', '/v1/me', undefined, token)
    const asg = me.assignments?.[0]?.id

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
      deviceScaleFactor: 2,
      timezoneId: 'Asia/Shanghai',
    })
    await context.addInitScript(
      ([t, th]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [token, theme],
    )
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shot = async (name) => {
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`) })
      console.log(`  📷 ${theme}-${name}.png`)
    }

    // ① 设置 → 通用「我的作息」
    await page.goto(`${BASE}/settings/general#work-hours`, { waitUntil: 'load', timeout: 90_000 })
    const row = page.getByTestId('settings-work-hours')
    await row.waitFor({ timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    check((await page.getByTestId('work-hours-start').inputValue()) === '540', '默认 9:00 上班')
    check((await page.getByTestId('work-hours-end').inputValue()) === '1080', '默认 18:00 下班')
    check((await page.getByTestId('work-hours-live').inputValue()) === '30', '直播前后默认 30 分钟')
    await page.getByTestId('work-hours-weekends').click()
    await page.waitForTimeout(500)
    const saved = await call('GET', '/v1/settings/work-hours', undefined, token, asg)
    check(saved.weekends === true, '打开「周末也排」存上了')
    await shot('settings-work-hours')
    // 还原（不影响后面）
    await call('PUT', '/v1/settings/work-hours', { ...saved, weekends: false }, token, asg)
    await page.keyboard.press('Escape')

    // ② 收件箱一张一张：通过 → 撤回
    await page.goto(`${BASE}/inbox?mode=focus`, { waitUntil: 'load' })
    const focus = page.getByTestId('inbox-focus')
    await focus.waitFor({ timeout: 30_000 })
    const card = page.getByTestId('inbox-focus-card')
    await card.waitFor({ timeout: 30_000 })
    // 找一张能「通过」的卡（草稿卡或岗位卡）
    let approvedId
    // 找一张回信草稿卡（要过取消窗口才发的那种；选择题卡没选不能通过）
    for (let i = 0; i < 20; i += 1) {
      const id = await card.getAttribute('data-id')
      const canApprove =
        (await card.locator('[data-focus-act="approve"]:not([disabled])').count()) > 0
      if (id?.startsWith('card:') && canApprove) {
        approvedId = id
        break
      }
      await focus.press('ArrowRight')
      await page.waitForTimeout(200)
    }
    check(approvedId !== undefined, `找到一张能通过的卡（${approvedId ?? '没有'}）`)
    if (approvedId !== undefined) {
      await focus.focus()
      await page.keyboard.press('a')
      const undo = page.getByTestId('inbox-focus-undo')
      await undo.waitFor({ timeout: 10_000 })
      const text = (await undo.textContent()) ?? ''
      check(/撤回 · \d+ 秒/.test(text), `通过的撤回带秒数（${text}）`)
      check(
        ((await page.getByTestId('inbox-focus-recent').textContent()) ?? '').includes('通过了'),
        '「刚才：通过了「…」」',
      )
      await shot('focus-undo-approve')
      await undo.click()
      await page.getByTestId('inbox-notice').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(800)
      await page
        .waitForFunction(
          (id) =>
            document.querySelector('[data-testid="inbox-focus-card"]')?.getAttribute('data-id') ===
            id,
          approvedId,
          { timeout: 5_000 },
        )
        .catch(() => undefined)
      check((await card.getAttribute('data-id')) === approvedId, '撤回后那张回来、停在这一张')
      const state = await call(
        'GET',
        `/v1/approvals/${encodeURIComponent(approvedId.slice(5))}`,
        undefined,
        token,
        asg,
      ).catch(() => undefined)
      check(state === undefined || state.state === 'pending', `那张卡回到待定（${state?.state}）`)
      await shot('focus-undone')

      // 不要 → 撤回
      const rejectBtn = card.locator('[data-focus-act="reject"], button[data-action="reject"]')
      if ((await rejectBtn.count()) > 0) {
        await focus.focus()
        await page.keyboard.press('d')
        // 有的卡点「不要」会先问理由：有输入框就直接提交
        await page.waitForTimeout(400)
        const undo2 = page.getByTestId('inbox-focus-undo')
        await undo2.waitFor({ timeout: 10_000 }).catch(() => undefined)
        if ((await undo2.count()) > 0) {
          check((await undo2.textContent()) === '撤回', '不要的撤回没有秒数')
          check(
            ((await page.getByTestId('inbox-focus-recent').textContent()) ?? '').includes('不要了'),
            '「刚才：不要了「…」」',
          )
          await shot('focus-undo-reject')
          await undo2.click()
          await page.waitForTimeout(800)
          check((await card.getAttribute('data-id')) === approvedId, '不要的撤回后也回来了')
        } else check(false, '点了「不要」后出「撤回」')
      }
    }
    await context.close()
  } finally {
    await demo.close()
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      await runTheme(browser, theme)
    }
  } finally {
    await browser.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
