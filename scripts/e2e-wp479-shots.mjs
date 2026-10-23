#!/usr/bin/env node
/**
 * WP479（决策 1625）：订阅模型勾选启用——端到端核对 + 截图，可重跑。**不联网**：订阅目录是本机 pi-ai 的生成目录，
 * 「已登录 ChatGPT 订阅」是往临时数据目录的秘密库里放一条假记录（`{"type":"oauth"}`，不是任何真凭据），
 * 全程不跑补全。
 *
 * 1. 起一个全新的本机服务进程（临时数据目录），登录；停掉，放一条假的订阅登录记录；
 * 2. 再起：第一次算默认勾选（每条线最新那一版）→ 停掉，把 `models.json` 里 GPT-6.1 Sol 抹成「还没见过」
 *    （等于目录刚多了一个新模型）；
 * 3. 再起：铃铛里一条「ChatGPT 订阅有新模型：GPT-6.1 Sol」→ 点它到设置 → 模型，订阅那一行自己展开、标「新」；
 *    助理输入框的模型选择器只列勾上的。浅 / 深各拍一套。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp479-shots.mjs [--port 4880] [--out <目录>]
 * ```
 * 审稿截图放私有仓，别提交进公开仓。不通过就退出码 1。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'out/wp479'))
const PORT = Number(argOf('--port') ?? '4880') || 4880
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'owner@localhost'
const KEY = randomBytes(32).toString('hex')
const NEW_MODEL = 'gpt-6.1-sol'

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个服务进程（只停自己起的这个 PID）。 */
async function boot(dataDir) {
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      AGENTSWS_PORT: String(PORT),
      AGENTSWS_DATA_DIR: dataDir,
      AGENTSWS_STATIC_DIR: join(ROOT, 'apps/workstation/dist'),
      AGENTSWS_SECRETS_KEY: KEY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/v1/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (!up) await sleep(500)
  }
  if (!up) throw new Error('服务进程没起来')
  return child
}
async function stop(child) {
  if (child.exitCode !== null) return
  const gone = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([gone, sleep(8000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  await sleep(500)
}

/** 数据目录里那份 models.json（品牌目录在哪层都找得到）。 */
function findModelsJson(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'models.json') return p
    if (statSync(p).isDirectory()) {
      const hit = findModelsJson(p)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const dataDir = mkdtempSync(join(tmpdir(), 'wp479-e2e-'))
  const api = async (method, path, token, assignment, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(assignment === undefined ? {} : { 'x-assignment': assignment }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await res.json()).data
  }
  const login = async () => {
    const link = await api('POST', '/v1/auth/magic-link', undefined, undefined, { email: OWNER })
    const token = (
      await api('POST', '/v1/auth/verify', undefined, undefined, { token: link.token })
    ).session_token
    const me = await api('GET', '/v1/me', token)
    return { token, me, assignment: me.assignments[0]?.id }
  }

  let child = await boot(dataDir)
  const { me } = await login()
  const person = me.person?.id ?? me.person_id ?? me.assignments[0]?.person_id
  check(typeof person === 'string', `登录了（${person}）`)
  await stop(child)

  // 一条假的订阅登录记录（只有「登录过」这个事实；不是任何真凭据，全程不跑补全）
  const { createSecretStore } = await import(
    pathToFileURL(join(ROOT, 'apps/server/dist/secret-store.js')).href
  )
  const { subscriptionSecretId } = await import(
    pathToFileURL(join(ROOT, 'apps/server/dist/subscription.js')).href
  )
  const store = createSecretStore({
    dbPath: join(dataDir, 'secrets.sqlite'),
    clock: { now: () => new Date().toISOString() },
    env: { AGENTSWS_SECRETS_KEY: KEY },
  })
  store.put(subscriptionSecretId(person, 'openai-codex'), { record: '{"type":"oauth"}' })
  store.close()

  // 第一次：按规则算默认勾选
  child = await boot(dataDir)
  let s = await login()
  let view
  for (let i = 0; i < 20; i += 1) {
    view = await api('GET', '/v1/models/enabled', s.token, s.assignment)
    if (view?.sources?.some((x) => x.provider_id === 'openai-codex')) break
    await sleep(500)
  }
  const sub = view?.sources?.find((x) => x.provider_id === 'openai-codex')
  const ticked = sub?.models.filter((m) => m.enabled).map((m) => m.id) ?? []
  console.log(`     目录：${sub?.models.map((m) => m.id).join('、')}`)
  console.log(`     默认勾：${ticked.join('、')}`)
  check(sub?.models.length === 9, '订阅目录 9 个')
  check(
    JSON.stringify(ticked) ===
      JSON.stringify([
        'gpt-5.3-codex-spark',
        'gpt-5.5',
        'gpt-5.6-terra',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-6.1-sol',
      ]),
    '每条线只勾最新那一版',
  )
  await stop(child)
  const modelsJson = findModelsJson(dataDir)
  check(modelsJson !== undefined, `models.json 在 ${modelsJson}`)
  const baseline = readFileSync(modelsJson, 'utf8')

  /** 把 GPT-6.1 Sol 抹成「还没见过」（等于目录刚多了一个新模型）。 */
  const pretendNew = () => {
    const state = JSON.parse(baseline)
    const e = state.enabled_models['openai-codex']
    e.enabled = e.enabled.filter((m) => m !== NEW_MODEL)
    e.seen = e.seen.filter((m) => m !== NEW_MODEL)
    e.notified = e.notified.filter((m) => m !== NEW_MODEL)
    writeFileSync(modelsJson, JSON.stringify(state, null, 2))
  }

  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      pretendNew()
      child = await boot(dataDir)
      s = await login()
      // 碰一下模型面（目录读进来、对出新模型）
      for (let i = 0; i < 20; i += 1) {
        const v = await api('GET', '/v1/models/enabled', s.token, s.assignment)
        if (v?.sources?.some((x) => x.provider_id === 'openai-codex')) break
        await sleep(500)
      }
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
      })
      await context.addInitScript(
        ([t, th]) => {
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
        },
        [s.token, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      if (page.url().includes('/onboarding')) {
        await page.getByText('先跳过').first().click()
        await page.waitForTimeout(1500)
      }

      // ① 铃铛
      await page.getByTestId('notify-bell').first().click()
      const item = page.getByTestId('notify-item').filter({ hasText: '有新模型' })
      await item
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined)
      check((await item.count()) > 0, '铃铛里有「ChatGPT 订阅有新模型：GPT-6.1 Sol」')
      if ((await item.count()) > 0) {
        console.log(`     铃铛：${(await item.first().innerText()).replace(/\s+/g, ' ')}`)
        await page.screenshot({ path: join(SHOTS, `${theme}-1-bell-new-models.png`) })
        await item.first().click()
        await page.waitForTimeout(1500)
      }

      // ② 设置 → 模型：订阅那一行自己展开、标「新」
      const list = page.getByTestId('model-enable-list')
      await list
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined)
      check((await list.count()) > 0, '点铃铛到设置 → 模型，订阅那一行的清单自己展开')
      const fresh = page.locator(`[data-testid="model-enable-row"][data-model="${NEW_MODEL}"]`)
      check(
        (await fresh.count()) > 0 && (await fresh.getAttribute('data-fresh')) === 'true',
        'GPT-6.1 Sol 标「新」、没自动勾',
      )
      check((await fresh.getAttribute('data-enabled')) === 'false', '新模型不自动勾')
      await page.waitForTimeout(2500) // 等高亮退掉
      // 订阅那一行整行露出来（页头是吸顶的，滚到行顶再让出页头那一截）
      await page.evaluate(() => {
        const row = document.querySelector('[data-testid="model-row-subscription"]')
        row?.scrollIntoView({ block: 'start' })
        document.querySelector('[data-testid="settings-pane"]')?.scrollBy(0, -110)
      })
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(SHOTS, `${theme}-2-settings-list.png`) })

      // ③ 选择器只列勾上的
      await page.keyboard.press('Escape')
      // 页内跳转（整页重载会再进一次首次设置）
      await page.evaluate(() => {
        window.history.pushState({}, '', '/assistant')
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForTimeout(1500)
      console.log(`     助理页：${page.url()}`)
      const picker = page.getByTestId('free-chat-model').first()
      await picker.waitFor({ timeout: 30_000 }).catch(() => undefined)
      if ((await picker.count()) > 0) {
        await picker.click()
        await page.waitForTimeout(800)
        const text = await page.locator('body').innerText()
        check(
          !text.includes('GPT-6 Sol\n') && !text.includes('GPT-5.6 Luna'),
          '选择器里没有没勾的（GPT-6 Sol、GPT-5.6 Luna）',
        )
        check(text.includes('GPT-6 Astra'), '选择器里有勾上的（GPT-6 Astra）')
        await page.screenshot({ path: join(SHOTS, `${theme}-3-picker-enabled-only.png`) })
      } else {
        await page.screenshot({ path: join(SHOTS, `${theme}-3-debug-assistant.png`) })
        check(false, '助理页上有模型选择器')
      }

      // ④ 看过之后铃铛那一条收掉
      const after = await api('GET', '/v1/home', s.token, s.assignment)
      check(
        !(after?.alerts ?? []).some((a) => String(a.title).includes('有新模型')),
        '看过之后提醒收掉',
      )
      await context.close()
      await stop(child)
    }
  } finally {
    await browser.close()
    if (child.exitCode === null) await stop(child)
    rmSync(dataDir, { recursive: true, force: true })
  }
  console.log(failed ? '有没过的' : '全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
