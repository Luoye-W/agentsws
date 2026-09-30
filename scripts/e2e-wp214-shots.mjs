#!/usr/bin/env node
/**
 * WP214：状态用图标、说明只在第一次——改前 / 改后截图（可重跑）。
 *
 * 起一个 demo（不联网：DeepSeek 账号是 demo 的**替身**，授权页就是本机回调），拍：
 *
 * 1. `<tag>-models-configured.png`：设置 → 模型「已配的」（账号那条 + 一条替身 API key 那条）；
 * 2. `<tag>-models-deepseek-card.png`：「加一个」里已登录的 DeepSeek 卡；
 * 3. `<tag>-web-search.png`：模型页「用你的 DeepSeek 账号搜索」那一行；
 * 4. `<tag>-subscription.png`：「OpenAI / ChatGPT」卡订阅登录已登上（替身）；
 * 5. `<tag>-plugins.png`：设置 → 官方插件（替身三种状态）；
 * 6. `<tag>-account.png`：设置 → 账号与积分，已关联的账号卡（替身）；
 * 7. `<tag>-scenes.png`：左下角场景面板（替身：一个运行中、一个起不来）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp214-shots.mjs --tag before|after [--port 4464]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp214')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4464'))
const TAG = value('--tag', 'after')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

function startDemo() {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  return { child, log }
}

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/app/bootstrap.json`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`demo 没起来（60 秒）：\n${log.join('')}`)
}

async function login() {
  const post = async (path, body) =>
    (
      await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()
  const link = await post('/v1/auth/magic-link', { email: OWNER })
  const verified = await post('/v1/auth/verify', { token: link.data.token })
  return verified.data.session_token
}

/** 把服务端回的 `data` 改一格（别的照走 demo）。 */
async function patchGet(page, pattern, patch) {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json().catch(() => ({ data: {} }))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...json, data: patch(json.data ?? {}) }),
    })
  })
}

