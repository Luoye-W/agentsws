#!/usr/bin/env node
/**
 * WP211：消息渠道页飞书 / 钉钉两张新卡的截图（可重跑）。存到 `docs/assets/wp211/`。
 *
 * **不联网、不用真账号、不连真飞书 / 钉钉**：全走 demo（合成数据）；「已配好 / 连不上 / 绑定码」
 * 那几种状态用 Playwright 把 `/v1/im/status` 与 `/v1/im/bind-code` 两条拦下来回假数据——
 * 真存一份凭据会让 demo 进程去连飞书 / 钉钉，这里一条都不发出去。表单只填不提交。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-im-team-shots.mjs [--port 4461]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp211')
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1] ?? '4461') || 4461
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

async function waitForDemo(log) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${BASE}/app/bootstrap.json`)).ok) return
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
  return (await post('/v1/auth/verify', { token: link.data.token })).data.session_token
}

/** 「已配好」那一版的状态（假的，不含任何凭据）。 */
function configuredStatus(real) {
  return {
    ...real,
    feishu: {
      configured: true,
      connected: true,
      state: 'connected',
      app_id: 'cli_a1b2c3d4e5f60718',
      me_bound: false,
    },
    dingtalk: {
      configured: true,
      connected: false,
      state: 'failed',
      error:
        'Client ID 或 Client Secret 不对，或者应用还没开「Stream 模式」。去钉钉开发者后台核一下再填。',
      client_id: 'dingxxxxxxxxxxxx',
      me_bound: true,
    },
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const child = spawn(
    process.execPath,
    [join(ROOT, 'apps/cli/bin/agentsws.mjs'), 'demo', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  let browser
  try {
    await waitForDemo(log)
    const token = await login()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } })
    await context.addInitScript((t) => {
      try {
        window.localStorage.setItem('agentsws.session_token', t)
      } catch {
        /* 写不进去就走 demo 的自动登录 */
      }
    }, token)

    // ① 没配的样子：整页 + 两张新卡
    const p = await context.newPage()
    p.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await p.goto(`${BASE}/im-channels`, { waitUntil: 'networkidle' })
    await p.locator('[data-testid="im-feishu"]').waitFor({ timeout: 20_000 })
    await p.waitForTimeout(500)
    await p.screenshot({ path: join(SHOTS, 'im-channels.png'), fullPage: true })
    for (const id of ['im-feishu', 'im-dingtalk']) {
      const card = p.locator(`[data-testid="${id}"]`)
      await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: join(SHOTS, `${id}-card.png`) })
    }

    // ② 填表单态（点主按钮展开；只填不提交；Secret 是密码框）
    const feishu = p.locator('[data-testid="im-feishu"]')
    await feishu.getByRole('button', { name: '填应用凭据' }).click()
    await feishu.locator('input[name="app_id"]').fill('cli_a1b2c3d4e5f60718')
    await feishu.locator('input[name="app_secret"]').fill('not-a-real-secret')
    await feishu.screenshot({ path: join(SHOTS, 'im-feishu-form-filled.png') })
    const ding = p.locator('[data-testid="im-dingtalk"]')
    await ding.getByRole('button', { name: '填应用凭据' }).click()
    await ding.locator('input[name="client_id"]').fill('dingxxxxxxxxxxxx')
    await ding.locator('input[name="client_secret"]').fill('not-a-real-secret')
    await ding.screenshot({ path: join(SHOTS, 'im-dingtalk-form-filled.png') })
    await p.close()

    // ③ 已配好 / 连不上 / 绑定码（拦下状态与绑定码两条，回假数据）
    const q = await context.newPage()
    await q.route('**/v1/im/status', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, data: configuredStatus(body.data) } })
    })
    await q.route('**/v1/im/bind-code', (route) =>
      route.fulfill({
        json: {
          data: { code: '246810', expires_at: new Date(Date.now() + 600_000).toISOString() },
          trace_id: '',
        },
      }),
    )
    await q.goto(`${BASE}/im-channels`, { waitUntil: 'networkidle' })
    await q.locator('[data-testid="im-feishu-bind"]').waitFor({ timeout: 20_000 })
    await q.locator('[data-testid="im-feishu-bind"] button').first().click()
    await q.getByText('绑定 246810').waitFor()
    for (const id of ['im-feishu', 'im-dingtalk']) {
      const card = q.locator(`[data-testid="${id}"]`)
      await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: join(SHOTS, `${id}-configured.png`) })
    }
    await q.close()
    console.log(`截图在 ${SHOTS}`)
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
