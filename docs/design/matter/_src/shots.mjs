// WP262 设计稿截图：本地直接开文件，1440 / 1024 × 明 / 暗，外加几张状态图。
// 用法：node docs/design/matter/_src/shots.mjs [只截名字里含这个词的]
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '../../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..')
const shots = join(dir, 'shots')
const only = process.argv[2] ?? ''

const jobs = []
for (const page of ['chat', 'states'])
  for (const w of [1440, 1024])
    for (const theme of ['light', 'dark'])
      jobs.push({ name: `${page}-${w}-${theme}`, page, w, q: theme === 'dark' ? 'theme=dark' : '' })
// 主稿的几种结尾与交互（1440，明暗各一张的标了 -dark）
for (const [name, q] of [
  ['chat-open-steps', 'open=1'],
  ['chat-running', 'state=running&open=1'],
  ['chat-running-dark', 'state=running&open=1&theme=dark'],
  ['chat-awaiting', 'state=awaiting'],
  ['chat-awaiting-dark', 'state=awaiting&theme=dark'],
  ['chat-blocked', 'state=blocked'],
  ['chat-done-todos', 'state=done&todos=1&todolist=1'],
  ['chat-menu-todos', 'todos=1&todolist=1&menu=1'],
  ['chat-private', 'private=1&typed=只把深色用在首页，要改哪里？'],
  ['chat-private-dark', 'private=1&typed=只把深色用在首页，要改哪里？&theme=dark'],
  ['chat-no-suggest', 'suggest=0'],
])
  jobs.push({ name, page: 'chat', w: 1440, q })
// 只截视口（不拉整页）：看吸顶页头 + 吸底输入卡在一屏里的样子
for (const theme of ['light', 'dark'])
  jobs.push({ name: `chat-viewport-${theme}`, page: 'chat', w: 1440, q: theme === 'dark' ? 'theme=dark' : '', viewport: true })

const browser = await chromium.launch()
for (const j of jobs.filter((x) => x.name.includes(only))) {
  const ctx = await browser.newContext({ viewport: { width: j.w, height: 900 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  const url = `${pathToFileURL(join(dir, `matter-v2-${j.page}.html`)).href}${j.q ? `?${j.q}` : ''}`
  await p.goto(url)
  await p.waitForTimeout(400)
  if (!j.viewport) {
    // 视口拉到整页高，左栏 / 右栏（100vh 吸顶）才铺满整张图
    const h = await p.evaluate(() => document.documentElement.scrollHeight)
    await p.setViewportSize({ width: j.w, height: Math.max(900, h) })
    await p.waitForTimeout(200)
  } else {
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await p.waitForTimeout(200)
  }
  await p.screenshot({ path: join(shots, `${j.name}.png`) })
  await ctx.close()
  console.log('shot', j.name)
}
await browser.close()
