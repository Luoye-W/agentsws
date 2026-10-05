#!/usr/bin/env node
/**
 * WP219（docs/90）：已审的内容更新——截图的可重跑出处（不联网：本地替身更新源，钥匙现生成、不落盘）。
 *
 * 在本进程里起一个 demo（`createDemo`），内容更新通道指向内存里的替身：用随软件带的两份技能各打一个新版
 * （「搜索判断」加一段、「开发信」改了「主题行」那一段），公司层先替「主题行」那段写一份自己的版本；
 * 查一次清单 → 两张「有新版」卡；批「开发信」那张 → 出冲突选择卡。拍到 `docs/assets/wp219/`：
 *
 * 1. `content-update-card.png`：内容更新卡（X 有新版 · 官方某日更新 · 已审；更新 / 查看改动）；
 * 2. `content-update-diff.png`：查看改动（按段）；
 * 3. `content-conflict-card.png`：冲突选择卡（用新版 / 保留我的）；
 * 4. `content-conflict-compare.png`：看对比（旧版 / 新版 / 你的）；
 * 5. `settings-content-updates.png`：设置 → 通用「已审的内容更新」（每次问我 / 自动、状态图标、更新 / 退回）；
 * 6. `settings-content-rollback.png`：点了「退回」之后。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp219-shots.mjs [--port 4419]
 * ```
 */
import { generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp219')
const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 ? args[i + 1] : '4419')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const load = (p) => import(pathToFileURL(join(ROOT, p)).href)

