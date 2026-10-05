#!/usr/bin/env node
/**
 * WP218 审稿截图：左下角「有新版本」按钮的几种样子。
 *
 * 普通浏览器里没有桌面壳，这里用 addInitScript 塞一个**替身桥**（window.agentsws.update），
 * 状态由脚本推——按钮本身、文案、图标都是真的工作台代码。
 * 先起演示服务：node apps/cli/bin/agentsws.mjs demo --port 4399
 * 用法：node scripts/wp218-shots.mjs [基址，默认 http://127.0.0.1:4399]
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 与其他截图脚本同一个取法（根目录没把 playwright 装成直接依赖）
const { chromium } = createRequire(import.meta.url)(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
)

const base = process.argv[2] ?? 'http://127.0.0.1:4399'
const out = join(ROOT, 'docs', 'assets', 'wp218')
mkdirSync(out, { recursive: true })

const states = [
  [
    '01-available',
    { state: 'available', version: '0.2.0-beta.2', mode: 'auto', source: 'primary' },
  ],
  [
    '02-downloading',
    { state: 'downloading', version: '0.2.0-beta.2', percent: 56, source: 'primary' },
  ],
  ['03-ready', { state: 'ready', version: '0.2.0-beta.2', source: 'primary' }],
  [
    '04-error-network',
    { state: 'error', stage: 'download', code: 'network', version: '0.2.0-beta.2' },
  ],
  [
    '05-mac-notify',
    { state: 'available', version: '0.2.0-beta.2', mode: 'notify', source: 'primary' },
  ],
]

const browser = await chromium.launch()
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme })
  await page.addInitScript(() => {
    let current = { state: 'idle' }
    const listeners = new Set()
    window.__pushUpdate = (s) => {
      current = s
      for (const l of listeners) l(s)
    }
    window.agentsws = {
      platform: 'win32',
      version: '0.2.0-beta.1',
      notify: async () => true,
      openExternal: async () => true,
      update: {
        status: async () => current,
        onChange: (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        download: async () => current,
        install: async () => 'cancelled',
      },
    }
  })
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  // 主题按工作台自己的开关走（跟系统那一档在演示里不一定生效），直接挂 dark class
  if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'))
  for (const [name, status] of states) {
    await page.evaluate((s) => window.__pushUpdate(s), status)
    await page.waitForSelector('[data-testid="update-button"]')
    await page.waitForTimeout(300)
    const rail = page.locator('[data-testid="rail-bottom"]')
    await rail.screenshot({ path: join(out, `${name}-${theme}.png`) })
    if (name === '03-ready' && theme === 'light')
      await page.screenshot({ path: join(out, '00-full-ready-light.png') })
  }
  await page.close()
}
await browser.close()
console.log(`截图在 ${out}/`)
