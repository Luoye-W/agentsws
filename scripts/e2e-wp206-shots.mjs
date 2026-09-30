#!/usr/bin/env node
/**
 * WP206：额度分配搬到网页版账号页之后工作台这一侧的截图，可重跑。存到 `docs/assets/wp206/`。
 * （接替 WP194 的 `e2e-wp194-shots.mjs`：公司页的「积分」tab 拿掉了，那几张已经拍不出来。）
 *
 * 1. `org-no-credits-tab.png`：公司页——页签里已经没有「积分」；
 * 2. `settings-credits-alloc-link.png`：设置 → 积分，owner 看得到「给同事分额度 → 在网页上」；
 * 3. `my-allowance-full.png`：额度到了——「我的本月额度」变红，「本月额度用完了，找管理员加。」照旧；
 * 4. `free-chat-quota-error.png`：出错处——随便聊里用「Agents 工坊（用积分）」问一句，回那句人话。
 *
 * 全走 demo 的真路由与真界面；云是替身（`cloud-stand-in`，数字是合成的，不真扣钱）。给自己设上限走的是
 * 本机 `POST /v1/cloud/allocation/limits`（工作台界面上已经没有这个入口，正式环境在网页上设）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build
 * pnpm exec tsc -b
 * node apps/cli/bin/agentsws.mjs demo --port 4399 &
 * node scripts/e2e-wp206-shots.mjs [--port 4399]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp206')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 && args[i + 1] !== undefined ? args[i + 1] : '4399')
const BASE = `http://127.0.0.1:${PORT}`

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // ⓪ 关联账号（替身云：发信之后自己点链接）
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    await page
      .locator('[data-testid="cloud-account-linked"], [data-testid="cloud-account-unlinked"]')
      .first()
      .waitFor({ timeout: 20_000 })
    const unlinked = page.getByTestId('cloud-account-unlinked')
    if ((await unlinked.count()) > 0) {
      await unlinked.locator('input[type="email"]').fill('boss@example.com')
      await unlinked.getByRole('button').last().click()
      await page.getByTestId('cloud-account-linked').waitFor({ timeout: 20_000 })
    }

    // ① 公司页：页签里没有「积分」了
    await page.goto(`${BASE}/org`, { waitUntil: 'load' })
    await page.getByRole('tablist').first().waitFor({ timeout: 20_000 })
    if ((await page.getByTestId('org-tab-credits').count()) > 0)
      throw new Error('公司页还有「积分」tab')
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'org-no-credits-tab.png') })
    console.log('  📷 org-no-credits-tab.png')

    // ② 设置 → 积分：owner 看得到「给同事分额度 → 在网页上」
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    await page.getByTestId('credits-alloc-web-link').waitFor({ timeout: 20_000 })
    await page
      .getByTestId('credits-panel')
      .screenshot({ path: join(SHOTS, 'settings-credits-alloc-link.png') })
    console.log('  📷 settings-credits-alloc-link.png')

    // ③ 额度到了：经本机接口给自己设一个比已用少的上限，再看「我的本月额度」
    const set = await page.evaluate(async () => {
      const token = localStorage.getItem('agentsws.session_token')
      const auth = { Authorization: `Bearer ${token}` }
      const who = await (await fetch('/v1/me', { headers: auth })).json()
      const owner = who.data.assignments.find((a) => a.role_id === 'common.owner')
      const me = await (
        await fetch('/v1/cloud/allocation/me', {
          headers: { ...auth, 'X-Assignment': owner.id },
        })
      ).json()
      const res = await fetch('/v1/cloud/allocation/limits', {
        method: 'POST',
        headers: { ...auth, 'X-Assignment': owner.id, 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'member',
          subject_id: (me.data ?? me).mine.member_id,
          monthly_limit: 5,
        }),
      })
      return res.status
    })
    if (set !== 200) throw new Error(`设上限：${set}`)
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'load' })
    await page.getByTestId('credits-mine-full').waitFor({ timeout: 20_000 })
    await page
      .getByTestId('credits-mine')
      .screenshot({ path: join(SHOTS, 'my-allowance-full.png') })
    console.log('  📷 my-allowance-full.png')

    // ⑥ 出错处：随便聊里用「Agents 工坊（用积分）」问一句，额度到了回那句人话
    await page.goto(`${BASE}/settings`, { waitUntil: 'load' })
    const enable = page.getByTestId('model-cloud-enable')
    await enable.waitFor({ timeout: 20_000 }).catch(() => undefined)
    if ((await enable.count()) > 0) {
      await enable.click()
      await page.getByTestId('model-cloud-disable').waitFor({ timeout: 20_000 })
    }
    await page.goto(`${BASE}/free-chat`, { waitUntil: 'load' })
    await page.getByTestId('free-chat-model').click()
    await page.getByTestId('free-chat-model-option').filter({ hasText: 'Agents' }).first().click()
    await page.getByTestId('free-chat-input').fill('帮我写一段新品上架的文案')
    await page.getByTestId('free-chat-send').click()
    await page.getByTestId('free-chat-error').waitFor({ timeout: 30_000 })
    await page.waitForTimeout(300)
    await page
      .getByTestId('free-chat-page')
      .screenshot({ path: join(SHOTS, 'free-chat-quota-error.png') })
    console.log('  📷 free-chat-quota-error.png')
  } finally {
    await browser.close()
  }
}

await main()
