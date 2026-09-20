#!/usr/bin/env node
/**
 * WP120（69 §4）：**右栏「角色」面板的点击级证据。**
 *
 * 与 `e2e-kol-sandbox.mjs` 同一条纪律：**只点界面**（唯一例外是拿一次登录令牌，
 * 工作台自己也是这么登的）。要证的是四件事，每件一张图：
 *
 * 1. 职责页开「角色」→ 看见**这条职责**的定位，而且**同时给出它所属岗位**那一段；
 * 2. 定位里真的有「你不负责」那一段——69 §0 那条亲测记录缺的就是它；
 * 3. 点「改写」→ 改一句 → 保存 → 标成「公司改写过」、**包里的原文折叠着仍在**、
 *    「还原」按钮才出现；
 * 4. 点「还原」→ 回到「包里自带」，「还原」按钮跟着消失。
 *
 * 用法：
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别测到旧界面
 * node scripts/e2e-role-persona.mjs [--port 4412] [--headed] [--keep]
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

const PORT = Number(value('--port', '4412'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
/** 拿红人那条职责当主角：69 §0 那条亲测记录说的就是它。 */
const DUTY = 'kol.youtube'

const shots = []
async function shoot(page, name) {
  const file = `wp120-role-${name}.png`
  await page.screenshot({ path: join(SHOTS, file), fullPage: true })
  shots.push(file)
  console.log(`  📷 ${file}`)
}

class StepError extends Error {}
const must = (ok, what) => {
  if (!ok) throw new StepError(what)
}

let step = 0
function say(text) {
  step += 1
  console.log(`\n[${String(step).padStart(2, '0')}] ${text}`)
}

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

