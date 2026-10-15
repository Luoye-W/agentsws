#!/usr/bin/env node
/**
 * WP345（决策 871）：**插件跟着工坊更新**在真 Chromium 里走一遍——本地假本机服务 + 假广告后台，不碰任何真站。
 *
 * 用的是真东西的地方：插件是 `apps/extension/build/chrome-mv3`（带固定 key）；往固定文件夹里放新版用的是
 * 桌面壳自己那一份 `apps/desktop/dist/extension-sync.js`（抄到旁边 → 校验 → 整体换）；插件里的「问新版 →
 * 关闸等空闲 → reload → 报版本」是插件自己的代码。
 *
 * 走的步骤：
 * 1. 工坊放 v1 → 「加载已解压」那个固定文件夹（Playwright 只能用 `--load-extension` 装）→ id 是固定 key 算出来的那个；
 * 2. 设置页里配对；存一个记号进 `chrome.storage`；点一下（真的用户手势）授广告后台的可选权限；
 * 3. 插件正挂着一个领活的长轮询 → 工坊放 v2（多要一条 `notifications` 权限）→ 插件发现新版、关闸；
 *    这时本机把一件活交给挂着的那个长轮询 → 插件把这件做完、回了结局，**之后**才重载；
 * 4. 重载后：版本是 v2、id 没变、配对还在、记号还在、广告后台的可选权限还在、新多要的权限直接生效；
 *    插件报上来「从 v1 换来」；重载后再排一件活，新版照常领走做完（队列没丢）；
 * 5. Chrome 关着时工坊放 v3 → 再开 Chrome：直接是 v3，存的东西都在；
 * 6. 本机说文件夹里是一个插件永远换不成的版本 → 插件只重载一次、报「放弃了」，再问也不重载。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-ext-update.mjs [--headed] [--keep] [--json <文件>]
 * 退出码：0 全过；1 有一步没过；2 起不来。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n) => {
  const i = args.indexOf(n)
  return i < 0 ? undefined : args[i + 1]
}
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')
const EXPECTED_ID = 'mlbfinfiigagllemohnopbhfdghagijg'
const ADS_ORIGIN = 'https://ads.google.com/*'

const sync = await import(pathToFileURL(join(ROOT, 'apps/desktop/dist/extension-sync.js')).href)
const ba = await import(pathToFileURL(join(ROOT, 'packages/browser-action/dist/index.js')).href)
const { chromium } = require(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
)

const work = mkdtempSync(join(tmpdir(), 'agentsws-wp345-e2e-'))
const folder = sync.extensionFolder(join(work, 'userData'))
const profile = join(work, 'profile')

/**
 * 造一版「安装包里的插件」：真构建 + 改版本号（+ 多要几条权限）。
 *
 * 测试副本另改两处（与 e2e-ext-actions 同一个办法）：广告后台的站点权限与下载改成「已授予」——自动化点不到
 * Chrome 自己的权限弹窗，而这一单要看的是「挂着长轮询时换版」，不是授权；可选权限多一条没有警告的 `idle`，
 * 它在用户点一下时**不弹窗直接授予**，用来验证「之前授的可选权限重载后还在」。
 */
function bundle(version, extraPermissions = []) {
  const dir = join(work, `bundle-${version}`)
  cpSync(BUILD, dir, { recursive: true })
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  m.version = version.split('-')[0]
  m.version_name = version
  m.permissions = [...m.permissions, 'downloads', ...extraPermissions]
  m.host_permissions = [...m.host_permissions, ADS_ORIGIN]
  m.optional_permissions = [...m.optional_permissions.filter((x) => x !== 'downloads'), 'idle']
  m.optional_host_permissions = m.optional_host_permissions.filter((x) => x !== ADS_ORIGIN)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
  return dir
}
/** 工坊启动时做的那一步（桌面壳自己那一份代码）。 */
const workshopStarts = (version, extra) =>
  sync.syncBundledExtension({
    source: bundle(version, extra),
    target: folder,
    now: () => new Date(),
  })

