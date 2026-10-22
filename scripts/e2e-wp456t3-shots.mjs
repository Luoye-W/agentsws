#!/usr/bin/env node
/**
 * WP456-T3（岗位 / 职责 / 事项页 + 看板）：浅 / 深各拍一套，和示意稿并排（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。顺手查几件 T3 的事：
 * - 「还没接 AI」只在输入框说一处：顶栏没有黄标、看板「设定」那一行不写它；
 * - 看板：对话 / 报表 / 计划各一张，产出 / 连接 / 设定 / 工坊服务合成一张清单卡，每行最右一个「›」；
 * - 卡（决定卡、看板卡）没有描边；
 * - 事项页顶上状态行：状态药丸 + 职责标签 + 时间；
 * - 页面上没有小于 12px 的中文。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<页>.png`；
 * 给了 `--mockups <示意稿目录>` 时再出 `compare-<theme>-<页>.png`（左示意稿、右实拍）。
 *
 * ```
 * npx tsc -b apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp456t3-shots.mjs --port 4808 --out <目录> [--mockups <目录>] [--prefix after] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp456-t3'))
const MOCKUPS = argOf('--mockups') === undefined ? undefined : resolve(argOf('--mockups'))
const PREFIX = argOf('--prefix') === undefined ? '' : `${argOf('--prefix')}-`
const PORT = Number(argOf('--port') ?? '4808') || 4808
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

const shotPath = (theme, name) => join(SHOTS, `${PREFIX}${theme}-${name}.png`)
const shot = async (page, theme, name, opts = {}) => {
  await page.waitForTimeout(1200)
  await page.screenshot({ path: shotPath(theme, name), ...opts })
  console.log(`  📷 ${PREFIX}${theme}-${name}.png`)
}

/** 这一屏上字号小于 12px、又含中文的可见文字。 */
const tinyChinese = (page) =>
  page.evaluate(() => {
    const out = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      if (!/[一-鿿]/.test(text)) continue
      const el = n.parentElement
      if (el === null || el.closest('[aria-hidden="true"], svg') !== null) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (Number.parseFloat(style.fontSize) < 12) out.push(text.trim().slice(0, 16))
    }
    return out
  })

/** 「还没接 AI / 还没接模型」在这一屏上出现了几处（看得见的）。 */
const noAiCount = (page) =>
  page.evaluate(() => {
    let n = 0
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let x = walker.nextNode(); x !== null; x = walker.nextNode()) {
      if (!/还没接(?: )?(?:AI|模型)/.test(x.textContent ?? '')) continue
      const el = x.parentElement
      if (el === null) continue
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) n += 1
    }
    return n
  })

