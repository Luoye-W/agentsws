#!/usr/bin/env node
/**
 * WP459（决策 1497–1505）：收件箱——端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo，用 Playwright 走：收件箱列表（三组、筛选、简报、右栏两堆）→ 点开一张回信卡（第三栏原信 + 草稿）
 * → 点「改」→ 按岗位筛 → AI 猜着交给岗位的（改判）→ 一张一张（含「改」）→ 首页那一行 → 全部处理完（清空）。
 * 不通过就退出码 1。
 *
 * 截图（`--out` 目录；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * `{theme}-1-inbox.png`、`-2-open.png`、`-3-open-edit.png`、`-4-filter.png`、`-4b-filter-pick.png`、`-5-guess.png`、
 * `-6-focus.png`、`-7-focus-edit.png`、`-8-home.png`、`-9-empty.png`；
 * 给了 `--mockups <目录>` 再出一份和示意稿并排的 `compare-{theme}-*.png`（左示意、右实拍）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * npx tsc -b apps/cli
 * node scripts/e2e-wp459-shots.mjs [--port 4764] [--out <目录>] [--mockups <示意稿目录>]
 * ```
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp459'))
const MOCKUPS = argOf('--mockups') === undefined ? undefined : resolve(argOf('--mockups'))
const PORT = Number(argOf('--port') ?? '4764') || 4764
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

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

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

/** 示意稿 → 实拍的对照（左右并排）。 */
const PAIRS = [
  ['1-inbox', 'inbox'],
  ['2-open', 'inbox-open'],
  ['3-open-edit', 'inbox-open-edit'],
  ['4-filter', 'inbox-filter'],
  ['4b-filter-pick', 'inbox-filter-pick'],
  ['5-guess', 'inbox-guess'],
  ['6-focus', '../v3/d-focus'],
  ['7-focus-edit', '../v3/d-focus-edit'],
  ['8-home', 'home-line'],
  ['9-empty', 'inbox-empty'],
]

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
    now: Date.parse('2026-10-22T01:30:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
    const owner = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
    const me = await call('GET', '/v1/me', undefined, owner)
    const asg = me.assignments?.[0]?.id
    const inbox = () => call('GET', '/v1/inbox', undefined, owner, asg)
    const view = await inbox()
    console.log(
      `收件箱：${view.counts.all} 件（卡 ${view.counts.cards} · 信 ${view.counts.mail}；要紧 ${view.counts.urgent}）`,
    )
    check(view.counts.all > 0, '收件箱有东西')
    check(view.counts.cards > 0 && view.counts.mail > 0, '卡和信混在一条队列里')

    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
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
    const shot = async (page, theme, name) => {
      await page.waitForTimeout(700)
      await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`) })
      console.log(`  📷 ${theme}-${name}.png`)
    }

    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      const { context, page } = await open(theme)
      // ① 列表
      await page.goto(`${BASE}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
      const groups = await page.getByTestId('inbox-group').count()
      check(groups >= 2, `列表：分了 ${groups} 组`)
      check((await page.getByTestId('inbox-brief').count()) === 1, '列表：顶上有简报')
      check((await page.getByTestId('inbox-waiting').count()) === 1, '列表：右栏等对方回')
      check((await page.getByTestId('inbox-kept').count()) === 1, '列表：右栏收好的')
      const navCount = await page.getByTestId('nav-inbox-count').textContent()
      check(Number(navCount) === view.counts.all, `左栏收件箱件数 ${navCount}`)
      await shot(page, theme, '1-inbox')

      // ② 点开一张带草稿的卡（第三栏）
      const draftRow = page.locator('[data-testid="inbox-row"][data-type="card"]')
      let opened = false
      /** WP485（决策 1672）：浏览器里第三栏是浮层，开着时点下一行一次就换成那一件（不用先收起）。 */
      let switched = 0
      let switchedOk = true
      for (let i = 0; i < (await draftRow.count()); i += 1) {
        const overlayOpen = (await page.getByTestId('rail-panel-frame').count()) > 0
        const id = await draftRow.nth(i).getAttribute('data-id')
        await draftRow.nth(i).click()
        const ok = await page
          .locator(`[data-testid="inbox-pane"][data-id="${id}"]`)
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
        if (overlayOpen) {
          switched += 1
          if (!ok) switchedOk = false
        }
        if ((await page.getByTestId('inbox-draft').count()) > 0) {
          opened = true
          break
        }
      }
      if (switched === 0) {
        // 第一行就是带草稿的：再点一行、再点回来，验一次「一次就换」
        const rows = page.getByTestId('inbox-row')
        if ((await rows.count()) > 1) {
          const current = await page.getByTestId('inbox-pane').getAttribute('data-id')
          for (let i = 0; i < (await rows.count()); i += 1) {
            const id = await rows.nth(i).getAttribute('data-id')
            if (id === current) continue
            await rows.nth(i).click()
            switched += 1
            switchedOk = await page
              .locator(`[data-testid="inbox-pane"][data-id="${id}"]`)
              .waitFor({ timeout: 10_000 })
              .then(() => true)
              .catch(() => false)
            await page.locator(`[data-testid="inbox-row"][data-id="${current}"]`).click()
            await page
              .locator(`[data-testid="inbox-pane"][data-id="${current}"]`)
              .waitFor({ timeout: 10_000 })
            break
          }
        }
      }
      check(
        switched > 0 && switchedOk,
        `浮层开着时点下一行：一次就换成那一件（点了 ${switched} 次）`,
      )
      check(opened, '第三栏：回信卡是原信 + 草稿')
      check((await page.getByTestId('rail-panel-frame').count()) === 1, '第三栏开在外壳那一栏里')
      await shot(page, theme, '2-open')
      if (opened) {
        await page.getByTestId('inbox-draft-edit').click()
        const box = page.getByTestId('inbox-draft-text')
        await box.click()
        await box.press('ControlOrMeta+End')
        await box.type(' We will refund you in full if it is lost.')
        check(
          (await page.getByTestId('inbox-draft-approve').textContent())?.includes('改好了') ===
            true,
          '改了字：按钮变「改好了，通过」',
        )
        await shot(page, theme, '3-open-edit')
        await page.getByTestId('inbox-draft-edit').click()
      }
      // WP485：浮层开着时点中栏里不开第三栏的普通按钮（按岗位筛的下拉）：照常生效，浮层不收
      {
        const trigger = page.getByTestId('inbox-filter-position')
        const free = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="inbox-filter-position"]')
          const f = document.querySelector('[data-testid="rail-panel-frame"]')
          if (b === null || f === null) return false
          return b.getBoundingClientRect().right < f.getBoundingClientRect().left
        })
        if (free) {
          await trigger.click()
          const menuOpen = await page
            .getByTestId('inbox-position-menu')
            .waitFor({ timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
          await page.waitForTimeout(300)
          check(
            menuOpen && (await page.getByTestId('rail-panel-frame').count()) === 1,
            '浮层开着时点普通按钮：按钮照常生效、浮层不收',
          )
          await trigger.click()
          await page.waitForTimeout(300)
        } else console.log('  ·（筛选按钮被浮层盖着，跳过普通按钮那一项）')
      }
      // WP485：点中栏空白处收起浮层
      {
        const spot = await page.evaluate(() => {
          const main = document.querySelector('main')
          const frame = document.querySelector('[data-testid="rail-panel-frame"]')
          if (main === null) return null
          const box = main.getBoundingClientRect()
          const right =
            frame === null ? box.right : Math.min(box.right, frame.getBoundingClientRect().left)
          const hit =
            'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"], [contenteditable="true"], .cursor-pointer'
          for (let y = box.top + 24; y < Math.min(box.bottom, innerHeight) - 8; y += 24) {
            for (let x = box.left + 16; x < right - 8; x += 24) {
              const el = document.elementFromPoint(x, y)
              if (el === null || !main.contains(el)) continue
              if (el.closest(hit) !== null || getComputedStyle(el).cursor === 'pointer') continue
              return { x, y }
            }
          }
          return null
        })
        if (spot !== null) {
          await page.mouse.click(spot.x, spot.y)
          await page.waitForTimeout(500)
        }
        check(
          spot !== null && (await page.getByTestId('rail-panel-frame').count()) === 0,
          '点中栏空白处：浮层收起',
        )
      }
      await page.keyboard.press('Escape')
      await page.goto(`${BASE}/inbox?mode=list`, { waitUntil: 'load' })
      await page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })

      // ③ 按岗位筛（下拉 + 筛好的样子）
      await page.getByTestId('inbox-filter-position').click()
      await page.getByTestId('inbox-position-menu').waitFor()
      await shot(page, theme, '4b-filter-pick')
      const pick = page.locator(
        '[data-testid^="inbox-position-"]:not([data-testid="inbox-position-all"]):not([data-testid="inbox-position-none"]):not([data-testid="inbox-position-menu"])',
      )
      let picked = false
      for (let i = 0; i < (await pick.count()); i += 1) {
        const text = (await pick.nth(i).textContent()) ?? ''
        if (/[1-9]\d*$/.test(text.trim())) {
          await pick.nth(i).click()
          picked = true
          break
        }
      }
      check(picked, '岗位下拉：有件数的岗位点得了')
      await page.getByTestId('inbox-go-position').waitFor({ timeout: 10_000 })
      await shot(page, theme, '4-filter')

      // ④ AI 猜着交给岗位的（改判）
      await page.goto(`${BASE}/inbox?mode=list`, { waitUntil: 'load' })
      await page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
      const guessed = page.getByTestId('inbox-brief-guessed')
      if ((await guessed.count()) > 0) {
        await guessed.click()
        await page.getByTestId('inbox-guess-list').waitFor({ timeout: 10_000 })
        await page.getByTestId('inbox-rehand').waitFor({ timeout: 10_000 })
        check(true, '简报「猜着交给岗位」点开：列出交给了谁、能改判')
      } else check(false, '简报里有「猜着交给岗位」')
      await shot(page, theme, '5-guess')
      await page.keyboard.press('Escape')

      // ⑤ 一张一张
      await page.goto(`${BASE}/inbox?mode=focus`, { waitUntil: 'load' })
      await page.getByTestId('inbox-focus').waitFor({ timeout: 30_000 })
      check(
        ((await page.getByTestId('inbox-focus-progress').textContent()) ?? '').includes('第 1 张'),
        '一张一张：第 1 张 / M',
      )
      await shot(page, theme, '6-focus')
      // 翻到一张回信卡再点「改」
      for (let i = 0; i < 12 && (await page.getByTestId('inbox-draft').count()) === 0; i += 1) {
        await page.getByTestId('inbox-focus').press('ArrowRight')
        await page.waitForTimeout(150)
      }
      if ((await page.getByTestId('inbox-draft').count()) > 0) {
        await page.getByTestId('inbox-focus').press('e')
        await page.getByTestId('inbox-draft-text').waitFor({ timeout: 5_000 })
        check(true, '一张一张：E = 改（就地改字）')
        await shot(page, theme, '7-focus-edit')
      } else check(false, '一张一张：翻得到回信卡')

      // ⑥ 首页那一行
      await page.goto(`${BASE}/`, { waitUntil: 'load' })
      await page.getByTestId('home').waitFor({ timeout: 30_000 })
      const line = page.getByTestId('home-inbox-line')
      await line.waitFor({ timeout: 30_000 })
      check(
        ((await page.getByTestId('home-inbox-count').textContent()) ?? '').includes(
          String(view.counts.all),
        ),
        '首页：收件箱里 N 件等你',
      )
      check((await page.getByTestId('home-decide').count()) === 0, '首页：不再列决策卡')
      await shot(page, theme, '8-home')
      await context.close()
    }

    // ⑦ 全部处理完：卡一律「稍后」、信「我自己处理」（只在 demo 里），再看清空的样子
    for (let round = 0; round < 4; round += 1) {
      const all = await inbox()
      if (all.counts.all === 0) break
      for (const item of all.items) {
        if (item.card !== undefined) {
          const action = item.card.available_actions.includes('snooze') ? 'snooze' : 'reject'
          await call(
            'POST',
            `/v1/approvals/${encodeURIComponent(item.card.id)}/decide`,
            { action, version: item.card.version },
            owner,
            item.card.position_id,
          ).catch((e) => console.error(`  ⚠️ ${item.card.title}：${e.message}`))
        } else if (item.mail !== undefined) {
          await call(
            'POST',
            `/v1/messages/${encodeURIComponent(item.mail.message_id)}/claim`,
            { as: 'me' },
            owner,
            asg,
          )
        }
      }
    }
    const left = await inbox()
    check(left.counts.all === 0, `清空：剩 ${left.counts.all} 件`)
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      await page.goto(`${BASE}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('inbox-empty').waitFor({ timeout: 30_000 })
      check(
        (await page.getByTestId('nav-inbox-count').count()) === 0,
        `${theme}：清空了左栏不显示件数`,
      )
      await shot(page, theme, '9-empty')
      await context.close()
    }

    // 和示意稿并排
    if (MOCKUPS !== undefined) {
      const page = await browser.newPage({ viewport: { width: 2880, height: 900 } })
      for (const theme of ['light', 'dark'])
        for (const [mine, mock] of PAIRS) {
          const a = join(
            MOCKUPS,
            `${mock.startsWith('../') ? `../${mock.slice(3).split('/')[0]}/${theme}-${mock.split('/').pop()}` : `${theme}-${mock}`}.png`,
          )
          const b = join(SHOTS, `${theme}-${mine}.png`)
          if (!existsSync(a) || !existsSync(b)) continue
          const src = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
          await page.setContent(
            `<body style="margin:0;display:flex;background:${theme === 'dark' ? '#111' : '#ddd'}"><img src="${src(a)}" style="width:1440px;height:900px"><img src="${src(b)}" style="width:1440px;height:900px"></body>`,
          )
          await page.screenshot({ path: join(SHOTS, `compare-${theme}-${mine}.png`) })
          console.log(`  📷 compare-${theme}-${mine}.png`)
        }
      await page.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
