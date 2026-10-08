#!/usr/bin/env node
/**
 * WP268（决策 213）：挑图卡与品牌素材库，截图可重跑出处。
 *
 * 起一个 demo（端口默认 4399，不碰 4317）。demo 里生图是占位图（模拟世界挂的那一条，不调真模型、不花钱），
 * CLI / 主题 / 店铺授权 / 店铺「文件」都是替身（内存里的假店），一个真店都不碰。
 *
 * 1. 网页模板：装 CLI → 登录 → 店铺 → 搭一版首页 → 店铺授权；说「给首页出几张横幅图」→ 事项里的挑图卡；
 * 2. 点第 2 张「用这张」→ 传店铺文件、写进 hero、推新预览（时间线「挂好了」+「预览好了」）；
 * 3. 社媒设计说「出几张社媒图」→ 不挂网站的挑图卡；
 * 4. 输入框加图（拖进来的那张进素材库）；
 * 5. 品牌素材库页（筛选、详情：来源 / 模型 / 提示词 / 店铺文件 / 挂在哪）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp268-shots.mjs [--port 4399]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp268')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4399') || 4399
if (PORT === 4317) throw new Error('4317 是本机在用的服务，换个端口')
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

async function poll(fn, ok, what) {
  for (let i = 0; i < 180; i += 1) {
    const v = await fn()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`等不到：${what}`)
}

async function login() {
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

async function assignmentFor(token, me, owner, role_id) {
  const hit = me.assignments.find((a) => a.role_id === role_id)?.id
  if (hit !== undefined) return hit
  const made = await api(token, owner, 'POST', '/v1/assignments', {
    person_id: me.person.id,
    role_id,
    ranges: [],
  })
  const id = made?.id ?? made?.assignment?.id
  if (id !== undefined) return id
  const again = await api(token, undefined, 'GET', '/v1/me')
  return again.assignments.find((a) => a.role_id === role_id)?.id
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
    const theme = await assignmentFor(token, me, owner, 'site.shopify-theme')
    const social = await assignmentFor(token, me, owner, 'design.social')

    // 网页模板就绪：装 CLI → 登录 → 店铺 → 搭一版首页 → 店铺授权（全是替身）
    await api(token, theme, 'POST', '/v1/platform-kit/cli/run', { action: 'install' })
    await poll(
      () => api(token, theme, 'GET', '/v1/site/theme?fresh=1'),
      (v) => v.next !== 'install_cli' && v.next !== 'node',
      'CLI 装好',
    )
    await api(token, theme, 'POST', '/v1/platform-kit/cli/run', { action: 'login' })
    await poll(
      () => api(token, theme, 'GET', '/v1/site/theme?fresh=1'),
      (v) => v.next !== 'login',
      'CLI 登录',
    )
    await api(token, theme, 'PUT', '/v1/site/theme/store', { store: SHOP })
    await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '用 agentsws-theme 给我搭个首页',
      role_id: 'site.shopify-theme',
    })
    await api(token, theme, 'POST', '/v1/shop-admin/run', {
      action: 'authorize',
      roles: ['site.shopify-theme'],
    })
    await poll(
      () => api(token, theme, 'GET', '/v1/shop-admin?roles=site.shopify-theme'),
      (v) => v.state === 'authorized',
      '店铺授权',
    )
    const hero = await api(token, theme, 'POST', `/v1/positions/${theme}/matters`, {
      title: '给首页出几张横幅图（品牌故事那屏也要一张）',
      role_id: 'site.shopify-theme',
    })
    const posters = await api(token, social, 'POST', `/v1/positions/${social}/matters`, {
      title: '出几张社媒图，新品折叠收纳箱上市',
      role_id: 'design.social',
    })

    browser = await chromium.launch({ headless: true })
    const shots = async (theme_) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, theme_],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }
    const snap = async (locator, name) => {
      await locator.scrollIntoViewIfNeeded()
      await locator.page().waitForTimeout(600)
      await locator.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
    }

    // ① 网页模板的挑图卡（亮 / 暗）
    for (const mode of ['light', 'dark']) {
      const { context, page } = await shots(mode)
      await page.goto(`${BASE}/matters/${hero.matter.id}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="image-pick-card"]')
      await card.waitFor({ timeout: 60_000 })
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="image-pick-card"] img').length >= 3,
        undefined,
        { timeout: 30_000 },
      )
      await snap(page.locator('main'), `1-pick-card-theme-${mode}`)
      await context.close()
    }

    // ② 选第 2 张 → 传店铺文件、写进 hero、推新预览
    {
      const { context, page } = await shots('light')
      await page.goto(`${BASE}/matters/${hero.matter.id}`, { waitUntil: 'networkidle' })
      page.on('response', async (r) => {
        if (r.url().includes('/decide') && !r.ok())
          console.error(`  ⚠️ 批卡没成：${r.status()} ${await r.text().catch(() => '')}`)
      })
      await page.waitForSelector('[data-testid="image-pick-use"]', { timeout: 30_000 })
      await page.locator('[data-testid="image-pick-use"]').nth(1).click()
      await page
        .waitForFunction(() => document.body.textContent?.includes('挂好了'), undefined, {
          timeout: 60_000,
        })
        .catch(async (e) => {
          const v = await api(token, theme, 'GET', `/v1/matters/${hero.matter.id}`)
          console.error(v.timeline.map((x) => `${x.kind}: ${x.text}`).join('\n'))
          throw e
        })
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(800)
      await page.locator('text=挂好了').last().scrollIntoViewIfNeeded()
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, '2-picked-placed.png') })
      console.log('  📷 2-picked-placed.png')
      await context.close()
    }

    // ③ 社媒设计的挑图卡（不挂网站）
    {
      const { context, page } = await shots('light')
      await page.goto(`${BASE}/matters/${posters.matter.id}`, { waitUntil: 'networkidle' })
      const card = page.locator('[data-testid="image-pick-card"]')
      await card.waitFor({ timeout: 60_000 })
      await page.waitForTimeout(800)
      await snap(card, '3-pick-card-social')

      // ④ 输入框加图：拖进来的一张进素材库，发话时带上它
      const dropDir = mkdtempSync(join(tmpdir(), 'wp268-drop-'))
      const png = join(dropDir, 'box.png')
      writeFileSync(
        png,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          'base64',
        ),
      )
      await page.setInputFiles('[data-testid="matter-say"] input[type="file"]', png)
      await page.waitForSelector('[data-testid="matter-attachments"]', { timeout: 30_000 })
      await page.fill('[data-testid="matter-say"] textarea', '用这张产品图做一张 IG 方图')
      await snap(page.locator('[data-testid="matter-dock"]'), '4-composer-attach')
      rmSync(dropDir, { recursive: true, force: true })
      await context.close()
    }

    // ⑤ 品牌素材库页（亮 / 暗），点一张看详情
    for (const mode of ['light', 'dark']) {
      const { context, page } = await shots(mode)
      await page.goto(`${BASE}/brand-assets`, { waitUntil: 'networkidle' })
      await page.waitForSelector('[data-testid="brand-asset"]', { timeout: 30_000 })
      await page.waitForTimeout(800)
      await page
        .locator('[data-testid="brand-asset"]')
        .filter({ has: page.locator('svg') })
        .first()
        .click()
      await page.waitForSelector('[data-testid="brand-asset-detail"]', { timeout: 10_000 })
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(SHOTS, `5-library-${mode}.png`), fullPage: false })
      console.log(`  📷 5-library-${mode}.png`)
      await context.close()
    }
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