// ── 假本机服务 + 假广告后台（同一个 127.0.0.1 端口）────────────────────────
const state = {
  reports: [],
  results: [],
  claims: [],
  queue: [],
  /** 有人挂着长轮询时，交活给它。 */
  waiters: [],
  /** 第 6 步：让本机谎报文件夹里的版本。 */
  fakeFolder: undefined,
}
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify(
      status < 300 ? { ok: true, data } : { ok: false, error: { message: String(data) } },
    ),
  )
}
async function bodyOf(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const p = u.pathname
  try {
    if (p === '/v1/extension/pair')
      return json(res, {
        token: 'ext_e2e',
        token_id: 'tok_1',
        workspace_id: 'ws',
        scopes: ['kol.observe', 'kol.capture', 'ads.act', 'reddit.read', 'reddit.write'],
        expires_at: '2099-01-01T00:00:00.000Z',
      })
    if (p === '/v1/extension/hello')
      return json(res, {
        workspace_id: 'ws',
        workspace_name: '假品牌',
        cloud_linked: false,
        shares_to_public_library: false,
        scopes: ['ads.act'],
        server_version: 'e2e',
      })
    if (p === '/v1/extension/version') {
      const body = await bodyOf(req)
      state.reports.push({ ...body, at: Date.now() })
      const folder_version =
        state.fakeFolder ?? sync.manifestVersion(folder, sync.nodeExtensionSyncFs())
      return json(res, folder_version === undefined ? {} : { folder_version })
    }
    if (p.startsWith('/v1/extension/reddit/')) return json(res, { retry_after_ms: 60000 })
    if (p === '/v1/extension/actions/next') {
      let job = state.queue.shift()
      if (job === undefined) {
        // 长轮询：挂着等最多 8 秒
        job = await new Promise((resolveJob) => {
          const t = setTimeout(() => {
            state.waiters = state.waiters.filter((w) => w !== resolveJob)
            resolveJob(undefined)
          }, 8000)
          state.waiters.push((j) => {
            clearTimeout(t)
            resolveJob(j)
          })
        })
      }
      if (job !== undefined) state.claims.push({ id: job.id, at: Date.now() })
      return json(res, job === undefined ? { retry_after_ms: 60000 } : { job, retry_after_ms: 0 })
    }
    const m = p.match(/^\/v1\/extension\/actions\/([^/]+)\/(progress|evidence|download|result)$/)
    if (m) {
      const body = await bodyOf(req)
      if (m[2] === 'result') state.results.push({ id: m[1], outcome: body.outcome, at: Date.now() })
      if (m[2] === 'progress') return json(res, { stop: false, confirmed: false })
      if (m[2] === 'evidence') return json(res, { id: 'ev', kept_until: 'x' })
      if (m[2] === 'download') return json(res, { recorded: true })
      return json(res, { id: m[1] })
    }
    if (p.startsWith('/aw/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        page(
          'Verify（假）',
          '<p>Verify you are human</p><iframe src="/recaptcha/api2/anchor"></iframe>',
        ),
      )
      return
    }
    res.writeHead(404)
    res.end()
  } catch (err) {
    json(res, String(err), 500)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const giveJob = (job) => {
  const w = state.waiters.shift()
  if (w === undefined) state.queue.push(job)
  else w(job)
}
const pauseJob = (id) =>
  ba.buildAdsJob({
    id,
    workspace_id: 'ws',
    account: { platform: 'google_ads', id: '123-456-7890', ocid: '42' },
    action: { kind: 'pause', entity: { level: 'campaign', id: '111' } },
    approval_id: `ap_${id}`,
    created_at: new Date().toISOString(),
    origins: { google_ads: BASE, meta_ads: BASE },
  })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
const until = async (fn, ms = 60_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !flag('--headed'),
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
  })
  return context
}
const workerOf = async (context) => {
  const sw = context.serviceWorkers().find((w) => w.url().includes(EXPECTED_ID))
  return sw ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }))
}
async function optionsPage(context) {
  const p = await context.newPage()
  await p.goto(`chrome-extension://${EXPECTED_ID}/options.html`)
  return p
}
/** chrome://extensions 页面自己的 developerPrivate（与人在那一页上点的同一套）。 */
async function extensionsPage(context) {
  const p = await context.newPage()
  await p.goto('chrome://extensions')
  return {
    devMode: (on) =>
      p.evaluate(
        (v) =>
          new Promise((r) =>
            chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: v }, r),
          ),
        on,
      ),
    info: () =>
      p.evaluate(
        (id) =>
          new Promise((r) =>
            chrome.developerPrivate.getExtensionInfo(id, (i) =>
              r({
                state: i?.state,
                disabled_because: Object.entries(i?.disableReasons ?? {})
                  .filter(([, v]) => v)
                  .map(([k]) => k),
              }),
            ),
          ),
        EXPECTED_ID,
      ),
    close: () => p.close(),
  }
}
const send = (p, message) => p.evaluate((m) => chrome.runtime.sendMessage(m), message)
const swState = (sw) =>
  sw.evaluate(
    async (origin) => ({
      version: chrome.runtime.getManifest().version_name,
      id: chrome.runtime.id,
      storage: await chrome.storage.local.get(['agentsws.settings', 'e2e.marker']),
      ads: await chrome.permissions.contains({ origins: [origin], permissions: ['downloads'] }),
      idle: await chrome.permissions.contains({ permissions: ['idle'] }),
      notifications: await chrome.permissions.contains({ permissions: ['notifications'] }),
    }),
    ADS_ORIGIN,
  )

