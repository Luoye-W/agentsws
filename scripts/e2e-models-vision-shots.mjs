#!/usr/bin/env node
/**
 * WP127（36 §14 / 70 §2.2）：「文字模型必须能看图、生图单独一档」三张截图的可重跑出处。
 *
 * 起一个 demo（不联网），用真浏览器拍三张：
 *
 * 1. `models-vision-settings`：设置页「模型」——顶部老用户提示 + 「文字与看图」标题 +
 *    那一行的三步小清单（卡在"看得懂图"）；
 * 2. `models-vision-image`：「生图」那一块（单价常显、用哪一条、生图模型名）；
 * 3. `models-vision-wizard`：向导第 ① 步选自己的接口，文字通了、看不了图——不放行、说人话。
 *
 * demo 里没有真模型（stub），所以"配了一个看不了图的模型"这个状态由浏览器侧的
 * 路由替身给（`page.route`）：界面画的是真的，只是那几条接口回的是固定的一份。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-models-vision-shots.mjs [--port 4411]
 * ```
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/workstation')

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4411'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'
const T0 = '2026-09-23T09:00:00.000Z'

const STEPS_NO_VISION = [
  { step: 'connect', ok: true },
  { step: 'text', ok: true },
  { step: 'vision', ok: false },
]
const NO_VISION_TEST = {
  ok: false,
  reason: 'no_vision',
  model: 'deepseek/deepseek-chat',
  detail:
    '这个模型看不了图，Agents 工坊要求模型能看图。换一个能看图的模型再测，常见的有：gpt-4o、gpt-4o-mini、claude-sonnet-4-5、qwen-vl-max、qwen-vl-plus、glm-4v-plus、moonshot-v1-8k-vision-preview、llama3.2-vision。',
  duration_ms: 1840,
  checked_at: T0,
  steps: STEPS_NO_VISION,
  vision: false,
}
const PROVIDER = {
  id: 'deepseek',
  kind: 'deepseek',
  label: '我的 DeepSeek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  region: 'cn',
  has_key: true,
  active: true,
  last_test: NO_VISION_TEST,
  vision_status: 'no',
}

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
  const link = await (
    await fetch(`${BASE}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER }),
    })
  ).json()
  const verified = await (
    await fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.data.token }),
    })
  ).json()
  return verified.data.session_token
}

const envelope = (data) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ data }),
})

/** 把"配了一个看不了图的 DeepSeek"这个状态替身进去（其余接口照走 demo）。 */
async function stubModels(page, { imageConfigured }) {
  await page.route('**/v1/models/providers', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill(envelope({ ...json.data, providers: [PROVIDER] }))
  })
  await page.route('**/v1/models/defaults', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill(
      envelope({
        ...json.data,
        default: 'deepseek/deepseek-chat',
        choices: [{ id: 'deepseek/deepseek-chat', label: '我的 DeepSeek（deepseek-chat）' }],
      }),
    )
  })
  await page.route('**/v1/models/image', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    const choices = [
      {
        provider_id: 'agentsws',
        label: 'Agents 工坊官方接口',
        official: true,
        default_model: 'gpt-image-1',
      },
    ]
    await route.fulfill(
      envelope(
        imageConfigured
          ? {
              ...json.data,
              configured: true,
              provider_id: 'agentsws',
              model: 'gpt-image-1',
              official: true,
              choices,
              unavailable_reason: undefined,
            }
          : { ...json.data, choices },
      ),
    )
  })
  await page.route('**/v1/models/providers/*/test', (route) =>
    route.fulfill(envelope(NO_VISION_TEST)),
  )
}

async function main() {
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

    // ① 设置页「模型」：老用户提示 + 三步小清单
    const page = await context.newPage()
    page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await stubModels(page, { imageConfigured: false })
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
    const panel = page.locator('[data-testid="models-panel"]')
    await panel.waitFor()
    await page.waitForSelector('[data-testid="models-vision-banner"]')
    await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(400)
    await page.screenshot({
      path: join(SHOTS, 'models-vision-settings.png'),
      clip: await clipOf(panel, 620),
    })
    console.log('  📷 models-vision-settings.png')

    // ② 「生图」那一块：选官方接口，单价常显
    const image = page.locator('[data-testid="models-image"]')
    await image.scrollIntoViewIfNeeded()
    await page.selectOption('[data-testid="models-image-select"]', 'agentsws')
    await page.waitForTimeout(300)
    await image.screenshot({ path: join(SHOTS, 'models-vision-image.png') })
    console.log('  📷 models-vision-image.png')
    await page.close()

    // ③ 向导第 ① 步：自己的接口，看不了图——不放行
    const wizard = await context.newPage()
    wizard.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
    await stubModels(wizard, { imageConfigured: false })
    await wizard.route('**/v1/models/providers/*', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      await route.fulfill(envelope({ ...PROVIDER, last_test: undefined }))
    })
    await wizard.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    await wizard.click('[data-testid="ai-pick-own"]')
    const form = wizard.locator('[data-testid="model-form"]')
    await form.waitFor()
    await form.getByLabel('API key').fill('sk-demo-text-only')
    await form.getByRole('button', { name: '保存' }).click()
    await wizard.waitForSelector('[data-testid="ai-own-failed"]')
    await wizard.waitForTimeout(400)
    await wizard.locator('[data-testid="onboarding-ai"]').screenshot({
      path: join(SHOTS, 'models-vision-wizard.png'),
    })
    console.log('  📷 models-vision-wizard.png')
  } finally {
    if (browser !== undefined) await browser.close()
    child.kill()
  }
}

/** 面板顶上那一截（提示 + 标题 + 已配的那一行）。 */
async function clipOf(locator, height) {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('面板没画出来')
  return { x: box.x, y: box.y, width: box.width, height: Math.min(height, box.height) }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