async function assignmentOf(token, role_id) {
  const me = await (
    await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json()
  const hit = me.data.assignments.find((a) => a.role_id === role_id && a.revoked_at == null)
  must(hit !== undefined, `demo 里没有 ${role_id} 这条职责的分配`)
  return hit.id
}

const settle = (page) => page.waitForTimeout(900)

/** 开出右栏「角色」面板，等它那几段真的渲染出来。 */
async function openRolePanel(page) {
  /*
   * 右栏的开合态是**持久化**的（localStorage）：刷新之后上一次开着的面板还开着，
   * 而点同一个图标是"收起"。所以先看它开没开，没开才点——不然这一步等于把它关掉。
   */
  const panel = page.locator('[data-testid="role-panel"]').first()
  const open = (await panel.count()) > 0 && (await panel.isVisible().catch(() => false))
  if (!open) await page.locator('[data-testid="rail-icon-role"]').first().click()
  await panel.waitFor({ timeout: 30_000 })
  await page.locator('[data-testid="role-effective"]').first().waitFor({ timeout: 30_000 })
  await settle(page)
}

async function run(page, assignment) {
  /* ── ① 职责页：这条职责的定位 + 它所属岗位那一段 ───────────────────── */
  say(`职责页（${DUTY}）开「角色」面板`)
  await page.goto(`${BASE}/positions/${assignment}/duties/${DUTY}`, { waitUntil: 'networkidle' })
  await settle(page)
  await openRolePanel(page)

  const panel = page.locator('[data-testid="role-panel"]').first()
  const blocks = panel.locator('[data-testid="role-persona"]')
  const n = await blocks.count()
  must(n === 2, `职责页该有两段（职责 + 所属岗位），实际 ${n} 段`)
  must(
    (await blocks.nth(0).getAttribute('data-subject')) === DUTY,
    '第一段不是这条职责自己',
  )
  must(
    (await blocks.nth(1).getAttribute('data-subject')) === 'kol-marketing',
    '第二段不是它所属的岗位（红人营销）',
  )

  // 69 §0 那条亲测记录缺的就是这一段：定位里必须写着"什么不归你、转给谁"
  const dutyText = await panel.locator('[data-testid="role-effective"]').first().innerText()
  must(dutyText.includes('你不负责'), '职责的定位里没有「你不负责」那一段')
  must(dutyText.includes('客服'), '「你不负责」那一段里没写转给客服')
  console.log('  ✓ 两段都在；「你不负责」那一段在，并且写着转给客服')
  await shoot(page, '01-duty')

  /* ── ② 岗位页：岗位那一段 + 下属职责清单 ───────────────────────────── */
  say('岗位页开「角色」面板')
  await page.goto(`${BASE}/positions/${assignment}?tab=view`, { waitUntil: 'networkidle' })
  await settle(page)
  await openRolePanel(page)
  const positionPanel = page.locator('[data-testid="role-panel"]').first()
  must(
    (await positionPanel.getAttribute('data-scope')) === 'kol-marketing',
    '岗位页开的不是红人营销那一段',
  )
  const duties = positionPanel.locator('[data-testid="role-duty-link"]')
  must((await duties.count()) > 0, '岗位页没有列出下属职责')
  console.log(`  ✓ 岗位那一段在；下属职责 ${await duties.count()} 条可点`)
  await shoot(page, '02-position')

  /* ── ③ 改写：公司层覆盖 ────────────────────────────────────────────── */
  say('回到职责页，点「改写」改一句')
  await page.goto(`${BASE}/positions/${assignment}/duties/${DUTY}`, { waitUntil: 'networkidle' })
  await settle(page)
  await openRolePanel(page)
  const dutyPanel = page.locator('[data-testid="role-panel"]').first()
  const first = dutyPanel.locator('[data-testid="role-persona"]').first()
  await first.locator('[data-testid="role-edit"]').click()
  const editor = first.locator('[data-testid="role-editor"]')
  await editor.waitFor({ timeout: 15_000 })
  const before = await editor.inputValue()
  must(before.includes('你不负责'), '文本框里没有预填现在生效的那一份')
  await editor.fill(`${before}\n（我们公司加的一句：报价一律先过人。）`)
  await shoot(page, '03-editing')
  await first.locator('[data-testid="role-save"]').click()

  await dutyPanel
    .locator('[data-testid="role-persona"]')
    .first()
    .locator('text=公司改写过')
    .waitFor({ timeout: 20_000 })
  const overridden = dutyPanel.locator('[data-testid="role-persona"]').first()
  must(
    (await overridden.locator('[data-testid="role-packaged"]').count()) === 1,
    '改写之后看不见「包里的原文」那一块——「还原」就成了看不见结果的按钮',
  )
  must(
    (await overridden.locator('[data-testid="role-revert"]').count()) === 1,
    '改写之后「还原」按钮没出现',
  )
  const nowText = await overridden.locator('[data-testid="role-effective"]').innerText()
  must(nowText.includes('报价一律先过人'), '改写没有生效')
  console.log('  ✓ 标成「公司改写过」；原文折叠着仍在；「还原」按钮出现；改的那句在')
  await shoot(page, '04-overridden')

  /* ── ④ 还原 ────────────────────────────────────────────────────────── */
  say('点「还原成原文」')
  await overridden.locator('[data-testid="role-revert"]').click()
  await dutyPanel
    .locator('[data-testid="role-persona"]')
    .first()
    .locator('text=包里自带')
    .waitFor({ timeout: 20_000 })
  const reverted = dutyPanel.locator('[data-testid="role-persona"]').first()
  must(
    (await reverted.locator('[data-testid="role-revert"]').count()) === 0,
    '还原之后「还原」按钮还在',
  )
  const backText = await reverted.locator('[data-testid="role-effective"]').innerText()
  must(!backText.includes('报价一律先过人'), '还原没有回到包里的原文')
  console.log('  ✓ 回到「包里自带」，加的那句没了，「还原」按钮跟着消失')
  await shoot(page, '05-reverted')

  return { shots }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS)) {
    if (f.startsWith('wp120-role-')) rmSync(join(SHOTS, f))
  }

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
    const assignment = await assignmentOf(token, DUTY)
    console.log(`demo 起来了：${BASE}（${DUTY} 的分配 ${assignment}）`)

    browser = await chromium.launch({ headless: !flag('--headed') })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 无痕窗口里写不进去，那就走 demo 的自动登录 */
      }
    }, token)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    pageForFailure = page
    const out = await run(page, assignment)
    console.log(`\n✅ 走通了，${out.shots.length} 张截图在 docs/assets/workstation/`)
    for (const s of out.shots) console.log(`   ${s}`)
  } catch (err) {
    failed = err
    console.error(`\n❌ 第 ${step} 步没走通：${err instanceof Error ? err.message : String(err)}`)
    if (!(err instanceof StepError)) console.error(err)
    try {
      await pageForFailure?.screenshot({
        path: join(SHOTS, 'wp120-role-FAILED.png'),
        fullPage: true,
      })
      console.error('   失败那一刻：docs/assets/workstation/wp120-role-FAILED.png')
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
