#!/usr/bin/env node
/**
 * WP478（对话框不挡内容 · 决策卡按钮一排 · 「改一下」→「修改」）：浅 / 深各拍一套（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。顺手查几件事：
 * - 内容压着对话框时是**底部小条**（没有快捷提问），滚到底是**完整对话框**；
 * - 滚到底时最后一块内容完全在对话框上方（底部留白够）；
 * - 框里有字时往上滚也不缩回小条；点小条立刻展开、光标在输入框里；
 * - 决策卡：卡底一排按钮，卡身里没有另一排「就这样 / 修改」；页面上不出现「改一下」。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<页>.png`。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp478-shots.mjs --port 4876 --out <目录> [--only preview] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp478'))
const ONLY = argOf('--only')
const PORT = Number(argOf('--port') ?? '4876') || 4876
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token, asg) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', { email })
  return (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
}

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

const shot = async (page, theme, name, opts = {}) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`), ...opts })
  console.log(`  📷 ${theme}-${name}.png`)
}

/** 把对话框外面那几层能滚的（主区 / 助理那一栏 / 整页）都滚到顶或底。 */
const scrollAll = (page, where) =>
  page.evaluate((to) => {
    const dock = document.querySelector('[data-testid="composer-full"]')
    const list = [document.scrollingElement]
    for (let el = dock?.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el)
      if (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight)
        list.push(el)
    }
    for (const el of list) {
      if (el === null) continue
      el.scrollTop = to === 'top' ? 0 : el.scrollHeight
    }
  }, where)

const dockState = (page) =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid="composer-full"]')?.parentElement?.dataset.state ?? '',
  )

/** 滚到底时：对话框前面那些东西的最低底边 ≤ 完整对话框的顶边（最后一块完全在框上方）。 */
const clearance = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer-full"]')
    const dock = box?.parentElement
    const parent = dock?.parentElement
    if (!box || !dock || !parent) return undefined
    let bottom = Number.NEGATIVE_INFINITY
    for (const c of parent.children) {
      if (c === dock) break
      const r = c.getBoundingClientRect()
      if (r.height > 0) bottom = Math.max(bottom, r.bottom)
    }
    return Math.round(box.getBoundingClientRect().top - bottom)
  })