async function shot(locator, name) {
  await locator.scrollIntoViewIfNeeded()
  await locator.page().waitForTimeout(300)
  await locator.screenshot({ path: join(SHOTS, `${TAG}-${name}.png`) })
  console.log(`  📷 ${TAG}-${name}.png`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { child, log } = startDemo()
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)
    let authorizeUrl
    await context.route('**/oauth/callback**', (route) => {
      authorizeUrl = route.request().url()
      return route.abort()
    })

    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const card = page.locator('[data-testid="model-template"][data-vendor="deepseek"]')
    await card.waitFor()

    // 照真流程用替身账号登上（授权页 → 本机回调 → 自动存 + 三步验证）
    await card.locator('[data-testid="dsa-login"]').click()
    await page.waitForSelector('[data-testid="dsa-waiting"]')
    await context.unroute('**/oauth/callback**')
    if (authorizeUrl === undefined) throw new Error('没拦到授权页地址')
    const loginTab = await context.newPage()
    await loginTab.goto(authorizeUrl)
    await loginTab.close()
    await page.waitForSelector('[data-testid="model-row"]', { timeout: 20_000 })
    await page.waitForTimeout(2000)

    // 替身：再配着一条 DeepSeek API key（demo 不给存真 key：存 key 会去官方拉模型清单，要出网）
    await patchGet(page, '**/v1/models/providers**', (data) => {
      const account = (data.providers ?? []).find((p) => p.kind === 'deepseek_account')
      return {
        ...data,
        providers: [
          {
            id: 'deepseek',
            kind: 'deepseek',
            label: 'DeepSeek 官方 · 官方 API 接口连接',
            base_url: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            region: 'cn',
            has_key: true,
            active: true,
            vision_status: 'ok',
            last_test: {
              ...account?.last_test,
              ok: true,
              model: 'deepseek/deepseek-flash',
              duration_ms: 2099,
              detail: '通了：连得上、文字能回、图也看得懂（用了 434 个 token）',
            },
          },
          ...(data.providers ?? []),
        ],
      }
    })
    await patchGet(page, '**/v1/settings/models/deepseek-account', (data) => ({
      ...data,
      balance: {
        status: 'ready',
        wallets: [{ currency: 'CNY', balance: '28.1146885000000000' }],
        bonus: [{ currency: 'CNY', balance: '0' }],
      },
    }))
    await patchGet(page, '**/v1/settings/models/subscription/openai-codex**', (data) => ({
      ...data,
      available: true,
      signed_in: true,
      in_flight: false,
      account: 'wang@nordvolt.example',
      expires_at: '2026-10-30T09:00:00.000Z',
      models: data.models?.length ? data.models : ['gpt-5.1-codex'],
      selected_model: data.selected_model ?? 'gpt-5.1-codex',
    }))
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="dsa-balance"], [data-testid="dsa-signed-in"]')
    await page.waitForTimeout(500)

    const configured = page.locator('[data-testid="model-row"]').first().locator('xpath=../..')
    await shot(configured, 'models-configured')
    // tooltip：键盘聚焦第一个状态图标（hover / focus 都出）
    if (TAG === 'after') {
      await page.locator('[data-testid="model-row"] [data-testid="status-icon"]').first().focus()
      await page.waitForTimeout(400)
      const box = await configured.boundingBox()
      if (box !== null)
        await page.screenshot({
          path: join(SHOTS, `${TAG}-models-tooltip.png`),
          clip: { x: box.x, y: Math.max(0, box.y - 90), width: box.width, height: box.height + 90 },
        })
      console.log(`  📷 ${TAG}-models-tooltip.png`)
      await page.locator('body').click({ position: { x: 5, y: 5 } })
      // 深色一张
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      await page.waitForTimeout(300)
      await shot(configured, 'models-configured-dark')
      await page.evaluate(() => document.documentElement.classList.remove('dark'))
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await shot(
      page.locator('[data-testid="model-template"][data-vendor="deepseek"]'),
      'models-deepseek-card',
    )
    await shot(page.locator('[data-testid="web-search-toggle"]'), 'web-search')
    const openai = page.locator('[data-testid="model-template"][data-vendor="openai"]')
    await openai
      .locator('[data-testid="subscription-signed-in"]')
      .waitFor({ timeout: 10_000 })
      .catch(() => {})
    await shot(openai, 'subscription')

    // 官方插件：三种状态（替身）
    await patchGet(page, '**/v1/settings/official-plugins**', () => ({
      plugins: [
        plugin('deepseek-schedule', '定时任务', 'installed', false),
        plugin('deepseek-websearch', '联网搜索', 'available', true),
        plugin('deepseek-memory', '长期记忆', 'upgradable', false),
        plugin('deepseek-files', '文件助手', 'pending', false),
      ],
    }))
    // 账号与积分：已关联（替身）
    await patchGet(page, '**/v1/cloud/account**', (data) => ({
      ...data,
      linked: true,
      email: OWNER,
      org_name: 'Nordvolt',
      expires_at: '2027-03-30T00:00:00.000Z',
      scopes: ['credits', 'kol.sync'],
      cloud_base_url: data.cloud_base_url ?? 'https://cloud.agentsws.example',
    }))
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: '官方插件' }).click()
    await shot(page.locator('[data-testid="official-plugins"]'), 'plugins')
    await page.goto(`${BASE}/settings/credits`, { waitUntil: 'networkidle' })
    await shot(page.locator('[data-testid="cloud-account"]'), 'account')

    // 连接页：已连上的一条（替身）+ 消息渠道页（替身：微信在收信、企业微信已配）
    await patchGet(page, '**/v1/connections', (data) => ({
      ...data,
      connections: [
        {
          id: 'conn_mail_1',
          service: 'imap_smtp',
          service_label: '任意邮箱（IMAP / SMTP）',
          alias: 'default',
          ownership: 'workspace',
          status: 'active',
          identity: { display_name: 'support@nordvolt.example' },
          credential_store: 'local_vault',
          data_sources: [],
          last_tested_at: '2026-09-29T08:00:00.000Z',
          last_test: { ok: true, reason: 'ok', checked_at: '2026-09-29T08:00:00.000Z' },
        },
      ],
    }))
    await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' })
    const connRow = page.locator('[data-testid="connection-row"]').first()
    if (await connRow.count()) await shot(connRow, 'connection-row')
    const search = page.locator('[data-testid="search-data"]')
    if (await search.count()) await shot(search, 'search-data')
    await patchGet(page, '**/v1/im/status', (data) => ({
      ...data,
      wechat: { bound: true, live: true, allowed: true, account_id: 'wxid_nordvolt' },
      wecom: { configured: true, connected: true, bot_id: 'aibot_demo' },
    }))
    await page.goto(`${BASE}/im-channels`, { waitUntil: 'networkidle' })
    const im = page.locator('main').first()
    if (await im.count()) await shot(im, 'im-channels')

    // 场景面板（替身：一个运行中、一个起不来）
    await patchGet(page, '**/v1/dsh-scenes', () => ({
      available: true,
      scenes: [
        scene('agentsws', 'agentsws', 'running'),
        scene('web', 'official', 'running'),
        scene('coding', 'official', 'failed', '端口 8791 被占用了'),
        scene('my-notes', 'custom', 'stopped'),
      ],
      templates: [],
    }))
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const toggle = page.locator('[data-testid="scene-toggle"]')
    if (await toggle.count()) {
      await toggle.click()
      await shot(page.locator('[data-testid="scene-panel"]'), 'scenes')
    } else console.log('  （场景入口没出，跳过）')
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

function plugin(name, title, state, network) {
  return {
    name,
    title,
    summary: `${title}：DeepSeek 官方插件。`,
    version: '0.2.0',
    license: 'MIT',
    source: 'shipped',
    tools: ['do_it'],
    network,
    ...(network ? { network_note: '会连官方的搜索服务。' } : {}),
    state,
    ...(state === 'installed' || state === 'upgradable' ? { installed_version: '0.1.0' } : {}),
    ...(state === 'pending' ? { pending: { action: 'install', approval_item_id: 'apr_1' } } : {}),
  }
}

function scene(name, origin, state, error) {
  return {
    name,
    origin,
    surface: origin === 'agentsws' ? 'agentsws' : 'web',
    is_default: origin === 'agentsws',
    deletable: origin === 'custom',
    launchable: true,
    initialized: true,
    state,
    ...(error === undefined ? {} : { error }),
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
