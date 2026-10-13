#!/usr/bin/env node
/**
 * WP301：建站起底改用店里的 Shopify 官方 Horizon——截图，可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI 与 `shopify theme …` 都是替身（店里线上那一份是手写的
 * Horizon 形状假主题；不跑真 shopify、不碰真店）。品牌平台设成 Shopify、给自己上网页模板职责、填店铺地址，然后：
 *
 * 1. 新品牌「用 Horizon 给我搭个首页」→ 时间线：在店里复制了一份 Horizon 起底 + 预览好了；
 * 2. Horizon 目录：把 `--horizon <目录>`（一份 Shopify/horizon 的本地克隆，**不进仓库**）按 `horizon-catalog.ts`
 *    生成的瘦目录排成一张表拍下来（不给 `--horizon` 就用 demo 里那份手写的假主题）；
 * 3. 「首页再改一版出预览」→ 检查 → 推未发布预览。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * npx tsc -b apps/server                          # 目录生成器用编译好的那一份
 * node scripts/e2e-wp301-shots.mjs [--port 4399] [--horizon /path/to/horizon]
 * ```
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp301')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4399') || 4399
const HORIZON = argOf('--horizon')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = '6suegp-md.myshopify.com'

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
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

/** 一份主题目录（真 Horizon 克隆或手写假主题）→ 瘦目录。 */
async function catalogIndex() {
  const mod = await import(pathToFileURL(join(ROOT, 'apps/server/dist/horizon-catalog.js')).href)
  let files
  if (HORIZON !== undefined) {
    const walk = (d) =>
      existsSync(d)
        ? readdirSync(d).flatMap((n) =>
            statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
          )
        : []
    const rel = (p) => relative(HORIZON, p).split('\\').join('/')
    files = {
      list: (dir) => walk(join(HORIZON, dir)).map(rel).sort(),
      read: (r) =>
        existsSync(join(HORIZON, r)) ? readFileSync(join(HORIZON, r), 'utf8') : undefined,
    }
  } else {
    const { FAKE_HORIZON_FILES } = await import(
      pathToFileURL(join(ROOT, 'apps/server/dist/site-theme-stand-in.js')).href
    )
    files = {
      list: (dir) =>
        Object.keys(FAKE_HORIZON_FILES)
          .filter((r) => r.startsWith(`${dir}/`))
          .sort(),
      read: (r) => FAKE_HORIZON_FILES[r],
    }
  }
  const catalog = mod.buildThemeCatalog(files)
  return { index: mod.catalogIndexOf(catalog), full: JSON.stringify(catalog).length }
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )

function catalogHtml({ index, full }) {
  const rows = (list, cols) =>
    list.map((e) => `<tr>${cols.map((c) => `<td>${esc(e[c] ?? '')}</td>`).join('')}</tr>`).join('')
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:13px/1.45 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#1d1d1f;background:#fff}
    h1{font-size:18px;margin:0 0 4px} p{color:#555;margin:0 0 14px}
    .cols{display:grid;grid-template-columns:1.3fr 1fr;gap:24px}
    table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #eee;padding:3px 6px;text-align:left;vertical-align:top}
    th{color:#777;font-weight:500} td:first-child{font-family:ui-monospace,monospace}
  </style>
  <h1>CATALOG.index.json · ${esc(index.theme)}</h1>
  <p>工坊按店里那一份主题自带的 schema 现生成（不进店里）：${index.sections.length} 个分区、${index.blocks.length} 个块；
  瘦目录 ${JSON.stringify(index, null, 1).length.toLocaleString()} 字，完整目录 CATALOG.json ${full.toLocaleString()} 字（按 ids 挑着读）。</p>
  <div class="cols"><div><table><tr><th>分区</th><th>名字</th><th>分类</th><th>收哪些块</th></tr>
  ${rows(index.sections.slice(0, 40), ['id', 'name', 'category', 'accepts'])}</table></div>
  <div><table><tr><th>块</th><th>名字</th><th>私有</th></tr>
  ${rows(
    index.blocks.slice(0, 48).map((b) => ({ ...b, private: b.private === true ? '私有' : '' })),
    ['id', 'name', 'private'],
  )}</table>${index.blocks.length > 48 ? `<p>…还有 ${index.blocks.length - 48} 个块</p>` : ''}</div></div>`
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  mkdirSync(SHOTS, { recursive: true })
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    await api(token, owner, 'PUT', '/v1/platform-kit/platform', { storefront_platform: 'shopify' })
    let theme = me.assignments.find((a) => a.role_id === 'site.shopify-theme')?.id
    if (theme === undefined)
      theme = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: 'site.shopify-theme',
          ranges: [],
        })
      ).id
    console.log(`  网页模板分配：${theme}`)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', 'light')
        } catch {
          /* 写不进去就走 demo 的自动登录 */
        }
      },
      [token],
    )
    const page = await context.newPage()
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => undefined)
    })
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shotOf = async (locator, name) => {
      await page.waitForTimeout(400)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    // 岗位页那一行引导走完（装 → 登 → 填店），与 WP253 同一条路
    await page.goto(`${BASE}/positions/${theme}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="install_cli"]', {
      timeout: 30_000,
    })
    await page.click('[data-testid="site-theme-install"]')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', {
      timeout: 90_000,
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="login"]', {
      timeout: 30_000,
    })
    await page.click('[data-testid="site-theme-login"]')
    await page.waitForSelector('[data-testid="site-theme-banner"][data-next="store"]', {
      timeout: 90_000,
    })
    await page.reload({ waitUntil: 'networkidle' })
    const manual = page.locator('[data-testid="site-theme-manual"]')
    if (await manual.isVisible().catch(() => false)) await manual.click()
    await page.waitForSelector('[data-testid="site-theme-store-input"]', { timeout: 30_000 })
    await page.fill('[data-testid="site-theme-store-input"]', SHOP)
    await page.click('[data-testid="site-theme-store-save"]')
    await page.waitForSelector('[data-testid="site-theme-banner"]', {
      state: 'detached',
      timeout: 30_000,
    })

    // ① 新品牌起底：在店里复制一份 Horizon → 检查 → 推未发布预览
    const built = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '用 Horizon 给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    await page.goto(`${BASE}/matters/${built.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-preview-open"]', { timeout: 60_000 })
    await shotOf(page.locator('main'), '1-init-horizon')
    const view = await api(token, theme, 'GET', '/v1/site/theme')
    console.log(`  起底：${JSON.stringify(view.workspace.base)}`)

    // ② Horizon 目录
    const cat = await context.newPage()
    await cat.setContent(catalogHtml(await catalogIndex()))
    await cat.waitForTimeout(300)
    await cat.screenshot({ path: join(SHOTS, '2-horizon-catalog.png'), fullPage: true })
    console.log('  📷 2-horizon-catalog.png')
    await cat.close()

    // ③ 改首页再推一版预览
    const again = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '首页再改一版出预览',
      role_id: 'site.shopify-theme',
    })
    await page.goto(`${BASE}/matters/${again.matter.id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="matter-preview-open"]', { timeout: 60_000 })
    await shotOf(page.locator('main'), '3-edit-home-preview')
    await context.close()
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