async function composerChecks(page, theme, name) {
  await scrollAll(page, 'top')
  await page.waitForTimeout(500)
  const top = await dockState(page)
  check(top === 'pill', `[${theme}] ${name} 内容压着对话框时是小条（现在 ${top}）`)
  check(
    (await page.getByTestId('composer-pill').isVisible()) &&
      (await page
        .getByTestId('composer-full')
        .evaluate((el) => getComputedStyle(el).opacity === '0' && el.inert)),
    `[${theme}] ${name} 小条看得见、快捷提问不出`,
  )
  await shot(page, theme, `${name}-pill`)
  await scrollAll(page, 'bottom')
  await page.waitForTimeout(500)
  const bottom = await dockState(page)
  check(bottom === 'full', `[${theme}] ${name} 滚到底是完整对话框（现在 ${bottom}）`)
  const gap = await clearance(page)
  check(
    gap !== undefined && gap >= 0,
    `[${theme}] ${name} 滚到底最后一块完全在对话框上方（离框 ${gap}px）`,
  )
  await shot(page, theme, `${name}-full`)
  // 点小条：立刻展开、光标进输入框
  await scrollAll(page, 'top')
  await page.waitForTimeout(400)
  if ((await dockState(page)) === 'pill') {
    await page.getByTestId('composer-pill').click()
    await page.waitForTimeout(300)
    const focused = await page.evaluate(
      () =>
        document.activeElement?.tagName === 'TEXTAREA' &&
        document.activeElement.closest('[data-testid="composer-full"]') !== null,
    )
    check(
      (await dockState(page)) === 'full' && focused,
      `[${theme}] ${name} 点小条展开、光标在输入框`,
    )
    // 有字：点别处、再滚，也不缩回小条
    await page.keyboard.type('草稿')
    await page.mouse.click(200, 300)
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(500)
    check((await dockState(page)) === 'full', `[${theme}] ${name} 框里有字时不缩回小条`)
    await page.locator('[data-testid="composer-full"] textarea').fill('')
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-18T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = await call('GET', '/v1/me', undefined, owner)
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner')?.id
    const positions = await call('GET', '/v1/positions', undefined, owner, ownerAsg)
    const instances = positions.instances ?? []
    const mine = (inst) =>
      (inst.roles ?? []).map((r) => r.my_assignment_id).filter((x) => x !== undefined)
    let full
    for (const inst of instances) {
      const id = mine(inst)[0]
      if (id === undefined) continue
      const view = await call('GET', `/v1/positions/${id}`, undefined, owner, id).catch(
        () => undefined,
      )
      if (view === undefined) continue
      if (full === undefined && (view.pending_cards ?? 0) > 0 && view.name?.zh === '客服')
        full = { id, view }
    }
    if (full === undefined) throw new Error('demo 里找不到有卡的岗位')
    const matters = await call('GET', '/v1/matters?limit=50', undefined, owner, full.id)
    const anna = matters.matters.find((m) => /Anna/.test(m.title))

    const open = async (theme, viewport = { width: 1440, height: 900 }) => {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        colorScheme: theme,
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
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      // 岗位页（客服，有卡）
      await page.goto(`${BASE}/positions/${full.id}`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('position-page').waitFor({ timeout: 60_000 })
      await page.getByTestId('deck-card').first().waitFor({ timeout: 20_000 })
      await page.waitForTimeout(1200)
      // 「要你处理」切成一列全摊开（内容比一屏长，才有「压着」的时候）
      const toggle = page.getByTestId('deck-list-toggle')
      if ((await toggle.count()) > 0) {
        await toggle.click()
        await page.waitForTimeout(800)
      }
      await composerChecks(page, theme, '1-position')
      if (ONLY !== 'preview') {
        const text = await page.getByTestId('position-page').innerText()
        check(!/改一下/.test(text), `[${theme}] 岗位页不出现「改一下」`)
        // 决策卡：卡底一排
        const cards = page.getByTestId('deck-card')
        const n = await cards.count()
        let rowOk = true
        for (let i = 0; i < n; i += 1) {
          const c = cards.nth(i)
          if ((await c.getByTestId('deck-actions').count()) === 0) continue
          const inBody = await c.locator('[data-testid="deck-card-body"] button').count()
          if (inBody > 0 && (await c.getByTestId('deck-choice-row').count()) > 0) rowOk = false
        }
        check(rowOk, `[${theme}] 决策卡按钮都在卡底一排`)
        await scrollAll(page, 'top')
        await page.waitForTimeout(400)
        await page
          .getByTestId('deck-card')
          .first()
          .screenshot({
            path: join(SHOTS, `${theme}-3-card-row.png`),
          })
        console.log(`  📷 ${theme}-3-card-row.png`)
      }
      // 事项页
      if (anna !== undefined) {
        await page.goto(`${BASE}/matters/${anna.id}`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('matter').waitFor({ timeout: 60_000 })
        await page.waitForTimeout(1500)
        await composerChecks(page, theme, '2-matter')
      }
      await context.close()
      // 移动窄窗
      const narrow = await open(theme, { width: 390, height: 844 })
      await narrow.page.goto(`${BASE}/positions/${full.id}`, { waitUntil: 'load', timeout: 90_000 })
      await narrow.page.getByTestId('position-page').waitFor({ timeout: 60_000 })
      await narrow.page.waitForTimeout(1500)
      const nt = narrow.page.getByTestId('deck-list-toggle')
      if ((await nt.count()) > 0) {
        await nt.click()
        await narrow.page.waitForTimeout(800)
      }
      await scrollAll(narrow.page, 'top')
      await narrow.page.waitForTimeout(500)
      check((await dockState(narrow.page)) === 'pill', `[${theme}] 窄窗岗位页压着内容时也是小条`)
      await shot(narrow.page, theme, '4-narrow-pill')
      await scrollAll(narrow.page, 'bottom')
      await narrow.page.waitForTimeout(500)
      await shot(narrow.page, theme, '4-narrow-full')
      await narrow.context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
