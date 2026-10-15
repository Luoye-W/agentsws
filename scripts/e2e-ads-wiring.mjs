#!/usr/bin/env node
/**
 * WP316：**改广告接线要的几种新走法，在真 Chromium + 真插件里走一遍**——本地假后台 + 假本机服务，**不碰任何真站**。
 *
 * 照 WP313 的 `e2e-ext-actions.mjs` 搭（同一个 127.0.0.1 端口既是假后台又是假本机服务；插件副本的可选权限改成已授予）。
 * 本机服务那一侧的接线（卡 → 进队 → 读回核对 → 账本 → 开始投放 / 撤销）在 vitest 里用替身插件钉住
 * （`apps/server/test/wp316-ads-wiring.test.ts`）；这里钉插件这一侧单测摸不到的三件：
 *
 * ① **止损截不到图也先停**（决策 600 C）：只有站点权限（`captureVisibleTab` 截不了）→ 不请人点图标、不等，
 *    停前停后各导出一份，结局「做完」并记 `evidence_missing`；
 * ② **上传表的读回版**：上传 → 预览截图 → 横条上确认 → 应用 → 当场核「Applied」→ 回列表再导出一份 `result`；
 * ③ **Google 撤销上传**：「所有批量操作」里那一行点撤销 → 确认 → 读回「Undone」。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-ads-wiring.mjs [--headed] [--keep]
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
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')

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
  confirmed: new Set(),
  uploaded: undefined,
  applied: false,
  status: { 111: 'Enabled' },
  history: { 'agentsws-campaigns.csv': 'Applied' },
}

const page = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:14px system-ui;margin:48px 24px}button,material-button,[role=button],[role=menuitem]{display:inline-block;margin:4px;padding:6px 10px;border:1px solid #888;border-radius:6px;cursor:pointer}</style>
  </head><body>${body}<script>${script}</script></body></html>`

/** 统计表右上角的「下载 → .csv」（点了浏览器真的下一个文件）。 */
const DOWNLOAD = `<button aria-label="Download">Download</button>
  <div id="menu" hidden><div role="menuitem" data-dl>.csv</div></div>`
const DOWNLOAD_JS = `document.querySelector('[aria-label=Download]').onclick=()=>{document.getElementById('menu').hidden=false}
  document.querySelector('[data-dl]').onclick=()=>{const a=document.createElement('a');a.href='/__fake/campaigns.csv?'+Date.now();a.download='campaigns.csv';document.body.append(a);a.click()}`

