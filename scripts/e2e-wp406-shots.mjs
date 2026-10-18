#!/usr/bin/env node
/**
 * WP406（私有 docs/107 §5）：岗位更新——截图的可重跑出处（不联网：云上那几条路是替身，钥匙现生成、不落盘）。
 *
 * 在本进程里起一个 demo（`createDemo`），官方订阅的岗位更新指向云替身：现打一份包（店铺管理的角色定位改了
 * 「口气」、加一条快捷问题；公共规矩改一条），公司层先把「口气」那一段改成自己的（撞了）。
 *
 * 1. `nudge-*.png`：没订阅——岗位设定里一行小字 +「看看更新了什么」+「订阅」；
 * 2. `card-*.png`：订上之后查一次 →「网站运营 · 本周更新 · 2 项」卡（逐项你改过没；全部应用 / 挑着看 / 这次跳过）；
 * 3. `pick-*.png`：卡上「挑着看」开第三栏——逐项勾、撞了那一项三栏「原来 / 新版 / 你的」+ 三种选法；
 * 4. `applied-*.png`：全部应用之后——用上的、撞了先保留你的、单项退回 / 整批退回。
 *
 * 每张浅色、深色各一张。截图存到 `--out`（默认私有仓 `docs/assets/wp406/`；公开仓不放截图）。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp406-shots.mjs [--port 4426] [--out <目录>]
 * ```
 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const PORT = Number(arg('--port', '4426'))
const SHOTS = resolve(
  arg('--out', join(homedir(), 'Documents/agentsws-internal/docs/assets/wp406')),
)
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const ROLE = 'dtc.store'

const load = (p) => import(pathToFileURL(join(ROOT, p)).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** demo 的钟是「今天」的场景时刻（东八区早上）：包算昨天发的，落在「最近一周」里。 */
const today = new Date()
const YESTERDAY = new Date(
  Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1),
).toISOString()

