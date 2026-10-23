#!/usr/bin/env node
/**
 * WP488：客服知识库「学一遍」+ 公共 / 售前 / 售后三份——浅 / 深各拍一套（不联网、不接真 AI、不碰 4317）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界，内存里，跑完即停）。「学一遍」的三个口换成替身：
 * 一批模拟往来邮件、一个本地假站点（官网 + 帮助中心多页）、一个只看提示词线索回 JSON 的假模型。全是现编的。
 *
 * 走一遍：
 * - 客服岗位页：快捷按钮里有「从过往邮件学」；
 * - 从过往邮件学 → 一件事项（有进度）→ 汇总卡「学到 N 条」：每条带依据、范围下拉、可去掉；
 * - 从官网 + 帮助中心学 → 采纳 → 知识库三标签页（公共 / 售前 / 售后）各有各的，卡上能改范围；
 * - 知识库页「从过往邮件学」先出预估（问模型几次、约多少）。
 * 不通过就退出码 1；`--no-check` 只拍不查。截图放 `--out`（私有仓），别提交进公开仓。
 *
 * ```
 * npx tsc -b packages/sdk apps/cli && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp488-shots.mjs --port 4950 --out <目录> [--no-check]
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
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp488'))
const PORT = Number(argOf('--port') ?? '4950') || 4950
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const WIDTH = 1280
const HEIGHT = 900
const NOW = '2026-10-23T09:00:00Z'
const OURS = 'support@nordvolt.example'

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

/* ── 替身：一批模拟往来 ─────────────────────────────────────────────── */
function mails() {
  const out = []
  let n = 0
  const day = (d) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString()
  const pair = (q, a) => {
    n += 1
    out.push({
      id: `in_${n}`,
      thread_id: `thr_${n}`,
      message_id: `<in${n}@buyer.example>`,
      from: { email: `buyer${n}@buyer.example` },
      subject: q.slice(0, 40),
      text: q,
      date: day(30 + n),
    })
    out.push({
      id: `out_${n}`,
      thread_id: `thr_${n}`,
      message_id: `<out${n}@nordvolt.example>`,
      from: { email: OURS },
      subject: `Re: ${q.slice(0, 40)}`,
      text: a,
      date: day(29 + n),
    })
  }
  for (let i = 0; i < 5; i++)
    pair(
      'I want to return the power bank, how do refunds work?',
      'Once the return arrives we refund to the original card within 5 business days.',
    )
  for (let i = 0; i < 4; i++)
    pair(
      'How much is the 2-pack and is there a bundle discount?',
      'Bundles are 10% off automatically at checkout.',
    )
  for (let i = 0; i < 3; i++)
    pair(
      'Where is my package? The tracking has not moved for days.',
      'Tracking can pause for up to 48 hours at customs, then it moves again.',
    )
  for (let i = 0; i < 3; i++)
    pair(
      'My charger stopped working after a month, is it under warranty?',
      'Yes, every charger has a 12-month warranty; send a short video and we ship a replacement.',
    )
  return out
}

const PAD =
  '<p>Nordvolt makes travel chargers and power banks. Our support team answers every email within one business day.</p>'
const PAGES = {
  'https://www.nordvolt.example/': `<html><body><a href="/pages/faq">FAQ</a><a href="/policies/shipping-policy">Shipping</a><h1>Nordvolt</h1>${PAD}</body></html>`,
  'https://www.nordvolt.example/pages/faq': `<html><body><h1>FAQ</h1><p>Can I take the 20000mAh on a plane? Yes, it is under 100Wh.</p>${PAD}</body></html>`,
  'https://www.nordvolt.example/policies/shipping-policy': `<html><body><h1>Shipping</h1><p>Orders ship within 2 business days from our US warehouse.</p>${PAD}</body></html>`,
  'https://help.nordvolt.example/': `<html><body><a href="/hc/articles/1">Charger not charging</a>${PAD}</body></html>`,
  'https://help.nordvolt.example/hc/articles/1': `<html><body><h1>Charger not charging</h1><p>Try another cable first; if it still fails, contact us with your order number.</p>${PAD}</body></html>`,
}