function fakeAds(url) {
  const u = new URL(url, 'http://x')
  if (u.pathname === '/aw/campaigns' && u.searchParams.has('campaignId')) {
    const id = u.searchParams.get('campaignId')
    const st = state.status[id] ?? 'Enabled'
    return page(
      'Campaigns – Google Ads（假）',
      `<h1>Campaign ${id}</h1>${DOWNLOAD}
       <div data-row-id="${id}"><span data-column="status"><span role="button">${st}</span></span></div>
       <div id="st" hidden><div role="menuitem">Enabled</div><div role="menuitem">Paused</div></div>`,
      `${DOWNLOAD_JS}
       document.querySelector('[data-column=status] [role=button]').onclick=()=>{document.getElementById('st').hidden=false}
       for (const el of document.querySelectorAll('#st [role=menuitem]')) el.onclick=async()=>{
         await fetch('/__fake/status',{method:'POST',body:JSON.stringify({id:'${id}',status:el.textContent})});
         document.querySelector('[data-column=status] [role=button]').textContent=el.textContent;document.getElementById('st').hidden=true}`,
    )
  }
  if (u.pathname === '/aw/campaigns')
    return page('Campaigns – Google Ads（假）', `<h1>Campaigns</h1>${DOWNLOAD}`, DOWNLOAD_JS)
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
  if (u.pathname === '/aw/bulk/history') {
    const rows = Object.entries(state.history)
      .map(
        ([name, st]) =>
          `<div data-bulk-history-row="${name}"><b>${name}</b> <span data-column="status">${st}</span> <button aria-label="Undo">Undo</button></div>`,
      )
      .join('')
    return page(
      'All bulk actions – Google Ads（假）',
      `<h1>All bulk actions</h1>${rows}<div role="dialog" hidden><material-button>Undo</material-button></div>`,
      `let pick;for(const b of document.querySelectorAll('[aria-label=Undo]'))b.onclick=()=>{pick=b.closest('[data-bulk-history-row]').dataset.bulkHistoryRow;document.querySelector('[role=dialog]').hidden=false}
       document.querySelector('[role=dialog] material-button').onclick=async()=>{await fetch('/__fake/undo',{method:'POST',body:JSON.stringify({name:pick})});
         document.querySelector('[data-bulk-history-row="'+pick+'"] [data-column=status]').textContent='Undone';document.querySelector('[role=dialog]').hidden=true}`,
    )
  }
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
      res.end(`Campaign,Campaign ID,Campaign state\nSpring sale,111,${state.status[111]}\n`)
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
    if (p === '/__fake/status') {
      const b = await bodyOf(req)
      state.status[b.id] = b.status
      return json(res, {})
    }
    if (p === '/__fake/undo') {
      const b = await bodyOf(req)
      state.history[b.name] = 'Undone'
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
          name: 'agentsws-campaigns.csv',
          mime: 'text/csv',
          base64: Buffer.from(SHEET).toString('base64'),
          fingerprint: FINGERPRINT,
        })
      const body = await bodyOf(req)
      if (what === 'progress') {
        state.progress.push({ id, ...body })
        return json(res, { stop: false, confirmed: state.confirmed.has(id) })
      }
      if (what === 'evidence') {
        state.evidence.push({ id, tag: body.tag })
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

const work = mkdtempSync(join(tmpdir(), 'agentsws-wp316-e2e-'))
function extCopy(name, allUrls) {
  const ext = join(work, name)
  cpSync(BUILD, ext, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions]
  manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions]
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
const until = async (fn, ms = 540_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const job = (id, action) =>
  ba.buildAdsJob({
    id,
    workspace_id: 'ws',
    account,
    action,
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    created_at: new Date().toISOString(),
    origins,
  })

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
  return { context, poll }
}

let code = 0
const contexts = []
try {
  // ① 只有站点权限（截不了图）：止损照样先停，前后导出作证，不等人点图标
  {
    const b = await launch('stop-loss', false)
    contexts.push(b.context)
    const started = Date.now()
    state.queue.push(
      job('job_stop', {
        kind: 'pause',
        entity: { level: 'campaign', id: '111', name: 'Spring sale' },
        stop_loss: true,
      }),
    )
    await b.poll()
    await until(() => state.results.some((r) => r.id === 'job_stop'))
    const r = state.results.find((x) => x.id === 'job_stop')
    check('止损：截不到图也做完', r?.outcome === 'done', r?.message ?? '没回结局')
    check('后台里真的停了', state.status[111] === 'Paused', state.status[111])
    check(
      '结果里记了「没截到」（前、后两格）',
      r?.reads?.evidence_missing === 'before,after',
      r?.reads?.evidence_missing ?? '',
    )
    const tags = state.downloads.filter((d) => d.id === 'job_stop').map((d) => d.tag)
    check(
      '停前停后各导出一份（下载路径交回本机）',
      tags.join(',') === 'snapshot,result',
      tags.join(','),
    )
    check(
      '没去等人点插件图标（没卡在十分钟的授权等待上）',
      Date.now() - started < 540_000,
      `${Math.round((Date.now() - started) / 1000)} 秒`,
    )
  }

  // ② 截图有授权：上传 → 预览 → 确认 → 应用 → 当场核 Applied → 导出 result
  {
    const b = await launch('granted', true)
    contexts.push(b.context)
    state.queue.push(
      job('job_upload', {
        kind: 'upload_sheet',
        sheet: {
          name: 'agentsws-campaigns.csv',
          mime: 'text/csv',
          fingerprint: FINGERPRINT,
          bytes: SHEET.length,
        },
        readback: true,
      }),
    )
    await b.poll()
    const waiting = await until(() =>
      state.progress.some((p) => p.id === 'job_upload' && p.waiting_confirm === true),
    )
    check('上传：走到「等你确认」', waiting)
    // 工坊卡上点了「确认提交」（进度回执里带回 confirmed）
    state.confirmed.add('job_upload')
    await until(() => state.results.some((r) => r.id === 'job_upload'), 540_000)
    const r = state.results.find((x) => x.id === 'job_upload')
    check('上传：做完', r?.outcome === 'done', r?.message ?? '没回结局')
    check('上传框收到的是批过的那份表', state.uploaded?.text === SHEET)
    check('点了应用', state.applied)
    const tags = state.downloads.filter((d) => d.id === 'job_upload').map((d) => d.tag)
    check('改前一份 + 读回一份导出', tags.join(',') === 'snapshot,result', tags.join(','))
    const shots = state.evidence.filter((e) => e.id === 'job_upload').map((e) => e.tag)
    check('截图：预览 + 提交后', shots.join(',') === 'preview,after', shots.join(','))

    // ③ Google 撤销上传
    state.queue.push(
      job('job_undo', { kind: 'undo_upload', upload_name: 'agentsws-campaigns.csv' }),
    )
    await b.poll()
    await until(() => state.results.some((x) => x.id === 'job_undo'))
    const u = state.results.find((x) => x.id === 'job_undo')
    check('撤销：做完、读回「Undone」', u?.outcome === 'done', u?.message ?? '没回结局')
    check('后台那一行变成已撤销', state.history['agentsws-campaigns.csv'] === 'Undone')
    const ushots = state.evidence.filter((e) => e.id === 'job_undo').map((e) => e.tag)
    check('撤销前后截图', ushots.join(',') === 'before,after', ushots.join(','))
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
          evidence: state.evidence,
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