async function post(path, body) {
  return (
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json()
}

async function api(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json.data
}

const review = {
  reviewer: 'Fable',
  reviewed_at: '2026-10-19',
  license_before: 'Apache-2.0',
  license_after: 'Apache-2.0',
  scan_hits: 0,
  scan_rules: [],
  notes_ok: true,
  tests_ok: true,
}

/** 包里的中文角色定位换掉某一段。 */
function withSection(zh, heading, body) {
  return zh
    .split('\n')
    .map((l) => (l.startsWith(`${heading}：`) ? `${heading}：${body}` : l))
    .join('\n')
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const skills = await load('packages/skills/dist/index.js')
  const roles = await load('packages/roles/dist/index.js')
  const { createDemo } = await load('apps/cli/dist/demo.js')
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )

  // ── 现打一份官方包（钥匙只活在这个进程里）──
  const work = mkdtempSync(join(tmpdir(), 'agentsws-wp406-shots-'))
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const bundled = roles.bundledContentFiles().roles.find((r) => r.id === ROLE).content
  const zh = typeof bundled.persona === 'string' ? bundled.persona : bundled.persona.zh
  const roleDir = join(work, 'role')
  mkdirSync(roleDir, { recursive: true })
  writeFileSync(
    join(roleDir, 'content.json'),
    JSON.stringify({
      schema: 'agentsws.role-content/1',
      kind: 'role',
      id: ROLE,
      content: {
        persona: {
          zh: withSection(zh, '口气', '像管店的人，先讲影响多少单、多少钱。'),
        },
        quick_prompts: [
          ...bundled.quick_prompts,
          {
            id: 'flash_sale_check',
            label: { zh: '秒杀报名检查', en: 'Flash sale check' },
            prompt: '帮我检查这周要报的秒杀活动：价格、库存、规则有没有踩线',
            kind: 'review',
          },
        ],
      },
    }),
  )
  const rulesDir = join(work, 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(
    join(rulesDir, 'content.json'),
    JSON.stringify({
      table: 'roles.house_rules',
      rows: [
        {
          id: 'no_tool_names',
          zh: '对用户说话时不提工具名、函数名、内部 id，用人话说做了什么；说数字先说出处。',
          en: 'Never mention tool names, function names or internal ids; say where a number comes from.',
        },
      ],
    }),
  )
  const meta = (kind, name, version, title, summary, extra = {}) => ({
    id: `${kind}:${name}`,
    kind,
    name,
    version,
    title,
    summary,
    upstream: {
      id: 'official',
      repo: 'agentsws-content',
      commit: 'demo',
      published_at: '2026-10-19',
      license: 'Apache-2.0',
    },
    review,
    released_at: YESTERDAY,
    ...extra,
  })

  const pack = skills.buildContentPack({
    channel: 'beta',
    serial: 20261019,
    created_at: YESTERDAY,
    min_app_version: '0.0.0',
    source: 'official',
    privateKeyPem: key,
    items: [
      {
        meta: meta(
          'role_content',
          ROLE,
          '1.1.0',
          { zh: '店铺管理 · 口气改了、快捷问题 +1', en: 'Store · tone, +1 quick prompt' },
          { zh: '口气先讲影响；加「秒杀报名检查」', en: 'Tone; flash sale check' },
          { positions: ['web-ops'] },
        ),
        dir: roleDir,
      },
      {
        meta: meta(
          'rules',
          'roles.house_rules',
          '1.0.1',
          { zh: '说话规矩 改 1 条', en: 'House rules · 1 changed' },
          { zh: '说数字先说出处', en: 'Cite numbers' },
          { positions: ['web-ops'] },
        ),
        dir: rulesDir,
      },
    ],
  })

  const live = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    officialContent: {
      enabled: true,
      root: join(work, 'store'),
      keys: [skills.contentPublicKeyOf(key)],
      appVersion: '0.2.1-beta.2',
      schedule: false,
      advise: async () => '建议全部应用；「口气」那一段和你改过的撞了，先保留你的。',
      aiMerge: async () => '像管店的人，先讲影响多少钱，说人话。',
    },
    officialCloud: {
      manifest: pack.manifestBytes,
      signature: pack.signature,
      blobs: pack.blobs,
      subscribed: false,
    },
  })
  await live.server.listen()
  let browser
  try {
    const link = await post('/v1/auth/magic-link', { email: OWNER })
    const token = (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
    const me = await api(token, undefined, 'GET', '/v1/me')
    const owner = me.assignments.find((a) => a.role_id === 'common.owner').id
    let store = me.assignments.find((a) => a.role_id === ROLE)?.id
    if (store === undefined)
      store = (
        await api(token, owner, 'POST', '/v1/assignments', {
          person_id: me.person.id,
          role_id: ROLE,
          ranges: [],
        })
      ).id
    await api(token, owner, 'POST', '/v1/cloud/account/link', { email: OWNER })
    for (let i = 0; i < 60; i += 1) {
      if ((await api(token, owner, 'GET', '/v1/cloud/account')).linked === true) break
      await sleep(250)
    }
    // 公司层把「口气」那一段改成自己的（撞了）
    await api(token, owner, 'PUT', '/v1/personas', {
      kind: 'role',
      id: ROLE,
      zh: withSection(zh, '口气', '像管店的人，说人话；我们家先讲毛利，再讲单量。'),
    })
    const oc = live.server.officialContent
    await oc.check()

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1360, height: 960 },
      locale: 'zh-CN',
    })
    await context.addInitScript(
      ([t]) => {
        try {
          window.localStorage.setItem('agentsws.session_token', t)
        } catch {
          /* 走 demo 的自动登录 */
        }
      },
      [token],
    )
    const page = await context.newPage()
    page.setDefaultTimeout(60_000)
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    const setTheme = (theme) =>
      page.evaluate((x) => window.localStorage.setItem('agentsws.theme', x), theme)
    const both = async (name, prepare) => {
      for (const theme of ['light', 'dark']) {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
        await setTheme(theme)
        const target = await prepare()
        await page.waitForTimeout(600)
        await target.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) })
        console.log(`  📷 ${name}-${theme}.png`)
      }
      await setTheme('light')
    }
    /** 岗位页 → 右栏「设定」→「岗位更新」标签。 */
    const openTab = async () => {
      await page.goto(`${BASE}/positions/${store}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)
      // 上一次开着的「设定」面板会跟着布局记住：开着就直接用
      if ((await page.getByTestId('settings-panel').count()) === 0) {
        if ((await page.getByTestId('rail-cards').count()) === 0) {
          const more = page.getByTestId('rail-overflow')
          if ((await more.count()) > 0) await more.click()
        }
        const card = page.getByTestId('rail-card-settings')
        await card.waitFor({ timeout: 20_000 })
        if ((await card.getAttribute('data-open')) !== 'true')
          await page.getByTestId('rail-card-toggle-settings').click()
        await page.getByTestId('rail-card-more-settings').click()
        await page.getByTestId('settings-panel').waitFor({ timeout: 20_000 })
      }
      await page.getByTestId('settings-tab-updates').click()
      await page.getByTestId('position-updates').waitFor()
      return page.getByTestId('settings-panel')
    }
    const deckCard = async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      const list = page.getByTestId('deck-list-toggle')
      if ((await list.count()) > 0) {
        await list.click()
        await page
          .locator('[data-testid="deck-list-item"][data-kind="content_update_digest"]')
          .first()
          .click()
      }
      const card = page.locator('[data-testid="deck-card"][data-kind="content_update_digest"]')
      await card.waitFor()
      return card
    }

    // 1. 没订阅：一行小字
    await both('nudge', async () => {
      const panel = await openTab()
      await page.getByTestId('cd-nudge').waitFor()
      await page.getByTestId('cd-nudge-look').click()
      return panel
    })

    // 2. 订上 → 查一次 → 卡
    await api(token, owner, 'POST', '/v1/content-updates/subscription', {})
    for (let i = 0; i < 40; i += 1) {
      const cards = await api(token, owner, 'GET', '/v1/approvals?kind=content_update_digest')
      if (cards.length > 0) break
      await oc.check()
      await sleep(250)
    }
    await both('card', deckCard)

    // 3. 挑着看：第三栏，展开撞了的那一项
    await both('pick', async () => {
      const card = await deckCard()
      await card.getByTestId('content-digest-pick').click()
      const panel = page.getByTestId('position-updates')
      await panel.waitFor()
      const item = panel.getByTestId('cd-pending-item').filter({ hasText: '店铺管理' })
      await item.getByTestId('cd-expand').click()
      await panel.getByTestId('cd-clash').first().waitFor()
      await panel.getByTestId('cd-choice-use_ai').first().click()
      await panel.getByTestId('cd-ai-text').waitFor()
      return page.getByTestId('rail-panel-frame').or(panel).first()
    })

    // 4. 全部应用之后
    const cards = await api(token, owner, 'GET', '/v1/approvals?kind=content_update_digest')
    await api(token, owner, 'POST', `/v1/approvals/${cards[0].id}/decide`, {
      action: 'approve',
      edited_payload: { ...cards[0].payload, selected_option_id: 'apply_all' },
    })
    await both('applied', async () => {
      const panel = await openTab()
      await page.getByTestId('cd-applied').waitFor()
      return panel
    })
  } finally {
    await browser?.close()
    await live.close()
    rmSync(work, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
