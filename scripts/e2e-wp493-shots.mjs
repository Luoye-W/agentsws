#!/usr/bin/env node
/**
 * WP493：ego 能用时社媒（Reddit）岗位不再催「先装好浏览器插件」、连接卡上插件显示「备用」——浅 / 深各拍一套
 * （不联网、不接真 AI、不碰 4317、**不碰真的 ego**）。
 *
 * 本进程里起一个 demo（真服务进程 + 演示世界 + stub 运行时），浏览器设置指到一个**假的 `ego-browser`**
 * （临时目录里的一个小 node 脚本：`skill` 回版本行、`nodejs` 回「连得上」，读页一律回空）——真 ego 一次都不起。
 * 先拍一张「没有 ego」（老样子：顶上一行装插件、连接卡插件亮红），再选上 ego 拍「ego 能用」。
 *
 * ```
 * npx tsc -b && pnpm -F @agentsws/workstation exec vite build   # demo 服务的是 dist
 * node scripts/e2e-wp493-shots.mjs --port 4962 --out <目录> [--no-check]
 * ```
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const SHOTS = resolve(argOf('--out') ?? join(ROOT, 'tmp/wp493'))
const PORT = Number(argOf('--port') ?? '4962') || 4962
const CHECK = !args.includes('--no-check')
if (PORT === 4317) throw new Error('别用 4317（那是本机正在用的服务）')
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = 'wang@nordvolt.example'

/** 假的 ego-browser：不开任何页面。 */
const FAKE_EGO = `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === 'skill') {
  console.log('[ego-browser:skill] ego-browser usage guide v2.1.0')
  process.exit(0)
}
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (input.includes('listTaskSpaces')) return console.log('@@OK 0')
  const m = /^const CFG = (.*);$/m.exec(input)
  const cfg = m ? JSON.parse(m[1]) : {}
  const res = { state: 'ok', closed: true, duration_ms: 1, steps: [] }
  if (cfg.out) fs.writeFileSync(cfg.out, JSON.stringify(res))
  console.log('@@FINAL ' + JSON.stringify(res))
})
`