async function login(email) {
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  const link = await post('/v1/auth/magic-link', { email })
  return (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
}

async function call(token, assignment, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-assignment': assignment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} 没成：${res.status} ${await res.text()}`)
  return (await res.json()).data
}

/** 抄一份随软件带的技能、改版本号、按 `edit` 改正文。 */
function candidate(work, skills, name, edit) {
  const dir = join(work, name)
  cpSync(join(skills.BUNDLED_SKILLS_DIR, name), dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  const md = readFileSync(file, 'utf8')
  const was = skills.bundledSkillVersion(md)
  const version =
    was.split('.').length >= 3 ? was.replace(/\d+$/, (n) => String(Number(n) + 1)) : `${was}.1`
  writeFileSync(file, edit(md.replace(`version: ${was}`, `version: ${version}`)))
  return { dir, version }
}

const review = {
  reviewer: 'Fable',
  reviewed_at: '2026-10-04',
  license_before: 'MIT',
  license_after: 'MIT',
  scan_hits: 0,
  scan_rules: [],
  notes_ok: true,
  tests_ok: true,
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const skills = await load('packages/skills/dist/index.js')
  const { contentFeedSources } = await load('apps/server/dist/index.js')
  const { createDemo } = await load('apps/cli/dist/demo.js')
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )

  // ── 本地替身更新源：两份技能各一个新版，钥匙现生成（只活在这个进程里）──
  const work = mkdtempSync(join(tmpdir(), 'agentsws-wp219-shots-'))
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  const seo = candidate(
    work,
    skills,
    'seo-judgment',
    (md) =>
      `${md.trimEnd()}\n\n## AI 问答里的品牌提及\n\n每周看一次 ChatGPT、Perplexity、Google AI 概览对品类问题的回答里有没有提到这个品牌；没提到的问题列进「先修再写」，不编排名。\n`,
  )
  const cold = candidate(work, skills, 'cold-email', (md) =>
    md.replace(
      '主题行只负责让人打开，不负责推销。',
      '主题行只负责让人打开，不负责推销。官方新版补了一条：同一轮三封的主题行保持同一条线，后两封不换主题。',
    ),
  )
  const meta = (name, version, title, summary) => ({
    id: `skill:${name}`,
    kind: 'skill',
    name,
    version,
    title,
    summary,
    upstream: {
      id: 'marketingskills',
      repo: 'coreyhaines31/marketingskills',
      commit: '5b2c0007766c6a1cf1d53fd8fc73e979e0821022',
      published_at: '2026-10-02',
      license: 'MIT',
    },
    review,
  })
  const pack = skills.buildContentPack({
    channel: 'beta',
    serial: 20261005,
    created_at: '2026-10-05T00:00:00.000Z',
    min_app_version: '0.1.0',
    items: [
      {
        meta: meta(
          'seo-judgment',
          seo.version,
          { zh: '搜索判断', en: 'SEO judgment' },
          {
            zh: '加了一段：AI 问答里有没有提到品牌，每周看一次',
            en: 'Added: check brand mentions in AI answers weekly',
          },
        ),
        dir: seo.dir,
      },
      {
        meta: meta(
          'cold-email',
          cold.version,
          { zh: '开发信', en: 'Cold email' },
          {
            zh: '「主题行」补了一条：一轮三封不换主题',
            en: 'Subject lines: keep one thread per round',
          },
        ),
        dir: cold.dir,
      },
    ],
    privateKeyPem: key,
  })
  const files = new Map()
  for (const s of contentFeedSources('beta')) {
    files.set(s.manifestUrl, pack.manifestBytes)
    files.set(s.signatureUrl, Buffer.from(pack.signature))
    for (const [sha, b] of pack.blobs) files.set(s.blobUrl(sha), b)
  }
  const fetchStandIn = async (url) => {
    const b = files.get(url)
    return {
      ok: b !== undefined,
      status: b === undefined ? 404 : 200,
      arrayBuffer: async () => new Uint8Array(b ?? Buffer.alloc(0)).buffer,
    }
  }

  const demo = await createDemo({
    root: ROOT,
    port: PORT,
    quiet: true,
    contentUpdates: {
      enabled: true,
      root: join(work, 'store'),
      keys: [skills.contentPublicKeyOf(key)],
      fetch: fetchStandIn,
      appVersion: '0.2.0-beta.1',
      schedule: false,
    },
  })
  await demo.server.listen()
  let browser
  try {
    // 公司层先替「主题行」那一段写一份自己的版本（像学习回路采纳过一条）
    const ws = demo.server.bootstrap.workspace.id
    const base = demo.server.skills.registry.peek('cold-email', 'package')
    const subject = base.sections.find((s) => s.heading === '主题行')
    await demo.server.skills.registry.setOverlay({
      skill: 'cold-email',
      tier: 'company',
      owner: ws,
      base_version: base.version,
      version: 0,
      ops: [
        {
          op: 'replace',
          section_id: subject.id,
          body: '主题行只负责让人打开。我们家的规矩：主题行带上对方公司的品类词（例如 `tws restock`），不超过 4 个词。',
          origin: 'learned',
        },
      ],
    })
    await demo.server.contentUpdates.check()

    const owner = await login(OWNER)
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${owner}` } })).json()
    ).data
    const asg = me.assignments.find((a) => a.role_id === 'common.owner').id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1360, height: 900 },
      locale: 'zh-CN',
    })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* demo 自动登录兜底 */
      }
    }, owner)
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))

    const jumpTo = async (kind, text) => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      await page.click('[data-testid="deck-list-toggle"]')
      await page
        .locator(`[data-testid="deck-list-item"][data-kind="${kind}"]`, { hasText: text })
        .first()
        .click()
      const card = page.locator(`[data-testid="deck-card"][data-kind="${kind}"]`)
      await card.waitFor()
      await page.waitForTimeout(300)
      return card
    }

    // 1–2：内容更新卡 + 查看改动
    const card = await jumpTo('content_update', '搜索判断')
    await card.screenshot({ path: join(SHOTS, 'content-update-card.png') })
    console.log('  📷 content-update-card.png')
    await card.locator('[data-testid="deck-content-compare"]').click()
    const diff = page.locator('[data-testid="content-diff-dialog"]')
    await diff.locator('[data-testid="content-diff-section"]').first().waitFor()
    await page.waitForTimeout(300)
    await diff.screenshot({ path: join(SHOTS, 'content-update-diff.png') })
    console.log('  📷 content-update-diff.png')
    await page.keyboard.press('Escape')

    // 3–4：批「开发信」那张 → 冲突选择卡 + 看对比
    const cards = await call(owner, asg, 'GET', '/v1/approvals?kind=content_update')
    const coldCard = cards.find((c) => c.payload?.item_id === 'skill:cold-email')
    await call(owner, asg, 'POST', `/v1/approvals/${coldCard.id}/decide`, { action: 'approve' })
    const conflict = await jumpTo('content_conflict', '主题行')
    await conflict.screenshot({ path: join(SHOTS, 'content-conflict-card.png') })
    console.log('  📷 content-conflict-card.png')
    await conflict.locator('[data-testid="deck-content-compare"]').click()
    const compare = page.locator('[data-testid="content-conflict-dialog"]')
    await compare.waitFor()
    await page.waitForTimeout(300)
    await compare.screenshot({ path: join(SHOTS, 'content-conflict-compare.png') })
    console.log('  📷 content-conflict-compare.png')
    await page.keyboard.press('Escape')

    // 5–6：设置 → 通用
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const row = page.locator('[data-testid="settings-content-updates"]')
    await row.waitFor()
    await page.waitForTimeout(300)
    const general = page.locator('[data-testid="settings-general"]')
    await general.screenshot({ path: join(SHOTS, 'settings-content-updates.png') })
    console.log('  📷 settings-content-updates.png')
    await row
      .locator(
        '[data-testid="content-update-item"][data-item="skill:cold-email"] [data-testid="content-update-rollback"]',
      )
      .click()
    await row
      .locator(
        '[data-testid="content-update-item"][data-item="skill:cold-email"][data-state="available"]',
      )
      .waitFor()
    await page.waitForTimeout(300)
    await general.screenshot({ path: join(SHOTS, 'settings-content-rollback.png') })
    console.log('  📷 settings-content-rollback.png')
  } finally {
    await browser?.close()
    await demo.close()
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
