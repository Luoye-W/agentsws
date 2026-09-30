#!/usr/bin/env node
/**
 * WP204：消息页按钮逐个真点一遍的截图出处。存到 `docs/assets/wp204/`。
 *
 * 全走 demo 的真路由（`apps/cli/src/demo.ts` 种的信；「显示图片」的代取在 demo 里是替身，
 * 题图回一张 5:1 品牌绿色块、追踪像素当取不到）。唯一的浏览器侧替身是第 ⑧ 张：demo 没有真邮箱，
 * 影子模式开不起来，所以把 `/v1/messages/accounts` 的回包加一格 `shadow_mode: true`。
 * 页面头上套的是桌面壳那份 CSP（`apps/desktop/src/csp.ts`）——证明代取回来的 `data:` 图在壳里显示得出来。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-wp204-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp204')
const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

// 与 apps/desktop/src/csp.ts 的 CONTENT_SECURITY_POLICY 同一份（img-src 只认 self / blob: / data:）
const DESKTOP_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  const log = []
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    page.on('response', (r) => {
      const u = r.url()
      if (u.includes('/v1/messages') && r.request().method() !== 'GET')
        log.push(`${r.request().method()} ${u.replace(BASE, '')} → ${r.status()}`)
    })
    // 桌面壳那份 CSP 套在文档上
    await page.route(`${BASE}/messages`, async (route) => {
      const res = await route.fetch()
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'content-security-policy': DESKTOP_CSP },
      })
    })
    const shot = async (name) => {
      await page.waitForTimeout(400)
      await page.locator('[data-testid="messages-page"]').screenshot({ path: join(SHOTS, name) })
      console.log(`  📷 ${name}`)
    }
    /** 等底下那句话换成含 `text` 的那一句（上一句可能还没消失）。 */
    const notice = async (text) => {
      const el = page.locator('[data-testid="messages-notice"]', { hasText: text })
      await el.waitFor({ timeout: 10_000 })
      return (await el.textContent()) ?? ''
    }

    await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="messages-thread"]').first().waitFor({ timeout: 20_000 })

    // ① ② 显示图片：之前挡着，之后题图由本机代取显示、追踪像素取不到照实说
    await page.getByText('Packaging Weekly').first().click()
    await page.locator('[data-testid="messages-show-images"]').waitFor()
    await shot('01-images-blocked.png')
    await page.locator('[data-testid="messages-show-images"]').click()
    console.log(`     回音：${await notice('没取到')}`)
    const srcdoc = await page.locator('[data-testid="message-html"]').getAttribute('srcdoc')
    console.log(`     正文里 data: 图：${srcdoc?.includes('src="data:image/png') === true}`)
    await shot('02-images-shown.png')

    // ③ 星标
    await page.locator('[data-testid="messages-star"]').first().click()
    await page.waitForTimeout(600)
    console.log(
      `     星标：${await page.locator('[data-testid="messages-star"]').first().getAttribute('aria-pressed')}`,
    )

    // ④ ⑤ 删除：先问一句 → 移到垃圾箱、离开这条、带撤销
    await page.locator('[data-testid="messages-delete"]').click()
    await shot('03-delete-confirm.png')
    await page.locator('[data-testid="messages-delete-yes"]').click()
    console.log(`     回音：${await notice('已移到垃圾箱')}`)
    await shot('04-deleted-undo.png')
    await page.locator('[data-testid="messages-undo"]').click()
    console.log(`     撤销：${await notice('已撤销')}`)

    // ⑥ 归档（整条会话、带撤销）
    await page.locator('[data-testid="messages-thread"]').first().click()
    await page.locator('[data-testid="messages-archive"]').click()
    console.log(`     回音：${await notice('已归档')}`)
    await shot('05-archived-undo.png')

    // ⑦ 回复 → 发送：demo 没有真邮箱，发不出去——话说在写信框里，框留着
    await page.locator('[data-testid="messages-thread"]').first().click()
    await page.locator('[data-testid="messages-reply"]').click()
    await page.locator('[data-testid="composer-body"]').fill('收到，今天给你补发。')
    await page.locator('[data-testid="composer-send"]').click()
    await page.locator('[data-testid="composer-error"]').waitFor({ timeout: 10_000 })
    console.log(`     发送：${await page.locator('[data-testid="composer-error"]').textContent()}`)
    await shot('06-send-failed-says-why.png')
    await page.locator('[data-testid="composer-close"]').click()

    // ⑧ 刷新 / 搜索 / 附件
    await page.locator('[data-testid="messages-sync"]').click()
    console.log(`     刷新：${await notice('邮箱')}`)
    await page.locator('[data-testid="messages-search"]').fill('包裹')
    await page.locator('[data-testid="messages-search-all"]').waitFor()
    await page.waitForTimeout(600)
    console.log(
      `     搜索命中：${await page.locator('[data-testid="messages-thread"]').count()} 条`,
    )
    await shot('07-search-all-folders.png')
    await page.locator('[data-testid="messages-search"]').fill('')
    await page.getByText('恒昌纸品').first().click()
    const att = page.locator('[data-testid="messages-attachment"]').first()
    await att.waitFor({ timeout: 10_000 }).catch(() => undefined)
    if ((await att.count()) > 0) {
      await att.click()
      console.log(`     附件：${await notice('附件')}`)
    }
    await page.locator('[data-testid="messages-search"]').fill('')

    // ⑨ 影子模式（浏览器侧替身：demo 开不了真影子模式）
    await page.route(`${BASE}/v1/messages/accounts`, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      for (const a of body.data.accounts) a.shadow_mode = true
      await route.fulfill({ response: res, json: body })
    })
    await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="messages-folder"][data-folder="inbox"]').click()
    await page.locator('[data-testid="messages-thread"]').first().click()
    await page.locator('[data-testid="messages-shadow-hint"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-testid="messages-shadow-hint"]').hover()
    await page.waitForTimeout(500)
    // 整页拍：问号里那句话会伸出消息页那一块
    await page.screenshot({ path: join(SHOTS, '08-shadow-mode.png') })
    console.log('  📷 08-shadow-mode.png')
  } finally {
    await browser.close()
  }
  console.log(`\n  请求：\n    ${log.join('\n    ')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
