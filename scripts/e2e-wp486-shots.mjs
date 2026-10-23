#!/usr/bin/env node
/**
 * WP486：「昨天学到的」卡说清来龙去脉 + 「证据」改「详情」+ 卡上 → 不再是死按钮——浅 / 深各拍一套
 * （不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），然后照 Luoye 10-23 的路子走一遍：
 * - Reddit 运营岗位上两张回帖卡**光点「不要」**（不写理由）→ 第二天出卡：**一张都不出**（原来出「加一条 不要」）；
 * - 再两张回帖卡点「不要」并写了理由 → 第二天出一张「昨天学到的」：正文点名那两张卡、说你做了什么；
 * - 卡头写「详情 N」；点它右栏列出攒出这条的两次纠正（时间、卡名、理由，链到那张卡），不出「无权查看」；
 * - 卡右下角 →：这张卡没有事项，点了打开「详情」（不是没反应）。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<序号>-<什么>.png`。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp486-shots.mjs --port 4932 --out <目录> [--no-check]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp486'))
const PORT = Number(argOf('--port') ?? '4932') || 4932
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const WIDTH = 1280
const HEIGHT = 860
const REASON = '回帖里别写 DM us，社区规则不许拉私信，就在帖子里答'

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

const shot = async (page, theme, name, opts = {}) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(SHOTS, `${theme}-${name}.png`), ...opts })
  console.log(`  📷 ${theme}-${name}.png`)
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
    now: Date.parse('2026-10-22T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const server = demo.server
    const ws = server.bootstrap.workspace.id
    const person_id = server.bootstrap.person.id
    const owner = await login(OWNER)
    const reddit = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .find((a) => a.role_id === 'social.reddit' && a.revoked_at === undefined)
    if (reddit === undefined) throw new Error('演示世界里没有 Reddit 运营这条职责')
    const brand = await server.brands.forWorkspace(ws)
    const actor = {
      workspace_id: ws,
      person_id,
      assignment_id: reddit.id,
      role_id: 'social.reddit',
    }
    const stage = async (post, title) => {
      const out = await brand.redditWrites.stage(actor, {
        target: {
          kind: 'comment',
          subreddit: 'nordvolt',
          parent_fullname: `t3_${post}`,
          permalink: `/r/nordvolt/comments/${post}/x/`,
          post_title: title,
          parent_author: 'dan',
        },
        text: 'Great question! DM us and we will sort it out for you.',
        reason: '自家版块用户提问，要回',
      })
      if (!out.staged) throw new Error(out.message)
      return out.approval_item_id
    }

    // ① 两张光点「不要」：第二天什么都不出
    for (const [post, title] of [
      ['b1', 'Charger gets warm after an hour'],
      ['b2', 'Does the 20000mAh fit in carry-on?'],
    ]) {
      const id = await stage(post, title)
      await call('POST', `/v1/approvals/${id}/decide`, { action: 'reject' }, owner, reddit.id)
    }
    const bare = await server.learning.proposeDailyFor(ws, '2026-10-22T23:30:00.000Z')
    check(bare.created.length === 0, '两张卡光点「不要」：第二天一张「学到」都不出')

    // ② 两张点「不要」并写了理由
    for (const [post, title] of [
      ['r1', 'Which cable for the 65W charger?'],
      ['r2', 'Warranty claim — where do I start?'],
    ]) {
      const id = await stage(post, title)
      await call(
        'POST',
        `/v1/approvals/${id}/decide`,
        { action: 'reject', reason: REASON },
        owner,
        reddit.id,
      )
    }
    const made = await server.learning.proposeDailyFor(ws, '2026-10-23T07:30:00.000Z')
    check(made.created.length === 1, '两次写了理由：第二天出一张「昨天学到的」')
    const cardId = made.created[0]
    if (cardId === undefined) throw new Error('没出卡，拍不了')
    const ownerAsg = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .find((a) => a.role_id === 'common.owner' && a.revoked_at === undefined)
    const item = await call('GET', `/v1/approvals/${cardId}`, undefined, owner, ownerAsg?.id)
    check(
      item?.summary?.includes('Which cable') &&
        item.summary.includes('Warranty') &&
        item.summary.includes(REASON),
      `卡正文点名那两张卡、说了理由：${item?.summary}`,
    )

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
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
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/cards/${cardId}`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('deck-card').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(1200)
      const pill = (await page.getByTestId('deck-evidence').innerText()).trim()
      check(/^详情/.test(pill) && !pill.includes('证据'), `[${theme}] 卡头写「${pill}」`)
      await shot(page, theme, '1-lesson-card')

      // 卡右下角 →：没有事项 → 打开详情
      await page.getByTestId('ws-go').click()
      await page.getByTestId('rail-evidence').waitFor({ timeout: 20_000 })
      const sources = await page.getByTestId('rail-evidence-source').count()
      check(sources === 2, `[${theme}] 点 → 打开详情：列出攒出这条的 ${sources} 次纠正`)
      const text = await page.getByTestId('rail-evidence').innerText()
      check(!text.includes('无权'), `[${theme}] 本人看自己的卡：没有「无权查看」`)
      check(text.includes('Which cable'), `[${theme}] 详情里写着来源卡名`)
      await shot(page, theme, '2-details-panel')
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
