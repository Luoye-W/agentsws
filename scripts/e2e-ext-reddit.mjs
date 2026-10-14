#!/usr/bin/env node
/**
 * WP329：**Reddit 写在真 Chromium 里走一遍**——本地假 old.reddit + 假本机服务，**不碰真 Reddit**。
 *
 * 单测里「手」是 jsdom；这里换成真浏览器 + 真插件，把单测摸不到的那几件事坐实：
 * - 插件领到 Reddit 的活、**新开一个看得见的标签页**、点 reply、把草稿填进回复框，横条写「填好了，等你点发送」；
 * - **插件从不点发送**：假页面把每一下 save / submit 的 `isTrusted` 报回来——只有「人」（Playwright 的真输入）点的那一下；
 * - 人点了之后插件认出新出现的那一条、读回编号与链接；发新帖时页面会跳走（脚本被扔掉），也认得出来；
 * - 人一直没点 → 到点停下交给人（这里把等的时长改成几秒）；没登录 → 打开页面就停。
 *
 * 假站与假本机服务是同一个 127.0.0.1 端口（插件本来就有 `http://127.0.0.1/*` 的权限）。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-ext-reddit.mjs [--headed] [--keep] [--shots]
 *   （`--shots` 把横条与设置页截到 `docs/assets/wp329/`）
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
const SHOTS = join(ROOT, 'docs/assets/wp329')

const ba = await import(pathToFileURL(join(ROOT, 'packages/browser-action/dist/index.js')).href)

// ── 假 old.reddit + 假本机服务 ──────────────────────────────────────────────
const state = { queue: [], progress: [], results: [], sends: [] }

const shell = (title, body, script = '', loggedIn = true) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:14px system-ui;margin:56px 24px}.thing{border-left:2px solid #ddd;padding:6px 10px;margin:8px 0}
  textarea{display:block;width:520px;height:90px;margin:6px 0}button{padding:4px 12px}</style></head>
  <body>${body}<div class="side">${loggedIn ? '<span class="user">u/inmo_official（本地假页面）</span>' : '<form><input name="user"><input type="password" name="passwd"></form>'}</div>
  <script>const report=(trusted,text)=>fetch('/__fake/sent',{method:'POST',body:JSON.stringify({trusted,text})});${script}</script></body></html>`

const comment = (id, author, text, child = '') =>
  `<div class="thing comment" id="thing_t1_${id}" data-fullname="t1_${id}" data-permalink="/r/inmoxr/comments/abc/slug/${id}/">
    <div class="entry"><p class="tagline">${author}</p><form class="usertext"><div class="usertext-body"><div class="md"><p>${text}</p></div></div></form>
    <ul class="flat-list buttons"><li class="reply-button"><a href="javascript:void(0)">reply</a></li></ul></div>
    <div class="child">${child}</div></div>`

function fakeReddit(raw) {
  const u = new URL(raw, 'http://x')
  const p = u.pathname
  if (p === '/r/inmoxr/submit')
    return shell(
      'submit to r/inmoxr（假）',
      `<h1>submit to r/inmoxr（本地假页面）</h1><form id="newlink" onsubmit="return false">
       <div id="title-field"><textarea name="title"></textarea></div>
       <div id="text-field"><textarea name="text"></textarea></div>
       <button name="submit" type="submit">submit</button></form>`,
      `document.querySelector('button[name=submit]').addEventListener('click',async e=>{
         const t=document.querySelector('#title-field textarea').value
         await report(e.isTrusted,t)
         location.href='/r/inmoxr/comments/new2/weekly/?t='+encodeURIComponent(t)})`,
    )
  if (p === '/r/inmoxr/comments/new2/weekly/')
    return shell(
      'post（假）',
      `<div id="siteTable"><div class="thing link" data-fullname="t3_new2" data-permalink="/r/inmoxr/comments/new2/weekly/">
       <div class="entry"><a class="title">${(u.searchParams.get('t') ?? '').replace(/</g, '&lt;')}</a></div></div></div>
       <div class="commentarea"></div>`,
    )
  if (p.startsWith('/r/inmoxr/comments/login/'))
    return shell('reddit（假）', '<p>log in to reply</p>', '', false)
  if (p.startsWith('/r/inmoxr/comments/abc/'))
    return shell(
      'Does the Air3 work with glasses?（假）',
      `<div id="siteTable"><div class="thing link" data-fullname="t3_abc"><div class="entry"><a class="title">Does the Air3 work with glasses?</a></div></div></div>
       <div class="commentarea"><form class="usertext"><textarea name="text"></textarea><button class="save" type="button">save</button></form>
       <div class="sitetable nestedlisting">${comment('c1', 'alice', 'Mine fogs up a bit when I wear glasses.')}</div></div>`,
      `document.querySelector('#thing_t1_c1 .reply-button a').addEventListener('click',()=>{
         const child=document.querySelector('#thing_t1_c1 > .child')
         child.insertAdjacentHTML('afterbegin','<form class="usertext"><textarea name="text"></textarea><button class="save" type="button">save</button></form>')
         child.querySelector('button.save').addEventListener('click',async e=>{
           const box=child.querySelector('textarea');await report(e.isTrusted,box.value)
           child.querySelector('form').remove()
           child.insertAdjacentHTML('beforeend','<div class="sitetable">'+${JSON.stringify(comment('new1', 'inmo_official', '__TEXT__'))}.replace('__TEXT__',box.value.replace(/</g,'&lt;'))+'</div>')})})`,
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
    if (p === '/__fake/sent') {
      state.sends.push(await bodyOf(req))
      return json(res, {})
    }
    if (p === '/v1/extension/hello')
      return json(res, {
        workspace_id: 'ws',
        workspace_name: '假品牌',
        cloud_linked: false,
        shares_to_public_library: false,
        scopes: ['reddit.act'],
        server_version: 'e2e',
      })
    if (p === '/v1/extension/actions/next') {
      const wants = (u.searchParams.get('platforms') ?? '').split(',')
      const job = wants.includes('reddit') ? state.queue.shift() : undefined
      return json(res, job === undefined ? { retry_after_ms: 60000 } : { job, retry_after_ms: 0 })
    }
    const m = p.match(/^\/v1\/extension\/actions\/([^/]+)\/(progress|result)$/)
    if (m) {
      const body = await bodyOf(req)
      if (m[2] === 'progress') {
        state.progress.push({ id: m[1], ...body })
        return json(res, { stop: false, confirmed: false })
      }
      state.results.push({ id: m[1], ...body })
      return json(res, { id: m[1] })
    }
    const html = fakeReddit(req.url ?? '/')
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

const job = (id, action, patch) => {
  const j = ba.buildRedditJob({
    id,
    workspace_id: 'ws',
    account_id: 'inmo_official',
    action,
    approval_id: `ap_${id}`,
    approval_level: 'L1',
    title:
      action.write.kind === 'submit'
        ? '发帖：Weekly Q&A（Reddit · r/inmoxr）'
        : '回复 alice（Reddit · r/inmoxr）',
    created_at: new Date().toISOString(),
    origin: BASE,
  })
  if (patch !== undefined) patch(j)
  return j
}
const DRAFT = 'Hi Alice, INMO here. The anti-fog insert in the box helps a lot with glasses.'

// ── 插件副本：可选权限改成「已授予」（真浏览器里那一步是用户点弹窗）──────────────
const work = mkdtempSync(join(tmpdir(), 'agentsws-wp329-e2e-'))
const ext = join(work, 'ext')
cpSync(BUILD, ext, { recursive: true })
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions]
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))

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

let code = 0
let context
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: !flag('--headed'),
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
  const pageAt = (path) => context.pages().find((pg) => pg.url().startsWith(`${BASE}${path}`))
  const bannerText = (pg) =>
    pg
      .locator('#agentsws-ads-banner [data-testid="ads-banner"]')
      .textContent()
      .catch(() => '')

  // ① 楼中楼：插件开新标签页、点 reply、填草稿、等人点发送 → 人点 → 读回
  state.queue.push(
    job('rw_reply', {
      write: { kind: 'reply', parent: 't1_c1', permalink: '/r/inmoxr/comments/abc/slug/c1/' },
      text: DRAFT,
    }),
  )
  await poll()
  let pg
  const filled = await until(async () => {
    pg = pageAt('/r/inmoxr/comments/abc/')
    if (pg === undefined) return false
    const v = await pg
      .locator('#thing_t1_c1 > .child textarea')
      .inputValue()
      .catch(() => '')
    return v === DRAFT && ((await bannerText(pg)) ?? '').includes('等你点发送')
  })
  check('新开标签页、点 reply、草稿填进回复框，横条写「等你点发送」', filled)
  check('插件没点发送（填好之后页面上一下 save 都没有）', state.sends.length === 0)
  if (pg !== undefined && filled) {
    if (flag('--shots')) {
      mkdirSync(SHOTS, { recursive: true })
      await pg.screenshot({ path: join(SHOTS, 'reddit-filled.png') })
    }
    await pg.locator('#thing_t1_c1 > .child button.save').click()
  }
  await until(() => state.results.some((r) => r.id === 'rw_reply'))
  const r1 = state.results.find((r) => r.id === 'rw_reply')
  check(
    '人点了发送 → 做完，读回编号与链接',
    r1?.outcome === 'done' &&
      r1?.reads?.fullname === 't1_new1' &&
      r1?.reads?.permalink === '/r/inmoxr/comments/abc/slug/new1/',
    JSON.stringify(r1 ?? {}),
  )
  check(
    '那一下 save 是人点的（isTrusted），插件一下都没点',
    state.sends.length === 1 && state.sends[0].trusted === true && state.sends[0].text === DRAFT,
    JSON.stringify(state.sends),
  )

  // ② 发新帖：填标题和正文；人点 submit 后页面跳到新帖页 → 插件放回脚本、认出新帖
  state.queue.push(
    job('rw_post', {
      write: { kind: 'submit', subreddit: 'inmoxr', title: 'Weekly Q&A' },
      text: 'Ask us anything about the Air3.',
    }),
  )
  await poll()
  let sp
  const ready = await until(async () => {
    sp = pageAt('/r/inmoxr/submit')
    if (sp === undefined) return false
    const t = await sp
      .locator('#title-field textarea')
      .inputValue()
      .catch(() => '')
    const b = await sp
      .locator('#text-field textarea')
      .inputValue()
      .catch(() => '')
    return (
      t === 'Weekly Q&A' &&
      b === 'Ask us anything about the Air3.' &&
      ((await bannerText(sp)) ?? '').includes('等你点发送')
    )
  })
  check('发帖页：标题、正文都填好，等人点 submit', ready)
  if (sp !== undefined && ready) await sp.locator('button[name=submit]').click()
  await until(() => state.results.some((r) => r.id === 'rw_post'))
  const r2 = state.results.find((r) => r.id === 'rw_post')
  check(
    '页面跳到新帖页（脚本被扔掉）也认出来：t3 编号与链接',
    r2?.outcome === 'done' && r2?.reads?.fullname === 't3_new2',
    JSON.stringify(r2 ?? {}),
  )
  check('submit 也是人点的', state.sends.at(-1)?.trusted === true)

  // ③ 人一直没点（等的时长改成 4 秒）→ 停下交给人，不代点
  const before = state.sends.length
  state.queue.push(
    job(
      'rw_idle',
      {
        write: { kind: 'comment', post: 't3_abc', permalink: '/r/inmoxr/comments/abc/slug/' },
        text: 'Thanks for asking!',
      },
      (j) => {
        const last = j.plan.steps.at(-1)
        if (last?.op === 'await_sent') last.timeout_ms = 4000
      },
    ),
  )
  await poll()
  await until(() => state.results.some((r) => r.id === 'rw_idle'), 90_000)
  const r3 = state.results.find((r) => r.id === 'rw_idle')
  check(
    '人没点发送 → 到点停下、不算发出、插件没代点',
    r3?.outcome === 'handover' &&
      (r3?.message ?? '').includes('不算发出') &&
      state.sends.length === before,
    r3?.message ?? '没回结局',
  )

  // ④ 没登录 → 打开页面就停
  state.queue.push(
    job('rw_login', {
      write: { kind: 'reply', parent: 't1_c1', permalink: '/r/inmoxr/comments/login/s/c1/' },
      text: DRAFT,
    }),
  )
  await poll()
  await until(() => state.results.some((r) => r.id === 'rw_login'))
  const r4 = state.results.find((r) => r.id === 'rw_login')
  check(
    '没登录 → 停下请人在这个标签页里登录',
    r4?.outcome === 'handover' && (r4?.message ?? '').includes('Reddit没登录'),
    r4?.message ?? '没回结局',
  )

  if (flag('--shots')) {
    await options.reload()
    await options.locator('[data-testid="ws-reddit"]').waitFor()
    await options
      .locator('[data-testid="ws-reddit"]')
      .screenshot({ path: join(SHOTS, 'options-reddit.png') })
  }
} catch (err) {
  console.error(err)
  code = 2
} finally {
  if (code !== 0 || checks.some((c) => !c.ok))
    console.log(
      '现场：',
      JSON.stringify(
        { progress: state.progress.slice(-6), results: state.results, sends: state.sends },
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
