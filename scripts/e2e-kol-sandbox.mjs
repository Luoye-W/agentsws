#!/usr/bin/env node
/**
 * WP117b（`docs/66` 复测 #19）：**红人营销主线的点击级证据。**
 *
 * `docs/66` 上那条结论是："「发开发信 → 虚拟红人回信 → 归并 → 议价」这条主线在
 * 界面上没有被实际走通过一次，只在单测里验证过状态机"。这个脚本就是那一次——
 * 它起一个 demo 服务进程，用真浏览器**一路点下去**，每一步截一张图，
 * 并在关键处断言状态带上的计数真的变了（已发 ≥ 1、回信 ≥ 1）。
 *
 * 三条纪律：
 *
 * 1. **只点界面。** 除了拿一次登录令牌（工作台自己也是这么登的），脚本不打任何
 *    业务接口——接口回 200 而界面什么都没发生，正是 66 断点 #5 那一类 bug，
 *    用接口断言就永远测不到。
 * 2. **断言的是数字，不是文案。** 「已发 1」「回信 3」是状态带上的计数，
 *    它们只有在信真的投进演练收件箱、回信真的被收回来的时候才会动。
 * 3. **可重跑。** 每次起一个全新的 demo（内存库），跑完关掉；退出码 0 = 全过，
 *    非 0 = 某一步没走通，控制台上写着是哪一步。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别测到旧界面
 * node scripts/e2e-kol-sandbox.mjs [--port 4410] [--headed] [--keep]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const PORT = Number(value('--port', '4410'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

/** 截图编号（01…NN），文件名固定 `kol-e2e-NN-<名字>.png`。 */
let shotNo = 0
const shots = []
async function shoot(page, name) {
  shotNo += 1
  const file = `kol-e2e-${String(shotNo).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(SHOTS, file), fullPage: true })
  shots.push(file)
  console.log(`  📷 ${file}`)
}

/** 一步走不通就带着人话停下来——退出码说明成败，控制台说明是哪一步。 */
class StepError extends Error {}
const must = (ok, what) => {
  if (!ok) throw new StepError(what)
}

let step = 0
function say(text) {
  step += 1
  console.log(`\n[${String(step).padStart(2, '0')}] ${text}`)
}

/* ── demo 服务进程 ─────────────────────────────────────────────────────── */

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new StepError(`demo 没起来（60 秒）：\n${log.join('')}`)
}

/**
 * 拿一个会话令牌。
 *
 * 这是脚本里**唯一**一次打接口——工作台自己登录走的也是这两跳
 * （`bootstrap.json` 说这是 demo 档 → magic-link → verify），
 * 在浏览器里点一遍只是把同样两个请求换个地方发。
 */
async function login() {
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

/** 这台 demo 上红人（YouTube）那条职责的分配 id——岗位页的地址要用它。 */
async function kolAssignment(token) {
  const me = await (
    await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()
  const hit = me.data.assignments.find((a) => a.role_id === 'kol.youtube' && a.revoked_at == null)
  must(hit !== undefined, 'demo 里没有 kol.youtube 这条职责的分配')
  return hit.id
}

/* ── 界面上的几个小工具 ───────────────────────────────────────────────── */

/** 状态带上的「已发 N · 回信 M」。读的是界面上的字，不是接口。 */
async function counters(page) {
  const text = await page.locator('[data-testid="kol-sandbox-counts"]').first().innerText()
  const num = (label) => {
    const m = text.match(new RegExp(`${label}\\s*(\\d+)`))
    return m === null ? Number.NaN : Number(m[1])
  }
  return { sent: num('已发'), replies: num('回信'), creators: num('合成红人'), text }
}

const settle = (page) => page.waitForTimeout(900)

async function gotoPanel(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('[data-testid="kol-panel"]').first().waitFor({ timeout: 30_000 })
  await settle(page)
}

/* ── 主线 ─────────────────────────────────────────────────────────────── */

async function run(page, assignment) {
  const panel = (view) => `${BASE}/positions/${assignment}?tab=view&kol=${view}`

  // ① 岗位页 · 候选池（演练还没开）
  say('打开红人营销岗位页的「候选池」')
  await gotoPanel(page, panel('pool'))
  await shoot(page, 'pool-before')

  // ② 打开演练
  say('打开「演练」开关 → 铺 24 个合成红人 + 顶上那条状态带')
  await page.locator('[data-testid="kol-sandbox-toggle"]').first().click()
  await page.locator('[data-testid="kol-sandbox-banner"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  let c = await counters(page)
  must(c.creators >= 20, `演练开了却只有 ${c.creators} 个合成红人`)
  must(c.sent === 0, `刚开演练就有 ${c.sent} 封已发，状态不干净`)
  await shoot(page, 'sandbox-on')

  // ③ 搜人：关键词留空、只按渠道（66 复测 #15 修的就是这条路）
  say('在候选池里挑一个合成红人，点开他的详情')
  const rows = page.locator('[data-testid="kol-library-row"]')
  await rows.first().waitFor({ timeout: 20_000 })
  const total = await rows.count()
  must(total > 5, `红人库里只有 ${total} 行，演练的人没铺进来`)
  /*
   * 挑一个**会回信**的：合成世界里六种性格按 `ghost ghost slow eager haggler
   * sampler ghost bouncer` 循环，序号 5 是 `haggler`（只谈钱）——正是我们要的
   * 那一条：他会回信、会问价钱，于是议价卡那一步才有由头。
   */
  const target = page.locator('[data-creator="sbx_syn_kol_005"]').first()
  must((await target.count()) > 0, '库里没有 sbx_syn_kol_005（合成红人的编号变了？）')
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await page.locator('[data-testid="kol-creator-detail"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  await shoot(page, 'creator-detail')

  // ④ 起草开发信 → 出卡
  say('填产品与一句话介绍 → 点「起草」→ 出一张待批的开发信卡')
  await page.locator('[data-testid="kol-outreach-pitch"]').first().fill('我们做桌面快充配件')
  await page.locator('[data-testid="kol-outreach-product"]').first().fill('NordVolt 65W 充电器')
  await page.locator('[data-testid="kol-outreach-go"]').first().click()
  await page.locator('[data-testid="kol-outreach-draft"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  const receipt = await page.locator('[data-testid="kol-detail-receipt"]').first().innerText()
  must(receipt.includes('批'), `起草之后那句回执不对：${receipt}`)
  await shoot(page, 'outreach-draft')

  // ⑤ 去岗位页的「卡片」tab 批这张卡
  say('去「卡片」tab，在那张开发信卡上点「批准」')
  await page.goto(`${BASE}/positions/${assignment}?tab=cards`, { waitUntil: 'networkidle' })
  const card = page.locator('[data-testid="deck-card"]').filter({ hasText: '开发信' }).first()
  await card.waitFor({ timeout: 20_000 })
  await shoot(page, 'outreach-card')
  await card.locator('[data-action="approve"]').first().click()
  await page.waitForTimeout(2500)
  await shoot(page, 'outreach-approved')

  // ⑥ 回面板：状态带上「已发」变成 1
  say('回面板 → 状态带上的「已发」应该变成 1（信真的投进了演练收件箱）')
  await gotoPanel(page, panel('pool'))
  c = await counters(page)
  must(c.sent >= 1, `批了卡，状态带上还是「已发 ${c.sent}」——这一跳没打通：${c.text}`)
  console.log(`  ✓ ${c.text}`)
  await shoot(page, 'sent-one')

  // ⑦ 跳到 3 天后 / 7 天后 → 回信到了
  say('点「跳到 3 天后」，再点「跳到 7 天后」→ 合成红人按性格回信')
  for (const days of [3, 7]) {
    await page.locator(`[data-testid="kol-sandbox-jump"][data-days="${days}"]`).first().click()
    await page.waitForTimeout(2500)
  }
  c = await counters(page)
  must(c.replies >= 1, `跳完时间还是「回信 ${c.replies}」——回信这一跳没打通：${c.text}`)
  console.log(`  ✓ ${c.text}`)
  await shoot(page, 'replies-in')

  // ⑧ 合作线程清单：每行看得出是谁
  say('切到「合作线程」→ 每一行要有红人名 + @账号 + 渠道 + 阶段 + 最近往来')
  await gotoPanel(page, panel('threads'))
  await page.locator('[data-testid="kol-collab-row"]').first().waitFor({ timeout: 20_000 })
  const firstName = await page.locator('[data-testid="kol-collab-name"]').first().innerText()
  must(firstName.trim() !== '', '合作清单第一行没有红人名字')
  console.log(`  ✓ 第一行：${firstName}`)
  await shoot(page, 'threads-list')

  // ⑨ 按阶段筛 → 只看「有回音」
  say('按阶段筛：只看「有回音」的那几条')
  await page.locator('[data-testid="kol-collab-filter"][data-stage="replied"]').first().click()
  await settle(page)
  const replied = await page.locator('[data-testid="kol-collab-row"]').count()
  must(replied >= 1, '筛「有回音」之后一条都没有——回信没有推动合作阶段')
  console.log(`  ✓ 有回音的合作 ${replied} 条`)
  await shoot(page, 'threads-filtered')

  // ⑩ 点开一条 → 往来 + 意向分类 + 跟进节奏
  say('点开一条 → 往来里要看得见我们发的那封与他回的那封，回信带意向分类')
  await page.locator('[data-testid="kol-collab-open"]').first().click()
  await page.locator('[data-testid="kol-thread-exchanges"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  const out = await page
    .locator('[data-testid="kol-thread-exchange"][data-direction="out"]')
    .count()
  const back = await page
    .locator('[data-testid="kol-thread-exchange"][data-direction="in"]')
    .count()
  must(out >= 1, '往来里没有我们发出去的那一封')
  must(back >= 1, '往来里没有他回过来的那一封')
  const klass = await page.locator('[data-testid="kol-thread-reply-class"]').first().innerText()
  console.log(`  ✓ 出站 ${out} 封、回信 ${back} 封，第一封回信判成「${klass}」`)
  const cadence = await page.locator('[data-testid="kol-thread-cadence"]').first().innerText()
  must(cadence.includes('跟进节奏'), '线程上没有跟进节奏那一句')
  console.log(`  ✓ ${cadence}`)
  await shoot(page, 'thread-exchanges')

  // ⑪ 议价卡（money 排版）
  say('在这条线程上报一个价 → 出一张 money 排版的议价卡')
  await page.locator('[data-testid="kol-thread-budget"]').first().fill('800')
  await page.locator('[data-testid="kol-thread-quote-go"]').first().click()
  await page.locator('[data-testid="kol-thread-receipt"]').first().waitFor({ timeout: 20_000 })
  const quoteReceipt = await page.locator('[data-testid="kol-thread-receipt"]').first().innerText()
  must(quoteReceipt.includes('批'), `议价的回执不对：${quoteReceipt}`)
  await shoot(page, 'quote-staged')

  say('去「卡片」tab 批这张议价卡（money 排版）')
  await page.goto(`${BASE}/positions/${assignment}?tab=cards`, { waitUntil: 'networkidle' })
  const money = page.locator('[data-testid="deck-card"]').filter({ hasText: '议价' }).first()
  await money.waitFor({ timeout: 20_000 })
  await shoot(page, 'quote-card')
  await money.locator('[data-action="approve"]').first().click()
  await page.waitForTimeout(2500)

  // ⑫ 批了之后阶段推进到「谈条件中」
  say('回合作线程 → 这条合作应该已经到「谈条件中」并带上预算')
  await gotoPanel(page, panel('threads'))
  await page.locator('[data-testid="kol-collab-filter"][data-stage="negotiating"]').first().click()
  await settle(page)
  const negotiating = await page.locator('[data-testid="kol-collab-row"]').count()
  must(negotiating >= 1, '批了议价卡，却没有一条合作在「谈条件中」')
  const budgetText = await page.locator('[data-testid="kol-collab-budget"]').first().innerText()
  must(budgetText.includes('800'), `合作行上没有预算：${budgetText}`)
  console.log(`  ✓ 谈条件中 ${negotiating} 条，预算 ${budgetText}`)
  await shoot(page, 'negotiating')

  // ⑬ 推到「谈成」→「交付中」
  say('推阶段：谈成 → 交付中')
  await page.locator('[data-testid="kol-collab-open"]').first().click()
  await page.locator('[data-testid="kol-thread-stage"]').first().waitFor({ timeout: 20_000 })
  for (const next of ['agreed', 'delivering']) {
    const btn = page.locator(`[data-testid="kol-thread-next"][data-next="${next}"]`).first()
    await btn.waitFor({ timeout: 20_000 })
    await btn.click()
    await page.waitForTimeout(1500)
  }
  await shoot(page, 'delivering')

  // ⑭ 登记交付物
  say('登记一条交付物（视频）')
  await page
    .locator('[data-testid="kol-thread-deliverable-url"]')
    .first()
    .fill('https://www.youtube.com/watch?v=e2e-demo')
  await page.locator('[data-testid="kol-thread-deliverable-add"]').first().click()
  await page.locator('[data-testid="kol-thread-deliverable"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  await shoot(page, 'deliverable')

  // ⑮ 验收（提一条结论 → 卡）
  say('验收：点「通过」→ 提一条待批的验收结论')
  await page.locator('[data-testid="kol-thread-review"][data-review="approved"]').first().click()
  await page.waitForTimeout(2000)
  const reviewReceipt = await page.locator('[data-testid="kol-thread-receipt"]').first().innerText()
  must(
    reviewReceipt.includes('批') || reviewReceipt.includes('验收'),
    `验收回执不对：${reviewReceipt}`,
  )
  await shoot(page, 'review')

  // ⑯ 建追踪链接
  say('建一条追踪链接（归因全靠它）')
  await page
    .locator('[data-testid="kol-thread-link-url"]')
    .first()
    .fill('https://nordvolt.example/p/charger-65w')
  await page.locator('[data-testid="kol-thread-link-add"]').first().click()
  await page.locator('[data-testid="kol-thread-link"]').first().waitFor({ timeout: 20_000 })
  await settle(page)
  await shoot(page, 'tracked-link')

  // ⑰ 回信归并进「消息」的 kolagents（63 那条链）
  say('去「消息」→ 红人回信应该也在 kolagents 文件夹里')
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await shoot(page, 'messages-kolagents')

  // ⑱ 面板：真漏斗不含演练，演练漏斗单独一块
  say('回面板 → 「建联漏斗」不含演练数据，「演练漏斗」单独一块')
  await page.goto(`${BASE}/positions/${assignment}?tab=view`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await shoot(page, 'funnels')

  return { shots }
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  // 重跑时先把上一轮的图清掉，免得半截的一轮留下孤儿文件冒充证据
  for (const f of readdirSync(SHOTS)) {
    if (f.startsWith('kol-e2e-')) rmSync(join(SHOTS, f))
  }

  /*
   * playwright 不是仓库的 dependency（它只给截图与这个脚本用），所以按路径取——
   * `node_modules/.pnpm/playwright@1.63.0/…`，与仓里拍截图那条命令同一份。
   */
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  let failed
  let pageForFailure
  try {
    await waitForDemo(log)
    const token = await login()
    const assignment = await kolAssignment(token)
    console.log(`demo 起来了：${BASE}（红人职责分配 ${assignment}）`)

    browser = await chromium.launch({ headless: !flag('--headed') })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    // 工作台把令牌放在 localStorage 里；先塞进去，页面一开就是登录态
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 无痕窗口里写不进去，那就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    // 哪一步栽了就把那一刻拍下来——光有一句超时，人还是不知道界面当时长什么样
    pageForFailure = page
    const out = await run(page, assignment)
    console.log(`\n✅ 主线走通了，${out.shots.length} 张截图在 docs/assets/workstation/`)
    for (const s of out.shots) console.log(`   ${s}`)
  } catch (err) {
    failed = err
    console.error(`\n❌ 第 ${step} 步没走通：${err instanceof Error ? err.message : String(err)}`)
    if (!(err instanceof StepError)) console.error(err)
    try {
      await pageForFailure?.screenshot({ path: join(SHOTS, 'kol-e2e-FAILED.png'), fullPage: true })
      console.error('   失败那一刻：docs/assets/workstation/kol-e2e-FAILED.png')
    } catch {
      /* 浏览器已经没了就算了 */
    }
  } finally {
    await browser?.close()
    if (!flag('--keep')) child.kill('SIGTERM')
  }
  process.exit(failed === undefined ? 0 : 1)
}

await main()
