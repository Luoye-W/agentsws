/**
 * 分享图（Open Graph，1200×630）与 apple-touch-icon：用品牌标记（`@agentsws/brand` 的静态那一档）+ 一行标题
 * 拼一张 HTML，用仓库里的 Playwright 截成 PNG，签进 `public/og/`。改了标题或标记后重跑：
 *   pnpm --filter @agentsws/brand build && node scripts/og.mjs
 * 不在每次构建时跑（构建机上未必有中文字体与浏览器），产物是静态文件。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markSvg, STOPS_ON_DARK, STOPS_ON_LIGHT } from '@agentsws/brand'

const require = createRequire(import.meta.url)
const { chromium } = require(
  require.resolve('playwright', {
    paths: [
      resolve(
        fileURLToPath(
          new URL('../../../node_modules/.pnpm/playwright@1.63.0/node_modules', import.meta.url),
        ),
      ),
    ],
  }),
)
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))
const OUTFIT = fileURLToPath(
  new URL(
    '../node_modules/@fontsource/outfit/files/outfit-latin-700-normal.woff2',
    import.meta.url,
  ),
)

const TEXT = {
  zh: {
    brand: 'Agents 工坊',
    home: ['面板会吃灰。', '这队 AI 同事，', '天天上班。'],
    roles: ['十个岗位，', '各管一摊。'],
    pricing: ['开源版免费。', '用积分，按用量。'],
    download: ['下载 Agents 工坊', 'Mac / Windows', '双击就装'],
    docs: ['每一步，', '都有一篇白话教程。'],
    changelog: ['更新日志', '每一步，都摊开给你看。'],
    legal: ['条款与隐私', '本地优先，上云你说了算。'],
    foot: '开源 · Apache-2.0 · agentsws.com',
  },
  en: {
    brand: 'Agents Workshop',
    home: ['Dashboards gather dust.', 'This AI team', 'shows up every day.'],
    roles: ['Ten roles,', 'each owning its lane.'],
    pricing: ['Open source is free.', 'Credits are pay as you go.'],
    download: ['Download for', 'Mac & Windows'],
    docs: ['A plain-language guide', 'for every step.'],
    changelog: ['Changelog', 'Every step, out in the open.'],
    legal: ['Terms & privacy', 'Local first. Cloud is opt-in.'],
    foot: 'Open source · Apache-2.0 · agentsws.com',
  },
}
const KEYS = ['home', 'roles', 'pricing', 'download', 'docs', 'changelog', 'legal']

function page(lang, key) {
  const t = TEXT[lang]
  const lines = t[key]
  const mark = markSvg({ stops: STOPS_ON_LIGHT, id: 'og' })
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Outfit;src:url("file://${OUTFIT}") format("woff2");font-weight:700}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#F3F5F2;font-family:Outfit,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;color:#263331;position:relative;overflow:hidden}
.band{position:absolute;inset:auto 0 0 0;height:14px;background:#007B67}
.brand{position:absolute;left:84px;top:72px;display:flex;align-items:center;gap:18px;font-size:34px;font-weight:700}
.brand svg{width:52px;height:52px}
.big{position:absolute;right:70px;top:120px;width:330px;height:330px}
.big svg{width:100%;height:100%}
h1{position:absolute;left:84px;top:${lines.length > 2 ? 180 : 210}px;width:720px;font-size:${lang === 'zh' ? 66 : 60}px;line-height:1.18;font-weight:700;letter-spacing:-.01em}
h1 span{display:block}
h1 span:not(:first-child){color:#007B67}
.foot{position:absolute;left:84px;bottom:62px;font-size:24px;color:#626B66}
</style></head><body>
<div class="brand">${mark}<span>${t.brand}</span></div>
<div class="big">${mark}</div>
<h1>${lines.map((l) => `<span>${l}</span>`).join('')}</h1>
<div class="foot">${t.foot}</div>
<div class="band"></div>
</body></html>`
}

mkdirSync(join(PUBLIC, 'og'), { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 } })
const p = await ctx.newPage()
for (const lang of ['zh', 'en']) {
  for (const key of KEYS) {
    await p.setContent(page(lang, key), { waitUntil: 'load' })
    await p.evaluate(() => document.fonts.ready)
    await p.screenshot({ path: join(PUBLIC, 'og', `${key}-${lang}.png`) })
    console.log(`og/${key}-${lang}.png`)
  }
}
// apple-touch-icon：深底圆角方块上放亮端点那套（浅底上黄那一头会消失，规范 §1.2）
await p.setViewportSize({ width: 180, height: 180 })
await p.setContent(
  `<!doctype html><html><body style="margin:0;width:180px;height:180px;background:#0E100F;display:grid;place-items:center"><div style="width:112px;height:112px">${markSvg({ stops: STOPS_ON_DARK, id: 'ati' }).replace('<svg ', '<svg width="112" height="112" ')}</div></body></html>`,
)
await p.screenshot({ path: join(PUBLIC, 'apple-touch-icon.png') })
console.log('apple-touch-icon.png')
await browser.close()
