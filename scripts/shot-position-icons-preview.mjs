#!/usr/bin/env node
/**
 * WP213：给 `docs/design/icons/position-duty-icons.html` 拍截图，存 `docs/design/icons/shots/`。
 *
 *     node scripts/shot-position-icons-preview.mjs
 *
 * 只开本地文件（file://），不起服务、不联网。2 倍像素，按节裁：总览、左栏、三张逐枚表、构造。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/package.json'),
)
const { chromium } = require('playwright')

const PAGE = pathToFileURL(join(ROOT, 'docs/design/icons/position-duty-icons.html')).href
const OUT = join(ROOT, 'docs/design/icons/shots')

/** 节的 id → 截图文件名。每张从这一节的标题拍到下一节标题之前。 */
const SECTIONS = [
  ['overview', 'overview'],
  ['rail', 'rail-mockups'],
  ['positions', 'positions-matrix'],
  ['duties', 'duties-matrix'],
  ['channels', 'channels-matrix'],
  ['construction', 'construction'],
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
await page.goto(PAGE)
for (const [id, name] of SECTIONS) {
  const box = await page.evaluate((sid) => {
    const h = document.getElementById(sid)
    let end = h.nextElementSibling
    while (end && end.tagName !== 'H2') end = end.nextElementSibling
    const top = h.getBoundingClientRect().top + window.scrollY - 8
    const bottom = end
      ? end.getBoundingClientRect().top + window.scrollY - 8
      : document.body.scrollHeight
    return { x: 0, y: top, width: document.documentElement.clientWidth, height: bottom - top }
  }, id)
  await page.screenshot({ path: join(OUT, `${name}.png`), clip: box, fullPage: true })
}
// 左栏单张：每种风格一张（浅色），方便直接贴
const rails = await page.$$('.rails > div')
for (const [i, name] of [
  [0, 'rail-line-light'],
  [1, 'rail-line-dark'],
  [2, 'rail-block-light'],
  [3, 'rail-block-dark'],
]) {
  await rails[i].screenshot({ path: join(OUT, `${name}.png`) })
}
await browser.close()
console.log(`截图在 ${OUT}`)
