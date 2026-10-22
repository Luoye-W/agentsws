#!/usr/bin/env node
/**
 * WP456-T8（助理 + 首页收尾）：浅 / 深各拍一套（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），拍四样：
 * - `1-assistant-empty`：助理，还没说过话；
 * - `2-assistant-thread`：助理，说过几句（模型用 demo 自带的「Agents 工坊（用积分）」替身，不出网）；
 *   `2b-assistant-plus`：点开输入框的「+」（附件、加图、联网、公司资料都在里面）；
 * - `3-home`：首页，演示品牌（有数据）；
 * - `4-home-new`：首页，新加的一个品牌（走完首次设置、建了两个岗位，还没有任何数据）。
 *
 * 顺手查（`--no-check` 只拍不查）：
 * - 助理的输入框就是岗位页那一个（`matter-say`，贴在中栏底部的 `composer-dock` 里）；框外没有「联网搜索」「用公司资料回答」两颗描边小标；
 * - 助理右上角「记忆」等是顶栏图标钮（有 tooltip），不是文字按钮；
 * - 首页不出现决定卡；有收件箱那一行、关键数字、岗位概况；节标题是共用那一种；
 * - 卡没有描边；页面上没有小于 12px 的中文。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<页>.png`；`--prefix before` 拍改前。
 * 给了 `--mockups <示意稿目录>` 时再出 `compare-<theme>-2-assistant-thread.png`（左：示意稿岗位页的完整对话框，右：实拍）；
 * 给了 `--before <目录>` 时出 `compare-<theme>-<页>.png`（左改前、右改后）。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp456t8-shots.mjs --port 4824 --out <目录> [--mockups <目录>] [--before <目录>] [--prefix before] [--no-check]
 * ```
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp456-t8'))
const MOCKUPS = argOf('--mockups') === undefined ? undefined : resolve(argOf('--mockups'))
const BEFORE = argOf('--before') === undefined ? undefined : resolve(argOf('--before'))
const PREFIX = argOf('--prefix') === undefined ? '' : `${argOf('--prefix')}-`
const PORT = Number(argOf('--port') ?? '4824') || 4824
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(method, path, body, token, asg) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', { email })
  return (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
}

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

const shotPath = (theme, name) => join(SHOTS, `${PREFIX}${theme}-${name}.png`)
const shot = async (page, theme, name, opts = {}) => {
  await page.waitForTimeout(1200)
  await page.screenshot({ path: shotPath(theme, name), ...opts })
  console.log(`  📷 ${PREFIX}${theme}-${name}.png`)
}

/** 这一屏上字号小于 12px、又含中文的可见文字。 */
const tinyChinese = (page) =>
  page.evaluate(() => {
    const out = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      if (!/[一-鿿]/.test(text)) continue
      const el = n.parentElement
      if (el === null || el.closest('[aria-hidden="true"], svg') !== null) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (Number.parseFloat(style.fontSize) < 12) out.push(text.trim().slice(0, 16))
    }
    return out
  })

/** 选得到的元素里，上边框不是 0 的有几个。 */
const bordered = (page, selector) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter(
        (el) => getComputedStyle(el).borderTopWidth !== '0px',
      ).length,
    selector,
  )

async function checkAssistant(page, theme, where) {
  const dock = page.locator('[data-testid="composer-dock"] [data-testid="matter-say"]')
  check((await dock.count()) === 1, `[${theme}] ${where}：输入框是岗位页那一个（贴底的完整对话框）`)
  check(
    (await page.getByTestId('free-chat-web-toggle').count()) === 0,
    `[${theme}] ${where}：框外没有「联网搜索」那颗描边小标`,
  )
  const memory = page.getByTestId('assistant-memory')
  const memoryText = (await memory.innerText().catch(() => '')).trim()
  const memoryTitle = await memory.getAttribute('title').catch(() => null)
  check(
    memoryText === '' && memoryTitle !== null && memoryTitle !== '',
    `[${theme}] ${where}：「记忆」是图标钮 + tooltip`,
  )
  const inTop = await page
    .locator('[data-testid="top-bar"] [data-testid="assistant-memory"]')
    .count()
  check(inTop === 1, `[${theme}] ${where}：「记忆」在顶栏右边那排图标里`)
}

