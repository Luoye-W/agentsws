#!/usr/bin/env node
/**
 * WP491（Luoye 10-23）：社媒岗位上 Reddit「没发出去」那一行——「修改」还原成原卡重走审核、「再填一次」按选路走 ego。
 * 浅 / 深各拍一套，顺手查几件事（不通过退出码 1；`--no-check` 只拍不查）。
 *
 * 本进程里起一个服务进程（临时数据目录，跑完删掉），托管工作台构建产物。**不联网、不接 AI、不碰 4317、不起 ego、
 * 不碰任何真社媒网站**：ego 是塞进去的假手（按剧本隔几秒回「发出去了」），插件是本机内存那一份动作通道（替身插件）。
 * 帖子与评论全是现编的（品牌 BlueLamp，r/bluelamp）。
 *
 * 1. 两条批过的回复交给替身插件、都没发出去 → 岗位页两行「没发出去」；
 * 2. 第一行点「修改」→ 那一行收起，卡片流里出原来那张卡（带上次的字，ego 能用 →「批准并发出」）→ 改字、批 →
 *    过了取消窗口工坊在（假）ego 里发出去；
 * 3. 第二行点「再填一次」→ 按钮「在发…」→ 那一行「正在 ego 里发」→「发出去了」；
 * 4. ego 没打开时再填一次 → 那一行「已交给浏览器插件」+ 一句原因。
 *
 * ```
 * npx tsc -b && pnpm -F @agentsws/workstation exec vite build   # 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp491-shots.mjs --port 4958 --out <目录> [--no-check]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp491'))
const PORT = Number(argOf('--port') ?? '4958') || 4958
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
mkdirSync(SHOTS, { recursive: true })
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'lan@bluelamp.example'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.log(`  ❌ ${what}`)
  }
}

/** 时钟往前拨（过取消窗口用）。 */
let offset = 0
/** 假 ego：`on` = 这会儿能不能用；跑一趟隔 `delay` 毫秒回「发出去了」（只在这个进程的内存里，什么都没发）。 */
const ego = { on: false, delay: 4_000, calls: [] }
const egoWriter = {
  available: () => ego.on,
  wanted: () => true,
  run: async (cfg) => {
    ego.calls.push(cfg)
    await sleep(ego.delay)
    const id = `e${ego.calls.length}`
    return {
      platform: cfg.platform,
      state: 'sent',
      external_id: `t1_${id}`,
      link: `https://www.reddit.com/r/bluelamp/comments/abc/charging_time/${id}/`,
      readback: 'link',
      clicked: true,
    }
  },
}

const { createServer } = await import(join(ROOT, 'apps/server/dist/index.js'))
const dataDir = mkdtempSync(join(tmpdir(), 'agentsws-wp491-shots-'))
const server = await createServer({
  quiet: true,
  startRun: false,
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  port: PORT,
  dbDir: dataDir,
  staticDir: join(ROOT, 'apps/workstation/dist'),
  clock: { now: () => new Date(Date.now() + offset).toISOString() },
  env: { AGENTSWS_OWNER_EMAIL: OWNER },
  egoWriter,
  mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
})

let asg
const call = async (method, path, body) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  if (asg !== undefined) headers.set('X-Assignment', asg)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function approve(id) {
  const fresh = await server.txn.approvals.get(id)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
}

/** 出卡 → 批 → 过取消窗口交给替身插件 → 人在插件里打开 → 插件回一个没发出去的结局。 */
async function failOne(brand, target, text, outcome, message) {
  const staged = await call('POST', '/v1/social/reddit/stage', { target, text })
  await approve(staged.approval_item_id)
  offset += 125_000
  await brand.redditWrites.sweep()
  const row = brand.redditWrites
    .writes()
    .find((w) => w.approval_item_id === staged.approval_item_id)
  const got = await brand.redditWrites.open(row.job_id)
  brand.adsActions.result(got.job.id, { outcome, message, step: 6, reads: {} })
  return staged.approval_item_id
}

