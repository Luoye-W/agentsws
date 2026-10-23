#!/usr/bin/env node
/**
 * WP489：导入红人表的预览、表格与邮件对不上那张卡、合作线程上的阶段与依据——浅 / 深各拍一套
 * （不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时，内存里，跑完即停），然后：
 * - 在红人面板「导入与活动」里传一张现编的红人表（中文表头、一个认不出的状态词）→ 预览：新增 / 合并 / 带合作 / 历史；
 * - 点「导入」→ 回执写着「历史合作（导入）」；
 * - 往消息库里放一段现编的往来（询价 → 报价 → 谈妥 → 寄样单号），跑「用邮件更新状态」→ 表格写「谈条件中」、
 *   邮件看是「已寄样」→ 出一张卡（带依据原话）；
 * - 卡上选「按邮件」→ 合作线程里写着「已寄样 · 邮件」与依据那一句。
 * 不通过就退出码 1；`--no-check` 只拍不查。
 *
 * 截图放 `--out` 目录（审稿截图放私有仓，别提交进公开仓），文件名 `<theme>-<序号>-<什么>.png`。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp489-shots.mjs --port 4954 --out <目录> [--no-check]
 * ```
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp489'))
const PORT = Number(argOf('--port') ?? '4954') || 4954
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const WIDTH = 1280
const HEIGHT = 900
const OURS = 'hello@nordvolt.example'
const ROSA = 'rosa@deskstudio.example'

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

/** 现编的红人表（中文表头、合并后的「合作情况」、一个认不出的状态词）。 */
const SHEET = [
  '达人名称,主页链接,邮箱,合作进度,报价,日期,备注',
  `Rosa Desk,https://www.youtube.com/@rosadeskstudio,${ROSA},谈价中,$600,2026-05-02,问过两次档期`,
  'Kai Setup,https://www.youtube.com/@kaisetuplab,kai@kaisetup.example,已合作,"¥3,000",2025-11-10,效果不错',
  'Mira Tech,https://www.instagram.com/miratechdesk,,谈崩了,,2026-02-01,嫌预算低',
  'Leo Builds,https://www.youtube.com/@leobuildsdesk,leo@leobuilds.example,等排期,,,',
].join('\n')

