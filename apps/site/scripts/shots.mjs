/**
 * 审稿截图（WP197）：先 `pnpm --filter @agentsws/site build`，再 `node scripts/shots.mjs [输出目录]`。
 * 用仓库里的 Playwright（不下载浏览器，用本机已有的 Chromium）。整页截图在「减少动态效果」下截，
 * 画面都是最后一帧；另截一张首屏不减动效的（集结播完、待机中）。
 */

import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { serve } from './serve.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [resolve('../../node_modules/.pnpm/playwright@1.63.0/node_modules')],
  }),
)

const out = resolve(process.argv[2] ?? '../../docs/assets/wp197')
mkdirSync(out, { recursive: true })
const server = await serve()
const base = `http://127.0.0.1:${server.address().port}`

const SHOTS = [
  ['home-1440-light', '/', 1440, 'light', true],
  ['home-1440-dark', '/', 1440, 'dark', true],
  ['home-390-light', '/', 390, 'light', true],
  ['home-390-dark', '/', 390, 'dark', true],
  ['home-en-1440-light', '/en/', 1440, 'light', true],
  ['roles-1440-light', '/roles/', 1440, 'light', true],
  ['pricing-1440-light', '/pricing/', 1440, 'light', true],
  ['pricing-1440-dark', '/pricing/', 1440, 'dark', true],
  ['pricing-390-light', '/pricing/', 390, 'light', true],
  ['download-1440-light', '/download/', 1440, 'light', true],
  ['download-390-light', '/download/', 390, 'light', true],
  ['docs-index-1440-light', '/docs/', 1440, 'light', true],
  ['docs-conn-shopify-1440-light', '/docs/conn-shopify/', 1440, 'light', true],
  ['docs-agentsws-credits-390-dark', '/docs/agentsws-credits/', 390, 'dark', true],
  ['changelog-1440-light', '/changelog/', 1440, 'light', true],
  ['terms-1440-light', '/terms/', 1440, 'light', true],
  ['privacy-en-1440-light', '/en/privacy/', 1440, 'light', true],
  ['404-1440-light', '/no-such-page/', 1440, 'light', false],
  ['hero-live-1440-light', '/', 1440, 'light', false],
]

const browser = await chromium.launch()
for (const [name, path, width, scheme, full] of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
    reducedMotion: name.startsWith('hero-live') ? 'no-preference' : 'reduce',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(base + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(name.startsWith('hero-live') ? 4200 : 300)
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: full })
  if (errors.length > 0) console.error(`${name}: ${errors.join(' | ')}`)
  console.log(`${name}.png`)
  await ctx.close()
}
await browser.close()
server.close()
