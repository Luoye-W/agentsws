#!/usr/bin/env node
/**
 * WP449（docs/109 §5.1 #5–8）：发布前质检整套的截图，可重跑出处（不联网、不接 AI、不连真实店、不碰 4317）。
 *
 * 在本进程里起一个 demo（演示世界，内存里，跑完即停），品牌档案的目标市场设成美国 + 德国，
 * 用「内容与博客」那条分配往账本里提两篇要发布的文章（走真的发布前质检），拍浅 / 深两套：
 *
 * 1. `1-citation-blocked-<theme>`：英文稿——引用页上是 42%、稿子写 57%，另一个链接打不开 → 留在草稿，卡上指到那两句；
 *    「好不好被 AI 引用」的建议也在卡上（不挡发布）；
 * 2. `2-de-version-blocked-<theme>`：德语稿——美元价、盎司、英文小数、Sie / du 混用 → 留在草稿，逐句指出。
 *
 * 引用页是 demo 里现编的一页（`research.example.org`，见 `apps/cli/src/demo.ts` 的 `DEMO_CITATION_PAGES`）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp449-shots.mjs [--port 4741] [--out <目录>]
 * ```
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(argOf('--port', '4741'))
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const SHOTS = resolve(argOf('--out', join(ROOT, 'docs/assets/wp449')))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}

async function login(email) {
  const link = await call(undefined, undefined, 'POST', '/v1/auth/magic-link', { email })
  return (await call(undefined, undefined, 'POST', '/v1/auth/verify', { token: link.token }))
    .session_token
}

const EN_POST = [
  'The NordVolt Trail Power keeps a phone, a lamp and a speaker running through a weekend at the campsite.',
  '',
  '## Do you really need one?',
  '',
  'A [2026 charging survey](https://research.example.org/charging-survey) found that 57% of people carry a power bank at least three days a week.',
  'Most campers plan for two nights, according to [this camping report](https://research.example.org/camping-2026).',
].join('\n')

const DE_POST = [
  'So wählen Sie die richtige Powerstation für das Camping.',
  '',
  '## Wie schwer ist sie?',
  '',
  'Die Trail Power wiegt 6.3 oz und passt in deinen Kofferraum.',
  '',
  '## Was kostet sie?',
  '',
  'Sie kostet $299.00 und du bekommst sie in zwei Tagen.',
].join('\n')

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port: PORT, quiet: true })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const token = await login(OWNER)
    const me = await call(token, undefined, 'GET', '/v1/me')
    const content = me.assignments.find(
      (a) => a.role_id === 'dtc.content' && a.revoked_at === undefined,
    )
    if (content === undefined) throw new Error('demo 负责人名下没有内容与博客')
    // 品牌档案：目标市场美国 + 德国（德语稿才按德国查）
    const state = await call(token, content.id, 'GET', '/v1/onboarding/state')
    const legal = state?.profile?.legal_name ?? state?.company?.legal_name ?? 'NordVolt Ltd.'
    await call(token, content.id, 'PUT', '/v1/workspace/profile', {
      legal_name: legal,
      markets: ['US', 'DE'],
    })
    const person = content.person_id
    const stage = async (id, title, body) => {
      const out = await demo.server.txn.ledger.stage({
        workspace_id: content.workspace_id,
        role_id: 'dtc.content',
        assignment_id: content.id,
        run_id: `run_wp449_${id}`,
        change_set_id: `cs_wp449_${id}`,
        kind: 'publish_post',
        target: { type: 'article', id: `art_wp449_${id}` },
        before: { title, published: false },
        after: { title, published: true, body },
        created_by: { kind: 'agent', id: 'agent_dtc.content' },
        mandate: { caps: { max_posts_per_day: 2 } },
        level: 'L2',
        approval: {
          title: `发布文章：${title}`,
          summary: '这篇会出现在店里的博客上。',
          recipients: [{ person, via: 'scope_manager' }],
          proposer: { kind: 'agent', id: 'agent_dtc.content', assignment_id: content.id },
        },
      })
      if (!out.ok) throw new Error(`没提上去：${out.message}`)
      const gate = out.change.after?.quality_gate
      console.log(
        `  ${title}：${gate?.passed ? '过了' : `挡下 ${gate?.issues?.length ?? 0} 处`}；被 AI 引用 ${gate?.ai_citability?.score ?? '—'}/100`,
      )
      return out.approval.id
    }
    const enCard = await stage('en', 'How much power do you need for a camping weekend?', EN_POST)
    const deCard = await stage('de', 'Die richtige Powerstation fürs Camping', DE_POST)

    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 1360, height: 1000 },
        colorScheme: theme,
        locale: 'zh-CN',
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
      const p = await context.newPage()
      p.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      for (const [name, id] of [
        ['1-citation-blocked', enCard],
        ['2-de-version-blocked', deCard],
      ]) {
        await p.goto(`${BASE}/cards/${id}`, { waitUntil: 'networkidle' })
        await p.waitForTimeout(1200)
        await p.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
        console.log(`  📷 ${name}-${theme}.png`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await demo.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
