#!/usr/bin/env node
/**
 * WP476（决策 1590）：匿名使用数据——端到端核对 + 截图，可重跑。**不往外网发任何一条**：
 * 「上报地址」是本进程里起的一个回环替身（`http://127.0.0.1:<PORT+1>`，假装 `t.agentsws.com`），
 * `/config` 回一把假 key，`/batch/` 只记下收到了什么。
 *
 * 1. 起一个全新的本机服务进程（临时数据目录、`AGENTSWS_TELEMETRY_HOST` 指替身），用真浏览器打开工作台；
 * 2. 第一次提示出现（浅 / 深截图）→ 点「知道了」不再出；
 * 3. 翻几页、点几颗关键按钮 → 替身收到的事件**只有**清单里的、页面只是路由模板、没有令牌 / 邮箱 / 具体编号；
 *    浏览器没有直接连替身（只连本机服务）；
 * 4. 设置 → 数据与隐私 → 开关（浅 / 深截图）→ 关掉之后再翻页、点按钮，替身一条都收不到。
 *
 * ```
 * pnpm exec tsc -b && pnpm -F @agentsws/workstation exec vite build
 * node scripts/e2e-wp476-shots.mjs [--port 4820] [--out <目录>]
 * ```
 * 审稿截图放私有仓，别提交进公开仓。不通过就退出码 1。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'out/wp476'))
const PORT = Number(argOf('--port') ?? '4820') || 4820
if (PORT === 4317 || PORT + 1 === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const FAKE_HOST = `http://127.0.0.1:${PORT + 1}`
const FAKE_KEY = 'phc_e2efakekeynotreal000000'
const OWNER = 'owner@localhost'

let failed = false
const check = (ok, what) => {
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 回环替身：假装 t.agentsws.com。 */
function startFakeHost() {
  const batches = []
  const other = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.method === 'GET' && req.url === '/config') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ key: FAKE_KEY, replay: false }))
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/batch/')) {
        batches.push(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"status":"Ok"}')
        return
      }
      other.push(`${req.method} ${req.url}`)
      res.writeHead(404)
      res.end()
    })
  })
  return new Promise((r) =>
    server.listen(PORT + 1, '127.0.0.1', () => r({ server, batches, other })),
  )
}

/** 页内跳转（React Router 认 popstate）。 */
async function go(page, path) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await page.waitForTimeout(800)
}