let code = 0
const contexts = []
const V1 = '0.9.0-e2e.1'
const V2 = '0.9.1-e2e.2'
const V3 = '0.9.2-e2e.3'
try {
  // ① 工坊放 v1，加载已解压
  const first = await workshopStarts(V1)
  check('工坊第一次放插件：installed', first.status === 'installed', JSON.stringify(first))
  let context = await launch()
  contexts.push(context)
  let sw = await workerOf(context)
  check('扩展 id 是固定 key 算出来的那个', new URL(sw.url()).host === EXPECTED_ID, sw.url())
  // 用户「加载已解压」之前要打开开发者模式（Chrome 155 起：开发者模式关着时，从文件夹装的插件一重载就被停用）
  const extPage = await extensionsPage(context)
  await extPage.devMode(true)

  // ② 配对（设置页里填码）+ 记号 + 授可选权限（真的点一下）
  let options = await optionsPage(context)
  await sw.evaluate((port) => chrome.storage.local.set({ 'agentsws.settings': { port } }), PORT)
  await options.reload()
  await options.locator('[data-testid="ws-code"]').fill('123456')
  await options.getByRole('button', { name: '配对' }).click()
  await options
    .locator('[data-testid="ws-paired"]', { hasText: '已配对' })
    .waitFor({ timeout: 10_000 })
  await sw.evaluate(() => chrome.storage.local.set({ 'e2e.marker': 'keep-me' }))
  await options.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'e2e-grant'
    b.textContent = 'grant'
    b.onclick = () => {
      chrome.permissions.request({ permissions: ['idle'] })
    }
    document.body.prepend(b)
  })
  await options.click('#e2e-grant')
  const granted = await until(async () => (await swState(sw)).idle, 10_000)
  check('点一下授了一条可选权限（idle，没有警告、不弹窗）', granted)
  const reportedV1 = await until(() => state.reports.some((r) => r.version === V1), 10_000)
  check('配上之后插件报了自己的版本', reportedV1, JSON.stringify(state.reports.at(-1) ?? {}))
  check(
    '设置页显示版本',
    (await options.locator('[data-testid="ws-version"]').textContent()) === V1,
  )

  // ③ 插件挂着长轮询 → 工坊放 v2 → 插件关闸等空闲；本机把一件活交给挂着的那个 → 做完、回结局 → 才重载
  await send(options, { type: 'ads-poll' })
  const waiting = await until(() => state.waiters.length > 0, 10_000)
  check('插件正挂着一个领活的长轮询', waiting)
  const second = await workshopStarts(V2, ['notifications'])
  check(
    '工坊放了新版（多要一条权限）：updated',
    second.status === 'updated',
    JSON.stringify(second),
  )
  const reloadedEvent = context.waitForEvent('serviceworker', { timeout: 90_000 })
  await send(options, { type: 'update-check' })
  await new Promise((r) => setTimeout(r, 1500))
  giveJob(pauseJob('job_during_update'))
  sw = await reloadedEvent
  const backAt = Date.now()
  const r1 = state.results.find((r) => r.id === 'job_during_update')
  check('重载前那件活做完、回了结局（没扔在半路）', r1 !== undefined, JSON.stringify(r1 ?? {}))
  const reported = await until(() => state.reports.some((r) => r.reloaded_from === V1), 15_000)
  const rep = state.reports.find((r) => r.reloaded_from === V1)
  check('重载后报「从 v1 换来」', reported && rep?.version === V2, JSON.stringify(rep ?? {}))
  check(
    '结局在重载之前（先做完再重载）',
    r1 !== undefined && rep !== undefined && r1.at <= rep.at && r1.at <= backAt,
    `结局 ${r1?.at} / 重载后报版本 ${rep?.at}`,
  )
  check('那件活只领了一次', state.claims.filter((c) => c.id === 'job_during_update').length === 1)

  // ④ 重载后：开着没有、版本、id、配对、记号、可选权限、新权限
  const info = await extPage.info()
  check('重载后插件开着（没被停用）', info.state === 'ENABLED', JSON.stringify(info))
  await extPage.close()
  const after = await swState(sw)
  check('版本换成 v2', after.version === V2, after.version)
  check('id 没变', after.id === EXPECTED_ID, after.id)
  check('配对还在（令牌在）', after.storage['agentsws.settings']?.token === 'ext_e2e')
  check('chrome.storage 的记号还在', after.storage['e2e.marker'] === 'keep-me')
  check('之前授的可选权限还在', after.idle === true)
  check('新版多要的权限直接生效（插件照常开着）', after.notifications === true)
  options = await optionsPage(context)
  giveJob(pauseJob('job_after_update'))
  await send(options, { type: 'ads-poll' })
  const done2 = await until(() => state.results.some((r) => r.id === 'job_after_update'), 30_000)
  check('重载后新版照常领活做完（队列没丢）', done2)
  await context.close()
  contexts.pop()

  // ⑤ Chrome 关着时工坊放 v3 → 再开
  const third = await workshopStarts(V3)
  check('Chrome 关着时工坊放 v3', third.status === 'updated')
  context = await launch()
  contexts.push(context)
  sw = await workerOf(context)
  const reopened = await swState(sw)
  check('再开 Chrome 直接是 v3', reopened.version === V3, reopened.version)
  check(
    '配对与记号还在',
    reopened.storage['agentsws.settings']?.token === 'ext_e2e' &&
      reopened.storage['e2e.marker'] === 'keep-me',
  )

  // ⑥ 换不成的版本：只重载一次、报「放弃了」，之后不再重载
  state.fakeFolder = '9.9.9-e2e.99'
  let workers = 0
  context.on('serviceworker', () => {
    workers += 1
  })
  options = await optionsPage(context)
  await send(options, { type: 'update-check' })
  const gaveUp = await until(() => state.reports.some((r) => r.gave_up === '9.9.9-e2e.99'), 30_000)
  check('重载了还是旧版 → 报「放弃了」', gaveUp)
  options = await optionsPage(context)
  await send(options, { type: 'update-check' })
  await send(options, { type: 'update-check' })
  await new Promise((r) => setTimeout(r, 3000))
  check('之后再问也不再重载（只重载了一次）', workers === 1, `service worker 起了 ${workers} 次`)
} catch (err) {
  console.error(err)
  console.log(
    '现场：',
    JSON.stringify({
      reports: state.reports,
      results: state.results,
      claims: state.claims,
      waiters: state.waiters.length,
    }),
  )
  code = 2
} finally {
  for (const c of contexts) await c.close().catch(() => {})
  server.close()
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true })
}
if (code === 0 && checks.some((c) => !c.ok)) code = 1
const out = opt('--json')
if (out !== undefined)
  writeFileSync(out, `${JSON.stringify({ code, checks, reports: state.reports }, null, 2)}\n`)
console.log(code === 0 ? `\n全过（${checks.length} 项）` : `\n没过（退出码 ${code}）`)
process.exit(code)
