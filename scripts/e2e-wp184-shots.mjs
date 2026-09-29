#!/usr/bin/env node
/**
 * WP184：左下角「场景」面板——用户自己装的官方桌面端那一行。截图的可重跑出处（不联网、不起任何场景）。
 *
 * 在本进程里起一个 demo；`DSH_HOME` / 工作区 / 「官方桌面端装在哪」都指向本脚本自己建的临时目录
 * （一个空的 `DeepSeek Harness.app` 目录当作「用户自己装的」——只拍那一行，不去点它），拍到
 * `docs/assets/wp184/scenes-official-desktop.png`。官方场景窗口本身的截图由
 * `apps/desktop/e2e/scene-window.spec.ts` 拍（`docs/assets/desktop/dsh-scene-window.png`）。
 *
 * ```
 * pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist，别拍旧界面
 * node scripts/e2e-wp184-shots.mjs [--port 4484]
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs/assets/wp184')

const args = process.argv.slice(2)
const i = args.indexOf('--port')
const PORT = Number(i >= 0 ? args[i + 1] : '4484')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

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

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  // 本脚本自己建的临时目录，拍完删掉
  const tmp = mkdtempSync(join(tmpdir(), 'agentsws-wp184-shots-'))
  const ws = mkdtempSync(join(tmpdir(), 'agentsws-wp184-shots-ws-'))
  const fakeApp = join(tmp, 'DeepSeek Harness.app')
  mkdirSync(fakeApp)
  process.env.AGENTSWS_DSH_HOME = join(tmp, 'dsh')
  process.env.AGENTSWS_DSH_WORKSPACE = ws
  process.env.AGENTSWS_OFFICIAL_DESKTOP_APP = fakeApp
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port: PORT, quiet: true })
  await demo.server.listen()
  let browser
  try {
    const owner = await login(OWNER)
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
    await page.goto(`${BASE}/?scenes=1`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="scene-official-desktop"]', { timeout: 20_000 })
    await page.waitForTimeout(300)
    const panel = page.locator('[data-testid="scene-panel"]')
    const box = await panel.boundingBox()
    await page.screenshot({
      path: join(SHOTS, 'scenes-official-desktop.png'),
      ...(box === null
        ? {}
        : {
            clip: {
              x: Math.max(0, box.x - 16),
              y: Math.max(0, box.y - 16),
              width: box.width + 32,
              height: box.height + 72,
            },
          }),
    })
    console.log('  📷 scenes-official-desktop.png')
  } finally {
    await browser?.close()
    await demo.close()
    rmSync(tmp, { recursive: true, force: true })
    rmSync(ws, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