/** 看板的几项检查（岗位页 / 职责页 / 事项页都一样）。 */
async function checkBoard(page, theme, where) {
  const board = page.getByTestId('rail-cards')
  if ((await board.count()) === 0) {
    check(false, `[${theme}] ${where} 有看板`)
    return
  }
  const list = page.getByTestId('rail-list-card')
  check((await list.count()) === 1, `[${theme}] ${where} 看板有一张清单卡`)
  const rows = await page
    .locator('[data-testid="rail-list-card"] [data-testid^="rail-list-row-"]')
    .count()
  check(rows >= 3, `[${theme}] ${where} 清单卡有 ${rows} 行`)
  const borders = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="rail-cards"] > section')].map(
      (el) => getComputedStyle(el).borderTopWidth,
    ),
  )
  check(
    borders.length > 0 && borders.every((b) => b === '0px'),
    `[${theme}] ${where} 看板卡没有描边（${borders.length} 张）`,
  )
  const settingsText = await page
    .locator('[data-testid="rail-list-row-settings"]')
    .innerText()
    .catch(() => '')
  check(!/还没接/.test(settingsText), `[${theme}] ${where} 看板「设定」不写「还没接 AI」`)
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
    // 有卡的岗位（客服）与一个空岗位（没卡、没在做的活）
    let full
    let empty
    for (const inst of instances) {
      const id = mine(inst)[0]
      if (id === undefined) continue
      const view = await call('GET', `/v1/positions/${id}`, undefined, owner, id).catch(
        () => undefined,
      )
      const work = await call('GET', `/v1/positions/${id}/work`, undefined, owner, id).catch(
        () => undefined,
      )
      if (view === undefined) continue
      const pending = view.pending_cards ?? 0
      if (full === undefined && pending > 0 && view.name?.zh === '客服') full = { id, view }
      if (empty === undefined && pending === 0 && (work?.items?.length ?? 0) === 0)
        empty = { id, view }
    }
    if (full === undefined) throw new Error('demo 里找不到有卡的岗位')
    const duty = full.view.roles.find((r) => r.my_assignment_id !== undefined)
    const matters = await call('GET', '/v1/matters?limit=50', undefined, owner, full.id)
    const anna = matters.matters.find((m) => /Anna/.test(m.title))
    console.log(
      `  · 岗位 ${full.id}（有卡）· 空岗位 ${empty?.id ?? '没有'} · 职责 ${duty?.role_id} · 事项 ${anna?.id ?? '没有'}`,
    )

    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
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

    const targets = [
      {
        name: '1-position',
        mock: '1-position',
        url: `/positions/${full.id}`,
        ready: async (p) => {
          await p.getByTestId('position-page').waitFor({ timeout: 60_000 })
          await p
            .getByTestId('deck-card')
            .first()
            .waitFor({ timeout: 20_000 })
            .catch(() => p.screenshot({ path: join(SHOTS, 'debug-position.png') }))
        },
        after: async (p, theme) => {
          await checkBoard(p, theme, '岗位页')
          const borders = await p.evaluate(() =>
            [...document.querySelectorAll('[data-testid="deck-card"]')].map(
              (el) => getComputedStyle(el).borderTopWidth,
            ),
          )
          check(
            borders.every((b) => b === '0px'),
            `[${theme}] 岗位页决定卡没有描边（${borders.length} 张）`,
          )
          check(
            (await p.getByTestId('deck-ghost').count()) === 0,
            `[${theme}] 决定卡后面没有叠着的假卡边`,
          )
          check(
            (await p.locator('[data-testid="deck-card"] [data-testid="deck-keyboard"]').count()) ===
              (await p.getByTestId('deck-keyboard').count()),
            `[${theme}] 快捷键提示在卡底里，卡下面没有单独那一行`,
          )
        },
      },
      ...(empty === undefined
        ? []
        : [
            {
              name: '1b-position-empty',
              url: `/positions/${empty.id}`,
              ready: (p) => p.getByTestId('position-page').waitFor({ timeout: 60_000 }),
              after: (p, theme) => checkBoard(p, theme, '空岗位页'),
            },
          ]),
      ...(duty === undefined
        ? []
        : [
            {
              name: '2-duty',
              url: `/positions/${duty.my_assignment_id}/duties/${duty.role_id}`,
              ready: (p) => p.getByTestId('top-bar').waitFor({ timeout: 60_000 }),
              after: (p, theme) => checkBoard(p, theme, '职责页'),
            },
          ]),
      ...(anna === undefined
        ? []
        : [
            {
              name: '3-matter',
              mock: '2-matter',
              url: `/matters/${anna.id}`,
              ready: (p) => p.locator('.ws-dcard').first().waitFor({ timeout: 60_000 }),
              after: async (p, theme) => {
                await checkBoard(p, theme, '事项页')
                const status = p.getByTestId('matter-meta')
                check((await status.count()) === 1, `[${theme}] 事项页顶上一行状态`)
                check(
                  (await status.locator('.ws-pill').count()) >= 1,
                  `[${theme}] 事项页状态行有状态药丸`,
                )
                const border = await p
                  .locator('.ws-dcard')
                  .first()
                  .evaluate((el) => getComputedStyle(el).borderTopWidth)
                check(border === '0px', `[${theme}] 事项页决定卡没有描边`)
                const runtime = await p.getByText(/运行时/).count()
                check(runtime === 0, `[${theme}] 事项页不出现「运行时」`)
              },
            },
          ]),
    ]

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      for (const target of targets) {
        await page.goto(`${BASE}${target.url}`, { waitUntil: 'load', timeout: 90_000 })
        try {
          await target.ready(page)
        } catch (e) {
          await page.screenshot({ path: join(SHOTS, `debug-${theme}-${target.name}.png`) })
          console.error(`  ⚠️ ${target.name} 没等到：${page.url()}`)
          throw e
        }
        await page.waitForTimeout(1500)
        const tiny = await tinyChinese(page)
        check(
          tiny.length === 0,
          `[${theme}] ${target.name} 没有小于 12px 的中文${tiny.length > 0 ? `（${tiny.slice(0, 6).join('、')}）` : ''}`,
        )
        const noAi = await noAiCount(page)
        check(noAi <= 1, `[${theme}] ${target.name}「还没接 AI」只说一处（现在 ${noAi} 处）`)
        const topNoAi = await page
          .getByTestId('top-bar')
          .innerText()
          .catch(() => '')
        check(!/还没接/.test(topNoAi), `[${theme}] ${target.name} 顶栏没有「还没接模型」`)
        if (target.after !== undefined) await target.after(page, theme)
        await shot(page, theme, target.name)
        // 看板单拍一张（岗位页那一列），再点清单卡「连接」那一行：第三栏开连接的完整一格
        if (target.name === '1-position') {
          const board = page.getByTestId('rail-cards')
          if ((await board.count()) > 0) {
            await board.screenshot({ path: shotPath(theme, '4-board') })
            console.log(`  📷 ${PREFIX}${theme}-4-board.png`)
          }
          const row = page.getByTestId('rail-list-row-connections')
          if ((await row.count()) > 0) {
            await row.click()
            const panel = page.getByTestId('connections-panel')
            const ok = await panel
              .waitFor({ timeout: 20_000 })
              .then(() => true)
              .catch(() => false)
            check(ok, `[${theme}] 清单卡「连接」那一行点了在第三栏开连接那一格`)
            await shot(page, theme, '5-board-connections-open')
          }
        }
        // 空岗位：一行提醒点「装插件」才展开装插件 + 配对码
        if (target.name === '1b-position-empty') {
          const open = page.getByTestId('extension-onboard-open')
          if ((await open.count()) > 0) {
            await open.click()
            await shot(page, theme, '1c-position-extension-open')
          }
        }
      }
      await context.close()
    }

    // 和示意稿并排（左示意稿、右实拍）
    if (MOCKUPS !== undefined) {
      const context = await browser.newContext({ viewport: { width: 2880, height: 900 } })
      const page = await context.newPage()
      for (const theme of ['light', 'dark'])
        for (const target of targets) {
          if (target.mock === undefined) continue
          const left = join(MOCKUPS, `after-${theme}-${target.mock}.png`)
          const right = shotPath(theme, target.name)
          if (!existsSync(left) || !existsSync(right)) continue
          const img = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
          await page.setContent(
            `<body style="margin:0;display:flex;gap:16px;background:#888"><img src="${img(left)}" style="width:1432px"><img src="${img(right)}" style="width:1432px"></body>`,
          )
          await page.waitForTimeout(300)
          const out = join(SHOTS, `compare-${theme}-${target.name}.png`)
          await page.screenshot({ path: out, fullPage: true })
          console.log(`  📷 compare-${theme}-${target.name}.png`)
        }
      await context.close()
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
