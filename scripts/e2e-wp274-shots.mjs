#!/usr/bin/env node
/**
 * WP274（决策 255）：设置页「模型 → 生图」一档的截图（可重跑）。
 *
 * 起一个 demo（不联网、不调真模型），用真浏览器拍：
 *
 * 1. `1-own-openai-{light,dark}`：文字模型是自己的 OpenAI key → 「现在用：你的 OpenAI 账号（GPT Image 2.5）」+ 不扣积分；
 * 2. `2-own-google`：自己的 Google key → 「你的 Google 账号（Nano Banana 2.1）」；
 * 3. `3-cloud`：DeepSeek（不带生图）+ 关联过账号 → 「Agents 工坊积分（Seedream 5.0 Pro）」+ 单价常显；
 * 4. `4-override`：单独指定一条（出图 / 改图两个型号）；
 * 5. `5-custom-endpoint`：下拉里选「自定义生图接口」→ 原生表单（key 框是密码框）；
 * 6. `6-none`：什么都没有 → 说人话。
 *
 * demo 里没有真的 OpenAI / Google 配置（填了就要联网拉清单），所以这几种状态由浏览器侧的路由替身给
 * （`page.route` 换掉 `/v1/models/image` 与 `/v1/models/providers` 的回包）：界面画的是真的，
 * 回包形状与服务端 `ModelImageView` 一致（服务端那一侧由 `apps/server/test/wp274-image-routing.test.ts` 钉住）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp274-shots.mjs [--port 4427]
 * ```
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp274')
mkdirSync(SHOTS, { recursive: true })

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(value('--port', '4427'))
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

const row = (over) => ({
  region: 'global',
  has_key: true,
  active: true,
  vision_status: 'ok',
  ...over,
})
const OPENAI_ROW = row({
  id: 'openai',
  kind: 'openai_compatible',
  label: 'OpenAI（API key，按量计费）',
  base_url: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
})
const GOOGLE_ROW = row({
  id: 'google',
  kind: 'openai_compatible',
  label: 'Google Gemini（API key，按量计费）',
  base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-3.8-flash',
})
const DEEPSEEK_ROW = row({
  id: 'deepseek',
  kind: 'deepseek',
  label: 'DeepSeek 官方 · 官方 API 接口连接',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  region: 'cn',
})
const CLOUD_ROW = row({
  id: 'agentsws',
  kind: 'agentsws_cloud',
  label: 'Agents 工坊（用积分）',
  base_url: 'https://cloud.agentsws.com/v1/ai',
  model: 'deepseek-flash',
  region: 'cn',
})
const SEEDREAM_ROW = row({
  id: 'seedream',
  kind: 'openai_compatible',
  label: '我的生图接口',
  base_url: 'https://images.example.com/api/v3',
  model: 'doubao-seedream-5-0-pro-260628',
  image_only: true,
})

const choice = {
  openai: {
    provider_id: 'openai',
    label: 'OpenAI（API key，按量计费）',
    official: false,
    default_model: 'gpt-image-2.5-flare',
    vendor: 'openai',
    default_edit_model: 'gpt-image-2.5-sunburst',
  },
  google: {
    provider_id: 'google',
    label: 'Google Gemini（API key，按量计费）',
    official: false,
    default_model: 'gemini-nano-banana-2.1',
    vendor: 'google',
  },
  cloud: {
    provider_id: 'agentsws',
    label: 'Agents 工坊（用积分）',
    official: true,
    default_model: 'doubao-seedream-5-0-pro-260628',
  },
  seedream: {
    provider_id: 'seedream',
    label: '我的生图接口',
    official: false,
    default_model: 'gpt-image-1',
    image_only: true,
  },
}
const USING = {
  openai: {
    source: 'own_openai',
    provider_id: 'openai',
    label: '你的 OpenAI 账号（GPT Image 2.5）',
    generate_model: 'gpt-image-2.5-flare',
    edit_model: 'gpt-image-2.5-sunburst',
    own_key: true,
  },
  google: {
    source: 'own_google',
    provider_id: 'google',
    label: '你的 Google 账号（Nano Banana 2.1）',
    generate_model: 'gemini-nano-banana-2.1',
    edit_model: 'gemini-nano-banana-2.1',
    own_key: true,
  },
  cloud: {
    source: 'cloud',
    provider_id: 'agentsws',
    label: 'Agents 工坊积分（Seedream 5.0 Pro）',
    generate_model: 'doubao-seedream-5-0-pro-260628',
    edit_model: 'doubao-seedream-5-0-pro-260628',
    own_key: false,
  },
}

const STATES = {
  openai: {
    providers: [OPENAI_ROW],
    image: {
      configured: true,
      official: false,
      override: false,
      credits_per_image: 0.5,
      choices: [choice.openai],
      using: USING.openai,
      auto: USING.openai,
    },
  },
  google: {
    providers: [GOOGLE_ROW],
    image: {
      configured: true,
      official: false,
      override: false,
      credits_per_image: 0.5,
      choices: [choice.google],
      using: USING.google,
      auto: USING.google,
    },
  },
  cloud: {
    providers: [DEEPSEEK_ROW, CLOUD_ROW],
    image: {
      configured: true,
      official: true,
      override: false,
      credits_per_image: 0.5,
      choices: [choice.cloud],
      using: USING.cloud,
      auto: USING.cloud,
    },
  },
  override: {
    providers: [OPENAI_ROW, CLOUD_ROW],
    image: {
      configured: true,
      official: false,
      override: true,
      provider_id: 'openai',
      model: 'gpt-image-2.5-flare',
      edit_model: 'gpt-image-2.5-sunburst',
      credits_per_image: 0.5,
      choices: [choice.cloud, choice.openai],
      using: { ...USING.openai, source: 'override' },
      auto: USING.openai,
    },
  },
  custom: {
    providers: [DEEPSEEK_ROW, SEEDREAM_ROW],
    image: {
      configured: true,
      official: false,
      override: true,
      provider_id: 'seedream',
      model: 'doubao-seedream-5-0-pro-260628',
      credits_per_image: 0.5,
      choices: [choice.seedream],
      using: {
        source: 'override',
        provider_id: 'seedream',
        label: '我的生图接口（doubao-seedream-5-0-pro-260628）',
        generate_model: 'doubao-seedream-5-0-pro-260628',
        edit_model: 'doubao-seedream-5-0-pro-260628',
        own_key: true,
      },
    },
  },
  none: {
    providers: [DEEPSEEK_ROW],
    image: {
      configured: false,
      official: false,
      override: false,
      credits_per_image: 0.5,
      choices: [],
      unavailable_reason:
        '生图还没配：去设置 → 模型 →「生图」那一块选一个（用 Agents 工坊官方接口按张扣积分，或者用你自己的 OpenAI 兼容口）。这条职责照样能用——它会出 brief、尺寸规格和变体计划，只是不出图。',
    },
  },
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

async function stub(page, state) {
  await page.route('**/v1/models/providers', async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill(envelope({ ...json.data, providers: state.providers }))
  })
  await page.route('**/v1/models/image', (route) => route.fulfill(envelope(state.image)))
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

    const shoot = async (name, state, { theme = 'light', act, selector } = {}) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
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
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await stub(page, state)
      await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
      const block = page.locator('[data-testid="models-image"]')
      await block.waitFor({ timeout: 60_000 })
      if (act !== undefined) await act(page)
      const target = selector === undefined ? block : page.locator(selector).first()
      await target.scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await target.screenshot({ path: join(SHOTS, `${name}.png`) })
      console.log(`  📷 ${name}.png`)
      await context.close()
    }

    await shoot('1-own-openai-light', STATES.openai)
    await shoot('1-own-openai-dark', STATES.openai, { theme: 'dark' })
    await shoot('2-own-google', STATES.google)
    await shoot('3-cloud', STATES.cloud)
    await shoot('4-override', STATES.override)
    await shoot('5-custom-endpoint', STATES.none, {
      act: async (page) => {
        await page.selectOption('[data-testid="models-image-select"]', '__custom__')
        await page.locator('[data-testid="models-image-custom"]').waitFor()
      },
    })
    await shoot('6-none', STATES.none)
    await shoot('7-image-only-row', STATES.custom, {
      selector: '[data-testid="model-row"][data-id="seedream"]',
    })
    await shoot('8-image-only-block', STATES.custom)
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
