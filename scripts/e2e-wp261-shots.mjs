#!/usr/bin/env node
/**
 * WP261：「授权管理商品和页面」那一行 + 商品改动审批卡，截图可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）；demo 里 CLI、`store auth` / `store execute`、店铺都是替身
 * （`platformCliStandIn` / `shopAuthSpawnStandIn` / `shopAdminRunStandIn` + 内存里的假店：不跑真 npm / shopify、不碰真店）。
 * 品牌平台设成 Shopify、给自己上店铺管理职责，然后在岗位页依次拍那一行：
 * 没装 → 一键安装 →（不知道店就填）→ 没授权 → 等浏览器 → 已授权；再借改写回包拍「缺权限」；
 * 最后开一件事「把第一个商品的标题改一下」→ 商品改动审批卡（只出卡，批了才改）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp261-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp261')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4399') || 4399
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const SHOP = 'nordvolt.myshopify.com'

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
    let store = me.assignments.find((a) => a.role_id === 'dtc.store')?.id
    if (store === undefined)
      store = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: 'dtc.store',
          ranges: [],
        })
      ).id
    console.log(`  店铺管理分配：${store}`)

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
    const header = async (name) => {
      await page.waitForTimeout(500)
      await page.screenshot({
        path: join(SHOTS, `${name}.png`),
        clip: { x: 0, y: 0, width: 1280, height: 380 },
      })
      console.log(`  📷 ${name}.png`)
    }
    const stateIs = (s) =>
      page.waitForSelector(`[data-testid="shop-admin-banner"][data-state="${s}"]`, {
        timeout: 90_000,
      })

    await page.goto(`${BASE}/positions/${store}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="shop-admin-banner"]', { timeout: 30_000 })
    if ((await page.getAttribute('[data-testid="shop-admin-banner"]', 'data-state')) === 'no_cli') {
      await header('1-no-cli')
      await page.click('[data-testid="shop-admin-install"]')
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="shop-admin-banner"]')
            ?.getAttribute('data-state') !== 'no_cli',
        undefined,
        { timeout: 90_000 },
      )
      await page.reload({ waitUntil: 'networkidle' })
    }
    if (
      (await page.getAttribute('[data-testid="shop-admin-banner"]', 'data-state')) === 'no_store'
    ) {
      await page.fill('[data-testid="shop-admin-store-input"]', SHOP)
      await header('1b-no-store')
      await page.press('[data-testid="shop-admin-store-input"]', 'Enter')
    }
    await stateIs('unauthorized')
    await header('2-authorize')
    await page.click('[data-testid="shop-admin-authorize"]')
    await stateIs('authorizing')
    await header('3-authorizing')
    await stateIs('authorized')
    await header('4-authorized')

    // 缺权限：改写回包演出来（demo 替身一次给全了权限；真机上网页模板先授权、店铺管理再看就是这样）
    await page.route('**/v1/shop-admin?**', async (route) => {
      const res = await route.fetch()
      const json = await res.json()
      json.data = {
        ...json.data,
        state: 'missing_scopes',
        missing: ['write_discounts', 'write_online_store_navigation'],
      }
      await route.fulfill({ response: res, json })
    })
    await page.reload({ waitUntil: 'networkidle' })
    await stateIs('missing_scopes')
    await header('5-missing-scopes')
    await page.unroute('**/v1/shop-admin?**')

    // 商品改动：只出卡（批了才改）。卡挂在事项页上（岗位页那一叠里与改价 / 上架合并成一组）
    const made = await api(token, store, 'POST', `/v1/positions/${store}/matters`, {
      title: '把第一个商品的标题改一下',
      role_id: 'dtc.store',
    })
    void made
    // demo 里本来就有两张商品卡（改价 / 上架），同一类会叠成一组；先把它俩驳回，拍出单独这一张
    const queue = await api(token, store, 'GET', '/v1/approvals?lane=mine')
    for (const a of queue.items ?? queue.rows ?? queue)
      if (a.role_id === 'dtc.store' && /^(改价|上架)/.test(a.title))
        await api(token, store, 'POST', `/v1/approvals/${a.id}/decide`, {
          action: 'reject',
          reason: '截图前清掉演示卡',
          via: 'workstation',
        })
    await page.goto(`${BASE}/positions/${store}`, { waitUntil: 'networkidle' })
    const card = page
      .locator('[data-testid="deck-card"]')
      .filter({ hasText: 'Rollout 折叠收纳箱' })
      .first()
    // 「要你处理」是一叠：改价 / 上架 / 改商品合成一组，一张张往后翻到这一张
    for (let i = 0; i < 8 && !(await card.isVisible().catch(() => false)); i += 1) {
      const next = page.getByText('下一张').first()
      if (!(await next.isVisible().catch(() => false))) break
      await next.click()
      await page.waitForTimeout(300)
    }
    await card.waitFor({ timeout: 30_000 }).catch(async (e) => {
      await page.screenshot({ path: join(SHOTS, 'debug-position.png'), fullPage: true })
      throw e
    })
    await card.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await card.screenshot({ path: join(SHOTS, '6-product-card.png') })
    console.log('  📷 6-product-card.png')
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