async function call(method, path, body, token, asg) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(asg === undefined ? {} : { 'x-assignment': asg }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? ''}`)
  return json.data
}
async function login(email) {
  const link = await call('POST', '/v1/auth/magic-link', { email })
  return (await call('POST', '/v1/auth/verify', { token: link.token })).session_token
}

let failed = false
const check = (ok, what) => {
  if (!CHECK) return
  if (ok) console.log(`  ✅ ${what}`)
  else {
    failed = true
    console.error(`  ❌ ${what}`)
  }
}
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), ...opts })
  console.log(`  📷 ${name}.png`)
}

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  /*
   * 真 ego 一次都不碰：demo 探 ego 按环境找（PATH、用户目录）——用户目录换成临时目录、PATH 去掉 ~/.local/bin，
   * 这台机器上装着的 ego 就探不到；只读那一路显式打开（demo 缺省关），浏览器设置指到下面那个假的。
   */
  // Playwright 的浏览器装在真用户目录下：换用户目录之前先记住
  process.env.PLAYWRIGHT_BROWSERS_PATH ??=
    process.platform === 'darwin'
      ? join(process.env.HOME ?? '', 'Library/Caches/ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : join(process.env.HOME ?? '', '.cache/ms-playwright')
  const fakeHome = mkdtempSync(join(tmpdir(), 'wp493-home-'))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  process.env.PATH = (process.env.PATH ?? '')
    .split(':')
    .filter((d) => !d.includes('.local/bin') && !d.includes('/ego'))
    .join(':')
  process.env.AGENTSWS_EGO_READ = 'on'
  const fakeDir = mkdtempSync(join(tmpdir(), 'wp493-fake-ego-'))
  const fakeEgo = join(fakeDir, 'ego-browser')
  writeFileSync(fakeEgo, FAKE_EGO)
  chmodSync(fakeEgo, 0o755)
  const { chromium } = require(
    join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
  )
  const { createDemo } = await import(pathToFileURL(join(ROOT, 'apps/cli/dist/demo.js')).href)
  const demo = await createDemo({ root: ROOT, port: PORT, quiet: true })
  await demo.server.listen()
  const browser = await chromium.launch({ headless: true })
  try {
    const server = demo.server
    const ws = server.bootstrap.workspace.id
    const person_id = server.bootstrap.person.id
    const owner = await login(OWNER)
    const mine = server.roles.assignments
      .listByPerson(person_id, { workspace_id: ws })
      .filter((a) => a.revoked_at === undefined)
    const reddit = mine.find((a) => a.role_id === 'social.reddit')
    const ownerAsg = mine.find((a) => a.role_id === 'common.owner')
    if (reddit === undefined || ownerAsg === undefined)
      throw new Error('演示世界里没有 Reddit 运营 / 负责人')
    const needs = () =>
      call('GET', `/v1/extension/needs?roles=social.reddit`, undefined, owner, reddit.id)

    const pass = async (theme, tag) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        timezoneId: 'Asia/Shanghai',
      })
      await context.addInitScript(
        ([t, th]) => {
          try {
            window.localStorage.setItem('agentsws.session_token', t)
            window.localStorage.setItem('agentsws.theme', th)
          } catch {}
        },
        [owner, theme],
      )
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error(`  ⚠️ 页面报错：${e.message}`))
      await page.goto(`${BASE}/positions/${reddit.id}`, { waitUntil: 'load', timeout: 90_000 })
      await page.getByTestId('rail-cards').waitFor({ timeout: 60_000 })
      await page.waitForTimeout(2500)
      const nag = await page.getByText('先装好浏览器插件').count()
      if (tag === 'ego') check(nag === 0, `[${theme}] ego 能用：岗位页没有「先装好浏览器插件」`)
      else check(nag > 0, `[${theme}] 没有 ego：岗位页照旧有「先装好浏览器插件」`)
      await shot(page, `${theme}-${tag}-1-position`)
      const row = page.getByTestId('rail-list-row-connections')
      if ((await row.count()) > 0) {
        await row.click()
        const panel = page.getByTestId('connections-panel')
        await panel.waitFor({ timeout: 20_000 }).catch(() => undefined)
        await page.waitForTimeout(1500)
        const rows = page.getByTestId('connection-extension-rows')
        const text = (await rows.count()) > 0 ? await rows.first().innerText() : ''
        if (tag === 'ego') {
          check(
            /ego 浏览器/.test(text) && /备用/.test(text),
            `[${theme}] 连接卡：ego 一行 + 插件「备用」（${text.replace(/\n/g, ' / ')}）`,
          )
          check(
            (await rows.locator('[data-todo="true"]').count()) === 0,
            `[${theme}] 连接卡插件那几行不亮红`,
          )
        } else check(/去配对/.test(text), `[${theme}] 没有 ego：插件那一行亮红「去配对」`)
        await shot(page, `${theme}-${tag}-2-connections`)
      } else check(false, `[${theme}] 没找到清单卡「连接」那一行`)
      await context.close()
    }

    // ① 没有 ego（老样子）
    const before = await needs()
    check(
      before.plugin_backup !== true && before.uses.includes('reddit'),
      '没有 ego：要插件读 Reddit',
    )
    await pass('light', 'before')

    // ② 选上 ego（假的 ego-browser）
    await call(
      'PUT',
      '/v1/settings/browser',
      { mode: 'ego', ego_path: fakeEgo },
      owner,
      ownerAsg.id,
    )
    let v = await needs()
    for (let i = 0; i < 40 && v.plugin_backup !== true; i += 1) {
      await new Promise((r) => setTimeout(r, 250))
      v = await needs()
    }
    check(
      v.plugin_backup === true && v.uses.length === 0,
      `ego 能用：插件是备用（${JSON.stringify(v.ego_covers)}）`,
    )
    for (const theme of ['light', 'dark']) await pass(theme, 'ego')
  } finally {
    await browser.close()
    await demo.close()
    rmSync(fakeDir, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
