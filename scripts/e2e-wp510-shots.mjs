#!/usr/bin/env node
/**
 * WP510（决策 1515）：同事 / 公司模式的收件箱——两个假用户端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317）。
 *
 * demo 里本来就是 ② 同事互联（王岚 + 陈晓，李默已离职）。用 Playwright 开两个浏览器（两个人各登各的）：
 *
 * 1. 王岚把 hello@ 这只邮箱的负责人指给陈晓（「分工」）→ 这只邮箱的信和那张「Sophie Laurent 还没回」催促卡
 *    只进陈晓的「给我的」，王岚的「给我的」里没有了，「全部」里写「给陈晓」；
 * 2. 陈晓在「全部」里打开王岚的一张卡 → 王岚那一行出「陈晓在看」；陈晓关掉 → 没了；
 * 3. 陈晓「不要」那张催促卡 → 王岚右栏「刚处理」写「陈晓不要了…」（处理留名）；
 * 4. 时钟往后拨 4 天（陈晓一直没上线）→ 他那只邮箱的信转给王岚，行上「陈晓不在，转给你」；
 * 5. 开公司模式（王岚是老板）→ 陈晓的「分工」只能看、不能改；「在看」照旧；
 * 6. ① 个人（另起一个 demo，把两位同事请走）：没有任何团队的字，不跳心跳；给了 `--base <main 的仓库根>`
 *    就用同一个脚本拍改前那一版，逐像素比一遍（「与改前一致」）。
 *
 * 截图（`--out`；审稿截图放私有仓，别提交进公开仓），浅 / 深各一套：
 * `{theme}-a1-mine.png`（王岚 · 给我的）、`-a2-all.png`（全部 + 陈晓在看）、`-a3-team.png`（分工）、
 * `-b1-mine.png`（陈晓 · 给我的：信 + 催促卡）、`-b2-open.png`（陈晓打开王岚的卡：只看）、`-a4-handled.png`、
 * `-a5-fallback.png`、`-b3-company.png`（公司模式里陈晓的分工只读）、`-solo-list.png` / `-solo-focus.png`
 * （+ `-solo-*-base.png`）。
 *
 * ```
 * npx tsc -b && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp510-shots.mjs --out <目录> [--port 5102] [--base <main 的仓库根>]
 * ```
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp510'))
const PORT = Number(argOf('--port') ?? '5102') || 5102
const BASE_ROOT = argOf('--base') === undefined ? undefined : resolve(argOf('--base'))
for (const p of [PORT, PORT + 1, PORT + 2, PORT + 3])
  if (p === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const WANG = 'wang@nordvolt.example'
const CHEN = 'chen@nordvolt.example'
const MAILBOX = 'hello@luminous-lab.example'
const NOW = Date.parse('2026-10-22T01:30:00Z')
const DAY = 86_400_000

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}

function client(base) {
  return async function call(method, path, body, token, assignment) {
    const headers = { 'content-type': 'application/json' }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    if (assignment !== undefined) headers['x-assignment'] = assignment
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
    return json.data
  }
}

async function startDemo(root, port) {
  const { createDemo } = await import(pathToFileURL(join(root, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root, port, quiet: true, now: NOW })
  await demo.server.listen()
  const base = `http://127.0.0.1:${port}`
  const call = client(base)
  const login = async (email) => {
    const link = await call('POST', '/v1/auth/magic-link', { email })
    const token = (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
    const me = await call('GET', '/v1/me', undefined, token)
    // 有岗位就用岗位那一条（底座那条没有批准权）
    const asgs = me.assignments ?? []
    const asg = (asgs.find((a) => !String(a.role_id).startsWith('common.')) ?? asgs[0])?.id
    return { token, asg, all: asgs.map((a) => a.id), id: me.person?.id }
  }
  return { demo, base, call, login }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  const open = async (token, theme) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
      deviceScaleFactor: 2,
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
    const beats = []
    page.on('request', (r) => {
      if (r.url().includes('/v1/inbox/presence')) beats.push(r.postData() ?? '')
    })
    return { context, page, beats }
  }
  const shot = async (page, name) => {
    await page.waitForTimeout(700)
    const path = join(SHOTS, `${name}.png`)
    await page.screenshot({ path })
    console.log(`  📷 ${name}.png`)
    return path
  }

  try {
    /* ── ② / ③：两个人 ─────────────────────────────────────────────── */
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}：② 同事互联，两个人`)
      // 浅 / 深各起一个 demo（各用一个端口：5102 / 5103；① 用 5104，改前那一版 5105）
      const { demo, base, call, login } = await startDemo(ROOT, theme === 'light' ? PORT : PORT + 1)
      try {
        const wang = await login(WANG)
        const chen0 = await login(CHEN)
        // 陈晓做客服（demo 里他只有底座那一条、批不了卡）；用王岚能分岗位的那一条分配
        let assigned = false
        for (const a of wang.all) {
          if (assigned) break
          assigned = await call(
            'POST',
            '/v1/assignments',
            {
              person_id: chen0.id,
              position_id: 'customer-care',
              ranges: [{ kind: 'brand', id: demo.world.workspace_id }],
            },
            wang.token,
            a,
          )
            .then(() => true)
            .catch(() => false)
        }
        check(assigned, '陈晓分到客服岗位')
        const chen = await login(CHEN)
        const team0 = await call('GET', '/v1/inbox/team', undefined, wang.token, wang.asg)
        check(team0.mode === 'peers', `demo 是 ② 同事互联（${team0.mode}）`)
        await call(
          'PUT',
          '/v1/inbox/team',
          { mailbox: { account: MAILBOX, owners: [chen.id] } },
          wang.token,
          wang.asg,
        )
        const inboxOf = (who, scope) =>
          call(
            'GET',
            `/v1/inbox${scope === 'all' ? '?scope=all' : ''}`,
            undefined,
            who.token,
            who.asg,
          )
        const wMine = await inboxOf(wang)
        const cMine = await inboxOf(chen)
        const nudge = (v) => v.items.find((i) => i.card?.title?.includes('还没回'))
        check(nudge(wMine) === undefined, '催促卡不在王岚的「给我的」里')
        check(nudge(cMine) !== undefined, '催促卡在负责人陈晓的「给我的」里')
        check(
          wMine.items.every((i) => i.type !== 'mail' || i.mail?.account !== MAILBOX),
          '这只邮箱的信不在王岚的「给我的」里',
        )
        const wAll = await inboxOf(wang, 'all')
        const nAll = nudge(wAll)
        check(
          nAll?.mine === false && nAll.owners?.[0]?.name === '陈晓',
          '王岚的「全部」里有催促卡，写着给陈晓',
        )

        const A = await open(wang.token, theme)
        const B = await open(chen.token, theme)
        // 陈晓 · 给我的
        await B.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
        await B.page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
        await shot(B.page, `${theme}-b1-mine`)
        // 王岚 · 给我的
        await A.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
        await A.page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
        check((await A.page.getByTestId('inbox-scope').count()) === 1, '页头有「给我的 / 全部」')
        await shot(A.page, `${theme}-a1-mine`)

        // 陈晓在「全部」里打开王岚的一张卡 → 王岚那一行出「陈晓在看」
        const target = wMine.items.find(
          (i) => i.type === 'card' && !i.card?.title?.includes('还没回'),
        )
        await B.page.goto(`${base}/inbox?mode=list&scope=all`, { waitUntil: 'load' })
        await B.page.locator(`[data-testid="inbox-row"][data-id="${target.id}"]`).click()
        await B.page
          .locator(`[data-testid="inbox-pane"][data-id="${target.id}"]`)
          .waitFor({ timeout: 15_000 })
        check(
          (await B.page.locator('[data-testid="inbox-owner"][data-kind="others"]').count()) > 0,
          '陈晓打开的是王岚的卡：写着给王岚、只看',
        )
        await shot(B.page, `${theme}-b2-open`)
        await A.page.goto(`${base}/inbox?mode=list&scope=all`, { waitUntil: 'load' })
        const viewing = A.page.locator(
          `[data-testid="inbox-row"][data-id="${target.id}"] [data-testid="inbox-viewing"]`,
        )
        const seen = await viewing
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false)
        check(
          seen && (await viewing.textContent())?.includes('陈晓在看'),
          '王岚那一行出「陈晓在看」',
        )
        await shot(A.page, `${theme}-a2-all`)
        // 陈晓离开收件箱（整页换走：关页面那一下用 keepalive 送出）→ 没了
        await B.page.goto(`${base}/`, { waitUntil: 'load' })
        const gone = await viewing
          .waitFor({ state: 'detached', timeout: 15_000 })
          .then(() => true)
          .catch(() => false)
        check(gone, '陈晓离开收件箱，「在看」消失')

        // 分工
        await A.page.getByTestId('inbox-team-button').click()
        await A.page.getByTestId('inbox-team-panel').waitFor({ timeout: 10_000 })
        await A.page.getByTestId('inbox-team-mailbox').first().waitFor({ timeout: 10_000 })
        await shot(A.page, `${theme}-a3-team`)
        await A.page.keyboard.press('Escape')

        /*
         * 陈晓「不要」一张发给他的卡 → 王岚「刚处理」写他（处理留名）。
         * demo 的演示账本只认场景里写好的人能批（陈晓不在场景名单上），所以这张卡落在服务进程自己的账本上。
         */
        const card = await demo.server.txn.approvals.create({
          workspace_id: demo.world.workspace_id,
          schema_version: 1,
          kind: 'home_suggestion',
          role_id: 'dtc.support',
          subject: { object: { type: 'thread', id: 'thr_wp510_demo' } },
          dedupe_key: `wp510:${theme}`,
          title: '给 Sam Lee 寄 3 件样品？',
          summary: '三家门店问能不能寄样品',
          payload: {},
          evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
          proposer: { kind: 'system', id: 'demo' },
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [{ person: chen.id, via: 'role_holder' }],
            rule: 'role_holder',
            escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
        await call(
          'POST',
          `/v1/approvals/${card.id}/decide`,
          { action: 'reject', reason: '先等对方报数量' },
          chen.token,
          chen.asg,
        )
        await A.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load' })
        const handled = A.page.getByTestId('inbox-handled')
        await handled.waitFor({ timeout: 15_000 })
        check(
          (await handled.textContent())?.includes('陈晓不要了'),
          '王岚「刚处理」：陈晓不要了发给他的那张卡（处理留名）',
        )
        await shot(A.page, `${theme}-a4-handled`)
        await B.context.close()

        // 陈晓 4 天没上线 → 他那只邮箱的信转给王岚
        demo.world.clock.advance(4 * DAY)
        await A.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load' })
        const fb = A.page.locator('[data-testid="inbox-owner"][data-kind="fallback"]').first()
        const fbOk = await fb
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false)
        check(
          fbOk && (await fb.textContent())?.includes('陈晓不在，转给你'),
          '负责人不在：信转给王岚，写着为什么',
        )
        await shot(A.page, `${theme}-a5-fallback`)
        await A.context.close()

        // ③ 公司模式：王岚是老板；陈晓的分工只读
        const org = (await call('GET', '/v1/orgs', undefined, wang.token, wang.asg))[0]
        let company = false
        for (const a of wang.all) {
          if (company) break
          company = await call(
            'PUT',
            `/v1/orgs/${org.id}/mode`,
            { mode: 'company', legal_name: 'Luminous Lab Ltd.' },
            wang.token,
            a,
          )
            .then(() => true)
            .catch(() => false)
        }
        check(company, '开了公司模式（王岚是老板）')
        const chen2 = await login(CHEN)
        // 公司模式里陈晓不是管理员
        const tv = await call('GET', '/v1/inbox/team', undefined, chen2.token, chen2.asg)
        check(tv.mode === 'company' && tv.can_edit === false, '③ 公司模式：陈晓不能改分工')
        const C = await open(chen2.token, theme)
        await C.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
        await C.page.getByTestId('inbox-team-button').click()
        await C.page.getByTestId('inbox-team-readonly').waitFor({ timeout: 10_000 })
        await shot(C.page, `${theme}-b3-company`)
        await C.context.close()
      } finally {
        await demo.close()
      }
    }

    /* ── ① 个人：一个字都不多（和改前逐像素比） ───────────────────────── */
    const solo = async (root, port, tag) => {
      const { demo, base, login } = await startDemo(root, port)
      const out = {}
      try {
        for (const p of ['p_li', 'p_chen'])
          await demo.server.identity.leaveWorkspace(demo.world.workspace_id, p)
        const wang = await login(WANG)
        for (const theme of ['light', 'dark']) {
          const A = await open(wang.token, theme)
          await A.page.goto(`${base}/inbox?mode=list`, { waitUntil: 'load', timeout: 90_000 })
          await A.page.getByTestId('inbox-row').first().waitFor({ timeout: 30_000 })
          if (tag === '') {
            for (const id of [
              'inbox-scope',
              'inbox-team-button',
              'inbox-handled',
              'inbox-viewing',
              'inbox-owner',
            ])
              check((await A.page.getByTestId(id).count()) === 0, `① ${theme}：没有 ${id}`)
          }
          out[`${theme}-solo-list`] = await shot(A.page, `${theme}-solo-list${tag}`)
          await A.page.goto(`${base}/inbox`, { waitUntil: 'load' })
          await A.page.getByTestId('inbox-focus-card').waitFor({ timeout: 30_000 })
          out[`${theme}-solo-focus`] = await shot(A.page, `${theme}-solo-focus${tag}`)
          if (tag === '') check(A.beats.length === 0, `① ${theme}：不跳心跳`)
          await A.context.close()
        }
      } finally {
        await demo.close()
      }
      return out
    }
    console.log('── ① 个人')
    const mine = await solo(ROOT, PORT + 2, '')
    if (BASE_ROOT !== undefined) {
      console.log('── ① 个人（改前那一版）')
      const before = await solo(BASE_ROOT, PORT + 3, '-base')
      const sharp = require(join(ROOT, 'node_modules/.pnpm/node_modules/sharp'))
      const lines = []
      for (const key of Object.keys(mine)) {
        const [a, b] = await Promise.all(
          [mine[key], before[key]].map((p) => sharp(p).raw().toBuffer({ resolveWithObject: true })),
        )
        let diff = 0
        const n = Math.min(a.data.length, b.data.length)
        for (let i = 0; i < n; i += 4)
          if (
            Math.abs(a.data[i] - b.data[i]) > 8 ||
            Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 ||
            Math.abs(a.data[i + 2] - b.data[i + 2]) > 8
          )
            diff += 1
        const ratio = diff / (n / 4)
        lines.push(`${key}: ${(ratio * 100).toFixed(3)}% 像素不同（${diff} 个）`)
        check(
          a.info.width === b.info.width && ratio < 0.002,
          `① ${key} 与改前一致（${(ratio * 100).toFixed(3)}%）`,
        )
      }
      writeFileSync(join(SHOTS, 'solo-compare.txt'), `${lines.join('\n')}\n`)
    }
  } finally {
    await browser.close()
  }
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
