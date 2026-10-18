#!/usr/bin/env node
/**
 * WP414（Luoye 10-19 真机，Reddit 回信卡）：端到端走一遍 + 截图，可重跑（不联网、不接真 AI、不碰 4317、不连真 Reddit）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），给店主挂上 Reddit 运营职责，
 * 用替身出四张「发出去」卡：r/Smartphones 里三张同类（换手机的帖子，AI 判断都是「和我们无关」）+ 自家版块一张。
 *
 * **端到端**（浅色那一轮）：卡底是「修改 / 不发 / 稍后」按钮 → 否掉第一张（不写理由）→ 顶上一行「另外 2 张也一并不发了」
 * → 服务端那两张真的「不发」了、自家版块那张没动 → 点快捷理由「不相关」补记 → 撤回 → 那两张回到待处理。
 * 再起一组：在卡身里点「发送」→ 顶上只问「要一起发送吗」，服务端一张都没自动发。不通过就退出码 1。
 *
 * **截图**（`--out` 目录，默认 `docs/assets/wp414`；审稿截图放私有仓，别提交进公开仓）：
 * 1. `1-buttons-{light,dark}`：卡底「修改 / 不发 / 稍后」按钮（「发送」在卡身里）；
 * 2. `2-drop-follow-{light,dark}`：点「不发」之后：可选快捷理由 + 「另外 2 张也一并不发了 · 看是哪几张 · 撤回」；
 * 3. `3-follow-list-{light,dark}`：展开「看是哪几张」——每张写着为什么算同类；
 * 4. `4-undone-{light,dark}`：补了理由、撤回之后；
 * 5. `5-revise-{light,dark}`：点「修改」开的那个框（说一句怎么改，或贴素材）；
 * 6. `6-send-suggest-{light,dark}`：点「发送」之后「这 2 张和刚才那张类似，要一起发送吗？」。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp414-shots.mjs [--port 4414] [--out <目录>]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'docs/assets/wp414'))
const PORT = Number(argOf('--port') ?? '4414') || 4414
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const OFF_TOPIC = '换手机的帖子，和我们的智能眼镜无关，回了也没价值'

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.token })).session_token
}

const shot = async (page, name, target) => {
  await page.waitForTimeout(500)
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`  📷 ${name}.png`)
}

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
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
    now: Date.parse('2026-10-19T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const ws = demo.world.workspace_id
    const person = demo.world.roleHolder
    const held = demo.server.roles.assignments
      .listByPerson(person, { workspace_id: ws })
      .find((a) => a.role_id === 'social.reddit' && a.revoked_at === undefined)
    const asg =
      held ??
      demo.server.roles.assignments.create({
        person_id: person,
        workspace_id: ws,
        granted_by: person,
        ranges: [{ kind: 'store', id: 'store_main' }],
        role_id: 'social.reddit',
      })
    const brand = await demo.server.brands.forWorkspace(ws)
    const actor = {
      workspace_id: ws,
      person_id: person,
      assignment_id: asg.id,
      role_id: 'social.reddit',
    }
    let seq = 0
    const stage = async (sub, author, title, reason) => {
      seq += 1
      const out = await brand.redditWrites.stage(actor, {
        target: {
          kind: 'comment',
          subreddit: sub,
          parent_fullname: `t3_wp414p${seq}`,
          permalink: `/r/${sub}/comments/wp414p${seq}/x/`,
          post_title: title,
          parent_author: author,
          parent_text: title,
        },
        text: `Thanks for sharing, ${author}. Hope you find a phone you like!`,
        reason,
      })
      if (!out.staged) throw new Error(out.message)
      return out.approval_item_id
    }
    const group = async () => ({
      ids: [
        await stage('Smartphones', 'alice', 'Switching from Pixel to iPhone, worth it?', OFF_TOPIC),
        await stage('Smartphones', 'bob', 'Which phone has the best battery this year?', OFF_TOPIC),
        await stage('Smartphones', 'cat', 'Upgrading my old Galaxy, need advice', OFF_TOPIC),
      ],
      own: await stage(
        'ivraxr',
        'dan',
        'Air3 captions keep lagging',
        '自家版块用户问字幕延迟，要回',
      ),
    })
    const state = async (id) => (await demo.server.txn.approvals.get(id))?.state
    /** 截图收尾 / 挪开用：在服务端直接定一张（不经工作台，不触发跟随）。 */
    const settle = async (id, action) => {
      const item = await demo.server.txn.approvals.get(id)
      const tok = [...(item?.deliveries ?? [])].reverse().find((d) => d.status === 'sent')
      if (tok === undefined) return
      await demo.server.txn.approvals.decide(id, person, {
        decision_token: tok.decision_token,
        action,
        ...(action === 'reject'
          ? { reason: '截图收尾' }
          : { defer_until: '2026-10-30T00:00:00.000Z' }),
        via: 'api',
      })
    }
    const owner = await login(OWNER)

    const open = async (theme) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
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
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      return { context, page }
    }

    const TITLES = [
      'Switching from Pixel to iPhone',
      'Which phone has the best battery',
      'Upgrading my old Galaxy',
    ]
    /**
     * 进 Reddit 运营那条职责的页面，拿当前那张 r/Smartphones 卡（Reddit 卡同族，牌堆把它们合成一摞，
     * 露在面上的那张就是代表），认出它是这一组里的哪一张。
     */
    const toCard = async (page, ids, own) => {
      await page.goto(`${BASE}/positions/${asg.id}/duties/social.reddit`, {
        waitUntil: 'networkidle',
      })
      const card = page.getByTestId('deck-card')
      await card.first().waitFor({ timeout: 30_000 })
      for (let i = 0; i < 40; i += 1) {
        const text = (await card.first().textContent()) ?? ''
        // 同族的卡合成一摞、露在面上的是哪张不固定：自家版块那张在面上就先在服务端推迟它（不算跟随）
        if (own !== undefined && text.includes('Air3 captions')) {
          await settle(own, 'defer')
          await page.reload({ waitUntil: 'networkidle' })
          await card.first().waitFor({ timeout: 30_000 })
          continue
        }
        const k = TITLES.findIndex((title) => text.includes(title))
        if (k >= 0)
          return { card: card.first(), leader: ids[k], others: ids.filter((_, j) => j !== k) }
        const next = page.getByTestId('deck-next')
        if ((await next.count()) === 0 || (await next.isDisabled())) break
        await next.click()
        await page.waitForTimeout(250)
      }
      await page.screenshot({ path: join(SHOTS, 'debug.png') })
      throw new Error(
        `牌堆里翻不到 r/Smartphones 那几张：${((await card.first().textContent()) ?? '').slice(0, 200)}`,
      )
    }
    const deck = (page) => page.getByTestId('deck-section')

    for (const theme of ['light', 'dark']) {
      console.log(`— ${theme}`)
      const { ids, own } = await group()
      const { context, page } = await open(theme)

      // 1. 卡底按钮
      const { card, leader: first, others } = await toCard(page, ids, own)
      const [second, third] = others
      const bar = card.getByTestId('deck-action-bar')
      const labels = (await bar.getByRole('button').allTextContents()).map((s) => s.trim())
      if (theme === 'light') {
        check(
          JSON.stringify(labels) === JSON.stringify(['修改', '不发', '稍后']),
          `卡底是「修改 / 不发 / 稍后」按钮（「发送」在卡身里）：${labels.join(' / ')}`,
        )
        check((await page.getByTestId('deck-more').count()) === 0, '没有 ··· 也没有「需要补素材」')
      }
      await shot(page, `1-buttons-${theme}`, card)

      // 5. 「修改」开的框
      await bar.getByText('修改').click()
      await page.getByTestId('deck-panel-instruct').waitFor({ timeout: 10_000 })
      await shot(page, `5-revise-${theme}`, card)
      await page.getByRole('button', { name: '返回' }).click()

      // 2. 否掉第一张：一下就生效
      await card.getByTestId('deck-action-bar').getByText('不发').click()
      const applied = page.getByTestId('deck-follow-applied')
      await applied.waitFor({ timeout: 20_000 })
      if (theme === 'light') {
        check(
          ((await applied.textContent()) ?? '').includes('另外 2 张也一并不发了'),
          '顶上一行：另外 2 张也一并不发了',
        )
        check(
          (await state(first)) === 'rejected' &&
            (await state(second)) === 'rejected' &&
            (await state(third)) === 'rejected',
          '服务端：第一张不发，同类两张跟着不发',
        )
        const mine = await demo.server.txn.approvals.get(own)
        check(mine?.decision?.followed === undefined, '自家版块那张没被跟着处理')
      }
      await shot(page, `2-drop-follow-${theme}`, deck(page))

      // 3. 看是哪几张
      await page.getByTestId('deck-follow-list-toggle').click()
      await page.getByTestId('deck-follow-list').waitFor({ timeout: 10_000 })
      if (theme === 'light')
        check(
          ((await page.getByTestId('deck-follow-list').textContent()) ?? '').includes(
            '同在 r/Smartphones',
          ),
          '每张写着为什么算同类',
        )
      await shot(page, `3-follow-list-${theme}`, deck(page))

      // 4. 补理由 + 撤回
      await page.getByTestId('deck-drop-reasons').getByText('不相关').click()
      await page.getByTestId('deck-drop-reason-saved').waitFor({ timeout: 10_000 })
      await page.getByTestId('deck-follow-undo').click()
      await page.getByTestId('deck-follow-undone').waitFor({ timeout: 10_000 })
      if (theme === 'light') {
        const reason = (await demo.server.txn.approvals.get(first))?.decision?.reason
        check(reason === '不相关', `理由补记上了（${reason}）`)
        check(
          (await state(second)) === 'pending' && (await state(third)) === 'pending',
          '撤回：同类两张回到待处理',
        )
        check((await state(first)) === 'rejected', '带头那张还是不发')
      }
      await shot(page, `4-undone-${theme}`, deck(page))
      // 收拾：这一轮剩下的卡不发，免得下一组翻不到
      for (const id of [second, third, own]) {
        const item = await demo.server.txn.approvals.get(id)
        const tok = [...(item?.deliveries ?? [])].reverse().find((d) => d.status === 'sent')
        if (tok !== undefined)
          await demo.server.txn.approvals.decide(id, person, {
            decision_token: tok.decision_token,
            action: 'reject',
            reason: '截图收尾',
            via: 'api',
          })
      }

      // 6. 「发送」：只问要不要一起发
      const next = await group()
      const sent = await toCard(page, next.ids, next.own)
      const sendCard = sent.card
      await sendCard.getByTestId('reddit-write-send').click()
      const suggested = page.getByTestId('deck-follow-suggested')
      await suggested.waitFor({ timeout: 20_000 })
      if (theme === 'light') {
        check(
          ((await suggested.textContent()) ?? '').includes('要一起发送吗'),
          '点「发送」之后：只问「这 2 张和刚才那张类似，要一起发送吗？」',
        )
        check(
          (await state(sent.others[0])) === 'pending' &&
            (await state(sent.others[1])) === 'pending',
          '服务端：同类卡一张都没自动发',
        )
      }
      await shot(page, `6-send-suggest-${theme}`, deck(page))
      for (const id of [...sent.others, next.own]) {
        const item = await demo.server.txn.approvals.get(id)
        const tok = [...(item?.deliveries ?? [])].reverse().find((d) => d.status === 'sent')
        if (tok !== undefined)
          await demo.server.txn.approvals.decide(id, person, {
            decision_token: tok.decision_token,
            action: 'reject',
            reason: '截图收尾',
            via: 'api',
          })
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
  if (failed) process.exit(1)
  console.log('WP414 端到端通过')
  // demo 里还挂着几个后台定时器：截完就走，不等它们
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