async function main() {
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  await server.listen(PORT)
  await server.identity.renamePerson(server.bootstrap.person.id, '蓝蓝')
  asg = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: 'social.reddit',
  }).id
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  await brand.adsActions.next(['reddit'], 0)
  const thread = '/r/bluelamp/comments/abc/charging_time/'
  const apA = await failOne(
    brand,
    {
      kind: 'reply',
      subreddit: 'bluelamp',
      parent_fullname: 't1_c1',
      permalink: `${thread}c1/`,
      post_title: 'Can I use it while charging?',
      parent_author: 'maple_tree',
      parent_text: 'Does the lamp work while it is plugged in? I read in bed a lot.',
    },
    'Hi maple_tree, yes, it works while plugged in, so night reading is fine.',
    'stopped',
    '你点了停止，已停下。',
  )
  await failOne(
    brand,
    {
      kind: 'reply',
      subreddit: 'bluelamp',
      parent_fullname: 't1_c2',
      permalink: `${thread}c2/`,
      post_title: 'Can I use it while charging?',
      parent_author: 'river_fox',
      parent_text: 'How long does a full charge take?',
    },
    'Hi river_fox, about three hours from empty with the cable in the box.',
    'handover',
    'Chrome 里的 Reddit 没登录（或登录掉了）。',
  )

  const link = await call('POST', '/v1/auth/magic-link', { email: OWNER })
  const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
  const browser = await chromium.launch({ headless: true })

  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    })
    await context.addInitScript(
      ([t, th]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
        } catch {}
      },
      [token, theme],
    )
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const shot = async (name, clip = { x: 0, y: 0, width: 1280, height: 560 }) => {
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`), clip })
      console.log(`  📷 ${theme}-${name}.png`)
    }
    /** 进社媒岗位（新进程首次打开有初始化设置，先跳过）。 */
    const enter = async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page
        .getByText('先跳过')
        .click({ timeout: 5_000 })
        .catch(() => undefined)
      await page.getByText('社媒运营').first().click()
      await page.waitForLoadState('networkidle')
    }
    await enter()
    const rows = page.locator('[data-testid="reddit-write-notice-row"]')
    await rows.first().waitFor({ timeout: 30_000 })

    if (theme === 'light') {
      check((await rows.count()) === 2, '两条没发出去 → 两行')
      await shot('1-failed-rows')

      // ── 2.「修改」→ 原卡 ──
      ego.on = true
      const rowA = rows.filter({ hasText: 'maple_tree' })
      await rowA.getByTestId('reddit-write-edit').click()
      await rowA.waitFor({ state: 'detached', timeout: 10_000 })
      check(true, '点「修改」后那一行收起')
      check((await page.getByTestId('reddit-write-edit-text').count()) === 0, '不再就地摊开改字框')
      const card = page.locator('[data-testid="deck-reddit-write"]').first()
      await card.waitFor({ timeout: 15_000 }).catch(async (e) => {
        await page.screenshot({ path: join(SHOTS, `debug-${theme}-no-card.png`), fullPage: true })
        throw e
      })
      const box = card.getByTestId('reddit-write-text')
      check(
        (await box.inputValue()) ===
          'Hi maple_tree, yes, it works while plugged in, so night reading is fine.',
        '原卡带着上次的字',
      )
      await card.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${theme}-2-revised-card.png`) })
      console.log(`  📷 ${theme}-2-revised-card.png`)
      const send = page.getByTestId('reddit-write-send').first()
      check(
        (await send.textContent()) === '批准并发出',
        `ego 能用：卡上按钮「批准并发出」（${await send.textContent()}）`,
      )
      await box.fill(
        'Hi maple_tree, yes, it works while plugged in. Night reading is fine, and the warm mode is easier on the eyes.',
      )
      await send.click()
      await page.waitForTimeout(800)
      await page.screenshot({ path: join(SHOTS, `${theme}-3-revised-approved.png`) })
      console.log(`  📷 ${theme}-3-revised-approved.png`)
      // 过了取消窗口：工坊在（假）ego 里发
      offset += 125_000
      ego.delay = 200
      await brand.redditWrites.sweep()
      await brand.redditWrites.idle()
      const sentA = brand.redditWrites
        .writes()
        .find((w) => w.approval_item_id !== apA && w.state === 'sent')
      check(
        sentA?.route === 'ego' && /warm mode/u.test(ego.calls.at(-1)?.text ?? ''),
        '改过的字批了 → 工坊在 ego 里发出去（假 ego）',
      )

      // ── 3.「再填一次」→ ego ──
      ego.delay = 6_000
      await page.route('**/refill', async (r) => {
        await sleep(1_500)
        await r.continue()
      })
      const rowB = rows.filter({ hasText: 'river_fox' })
      await rowB.getByTestId('reddit-write-refill').click()
      await page.waitForTimeout(300)
      check(
        (await rowB.getByTestId('reddit-write-refill').textContent()) === '在发…',
        '点了按钮进「在发…」',
      )
      await shot('4-refill-pending')
      const going = page.getByTestId('reddit-write-going').first()
      await going.waitFor({ timeout: 10_000 })
      check((await going.getAttribute('data-route')) === 'ego', '那一行说正在 ego 里发')
      await shot('5-refill-ego')
      await page.unroute('**/refill')
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="reddit-write-going"]')
            ?.getAttribute('data-state') === 'sent',
        undefined,
        { timeout: 30_000 },
      )
      check(true, '发出去了照实变')
      await shot('6-refill-sent')
      await page.getByTestId('reddit-write-going-close').click()

      // ── 4. ego 没打开 → 交给插件、照实一句 ──
      ego.on = false
      await failOne(
        brand,
        {
          kind: 'reply',
          subreddit: 'bluelamp',
          parent_fullname: 't1_c3',
          permalink: `${thread}c3/`,
          post_title: 'Can I use it while charging?',
          parent_author: 'oak_leaf',
          parent_text: 'Is the cable USB-C?',
        },
        'Hi oak_leaf, yes, USB-C on both ends.',
        'stopped',
        '你点了停止，已停下。',
      )
      await enter()
      const rowC = page.locator('[data-testid="reddit-write-notice-row"]', { hasText: 'oak_leaf' })
      await rowC.waitFor({ timeout: 30_000 }).catch(async (e) => {
        await page.screenshot({ path: join(SHOTS, `debug-${theme}-no-row.png`), fullPage: true })
        throw e
      })
      await rowC.getByTestId('reddit-write-refill').click()
      const plug = page.getByTestId('reddit-write-going').first()
      await plug.waitFor({ timeout: 10_000 })
      const plugText = (await plug.textContent()) ?? ''
      check(
        (await plug.getAttribute('data-route')) === 'plugin' &&
          /ego 这会儿用不了，这一次改交给插件/u.test(plugText),
        `ego 没打开：交给插件、照实一句（${plugText}）`,
      )
      await shot('7-refill-plugin')
    } else {
      // 深色先拍、只拍「没发出去」那两行（浅色那一轮再把流程走完）
      await shot('1-failed-rows')
    }
    await context.close()
  }
  await browser.close()
}

try {
  await main()
} finally {
  await server.close().catch(() => {})
  rmSync(dataDir, { recursive: true, force: true })
}
if (failed) process.exit(1)