const events = (batches) => batches.flatMap((b) => b.batch ?? [])

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const fake = await startFakeHost()
  const dataDir = mkdtempSync(join(tmpdir(), 'wp476-e2e-'))
  const child = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    env: {
      ...process.env,
      AGENTSWS_PORT: String(PORT),
      AGENTSWS_DATA_DIR: dataDir,
      AGENTSWS_STATIC_DIR: join(ROOT, 'apps/workstation/dist'),
      AGENTSWS_TELEMETRY_HOST: FAKE_HOST,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: 'ignore',
  })
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const browser = await chromium.launch({ headless: true })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i += 1) {
      up = await fetch(`${BASE}/v1/health`).then(
        (r) => r.ok,
        () => false,
      )
      if (!up) await sleep(500)
    }
    check(up, `本机服务进程起来了（${BASE}，PID ${child.pid}）`)
    const post = async (path, body, token) =>
      (
        await (
          await fetch(`${BASE}${path}`, {
            method: body === undefined ? 'GET' : path.includes('settings') ? 'PUT' : 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        ).json()
      ).data
    const link = await post('/v1/auth/magic-link', { email: OWNER })
    const token = (await post('/v1/auth/verify', { token: link.token })).session_token
    const me = (
      await (await fetch(`${BASE}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json()
    ).data
    const assignment = me.assignments[0]?.id
    const settings = async (body) =>
      (
        await (
          await fetch(`${BASE}/v1/settings/telemetry`, {
            method: body === undefined ? 'GET' : 'PUT',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
              'x-assignment': assignment,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        ).json()
      ).data
    const view = await settings()
    check(
      view?.active === true && view.client?.api_host === '/v1/telemetry',
      `服务进程问到了替身的 key，工作台只拿到本机转发口（${JSON.stringify(view?.client)}）`,
    )

    for (const theme of ['light', 'dark']) {
      console.log(`── ${theme}`)
      await settings({ enabled: true, notice_seen: false })
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme,
        deviceScaleFactor: 2,
        // posthog-js 认得出无头浏览器 / 自动化（UA 里的 HeadlessChrome、navigator.webdriver）并整条丢掉——
        // 这里扮成普通 Chrome（桌面壳是 Electron，不在它的名单里）
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      })
      await context.addInitScript(
        ([t, th, dbg]) => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false })
          Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
          window.localStorage.setItem('agentsws.session_token', t)
          window.localStorage.setItem('agentsws.theme', th)
          if (dbg) window.localStorage.setItem('ph_debug', 'true')
        },
        [token, theme, process.env.WP476_DEBUG === '1'],
      )
      const page = await context.newPage()
      const direct = []
      page.on('request', (r) => {
        if (!r.url().startsWith(BASE)) direct.push(r.url())
      })
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      if (process.env.WP476_DEBUG === '1') {
        page.on('response', (r) => {
          if (/telemetry|no-external|posthog/.test(r.url()))
            console.log(`     · ${r.request().method()} ${r.url()} → ${r.status()}`)
        })
        page.on('console', (m) => {
          if (m.type() === 'error' || /posthog|PostHog/i.test(m.text()))
            console.log(`     · console: ${m.text().slice(0, 200)}`)
        })
      }
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
      if (page.url().includes('/onboarding')) {
        await page.getByText('先跳过').first().click()
        await page.waitForTimeout(1500)
      }
      const notice = page.getByTestId('telemetry-notice')
      await notice.waitFor({ timeout: 60_000 }).catch(() => undefined)
      check((await notice.count()) > 0, '第一次提示出现了')
      await page.screenshot({ path: join(SHOTS, `${theme}-1-first-notice.png`) })
      if ((await notice.count()) > 0) {
        await notice.screenshot({ path: join(SHOTS, `${theme}-1b-first-notice-close.png`) })
        await page.getByTestId('telemetry-notice-ok').click()
        await page.waitForTimeout(500)
        check((await page.getByTestId('telemetry-notice').count()) === 0, '点「知道了」后不再出')
      }

      // 翻几页、点几颗关键按钮
      const before = events(fake.batches).length
      await go(page, '/todos')
      await go(page, '/inbox')
      await go(page, `/positions/${assignment}`)
      // 关键按钮：顶上的搜索（⌘K）——点开再关上
      const searchBtn = page.getByTestId('shell-search')
      check((await searchBtn.count()) > 0, '顶上有搜索按钮（shell-search → shell.search）')
      if ((await searchBtn.count()) > 0) {
        await searchBtn.first().click()
        await page.waitForTimeout(500)
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      }
      await go(page, '/settings/privacy')
      const row = page.getByTestId('settings-telemetry')
      await row.waitFor({ timeout: 30_000 }).catch(() => undefined)
      check((await row.count()) > 0, '设置 → 数据与隐私里有「帮助改进工坊」')
      if ((await row.count()) > 0) {
        await row.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(SHOTS, `${theme}-2-settings-privacy.png`) })
      }
      // SDK 攒一小批再发（默认几秒一批），等它发到本机、本机再转给替身
      await page.waitForTimeout(6000)
      const got = events(fake.batches).slice(before)
      const names = [...new Set(got.map((e) => e.event))].sort()
      check(got.length > 0, `替身收到了事件：${names.join('、')}（${got.length} 条）`)
      const click = got.find((e) => e.event === 'ui_click')
      check(click?.properties?.button_id === 'shell.search', '点按钮记的是固定编号 shell.search')
      if (theme === 'light' && click !== undefined)
        console.log(`     一条按钮事件出门时长这样：${JSON.stringify(click)}`)
      const routes = [...new Set(got.map((e) => e.properties?.route).filter(Boolean))].sort()
      console.log(`     页面：${routes.join('  ')}`)
      check(
        got.every((e) =>
          [
            '$pageview',
            'app_opened',
            'ui_click',
            'client_error',
            'task_finished',
            'card_decided',
          ].includes(e.event),
        ),
        '只有清单里的事件',
      )
      const text = JSON.stringify(got)
      check(
        !text.includes(token) && !text.includes(OWNER) && !text.includes(String(assignment)),
        '没有令牌、邮箱、具体编号（分配 id）',
      )
      check(
        got.every((e) => e.properties?.distinct_id === view.install_id),
        '匿名号就是这台机器的匿名设备号',
      )
      check(direct.length === 0, `浏览器只连本机服务（直连外面的：${direct.length} 个）`)

      // 关掉 → 之后一条都收不到
      const sw = page.getByTestId('settings-telemetry-switch')
      if ((await sw.count()) > 0) {
        await sw.click()
        await page.waitForTimeout(800)
        check((await sw.getAttribute('aria-checked')) === 'false', '开关关上了')
        await page.screenshot({ path: join(SHOTS, `${theme}-3-settings-off.png`) })
        // 关掉那一刻 SDK 手上可能还有正在排队的：等它发完再数
        await page.waitForTimeout(6000)
        const offAt = events(fake.batches).length
        await page.keyboard.press('Escape')
        await go(page, '/todos')
        await go(page, '/inbox')
        await page.waitForTimeout(6000)
        check(events(fake.batches).length === offAt, '关掉之后替身一条都没再收到')
      }
      await context.close()
    }
    check(fake.other.length === 0, `替身没收到别的路（${fake.other.join(', ')}）`)
  } finally {
    await browser.close()
    child.kill('SIGTERM')
    await new Promise((r) => child.once('exit', r))
    fake.server.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  console.log(failed ? '\n有没过的' : `\n全部通过，截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}

await main()
