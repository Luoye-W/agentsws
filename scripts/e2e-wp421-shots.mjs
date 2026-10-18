#!/usr/bin/env node
/**
 * WP421（自查 general 组）：公关 / 内容与搜索 / B2B / 设计补通——端到端走一遍 + 截图（不联网：demo 的 stub 运行时、替身）。
 *
 * 在本进程里起一个 demo（`createDemo`），用 demo 店主的身份按岗位走主流程：
 *
 * 1. `pr-press-*`：公共关系说「起草一篇新闻稿」→ 走新闻稿那条职责、起草工具出卡（不再被分到信息监控）；
 *    批了草稿 = 定稿；再提「发出去」那张，批了照实说「没发出去：分发渠道还没接通」；
 * 2. `b2b-samples-*`：B2B 业务问「样品到哪了」→ 读 B2B 库回答；
 * 3. `b2b-redraft-*`：回询盘卡点「改一下」→ 没接模型时原稿再出一张、照实说「请直接改」（卡不丢）；
 * 4. `b2b-import-*`：主动开发面板的「导入名单」；
 * 5. `design-request-*` / `design-queue-*`：店铺管理下一张设计需求单 → 设计岗收到（开事项 + 待办），设计岗问「有哪些单等着我」读得到；
 * 6. `content-geo-*`：内容与搜索问「AI 搜索里有没有我们」→ 读 GEO（没跑过照实说）；
 * 7. `claude-sub-*`：设置 → 模型里 Claude 订阅照实写暂不可用。
 *
 * 每张浅色、深色各一张，存到 `--out`（默认私有仓 `docs/assets/wp421/`；公开仓不放截图）。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp421-shots.mjs [--port 4560] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(arg('--port', '4560'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(
  arg('--out', join(homedir(), 'Documents/agentsws-internal/docs/assets/wp421')),
)
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const load = (p) => import(pathToFileURL(join(ROOT, p)).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(path, body) {
  return (
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json()
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

/** 判定：不对就停（这是端到端，不是只拍照）。 */
function check(ok, what) {
  if (!ok) throw new Error(`✗ ${what}`)
  console.log(`  ✓ ${what}`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { createDemo } = await load('apps/cli/dist/demo.js')
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const live = await createDemo({ root: ROOT, port: PORT, quiet: true })
  await live.server.listen()
  let browser
  try {
    const link = await post('/v1/auth/magic-link', { email: OWNER })
    const token = (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
    const me = await api(token, undefined, 'GET', '/v1/me')
    const asg = (role) => {
      const hit = me.assignments.find((a) => a.role_id === role)
      if (hit === undefined) throw new Error(`demo 店主没挂 ${role}`)
      return hit.id
    }
    const ws = me.workspace?.id ?? live.server.bootstrap.workspace.id
    const person = me.person.id
    const pending = async () =>
      live.server.approvals.queue({
        workspace_id: ws,
        person_id: person,
        lane: 'mine',
        state: ['pending'],
      })

    /** 在这条职责上开一件事，回事项 id、调了哪些工具与 AI 的回话。 */
    const ask = async (role, title) => {
      const a = asg(role)
      const out = await api(token, a, 'POST', `/v1/positions/${a}/matters`, {
        title,
        role_id: role,
      })
      let reply = ''
      let routed = ''
      for (let i = 0; i < 80 && reply === ''; i += 1) {
        const view = await api(token, a, 'GET', `/v1/matters/${out.matter.id}`)
        reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
        routed = view.matter?.role_id ?? ''
        if (reply === '') await sleep(250)
      }
      return { matter: out.matter.id, reply, routed, assignment: a }
    }
    const decide = (assignment, id, body) =>
      api(token, assignment, 'POST', `/v1/approvals/${id}/decide`, body)
    /** 批了之后等它施行完。demo 有 2 分钟取消窗口——这里直接跳过窗口施行（同窗口过完那一刻）。 */
    const settle = async (id) => {
      const item = await live.server.approvals.get(id)
      const change_id = item?.payload?.change_id
      if (change_id !== undefined && ['approved', 'approved_edited'].includes(item.state))
        await live.server.txn.executor.apply(change_id, { force: true }).catch(() => undefined)
      return live.server.approvals.get(id)
    }

    console.log('① 公共关系：起草新闻稿')
    const pr = asg('pr.press')
    const press = await ask('pr.press', '帮我起草一篇新品发布的新闻稿，下周三发')
    check(press.reply.includes('新闻稿草稿出卡了'), `回话：${press.reply.slice(0, 40)}…`)
    const brand = await live.server.brands.forWorkspace(ws)
    const release = brand.pr.releases({}).find((r) => r.headline.includes('新品发布'))
    check(release?.status === 'draft', '库里多了一篇草稿')
    const draftCard = (await pending()).find(
      (i) => i.payload?.kind === 'press_release' && i.payload?.target?.id === release.id,
    )
    check(draftCard !== undefined, '出了新闻稿草稿卡')
    await decide(pr, draftCard.id, { action: 'approve' })
    const draftDone = await settle(draftCard.id)
    check(
      brand.pr.release(release.id)?.status === 'approved',
      `草稿批了 = 定稿（卡：${draftDone?.state}）`,
    )
    const dist = await api(token, pr, 'POST', `/v1/pr/releases/${release.id}/distribute`)
    await decide(pr, dist.approval_item_id, { action: 'approve' })
    const distDone = await settle(dist.approval_item_id)
    check(distDone?.state !== 'applied', `发稿卡批了不写「已执行」（卡：${distDone?.state}）`)
    check(brand.pr.release(release.id)?.status !== 'distributed', '稿子没标「已发」')

    console.log('② B2B：样品到哪了 / 改一下')
    const samples = await ask('b2b.sales', '样品到哪了？')
    check(samples.reply.includes('样品'), `回话：${samples.reply.slice(0, 40)}…`)
    const sales = asg('b2b.sales')
    const reply = (await pending()).find((i) => i.payload?.kind === 'b2b_reply')
    let redraft
    if (reply === undefined) console.log('  （demo 里这会儿没有回询盘卡，跳过「改一下」）')
    else {
      const out = await decide(sales, reply.id, {
        action: 'instruct',
        instruction: { scope: 'single_reply', text: 'MOQ 写 500，语气再客气一点' },
      })
      redraft = out.redraft
      check(redraft?.approval_item_id !== undefined, `「改一下」回执：${redraft?.message}`)
    }

    console.log('③ 设计：别的岗位下单 → 设计岗收到')
    const req = await ask('dtc.store', '下一张单给设计岗：新品首页主视觉，桌面和手机各一张')
    check(req.reply.includes('需求单下给设计岗'), `回话：${req.reply.slice(0, 40)}…`)
    const queue = await ask('design.dtc', '有哪些单等着我？')
    check(queue.reply.includes('张需求单'), `设计岗：${queue.reply.slice(0, 40)}…`)

    console.log('④ 内容与搜索：AI 搜索里有没有我们')
    const geo = await ask('dtc.content', 'AI 搜索里有没有我们？')
    check(geo.reply !== '' && !geo.reply.includes('没有剧本'), `回话：${geo.reply.slice(0, 40)}…`)

    browser = await chromium.launch({ headless: true })
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 960 },
        locale: 'zh-CN',
        colorScheme: theme,
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {
            /* 写不进去就走 demo 的自动登录 */
          }
        },
        [token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      const shot = async (name, path, locator) => {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(800)
        const target = locator === undefined ? page : page.locator(locator).first()
        await target.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
        console.log(`  📷 ${name}-${theme}.png`)
      }
      await shot('pr-press', `/matters/${press.matter}`)
      await shot('pr-press-distribute-card', `/cards/${dist.approval_item_id}`)
      await shot('b2b-samples', `/matters/${samples.matter}`)
      if (redraft?.approval_item_id !== undefined)
        await shot('b2b-redraft', `/cards/${redraft.approval_item_id}`)
      // 主动开发面板在职责页「⋯ 这条职责能做什么」→「看板」（右侧面板报表下半截）
      try {
        await page.goto(`${BASE}/positions/${asg('b2b.outbound')}/duties/b2b.outbound`, {
          waitUntil: 'networkidle',
        })
        await page.getByTestId('duty-about-link').click({ timeout: 20_000 })
        await page.getByTestId('duty-boards-link').click({ timeout: 20_000 })
        const more = page.getByTestId('rail-card-more-reports')
        if ((await more.count()) > 0) await more.click()
        const panel = page.getByTestId('b2b-import').first()
        await panel.waitFor({ timeout: 20_000 })
        await panel.scrollIntoViewIfNeeded()
        await page.waitForTimeout(600)
        await page
          .getByTestId('b2b-outbound-panel')
          .first()
          .screenshot({ path: join(SHOTS, `b2b-import-${theme}.png`) })
        console.log(`  📷 b2b-import-${theme}.png`)
      } catch (e) {
        console.error(`  （主动开发面板没拍成：${String(e.message).split('\n')[0]}）`)
      }
      await shot('design-request', `/matters/${req.matter}`)
      await shot('design-queue', `/matters/${queue.matter}`)
      await shot('content-geo', `/matters/${geo.matter}`)
      await page.goto(`${BASE}/settings/models`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)
      const claude = page.getByText('用 Claude 订阅登录（暂不可用）').first()
      if ((await claude.count()) > 0) {
        await claude.click().catch(() => undefined)
        await page.waitForTimeout(600)
      }
      await page.screenshot({ path: join(SHOTS, `claude-sub-${theme}.png`) })
      console.log(`  📷 claude-sub-${theme}.png`)
      await context.close()
    }
  } finally {
    await browser?.close()
    await live.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