async function checkHome(page, theme, where) {
  check((await page.getByTestId('deck-card').count()) === 0, `[${theme}] ${where}：没有决定卡`)
  check((await page.locator('.ws-dcard').count()) === 0, `[${theme}] ${where}：没有决定卡外壳`)
  check(
    (await page.getByTestId('home-inbox-line').count()) === 1,
    `[${theme}] ${where}：收件箱那一行`,
  )
  check((await page.getByTestId('home-key').count()) === 1, `[${theme}] ${where}：关键数字`)
  check((await page.getByTestId('position-cards').count()) === 1, `[${theme}] ${where}：岗位概况`)
  const heads = await page.locator('[data-testid="home"] .ws-sec-head').count()
  check(heads >= 2, `[${theme}] ${where}：节标题用共用件（${heads} 个）`)
  const cardBorders = await bordered(
    page,
    '[data-testid="home"] .ws-card, [data-testid="position-card"]',
  )
  check(cardBorders === 0, `[${theme}] ${where}：卡没有描边`)
  const tileButtons = await page.locator('[data-testid="position-card"] button.bg-ws-brand').count()
  check(tileButtons === 0, `[${theme}] ${where}：岗位卡上没有主按钮（整卡可点）`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    reportHistory: true,
    now: Date.parse('2026-10-18T07:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const owner = await login(OWNER)
    const me = await call('GET', '/v1/me', undefined, owner)
    const ownerAsg = me.assignments.find((a) => a.role_id === 'common.owner')?.id

    // 新品牌：建一个、切过去（换一张绑它的会话）、照推荐建两个岗位（走完首次设置）
    const orgs = await call('GET', '/v1/orgs', undefined, owner, ownerAsg)
    const org = orgs[0]
    const brand = await call(
      'POST',
      `/v1/orgs/${org.id}/brands`,
      { name: 'Lumo Home', vertical: 'goods' },
      owner,
      ownerAsg,
    )
    const switched = await call(
      'POST',
      `/v1/orgs/${org.id}/brands/${brand.workspace_id ?? brand.id}/switch`,
      undefined,
      owner,
      ownerAsg,
    )
    const fresh = switched.session_token
    const freshMe = await call('GET', '/v1/me', undefined, fresh)
    const freshAsg = freshMe.assignments.find((a) => a.role_id === 'common.owner')?.id
    const plan = await call(
      'POST',
      '/v1/onboarding/suggest',
      { text: '我们卖家居小电器，有独立站，要做网站客服和社媒运营' },
      fresh,
      freshAsg,
    )
    await call(
      'POST',
      '/v1/onboarding/apply',
      { position_ids: [], role_ids: [], positions: plan.positions.slice(0, 3) },
      fresh,
      freshAsg,
    )
    console.log(
      `  · 新品牌 ${brand.workspace_id ?? brand.id}：建了 ${plan.positions.slice(0, 3).length} 个岗位`,
    )

    const open = async (theme, token) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
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
      return { context, page }
    }

    const common = async (page, theme, name) => {
      const tiny = await tinyChinese(page)
      check(
        tiny.length === 0,
        `[${theme}] ${name} 没有小于 12px 的中文${tiny.length > 0 ? `（${tiny.slice(0, 6).join('、')}）` : ''}`,
      )
    }

    // ① 助理：还没说过话（两种主题都先拍空的，再说话）
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, owner)
      await page.goto(`${BASE}/assistant`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('free-chat-empty').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await common(page, theme, '1-assistant-empty')
      if (PREFIX === '') await checkAssistant(page, theme, '助理（空）')
      await shot(page, theme, '1-assistant-empty')
      await context.close()
    }

    // 关联 demo 的替身云、启用「Agents 工坊（用积分）」，用接口说几句
    await call('POST', '/v1/cloud/account/link', { email: 'boss@example.com' }, owner, ownerAsg)
    for (let i = 0; i < 50; i += 1) {
      const acct = await call('GET', '/v1/cloud/account', undefined, owner, ownerAsg)
      if (acct.linked === true) break
      await new Promise((r) => setTimeout(r, 200))
    }
    await call(
      'PUT',
      '/v1/models/providers/agentsws',
      { kind: 'agentsws_cloud', model: 'deepseek-flash' },
      owner,
      ownerAsg,
    ).catch((e) => console.error(`  ⚠️ 启用云模型：${e.message}`))
    const models = await call('GET', '/v1/free-chat/models', undefined, owner, ownerAsg)
    const model = (models.choices.find((c) => c.official) ?? models.choices[0])?.id
    const thread = await call('GET', '/v1/free-chat/thread', undefined, owner, ownerAsg)
    const say = async (text) => {
      const res = await fetch(`${BASE}/v1/free-chat/sessions/${thread.session.id}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${owner}`,
          'x-assignment': ownerAsg,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text, ...(model === undefined ? {} : { model }) }),
      })
      await res.text()
    }
    await say('退货期限以后统一定 30 天，包邮门槛 99 元')
    await say('帮我想三个 USB-C 充电器的新品名字')
    await say('今天有什么要我处理的？')
    await new Promise((r) => setTimeout(r, 1500))

    for (const theme of ['light', 'dark']) {
      const { context, page } = await open(theme, owner)
      // ② 助理：有对话
      await page.goto(`${BASE}/assistant`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('free-chat-messages').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1500)
      await common(page, theme, '2-assistant-thread')
      if (PREFIX === '') await checkAssistant(page, theme, '助理（有对话）')
      await shot(page, theme, '2-assistant-thread')
      if (PREFIX === '') {
        await page.getByTestId('matter-attach').click()
        const menu = page.getByTestId('composer-plus-menu')
        const ok = await menu
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
        check(ok, `[${theme}] 「+」里有附件 / 加图 / 联网 / 公司资料`)
        await shot(page, theme, '2b-assistant-plus')
        // 打开联网：框里出一颗小标
        await page.getByTestId('composer-plus-web').click()
        await page.waitForTimeout(400)
        check(
          (await page
            .locator('[data-testid="matter-say"] [data-testid="assistant-toggle-chip"]')
            .count()) >= 1,
          `[${theme}] 联网开着时在框里是一颗小标`,
        )
        await shot(page, theme, '2c-assistant-web-on')
      }

      // ③ 首页：演示品牌（有数据）
      await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('home').waitFor({ timeout: 60_000 })
      await page
        .getByTestId('home-key-card')
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined)
      await page.waitForTimeout(1500)
      await common(page, theme, '3-home')
      if (PREFIX === '') await checkHome(page, theme, '首页（有数据）')
      await shot(page, theme, '3-home')
      await shot(page, theme, '3b-home-full', { fullPage: true })
      await context.close()

      // ④ 首页：新品牌
      const fresh2 = await open(theme, fresh)
      await fresh2.page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 90_000 })
      await fresh2.page.getByTestId('home').waitFor({ timeout: 60_000 })
      await fresh2.page.waitForTimeout(2000)
      await common(fresh2.page, theme, '4-home-new')
      if (PREFIX === '') await checkHome(fresh2.page, theme, '首页（新品牌）')
      await shot(fresh2.page, theme, '4-home-new')
      await fresh2.context.close()
    }

    // 并排：左示意稿（岗位页的完整对话框）/ 左改前，右实拍
    const pairs = []
    for (const theme of ['light', 'dark']) {
      if (MOCKUPS !== undefined)
        pairs.push({
          left: join(MOCKUPS, `after-${theme}-1-position.png`),
          right: shotPath(theme, '2-assistant-thread'),
          out: `compare-mock-${theme}-2-assistant-thread.png`,
        })
      if (BEFORE !== undefined)
        for (const name of ['1-assistant-empty', '2-assistant-thread', '3-home', '4-home-new'])
          pairs.push({
            left: join(BEFORE, `before-${theme}-${name}.png`),
            right: shotPath(theme, name),
            out: `compare-${theme}-${name}.png`,
          })
    }
    if (pairs.length > 0) {
      const context = await browser.newContext({ viewport: { width: 2880, height: 900 } })
      const page = await context.newPage()
      for (const p of pairs) {
        if (!existsSync(p.left) || !existsSync(p.right)) continue
        const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`
        await page.setContent(
          `<body style="margin:0;display:flex;gap:16px;background:#888"><img src="${img(p.left)}" style="width:1432px"><img src="${img(p.right)}" style="width:1432px"></body>`,
        )
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(SHOTS, p.out), fullPage: true })
        console.log(`  📷 ${p.out}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
