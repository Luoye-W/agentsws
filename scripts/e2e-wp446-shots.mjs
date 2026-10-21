#!/usr/bin/env node
/**
 * WP446（docs/109 §4）：「SEO 与 GEO」独立成职责之后的截图，可重跑出处（不联网、不接 AI、不连真实店、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），拍浅 / 深两套：
 *
 * 1. `1-web-ops-settings-<theme>`：网站运营岗位设定——「内容与博客」与「SEO 与 GEO」两条都在；
 * 2. `2-seo-duty-<theme>`：SEO 与 GEO 职责页（右栏报表里是今天值得动的 5 件事、按页收入、AI 可见度、AI 来源流量）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp446-shots.mjs [--port 4660] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(argOf('--port', '4660'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(argOf('--out', join(ROOT, 'docs/assets/wp446')))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call(undefined, undefined, 'POST', '/v1/auth/magic-link', { email })
  return (await call(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token }))
    .session_token
}

async function page(browser, token, theme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: theme,
    locale: 'zh-CN',
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
  const p = await context.newPage()
  p.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
  return { context, p }
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
    const token = await login(OWNER)
    const me = await call(token, undefined, 'GET', '/v1/me')
    const seo = me.assignments.find((a) => a.role_id === 'dtc.seo' && a.revoked_at === undefined)
    if (seo === undefined) throw new Error('demo 负责人名下没有 SEO 与 GEO')
    for (const theme of ['light', 'dark']) {
      // ① 网站运营岗位设定：两条都在
      {
        const { context, p } = await page(browser, token, theme)
        await p.goto(`${BASE}/positions/${encodeURIComponent(seo.id)}?tab=settings`, {
          waitUntil: 'networkidle',
        })
        const list = p.getByTestId('settings-duties')
        await list.waitFor({ timeout: 30_000 })
        const roles = await p
          .getByTestId('settings-duty')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-role')))
        if (!roles.includes('dtc.content') || !roles.includes('dtc.seo'))
          throw new Error(`岗位设定里没有两条：${roles.join(',')}`)
        await p.waitForTimeout(800)
        await list.screenshot({ path: join(SHOTS, `1-web-ops-settings-${theme}.png`) })
        console.log(`  📷 1-web-ops-settings-${theme}.png（${roles.join(' / ')}）`)
        await context.close()
      }
      // ② SEO 与 GEO 职责页 + 右栏报表
      {
        const { context, p } = await page(browser, token, theme)
        await p.goto(`${BASE}/positions/${encodeURIComponent(seo.id)}/duties/dtc.seo`, {
          waitUntil: 'networkidle',
        })
        if ((await p.getByTestId('rail-cards').count()) === 0)
          await p.getByTestId('rail-toggle').click()
        const card = p.getByTestId('rail-card-reports')
        await card.waitFor({ timeout: 20_000 })
        if ((await card.getAttribute('data-open')) !== 'true')
          await p.getByTestId('rail-card-toggle-reports').click()
        await p.getByTestId('rail-card-more-reports').click()
        await p.getByTestId('reports-panel').waitFor({ timeout: 20_000 })
        await p.getByTestId('rail-panel-wide').click()
        await p.waitForTimeout(1500)
        await p.screenshot({ path: join(SHOTS, `2-seo-duty-${theme}.png`) })
        console.log(`  📷 2-seo-duty-${theme}.png`)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
