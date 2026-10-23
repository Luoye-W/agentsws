#!/usr/bin/env node
/**
 * 官网与 README 用的工作台截图，从当前代码的演示世界重拍（WP344 起；10-23 按界面优化定稿后的样子重写）。
 * 产物进 `apps/site/src/assets/app/`（1360 宽、1 倍、PNG），官网构建时由 astro:assets 压成多尺寸；README 直接引用这些 PNG。
 *
 * ```
 * pnpm exec tsc -b apps/cli apps/workstation          # 演示世界与工作台要先编好
 * pnpm -F @agentsws/workstation exec vite build
 * node apps/site/scripts/app-shots.mjs [--port 4861]   # 本进程里起一个 demo，拍完即停
 * ```
 *
 * 拍哪些（浅色全拍，深色只拍首屏、收件箱、回答三张——官网与 README 按看的人的系统换）：
 * - `home-*`：首页（问候、收件箱 / 待办一行、关键数字、岗位）
 * - `inbox-*`：收件箱列表，右边打开一封「对方还没回」的催一下草稿
 * - `calendar-light`：日历周视图，点了「帮我排进空档」出虚线候选
 * - `answer-*`：网站运营里问「这周店里卖得怎么样」，回来数字卡 + 条形图 + 表格
 * - `role-support` / `role-webops` / `role-b2b`：三个岗位页（1360 × 760）
 * - `onboarding-ai`：初始化设置第一步「接上 AI」（1360 × 760，下载页用）；`onboarding-ai-card` 只裁中间那张卡、2 倍（首页「接上 AI」那段用）
 *
 * 演示世界没接真模型，有两处只在截图里改了回包（脚本里拦，不碰演示数据）：
 * ① 「回答就是图表」：岗位入口的回包换成服务端会回的那种形状（genui 用契约里同一份 `filterGenuiSpec` 现过滤）；
 * ② 首页那行「AI 今天替你处理了 N 件」：演示世界里 AI 一件都没办（没接模型），这里只把这个数改成 12。
 * 只听 127.0.0.1；端口不许 4317。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const OUT = join(ROOT, 'apps/site/src/assets/app')

const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const PORT = Number(argOf('--port') ?? '4861') || 4861
if (PORT === 4317) throw new Error('4317 是本机正在用的服务，换一个')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
/** 演示世界的「现在」（种子数据按它摆）。浏览器的钟不动：冻住它工作台的日期格式化会报错，截图上的日期就是拍的那天。 */
const NOW = Date.parse('2026-10-22T02:00:00Z')
const AI_HANDLED = 12

async function call(method, path, body, token, assignment) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (assignment !== undefined) headers['x-assignment'] = assignment
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

/** 「回答就是图表」：店里的商品问答（与 WP336 截图同一份演示数）。 */
const ROWS = [
  ['USB-C 65W 充电器', 129, 340, '在卖'],
  ['GaN 旅行转换头', 89, 120, '在卖'],
  ['编织数据线 2m', 22.5, 860, '在卖'],
  ['10000mAh 充电宝', 59, 210, '在卖'],
]
const QUESTION = '这周店里卖得怎么样'
const LEAD = '这周 126 单，销售额 $9,840，比上周多 9%。数据线卖得最多。'
const RAW = {
  items: [
    {
      type: 'grid',
      cols: 3,
      items: [
        { type: 'stat', label: '订单', value: '126', delta: '+12%' },
        { type: 'stat', label: '销售额', value: '$9,840', delta: '+9%' },
        { type: 'stat', label: '转化', value: '3.4%', delta: '+0.3' },
      ],
    },
    {
      type: 'chart',
      kind: 'bars',
      horizontal: true,
      data: ROWS.map(([label, , stock]) => ({ label, value: stock })),
    },
    { type: 'table', columns: ['商品', '价格', '库存', '状态'], rows: ROWS },
  ],
}