let mid = 0
const record = (ws, from, to, at, subject, text) => ({
  id: `msg_wp489_${++mid}`,
  workspace_id: ws,
  source: 'imap',
  account: OURS,
  folder: from === OURS ? 'Sent' : 'INBOX',
  folder_kind: from === OURS ? 'sent' : 'inbox',
  thread_id: '<wp489-1@nordvolt.example>',
  message_id: `<wp489-${mid}@x.example>`,
  references: [],
  headers: {},
  from: { email: from },
  to: [{ email: to }],
  cc: [],
  bcc: [],
  subject,
  snippet: text.slice(0, 60),
  text,
  has_remote_images: false,
  attachments: [],
  date: at,
  received_at: at,
  flags: { read: true, starred: false, answered: false, draft: false },
  labels: [],
})

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const sheetPath = join(tmpdir(), `wp489-${process.pid}.csv`)
  writeFileSync(sheetPath, SHEET)
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    now: Date.parse('2026-10-23T09:00:00Z'),
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const server = demo.server
    const ws = server.bootstrap.workspace.id
    const person_id = server.bootstrap.person.id
    const owner = await login(OWNER)
    const youtube = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .find((a) => a.role_id === 'kol.youtube' && a.revoked_at === undefined)
    if (youtube === undefined) throw new Error('演示世界里没有红人（YouTube）这条职责')
    const brand = await server.brands.forWorkspace(ws)
    const actor = { workspace_id: ws, person_id, assignment_id: youtube.id, role_id: 'kol.youtube' }

    let cardId
    let matchCardId
    for (const [i, theme] of ['light', 'dark'].entries()) {
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

      // ① 导入预览（两套主题都从同一张表开始预览；只在第一套里真导）
      await page.goto(`${BASE}/influencer/setup`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('kol-import-file').waitFor({ state: 'attached', timeout: 60_000 })
      await page.getByTestId('kol-import-file').setInputFiles(sheetPath)
      await page.getByTestId('kol-import-preview').waitFor({ timeout: 30_000 })
      const summary = await page.getByTestId('kol-import-summary').innerText()
      check(
        /新增 \d+ 人/.test(summary) && summary.includes('带合作'),
        `[${theme}] 预览：${summary}`,
      )
      check(summary.includes('状态没认出'), `[${theme}] 认不出的状态词照实说`)
      await page.getByTestId('kol-import-preview').scrollIntoViewIfNeeded()
      await shot(page, theme, '1-import-preview')

      if (i === 0) {
        // 认不出的「等排期」指给「已谈成」，然后导入
        await page.getByTestId('kol-import-status').last().selectOption('agreed')
        await page.getByTestId('kol-import-commit').click()
        const receipt = await page.getByTestId('kol-import-result').innerText({ timeout: 20_000 })
        check(receipt.includes('历史合作（导入）'), `导入回执：${receipt}`)

        // ② 邮箱里有一段往来：询价 → 报价 → 谈妥 → 寄样单号（表格写的还是「谈价中」）
        const put = (r) => brand.messages.store.put(r)
        await put(
          record(
            ws,
            OURS,
            ROSA,
            '2026-05-01T08:00:00Z',
            'Desk lamp collab?',
            'Hi Rosa, we would love to send you our desk lamp.',
          ),
        )
        await put(
          record(
            ws,
            ROSA,
            OURS,
            '2026-05-02T08:00:00Z',
            'Re: Desk lamp collab?',
            'Sounds fun! What is your budget for one video?',
          ),
        )
        await put(
          record(
            ws,
            OURS,
            ROSA,
            '2026-05-03T08:00:00Z',
            'Re: Desk lamp collab?',
            'We can do a flat fee of $600 plus the lamp.',
          ),
        )
        await put(
          record(
            ws,
            ROSA,
            OURS,
            '2026-05-04T08:00:00Z',
            'Re: Desk lamp collab?',
            'Deal, let’s do it! Send it over.',
          ),
        )
        await put(
          record(
            ws,
            OURS,
            ROSA,
            '2026-05-06T08:00:00Z',
            'Your lamp is on the way',
            'The lamp has shipped today, tracking number 1Z999AA10123456784 via UPS.',
          ),
        )
        // 一段对不上任何人的合作来信（陌生地址、没提到表里的谁）→ 判完进「没对上」那张卡
        await put({
          ...record(
            ws,
            'hi@nightdeskclub.example',
            OURS,
            '2026-06-03T08:00:00Z',
            'Sponsorship for my desk channel?',
            'Hi! I run a small desk-setup channel. Could we discuss a sponsorship?',
          ),
          thread_id: '<wp489-stranger@x.example>',
        })
        const est = await brand.kolImport.estimateMailStages(actor, {})
        check(est.creators >= 1, `预估：${est.summary}`)
        const run = await brand.kolImport.runMailStages(actor, {})
        check(run.conflicts === 1, `判完：${run.summary}`)
        const cards = await call(
          'GET',
          '/v1/approvals?lane=mine',
          undefined,
          owner,
          youtube.id,
        ).catch(() => undefined)
        const rows = Array.isArray(cards) ? cards : (cards?.rows ?? cards?.items ?? [])
        cardId = rows.find((c) => c.proposer?.id === 'kol-stage')?.id
        if (cardId === undefined) {
          const all = await server.approvals.queue({ workspace_id: ws, person_id, lane: 'mine' })
          cardId = all.find((c) => c.proposer?.id === 'kol-stage')?.id
        }
        check(cardId !== undefined, '表格与邮件对不上：出了一张卡')
        const all = await server.approvals.queue({ workspace_id: ws, person_id, lane: 'mine' })
        matchCardId = all.find((c) => c.proposer?.id === 'kol-mail-match')?.id
        check(matchCardId !== undefined, '对不上的往来与没找到往来的红人：一张卡')
      }

      // ③ 冲突卡
      if (cardId !== undefined) {
        await page.goto(`${BASE}/cards/${cardId}`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('deck-card').first().waitFor({ timeout: 60_000 })
        await page.waitForTimeout(1200)
        const text = await page.getByTestId('deck-card').first().innerText()
        check(
          text.includes('谈条件中') && text.includes('已寄样'),
          `[${theme}] 卡上写着表格与邮件各是哪一步`,
        )
        check(text.includes('tracking number'), `[${theme}] 卡上有依据原话`)
        await shot(page, theme, '2-conflict-card')
      }

      // ③b「没对上」那张卡：每段一个下拉、没往来的人一个邮箱框
      if (matchCardId !== undefined) {
        await page.goto(`${BASE}/cards/${matchCardId}`, { waitUntil: 'load', timeout: 90_000 })
        await page.getByTestId('deck-kol-mail-match').waitFor({ timeout: 60_000 })
        const text = await page.getByTestId('deck-kol-mail-match').innerText()
        check(text.includes('Sponsorship'), `[${theme}] 卡上列出那段没对上的往来`)
        check(
          (await page.getByTestId('kol-mail-match-email').count()) > 0,
          `[${theme}] 没找到往来的红人可以就地补邮箱`,
        )
        await shot(page, theme, '2b-mail-match-card')
      }

      if (i === 0 && cardId !== undefined) {
        await server.approvals
          .decide(cardId, person_id, { action: 'approve', selected_option_id: 'mail' })
          .catch(async () =>
            call(
              'POST',
              `/v1/approvals/${cardId}/decide`,
              { action: 'approve', selected_option_id: 'mail' },
              owner,
              youtube.id,
            ),
          )
        // 卡的决定钩子是异步的：等它落库
        for (let k = 0; k < 20; k += 1) {
          const c = brand.kol.collaborations().find((x) => x.stage === 'sample_sent')
          if (c !== undefined) break
          await brand.kolImport.onDecided(await server.approvals.get(cardId))
          await new Promise((r) => setTimeout(r, 200))
        }
        check(
          brand.kol
            .collaborations()
            .some((x) => x.stage === 'sample_sent' && x.stage_source === 'mail'),
          '选「按邮件」→ 合作改成「已寄样」，来源 = 邮件',
        )
      }

      // ④ 合作线程：阶段、来源、依据
      await page.goto(`${BASE}/influencer/creators?kol=threads`, {
        waitUntil: 'load',
        timeout: 90_000,
      })
      await page.getByTestId('kol-collab-row').first().waitFor({ timeout: 60_000 })
      const row = page.getByTestId('kol-collab-row').filter({ hasText: 'Rosa Desk' }).first()
      await row.getByTestId('kol-collab-open').click()
      await page.getByTestId('kol-thread-stage').waitFor({ timeout: 30_000 })
      const stage = await page.getByTestId('kol-thread-stage').innerText()
      check(
        stage.includes('已寄样') && stage.includes('邮件'),
        `[${theme}] 线程上：${stage.split('\n')[0]}`,
      )
      check(stage.includes('tracking number'), `[${theme}] 线程上有依据那一句`)
      await page.getByTestId('kol-thread-stage').scrollIntoViewIfNeeded()
      await shot(page, theme, '3-thread-evidence')
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
