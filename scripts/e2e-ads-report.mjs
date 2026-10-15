#!/usr/bin/env node
/**
 * WP315：**「工坊日报」建立与每日导出在真 Chromium 里走一遍**——本地假后台 + 假本机服务，**不碰任何真站**。
 *
 * 照 WP313 的 `e2e-ext-actions.mjs` 搭（同一个做法：假后台与假本机服务同一个 127.0.0.1 端口，插件副本里
 * 两家后台的可选权限改成「已授予」），坐实单测摸不到的几件事：
 * - 步骤表里的选择器在真 DOM 上点得到（含中文报表名 `a >> text=工坊日报 · 广告系列`）；
 * - 一件导出活里连着点五次「下载 CSV」，`chrome.downloads` 五次都给了路径，文件真在盘上；
 * - 下下来的文件用 `ads-core` 解析得出行（看数据只用导出文件，不读页面上的数）。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-ads-report.mjs [--headed] [--keep]
 * 退出码：0 全过；1 有一步没过；2 起不来。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const core = await import(pathToFileURL(join(ROOT, 'packages/ads-core/dist/index.js')).href)

// ── 手写的样例导出（假名字、假编号）────────────────────────────────────────
const CSV = {
  广告系列:
    'Day,Campaign,Campaign ID,Campaign status,Budget,Currency code,Cost,Impr.,Clicks,Conversions,Conv. value\n2026-10-14,Spring Sale,111,Enabled,200.00,USD,90.00,1800,30,0,0.00\n',
  广告组:
    'Day,Campaign,Ad group,Ad group ID,Cost,Clicks\n2026-10-14,Spring Sale,Tiles,21,90.00,30\n',
  广告: 'Day,Campaign,Ad group,Ad ID,Headline 1,Cost,Clicks\n2026-10-14,Spring Sale,Tiles,31,Magnetic tiles,90.00,30\n',
  关键词:
    'Day,Campaign,Ad group,Keyword,Match type,Cost,Clicks\n2026-10-14,Spring Sale,Tiles,[magnetic tiles],Exact match,40.00,12\n',
  搜索字词:
    'Day,Search term,Campaign,Ad group,Cost,Clicks\n2026-10-14,magnet toys for kids,Spring Sale,Tiles,50.00,18\n',
}

const state = { saved: [], queue: [], progress: [], downloads: [], results: [] }

const page = (title, body, script) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:14px system-ui;margin:48px 24px}*[role],material-button,button,a{display:inline-block;margin:3px;padding:4px 8px;border:1px solid #999;border-radius:6px;cursor:pointer}</style>
  </head><body>${body}<script>${script}</script></body></html>`

const COMMON_JS = `
  let opened='';
  for (const a of document.querySelectorAll('a.saved')) a.onclick=(e)=>{e.preventDefault();opened=a.textContent.trim()}
  const save=[...document.querySelectorAll('[role=dialog] *')].find(e=>e.textContent.trim()==='Save');
  save.onclick=()=>{const n=document.querySelector('[role=dialog] input.name').value;
    fetch('/__fake/saved',{method:'POST',body:n});
    // 像单页应用那样就地多出一行（不整页刷新：整页刷新时页面脚本会断，见报告）
    const a=document.createElement('a');a.className='saved';a.href='#';a.textContent=n;a.onclick=(e)=>{e.preventDefault();opened=n};document.body.append(a)}
  const csv=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='.csv');
  csv.onclick=()=>{const a=document.createElement('a');a.href='/__fake/report.csv?name='+encodeURIComponent(opened);a.download=opened+'.csv';document.body.append(a);a.click()}`

function fakeAds(url) {
  const u = new URL(url, 'http://x')
  const links = state.saved.map((n) => `<a class="saved" href="#">${n}</a>`).join('')
  const opts = (xs) => [...new Set(xs)].map((x) => `<div role="option">${x}</div>`).join('')
  if (u.pathname === '/aw/reporting/reporteditor')
    return page(
      'Report editor（假）',
      `<h1>Reports（本地假后台）</h1>
       <material-button>Predefined reports (Dimensions)</material-button>
       ${['Campaign', 'Ad group', 'Ad', 'Search keyword', 'Search terms'].map((x) => `<div role="menuitem">${x}</div>`).join('')}
       <div data-report="table">table</div>
       <button aria-label="Columns">Columns</button><button aria-label="Segment">Segment</button>
       <div role="menuitem">Day</div><button aria-label="Date range">Date</button>
       <div role="menuitem">Last 7 days</div><div role="checkbox" aria-label="Include today">today</div>
       <material-button>Save as</material-button>
       <button aria-label="Download">Download</button><div role="menuitem">.csv</div>
       <div role="dialog"><input aria-label="Search columns">${opts(Object.values(ba.GOOGLE_REPORT_COLUMNS).flat())}
         <material-button>Apply</material-button><input class="name" aria-label="Report name"><material-button>Save</material-button></div>
       <div>${links}</div>`,
      COMMON_JS,
    )
  if (u.pathname === '/adsmanager/reporting/manage')
    return page(
      'Ads reporting（假）',
      `<h1>Ads Reporting（本地假后台）</h1>
       <div role="button">Create report</div><div role="menuitem">Pivot table</div><div data-report="editor">editor</div>
       <button aria-label="Breakdowns">Breakdowns</button><button aria-label="Metrics">Metrics</button>
       <button aria-label="Date range">Date</button><div role="menuitem">Last 7 days</div>
       <div role="checkbox" aria-label="Include today">today</div><div role="button">Update</div>
       <div role="button">Save as</div><div role="button">Export</div><div role="menuitem">.csv</div>
       <div role="dialog"><input type="search">${opts([...ba.META_REPORT_BREAKDOWNS, ...ba.META_REPORT_METRICS])}
         <div role="button">Done</div><input class="name" name="report_name"><div role="button">Save</div></div>
       <div>${links}</div>`,
      COMMON_JS,
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
async function textOf(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const p = u.pathname
  if (process.env.E2E_DEBUG) console.error(req.method, p)
  try {
    if (p === '/__fake/saved') {
      const name = await textOf(req)
      if (name !== '' && !state.saved.includes(name)) state.saved.push(name)
      return json(res, {})
    }
    if (p === '/__fake/report.csv') {
      const name = u.searchParams.get('name') ?? ''
      const level = name.split(' · ')[1] ?? '广告系列'
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.csv`)}`,
      })
      res.end(CSV[level] ?? CSV.广告系列)
      return
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
    const m = p.match(/^\/v1\/extension\/actions\/([^/]+)\/(progress|evidence|download|result)$/)
    if (m) {
      const [, id, what] = m
      const body = JSON.parse((await textOf(req)) || '{}')
      if (what === 'progress') {
        state.progress.push({ id, ...body })
        return json(res, { stop: false, confirmed: false })
      }
      if (what === 'evidence') return json(res, { id: 'ev', kept_until: 'x' })
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

const work = mkdtempSync(join(tmpdir(), 'agentsws-wp315-e2e-'))
function extCopy(name) {
  const ext = join(work, name)
  cpSync(BUILD, ext, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
  manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions]
  manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions]
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
const until = async (fn, ms = 420_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
const job = (id, account, kind) =>
  ba.buildAdsJob({
    id,
    workspace_id: 'ws',
    account,
    action: { kind },
    ...(kind === 'setup_daily_report' ? { approval_id: `notice_${id}`, approval_level: 'L3' } : {}),
    created_at: new Date().toISOString(),
    origins,
  })

let code = 0
let context
try {
  const ext = extCopy('ext')
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
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
  const run = async (j) => {
    state.queue.push(j)
    await poll()
    await until(() => state.results.some((r) => r.id === j.id))
    return state.results.find((r) => r.id === j.id)
  }

  const google = { platform: 'google_ads', id: '123-456-7890', ocid: '42' }
  const r1 = await run(job('g_setup', google, 'setup_daily_report'))
  check(
    'Google 建「工坊日报」：做完、读回认得出',
    r1?.outcome === 'done',
    r1?.message ?? '没回结局',
  )
  check(
    '五份保存报表、名字是我们起的',
    state.saved.join('|') ===
      ba.REPORT_LEVELS.google_ads.map((l) => ba.workshopReportName('google_ads', l)).join('|'),
    state.saved.join('|'),
  )
  const r2 = await run(job('g_export', google, 'export_daily_report'))
  check('Google 导出：做完', r2?.outcome === 'done', r2?.message ?? '没回结局')
  const dls = state.downloads.filter((d) => d.id === 'g_export')
  check(
    '一件活里连着下了五份 CSV，都给了路径',
    dls.length === 5 && dls.every((d) => d.tag === 'report' && d.path !== ''),
    String(dls.length),
  )
  check(
    '文件真在盘上',
    dls.every((d) => existsSync(d.path)),
  )
  const rows = dls.flatMap((d) =>
    core.adsReportRows(
      core.parseAdsExport(core.decodeExportBytes(new Uint8Array(readFileSync(d.path)))),
    ),
  )
  check(
    '五份都解析得出行（含搜索字词那一层）',
    rows.length === 5 && rows.some((r) => r.level === 'search_term'),
    rows.map((r) => r.level).join(','),
  )
  check(
    '没读页面上的数（步骤里没有 read）',
    !job('x', google, 'export_daily_report').plan.steps.some((s) => s.op === 'read'),
  )

  state.saved = []
  const meta = { platform: 'meta_ads', id: 'act_999' }
  const r3 = await run(job('m_setup', meta, 'setup_daily_report'))
  check(
    'Meta 建「工坊日报」：做完',
    r3?.outcome === 'done' && state.saved[0] === '工坊日报',
    r3?.message ?? '',
  )
  const r4 = await run(job('m_export', meta, 'export_daily_report'))
  check(
    'Meta 导出：一份 CSV',
    r4?.outcome === 'done' && state.downloads.filter((d) => d.id === 'm_export').length === 1,
    r4?.message ?? '',
  )
} catch (err) {
  console.error(err)
  code = 2
} finally {
  if (code !== 0 || checks.some((c) => !c.ok))
    console.log(
      '现场：',
      JSON.stringify(
        {
          progress: state.progress.filter((x, i, a) => i === a.length - 1 || a[i + 1]?.id !== x.id),
          results: state.results,
          downloads: state.downloads,
        },
        null,
        1,
      ),
    )
  await context?.close().catch(() => {})
  server.close()
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true })
}
if (code === 0 && checks.some((c) => !c.ok)) code = 1
console.log(code === 0 ? `\n全过（${checks.length} 项）` : `\n没过（退出码 ${code}）`)
process.exit(code)
