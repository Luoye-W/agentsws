// WP239 设计稿截图：本地直接开文件，1440 / 1024 × 明 / 暗，外加几张状态图。
// 用法：node docs/design/position/_src/shots.mjs [只截名字里含这个词的]
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '../../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..')
const shots = join(dir, 'shots')
const only = process.argv[2] ?? ''

const jobs = []
for (const page of ['list', 'settings', 'empty'])
  for (const w of [1440, 1024])
    for (const theme of ['light', 'dark'])
      jobs.push({ name: `${page}-${w}-${theme}`, page, w, q: theme === 'dark' ? '?theme=dark' : '' })
// 主稿的几种状态（1440 浅色）
for (const [name, q] of [
  ['list-view-board', '?view=board'],
  ['list-view-calendar', '?view=calendar'],
  ['list-view-table', '?view=table'],
  ['list-filter-open', '?filter=1'],
  ['list-quick-community', '?view=community'],
  ['list-quick-schedule', '?view=schedule'],
  ['list-banner-focus-charts', '?banner=1&focus=1&charts=1'],
  ['list-view-calendar-dark', '?view=calendar&theme=dark'],
  ['list-view-board-dark', '?view=board&theme=dark'],
])
  jobs.push({ name, page: 'list', w: 1440, q })
jobs.push({ name: 'settings-advanced-dev-menu', page: 'settings', w: 1440, q: '?dev=1&menu=1' })
jobs.push({ name: 'list-tab-records', page: 'list', w: 1440, q: '?tab=records' })

const browser = await chromium.launch()
for (const j of jobs.filter((x) => x.name.includes(only))) {
  const ctx = await browser.newContext({ viewport: { width: j.w, height: 900 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  const url = pathToFileURL(join(dir, `position-v2-${j.page}.html`)).href + j.q
  await p.goto(url)
  await p.waitForTimeout(400)
  // 视口拉到整页高，左栏 / 右栏（100vh 吸顶）才铺满整张图
  const h = await p.evaluate(() => document.documentElement.scrollHeight)
  await p.setViewportSize({ width: j.w, height: Math.max(900, h) })
  await p.waitForTimeout(200)
  await p.screenshot({ path: join(shots, `${j.name}.png`) })
  await ctx.close()
  console.log('shot', j.name)
}
await browser.close()
