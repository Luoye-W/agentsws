#!/usr/bin/env node
/**
 * WP313：**插件动作通道在真 Chromium 里走一遍**——本地假后台 + 假本机服务，**不碰任何真站**。
 *
 * 单测里「手」是 jsdom；这里换成真浏览器，把单测摸不到的那几件事坐实（docs/101 §7 第 9 条）：
 * - MV3 service worker 长轮询领活、在一个**看得见的**标签页里按步骤表走；
 * - 页面脚本运行时注入（不进清单）、换页后重新放进去；
 * - 上传表用 DataTransfer 放进 `<input type=file>`，页面真的收到了那份字节；
 * - `chrome.downloads` 拿到导出文件的路径；`captureVisibleTab` 只凭站点权限能不能截；
 * - 顶上横条：等确认时点「确认提交」才应用；撞上验证码页就停、交给人。
 *
 * 假后台与假本机服务是同一个 127.0.0.1 端口（插件本来就有 `http://127.0.0.1/*` 的权限）。
 * 两家广告后台的可选权限在测试副本里改成「已授予」（真浏览器里那一步是用户点弹窗）。
 * 跑两轮：① 只有站点权限——实测 `captureVisibleTab` 截不了，横条请人点插件图标；人点了「停止」就停；
 * ② 用 `<all_urls>` 代替「人点了插件图标」（自动化点不到工具栏图标），整条走完。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-ext-actions.mjs [--headed] [--keep] [--shots]
 *   （`--shots` 把横条与设置页截到 `docs/assets/wp313/`）
 * 退出码：0 全过；1 有一步没过；2 起不来。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')
const SHOTS = join(ROOT, 'docs/assets/wp313')

const ba = await import(pathToFileURL(join(ROOT, 'packages/browser-action/dist/index.js')).href)
const SHEET = 'Campaign,Campaign status,Budget\nSpring sale,Paused,20\n'
const FINGERPRINT = await ba.sheetFingerprint(SHEET)

// ── 假后台 + 假本机服务 ────────────────────────────────────────────────────
const state = {
  queue: [],
  progress: [],
  evidence: [],
  downloads: [],
  results: [],
  uploaded: undefined,
  previewed: false,
  applied: false,
}

const page = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:14px system-ui;margin:48px 24px}button,material-button,[role=button],[role=menuitem]{display:inline-block;margin:4px;padding:6px 10px;border:1px solid #888;border-radius:6px;cursor:pointer}</style>
  </head><body>${body}<script>${script}</script></body></html>`

function fakeAds(url) {
  const u = new URL(url, 'http://x')
  if (u.pathname === '/aw/campaigns' && !u.searchParams.has('campaignId'))
    return page(
      'Campaigns – Google Ads（假）',
      `<h1>Campaigns（本地假后台）</h1><button aria-label="Download">Download</button>
       <div id="menu" hidden><div role="menuitem">.csv</div></div>`,
      `document.querySelector('[aria-label=Download]').onclick=()=>{document.getElementById('menu').hidden=false}
       document.querySelector('[role=menuitem]').onclick=()=>{const a=document.createElement('a');a.href='/__fake/campaigns.csv';a.download='campaigns.csv';document.body.append(a);a.click()}`,
    )
  if (u.pathname === '/aw/bulk/uploads')
    return page(
      'Bulk uploads – Google Ads（假）',
      `<h1>Uploads（本地假后台）</h1><button aria-label="Upload">+</button>
       <input type="file"><material-button>Preview</material-button><material-button>Apply</material-button>
       <div id="out"></div>`,
      `const out=document.getElementById('out');let file;
       document.querySelector('input[type=file]').addEventListener('change',async e=>{file=e.target.files[0];
         await fetch('/__fake/uploaded',{method:'POST',body:JSON.stringify({name:file.name,size:file.size,text:await file.text()})})})
       document.querySelectorAll('material-button')[0].onclick=()=>{if(file)out.innerHTML='<div data-bulk-upload="preview"><div data-bulk-upload="summary">1 change · 0 errors</div></div>'}
       document.querySelectorAll('material-button')[1].onclick=()=>{fetch('/__fake/applied',{method:'POST'});out.insertAdjacentHTML('beforeend','<div data-bulk-upload="status">Applied</div>')}`,
    )
  if (u.pathname.startsWith('/aw/') || u.searchParams.has('campaignId'))
    return page(
      'Verify（假）',
      '<p>Verify you are human</p><iframe src="/recaptcha/api2/anchor"></iframe>',
    )
  return undefined
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

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const p = u.pathname
  try {
    if (p === '/__fake/campaigns.csv') {
      res.writeHead(200, {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="campaigns.csv"',
      })
      res.end('Campaign,Status\nSpring sale,Enabled\n')
      return
    }
    if (p === '/__fake/uploaded') {
      state.uploaded = await bodyOf(req)
      return json(res, {})
    }
    if (p === '/__fake/applied') {
      state.applied = true
      return json(res, {})
    }
    if (p === '/v1/extension/hello')
      return json(res, {
        workspace_id: 'ws',
        workspace_name: '假品牌',
        cloud_linked: false,
        shares_to_public_library: false,
        scopes: ['ads.act'],
        server_version: 'e2e',
      })
    if (p === '/v1/extension/actions/next') {
      const job = state.queue.shift()
      return json(res, job === undefined ? { retry_after_ms: 60000 } : { job, retry_after_ms: 0 })
    }
    const m = p.match(
      /^\/v1\/extension\/actions\/([^/]+)\/(sheet|progress|evidence|download|result)$/,
    )
    if (m) {
      const [, id, what] = m
      if (what === 'sheet')
        return json(res, {
          name: 'spring.csv',
          mime: 'text/csv',
          base64: Buffer.from(SHEET).toString('base64'),
          fingerprint: FINGERPRINT,
        })
      const body = await bodyOf(req)
      if (what === 'progress') {
        state.progress.push({ id, ...body })
        return json(res, { stop: false, confirmed: false })
      }
      if (what === 'evidence') {
        state.evidence.push({
          id,
          tag: body.tag,
          bytes: Buffer.from(body.png_base64, 'base64').length,
          png: body.png_base64,
        })
        return json(res, { id: `ev_${state.evidence.length}`, kept_until: 'x' })
      }
      if (what === 'download') {
        state.downloads.push({ id, ...body })
        return json(res, { recorded: true })
      }
      state.results.push({ id, ...body })
      return json(res, { id })
    }
    const html = fakeAds(req.url ?? '/')
    if (html !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
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
const origins = { google_ads: BASE, meta_ads: BASE }
const account = { platform: 'google_ads', id: '123-456-7890', ocid: '42' }

// ── 插件副本：可选权限改成「已授予」（真浏览器里那一步是用户点弹窗）──────────────
const work = mkdtempSync(join(tmpdir(), 'agentsws-wp313-e2e-'))
function extCopy(name, allUrls) {
  const ext = join(work, name)
  cpSync(BUILD, ext, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions]
  manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions]
  // 第二轮：用 <all_urls> 代替「用户点了插件图标授权截图」（自动化点不到工具栏图标）
  if (allUrls) manifest.host_permissions.push('<all_urls>')
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))
  return ext
}

const { chromium } = require(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
)
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  — ${detail}`}`)
}
const until = async (fn, ms = 60_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const uploadJob = (id) =>
  ba.buildAdsJob({
    id,
    workspace_id: 'ws',
    account,
    action: {
      kind: 'upload_sheet',
      sheet: {
        name: 'spring.csv',
        mime: 'text/csv',
        fingerprint: FINGERPRINT,
        bytes: SHEET.length,
      },
    },
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    created_at: new Date().toISOString(),
    origins,
  })

/** 起一个装了插件副本的 Chromium，配好对，开设置页。 */
async function launch(name, allUrls) {
  const ext = extCopy(name, allUrls)
  const context = await chromium.launchPersistentContext(join(work, `${name}-profile`), {
    channel: 'chromium',
    headless: !flag('--headed'),
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  let [sw] = context.serviceWorkers()
  if (sw === undefined) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extId = new URL(sw.url()).host
  await sw.evaluate(
    (port) => chrome.storage.local.set({ 'agentsws.settings': { port, token: 'ext_e2e' } }),
    PORT,
  )
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extId}/options.html`)
  const poll = () => options.evaluate(() => chrome.runtime.sendMessage({ type: 'ads-poll' }))
  const adsPage = () => context.pages().find((p) => p.url().startsWith(`${BASE}/aw/`))
  return { context, options, poll, adsPage }
}

const banner = (p) => p.locator('#agentsws-ads-banner [data-testid="ads-banner"]')

let code = 0
const contexts = []
try {
  // ① 只有站点权限：截不到图 → 横条请人点插件图标 → 人点了横条上的「停止」→ 停
  {
    const b = await launch('site-only', false)
    contexts.push(b.context)
    state.queue.push(uploadJob('job_grant'))
    await b.poll()
    let asked = false
    await until(async () => {
      const p = b.adsPage()
      if (p === undefined) return false
      asked = (
        (await banner(p)
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('允许截图')
      return asked
    })
    check('只凭站点权限截不了图：横条上请人点插件图标', asked)
    const p = b.adsPage()
    if (p !== undefined) {
      if (flag('--shots')) {
        mkdirSync(SHOTS, { recursive: true })
        await p.screenshot({ path: join(SHOTS, 'banner-grant.png') })
      }
      await p.locator('#agentsws-ads-banner [data-testid="ads-banner-stop"]').click()
    }
    await until(() => state.results.some((r) => r.id === 'job_grant'))
    const r = state.results.find((x) => x.id === 'job_grant')
    check('横条上点「停止」→ 停', r?.outcome === 'stopped', r?.message ?? '没回结局')
    check('停在截图之前，没点应用', !state.applied)
  }

  // ② 截图有授权：快照下载 → 上传 → 预览截图 → 横条上确认 → 应用 → 截图 → 读回
  {
    const b = await launch('granted', true)
    contexts.push(b.context)
    state.uploaded = undefined
    state.queue.push(uploadJob('job_upload'))
    await b.poll()
    const waiting = await until(() =>
      state.progress.some((p) => p.id === 'job_upload' && p.waiting_confirm === true),
    )
    check('领到活、走到「等你确认」', waiting)
    const p = b.adsPage()
    check('在一个看得见的标签页里做（不是无界面）', p !== undefined, p?.url() ?? '')
    if (p !== undefined) {
      const yes = p.locator('#agentsws-ads-banner [data-testid="ads-banner-yes"]')
      await yes.waitFor({ timeout: 10_000 })
      if (flag('--shots')) await p.screenshot({ path: join(SHOTS, 'banner-confirm.png') })
      check('横条上出了「确认提交」', await yes.isVisible())
      await yes.click()
    }
    await until(() => state.results.some((r) => r.id === 'job_upload'))
    const r1 = state.results.find((r) => r.id === 'job_upload')
    check('结局：做完、读回对上', r1?.outcome === 'done', r1?.message ?? '没回结局')
    check(
      '上传框真的收到了批过的那份表（DataTransfer）',
      state.uploaded?.text === SHEET,
      JSON.stringify(state.uploaded ?? {}),
    )
    check('点了应用', state.applied)
    const shots = state.evidence.filter((e) => e.id === 'job_upload')
    check('截图：预览 + 提交后', shots.map((e) => e.tag).join(',') === 'preview,after')
    check(
      '截图是 PNG',
      shots.length > 0 &&
        shots.every(
          (e) => Buffer.from(e.png, 'base64').subarray(0, 4).toString('hex') === '89504e47',
        ),
    )
    const dl = state.downloads.find((d) => d.id === 'job_upload')
    // 自动化浏览器里下载被 Playwright 接走（文件名是随机串）；真 Chrome 里是「下载」文件夹里的 campaigns.csv
    check('改前快照：chrome.downloads 给了文件路径', (dl?.path ?? '') !== '', dl?.path ?? '没有')

    // ③ 撞上验证码页：停、交给人
    state.queue.push(
      ba.buildAdsJob({
        id: 'job_pause',
        workspace_id: 'ws',
        account,
        action: { kind: 'pause', entity: { level: 'campaign', id: '111' } },
        approval_id: 'ap_2',
        created_at: new Date().toISOString(),
        origins,
      }),
    )
    await b.poll()
    await until(() => state.results.some((r) => r.id === 'job_pause'))
    const r2 = state.results.find((r) => r.id === 'job_pause')
    check(
      '验证码页：停下交给人',
      r2?.outcome === 'handover' && (r2?.message ?? '').includes('验证'),
      r2?.message ?? '没回结局',
    )
    if (flag('--shots')) {
      await b.options.reload()
      await b.options.locator('[data-testid="ws-ads"]').waitFor()
      await b.options
        .locator('[data-testid="ws-ads"]')
        .screenshot({ path: join(SHOTS, 'options-ads.png') })
    }
  }
} catch (err) {
  console.error(err)
  code = 2
} finally {
  if (code !== 0 || checks.some((c) => !c.ok))
    console.log(
      '现场：',
      JSON.stringify(
        {
          progress: state.progress.slice(-5),
          results: state.results,
          downloads: state.downloads,
          evidence: state.evidence.map((e) => ({ id: e.id, tag: e.tag, bytes: e.bytes })),
          uploaded: state.uploaded,
        },
        null,
        1,
      ),
    )
  for (const c of contexts) await c.close().catch(() => {})
  server.close()
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true })
}
if (code === 0 && checks.some((c) => !c.ok)) code = 1
console.log(code === 0 ? `\n全过（${checks.length} 项）` : `\n没过（退出码 ${code}）`)
process.exit(code)