/** 替身：只看提示词里的线索回 JSON 的假模型。 */
const fakeModel = {
  complete: async (prompt) => {
    if (prompt.includes('主题是「returns_refunds」'))
      return '{"question":"How do refunds work?","answer":"Once the return arrives we refund to the original card within 5 business days.","stage":"postsales","confidence":0.82}'
    if (prompt.includes('主题是「pre_sales」'))
      return '{"question":"Is there a bundle discount?","answer":"Bundles are 10% off automatically at checkout.","stage":"presales","confidence":0.8}'
    if (prompt.includes('主题是「order_tracking」'))
      return '{"question":"Why has my tracking not moved?","answer":"Tracking can pause for up to 48 hours at customs, then it moves again.","confidence":0.74}'
    if (prompt.includes('主题是「warranty」'))
      return '{"question":"Is my charger under warranty?","answer":"Every charger has a 12-month warranty; send a short video and we ship a replacement.","stage":"postsales","confidence":0.78}'
    if (prompt.includes('/pages/faq'))
      return '{"items":[{"question":"Can I take the 20000mAh power bank on a plane?","answer":"Yes, it is under 100Wh so it is allowed in carry-on.","stage":"presales","confidence":0.9}]}'
    if (prompt.includes('shipping-policy'))
      return '{"items":[{"question":"How fast do orders ship?","answer":"Orders ship within 2 business days from our US warehouse.","stage":"both","confidence":0.85}]}'
    if (prompt.includes('/hc/articles/1'))
      return '{"items":[{"question":"My charger is not charging, what should I do?","answer":"Try another cable first; if it still fails, contact us with your order number.","stage":"postsales","confidence":0.8}]}'
    return '{"items":[]}'
  },
  estimate: (calls) => calls * 0.012,
  budget: async () => undefined,
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
    now: Date.parse(NOW),
    knowledgeLearn: {
      knowledgeLearnMail: async () => ({
        accounts: () => [OURS],
        stored: async () => mails(),
        history: async () => ({ records: [], supported: true }),
        machineSent: async () => new Set(),
      }),
      knowledgeLearnModel: async () => fakeModel,
      knowledgeSiteFetch: async (url) => {
        const html = PAGES[String(url)]
        return html === undefined
          ? new Response('not found', { status: 404 })
          : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      },
    },
  })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const server = demo.server
    const ws = server.bootstrap.workspace.id
    const person_id = server.bootstrap.person.id
    const owner = await login(OWNER)
    const support = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .find((a) => a.role_id === 'dtc.support' && a.revoked_at === undefined)
    if (support === undefined) throw new Error('演示世界里没有网站客服这条职责')

    const est = await call(
      'POST',
      '/v1/knowledge/learn/estimate',
      { source: 'email' },
      owner,
      support.id,
    )
    check(
      est.months === 12 && est.calls === 4,
      `预估：近 ${est.months} 个月、问模型 ${est.calls} 次`,
    )

    const emailJob = await call(
      'POST',
      '/v1/knowledge/learn',
      { source: 'email' },
      owner,
      support.id,
    )
    await server.knowledgeLearn.settled()
    const siteJob = await call(
      'POST',
      '/v1/knowledge/learn',
      { source: 'website', urls: ['https://www.nordvolt.example/', 'help.nordvolt.example'] },
      owner,
      support.id,
    )
    await server.knowledgeLearn.settled()
    const jobs = await call('GET', '/v1/knowledge/learn/jobs', undefined, owner, support.id)
    const email = jobs.find((j) => j.id === emailJob.id)
    const site = jobs.find((j) => j.id === siteJob.id)
    check(email?.state === 'done' && email.learned === 4, `过往邮件学到 ${email?.learned} 条`)
    check(site?.state === 'done' && site.learned === 3, `网站学到 ${site?.learned} 条`)
    // 网站那张先采纳（知识库三标签页里有东西），邮件那张留着拍
    const siteCard = await server.txn.approvals.get(site.approval_id)
    const token = [...(siteCard?.deliveries ?? [])]
      .reverse()
      .find((d) => d.status === 'sent')?.decision_token
    await call(
      'POST',
      `/v1/approvals/${site.approval_id}/decide`,
      { action: 'approve', ...(token === undefined ? {} : { decision_token: token }) },
      owner,
      support.id,
    )
    await server.knowledgeLearn.settled()
    const positions = await call('GET', '/v1/positions', undefined, owner, support.id)
    const careAsg = (positions.instances ?? [])
      .flatMap((p) => p.roles ?? [])
      .find((r) => r.role_id === 'dtc.support' && r.my_assignment_id !== undefined)

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

      // ① 客服岗位页的快捷按钮
      if (careAsg !== undefined) {
        await page.goto(`${BASE}/positions/${careAsg.my_assignment_id}`, {
          waitUntil: 'load',
          timeout: 90_000,
        })
        const chip = page.locator('[data-action="learn_email"]')
        await chip.waitFor({ timeout: 60_000 }).catch(() => undefined)
        check((await chip.count()) === 1, `[${theme}] 客服岗位页有「从过往邮件学」快捷按钮`)
        await shot(page, theme, '1-position-quick-action')
      } else check(false, `[${theme}] 找不到客服岗位`)

      // ② 汇总卡：改一条范围、去掉一条
      await page.goto(`${BASE}/cards/${email.approval_id}`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('deck-knowledge-learned').waitFor({ timeout: 60_000 })
      const items = await page.getByTestId('kl-card-item').count()
      check(items === 4, `[${theme}] 汇总卡列出 ${items} 条`)
      await page.getByTestId('kl-card-stage').nth(2).selectOption('both')
      await page.getByTestId('kl-card-drop').nth(1).check()
      const confirm = (await page.getByTestId('kl-card-confirm').innerText()).trim()
      check(confirm === '采纳 3 条', `[${theme}] 去掉一条后主按钮写「${confirm}」`)
      await shot(page, theme, '2-learned-card')

      // ③ 知识库：学一遍那一块 + 预估
      await page.goto(`${BASE}/knowledge`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('kl-panel').waitFor({ timeout: 60_000 })
      await page.getByTestId('kl-estimate-email').click()
      await page.getByTestId('kl-estimate').waitFor({ timeout: 20_000 })
      const line = (await page.getByTestId('kl-estimate').innerText()).trim()
      check(/问模型 4 次/.test(line), `[${theme}] 预估：${line}`)
      await shot(page, theme, '3-knowledge-learn-estimate')

      // ④ 三标签页 + 卡上改范围
      for (const [i, tab] of [
        ['4', 'both'],
        ['5', 'presales'],
        ['6', 'postsales'],
      ]) {
        await page.getByTestId(`knowledge-stage-${tab}`).click()
        await page.waitForTimeout(400)
        const rows = await page.getByTestId('knowledge-row').count()
        check(rows > 0, `[${theme}] 「${tab}」标签页有 ${rows} 条`)
        await shot(page, theme, `${i}-knowledge-tab-${tab}`, { fullPage: true })
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