async function quickAnswer(page, asg, filterGenuiSpec) {
  const answer = {
    lead: LEAD,
    components: [{ kind: 'genui', spec: filterGenuiSpec(RAW).spec }],
    sources: ['店里的商品列表', '最近的订单'],
  }
  await page.route('**/v1/positions/*/matters', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    if (json.data?.mode === 'quick')
      json.data.answer = { ...json.data.answer, outcome: 'answered', text: LEAD, ...answer }
    await route.fulfill({ response: res, json })
  })
  try {
    for (let attempt = 1; ; attempt += 1) {
      await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle', timeout: 120_000 })
      const box = page.locator('[data-testid="position-entry-input"]')
      await box.waitFor({ timeout: 30_000 })
      await page.waitForTimeout(800)
      await box.click()
      await box.fill(QUESTION)
      await box.press('Enter')
      try {
        await page.waitForSelector('[data-testid="answer-genui"]', { timeout: 30_000 })
        return
      } catch (e) {
        if (attempt >= 3) throw e
        console.error(`  回答没出来，重试第 ${attempt + 1} 次`)
      }
    }
  } finally {
    await page.unroute('**/v1/positions/*/matters')
  }
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { filterGenuiSpec } = await import(
    pathToFileURL(join(ROOT, 'packages/contracts/dist/index.js')).href
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  mkdirSync(OUT, { recursive: true })
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    reportHistory: true,
    now: NOW,
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  let failed = false
  try {
    const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
    const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
    const me = await call('GET', '/v1/me', undefined, token)
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    // 关联演示里的替身云、启用「Agents 工坊（用积分）」：界面上不出「还没接 AI」
    await call('POST', '/v1/cloud/account/link', { email: 'boss@example.com' }, token, owner)
    for (let i = 0; i < 50; i += 1) {
      if ((await call('GET', '/v1/cloud/account', undefined, token, owner)).linked === true) break
      await new Promise((r) => setTimeout(r, 200))
    }
    await call(
      'PUT',
      '/v1/models/providers/agentsws',
      { kind: 'agentsws_cloud', model: 'deepseek-flash' },
      token,
      owner,
    )
    const instances = (await call('GET', '/v1/positions', undefined, token, owner)).instances ?? []
    const asgOf = (id) =>
      instances
        .find((x) => x.position_id === id)
        ?.roles.find((r) => r.my_assignment_id !== undefined)?.my_assignment_id

    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 820 },
        deviceScaleFactor: 1,
        colorScheme: scheme,
        reducedMotion: 'reduce',
        timezoneId: 'Asia/Shanghai',
        locale: 'zh-CN',
      })
      await context.addInitScript(
        ([t, s]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', s)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, scheme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  页面报错：${e.message}`))
      const shot = async (name, fn, size = { width: 1360, height: 820 }) => {
        try {
          await page.setViewportSize(size)
          await fn()
          await page.waitForTimeout(900)
          await page.screenshot({ path: join(OUT, `${name}.png`) })
          console.log(`  ${name}.png`)
        } catch (e) {
          failed = true
          console.error(`  ❌ ${name}：${String(e.message).split('\n')[0]}`)
        }
      }

      // ① 首屏：首页（只在截图里把「AI 今天替你处理了 N 件」改成 12，见文件头）
      await page.route('**/v1/home?**', async (route) => {
        const res = await route.fetch()
        const json = await res.json()
        if (json.data?.battle_report !== undefined)
          json.data.battle_report = {
            ...json.data.battle_report,
            ai_handled: AI_HANDLED,
            auto_sent: 0,
          }
        await route.fulfill({ response: res, json })
      })
      await shot(`home-${scheme}`, async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 120_000 })
        await page.getByTestId('home').waitFor({ timeout: 60_000 })
      })
      await page.unroute('**/v1/home?**')

      // ② 收件箱：列表 + 右边打开「对方还没回」那封的催一下草稿
      await shot(`inbox-${scheme}`, async () => {
        await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' })
        await page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
        const row = page.locator('[data-testid="inbox-row"]').filter({ hasText: '还没回' }).first()
        await row.click()
        await page.getByTestId('inbox-pane').waitFor({ timeout: 10_000 })
      })

      // ③ 回答就是图表
      const web = asgOf('web-ops')
      await shot(`answer-${scheme}`, async () => {
        if (web === undefined) throw new Error('演示世界里没有网站运营岗位')
        await quickAnswer(page, web, filterGenuiSpec)
      })

      if (scheme === 'light') {
        // ④ 日历周视图 +「帮我排进空档」的虚线候选
        await shot('calendar-light', async () => {
          await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' })
          await page.getByTestId('calendar-host').waitFor({ timeout: 30_000 })
          await page.getByTestId('caltodo-ai').click()
          await page.getByTestId('caltodo-ai-bar').waitFor({ timeout: 15_000 })
        })

        // ⑤ 岗位页三张
        for (const [id, name] of [
          ['customer-care', 'role-support'],
          ['web-ops', 'role-webops'],
          ['b2b', 'role-b2b'],
        ]) {
          await shot(
            name,
            async () => {
              const asg = asgOf(id)
              if (asg === undefined) throw new Error(`演示世界里没有 ${id}`)
              await page.goto(`${BASE}/positions/${asg}`, { waitUntil: 'networkidle' })
              await page.getByTestId('position-page').waitFor({ timeout: 60_000 })
            },
            { width: 1360, height: 760 },
          )
        }

        // ⑥ 初始化设置第一步「接上 AI」
        await shot(
          'onboarding-ai',
          async () => {
            await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
            await page.getByText('ChatGPT 订阅').first().waitFor({ timeout: 30_000 })
          },
          { width: 1360, height: 760 },
        )
        // ⑦ 同一页只裁中间那张设置卡、两倍清晰度：首页「接上 AI」那段用（整页缩小了选项看不清）
        try {
          const sharp = await context.browser().newContext({
            viewport: { width: 1360, height: 760 },
            deviceScaleFactor: 2,
            colorScheme: 'light',
            reducedMotion: 'reduce',
            timezoneId: 'Asia/Shanghai',
            locale: 'zh-CN',
          })
          await sharp.addInitScript(
            ([t]) => {
              try {
                window.localStorage.setItem('agentsws.session_token', t)
                window.localStorage.setItem('agentsws.theme', 'light')
              } catch {
                /* 同上 */
              }
            },
            [token],
          )
          const card = await sharp.newPage()
          await card.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
          await card.getByText('ChatGPT 订阅').first().waitFor({ timeout: 30_000 })
          await card.waitForTimeout(900)
          await card.screenshot({
            path: join(OUT, 'onboarding-ai-card.png'),
            clip: { x: 448, y: 64, width: 704, height: 476 },
          })
          console.log('  onboarding-ai-card.png')
          await sharp.close()
        } catch (e) {
          failed = true
          console.error(`  ❌ onboarding-ai-card：${String(e.message).split('\n')[0]}`)
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.server.close?.()
  }
  if (failed) process.exitCode = 1
}

await main()
