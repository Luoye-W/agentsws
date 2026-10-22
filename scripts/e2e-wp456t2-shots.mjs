#!/usr/bin/env node
/**
 * WP456-T2（共用组件）：组件一览页 + 换过共用件的几张真页面，浅 / 深各拍一套（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停）。顺手查几件 T2 的事：
 * - 组件一览页上各件都在（分段切换、列表组、一行提醒、决定卡……）；
 * - 页面上的分段切换全是共用那一种（`.ws-seg`），没有别的写法混进来；
 * - 深色下决定卡带细边（`--ws-card-edge`）、没有彩色描边；
 * - 页面上没有小于 12px 的中文。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<页>.png`。
 *
 * ```
 * npx tsc -b apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp456t2-shots.mjs [--port 4720] [--out <目录>] [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp456-t2'))
const PORT = Number(argOf('--port') ?? '4720') || 4720
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

/** 带 x-assignment 的那种调用（开事项、建分配要它）。 */
async function api(token, asg, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()).data
}

/**
 * 事项页里的决定卡：建站岗位开一件事 → 建站工具没装 → 事项里出一张连接卡（同 WP324 的拍法）。
 * 拿不到就返回 undefined（只是少拍一张，不算失败）。
 */
async function matterWithCard(token, me) {
  try {
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    await api(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    let site = me.assignments.find((a) => a.role_id === 'site.shopify-theme')?.id
    if (site === undefined)
      site = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: 'site.shopify-theme',
          ranges: [],
        })
      ).id
    const a = await api(token, site, 'POST', `/v1/positions/${site}/matters`, {
      title: '从头给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    for (let i = 0; i < 120; i += 1) {
      const view = await api(token, site, 'GET', `/v1/matters/${a.matter.id}`)
      if (view.timeline.some((e) => e.approval_item_id !== undefined)) return a.matter.id
      await new Promise((r) => setTimeout(r, 250))
    }
  } catch (e) {
    console.error(`  · 事项页的卡没备好：${e instanceof Error ? e.message : e}`)
  }
  return undefined
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
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`), ...opts })
  console.log(`  📷 ${theme}-${name}.png`)
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

/** 页面上「看起来像分段切换」却不是共用那一种的：一组 aria-pressed / role=tab 的兄弟按钮，外面不是 .ws-seg。 */
const strayToggles = (page) =>
  page.evaluate(() => {
    const out = []
    for (const g of document.querySelectorAll('[role="tablist"], fieldset')) {
      const items = g.querySelectorAll(':scope > button[aria-pressed], :scope > button[role="tab"]')
      if (items.length >= 2 && !g.classList.contains('ws-seg') && !g.classList.contains('ws-opts'))
        out.push(g.getAttribute('data-testid') ?? g.getAttribute('aria-label') ?? g.tagName)
    }
    return out
  })

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
    const asg = me.assignments.find(
      (a) => !a.role_id.startsWith('common.') && a.revoked_at === undefined,
    )
    const matterId = await matterWithCard(owner, me)

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

    const pages = [
      {
        name: '0-ui-kit',
        url: '/ui-kit',
        ready: (p) => p.getByTestId('ui-kit').waitFor({ timeout: 60_000 }),
        full: true,
        after: async (p, theme) => {
          for (const sel of ['.ws-phead', '.ws-seg', '.ws-group', '.ws-notice', '.ws-empty'])
            check((await p.locator(sel).count()) > 0, `[${theme}] 组件一览有 ${sel}`)
          check((await p.locator('.ws-dcard').count()) > 0, `[${theme}] 组件一览有决定卡`)
          check(
            (await p.locator('[data-genui]').count()) > 0,
            `[${theme}] 组件一览有 genui 画的卡（同一套档位）`,
          )
          if (theme === 'dark') {
            const edge = await p.evaluate(() => {
              const card = document.querySelector('.ws-dcard')
              return card === null ? '' : getComputedStyle(card).boxShadow
            })
            check(/inset/.test(edge), `[dark] 决定卡有一圈细边`)
          }
        },
      },
      {
        name: '1-position',
        url: `/positions/${asg.id}`,
        ready: (p) => p.getByTestId('top-bar').waitFor({ timeout: 60_000 }),
        after: async (p, theme) => {
          const borders = await p.evaluate(() =>
            [...document.querySelectorAll('[data-testid="deck-card"]')].map(
              (el) => getComputedStyle(el).borderTopWidth,
            ),
          )
          check(
            borders.every((b) => b === '0px'),
            `[${theme}] 卡片流的卡没有描边（${borders.length} 张）`,
          )
        },
      },
      {
        name: '3-messages',
        url: '/messages',
        ready: (p) => p.getByTestId('messages-page').waitFor({ timeout: 60_000 }),
      },
      {
        name: '6-settings-general',
        url: '/settings/general',
        ready: (p) => p.getByRole('dialog').first().waitFor({ timeout: 60_000 }),
      },
      {
        name: '7-notifications',
        url: '/',
        ready: async (p) => {
          await p.getByTestId('notify-bell').waitFor({ timeout: 60_000 })
          await p.getByTestId('notify-bell').click()
          await p.getByTestId('notify-panel').waitFor({ timeout: 30_000 })
        },
      },
    ]

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme)
      for (const target of pages) {
        await page.goto(`${BASE}${target.url}`, { waitUntil: 'load', timeout: 90_000 })
        await target.ready(page)
        await page.waitForTimeout(800)
        const tiny = await tinyChinese(page)
        check(
          tiny.length === 0,
          `[${theme}] ${target.name} 没有小于 12px 的中文${tiny.length > 0 ? `（${tiny.slice(0, 6).join('、')}）` : ''}`,
        )
        const stray = await strayToggles(page)
        check(
          stray.length === 0,
          `[${theme}] ${target.name} 分段切换都是共用那一种${stray.length > 0 ? `（还有：${stray.join('、')}）` : ''}`,
        )
        if (target.after !== undefined) await target.after(page, theme)
        await shot(page, theme, target.name, target.full === true ? { fullPage: true } : {})
      }
      // 事项页：里面那张决定卡（无描边、头 / 身 / 底走外壳）
      if (matterId === undefined) console.log(`  · [${theme}] 没有备好的事项，事项页不拍`)
      else {
        await page.goto(`${BASE}/matters/${matterId}`, { waitUntil: 'load', timeout: 90_000 })
        const card = page.locator('.ws-dcard').first()
        await card.waitFor({ timeout: 60_000 })
        const border = await card.evaluate((el) => getComputedStyle(el).borderTopWidth)
        check(border === '0px', `[${theme}] 事项页的决定卡没有彩色描边`)
        await shot(page, theme, '2-matter')
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
