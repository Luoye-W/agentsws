#!/usr/bin/env node
/**
 * WP413：**插件侧边栏在真 Chromium 里走一遍**——真本机服务（临时目录、stub、没有模型）+ 真插件，
 * Reddit 是**本地替身页面**（Playwright 把 `*.reddit.com` 的请求全部截下来回假页面，**不连真 Reddit**）。
 *
 * 走的一条：巡查读过一轮（替身 JSON）→ 自动出一张「发出去」卡 → 侧边栏里就地配对 → 看进度 →
 * 改草稿 → 点「填进页面」（插件里批 = 工坊里批，不等取消窗口）→ 插件新开标签页把改过的草稿填好 →
 * 「人」在页面上点 save（Playwright 的真输入，isTrusted）→ 插件读回 → 侧边栏这一条「已发 · 已记录」→
 * 记录里标「在插件里批的」；服务端那张卡 `via: 'extension'`、发出记录 `approved_via: 'extension'`。
 *
 * WP419：WP411 之后自动起草前要**先读整串、先定品牌号口吻**——这里照真流程走：插件把整串也读了、口吻没定时
 * 侧边栏照实说「等你先定品牌号怎么说话」（带「去定」），定了才出卡；卡上带「品牌号在这串里说过」。
 *
 * 用法（先 `npx tsc -b` 与 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-wp413-sidepanel.mjs [--headed] [--keep] [--shots=<目录>] [--port=<本机端口>]
 *   （`--shots` 把侧边栏浅 / 深两套与替身 Reddit 页截到那个目录；截图放私有文档仓，不进本仓）
 * 退出码：0 全过；1 有一步没过；2 起不来。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const SHOTS = args.find((a) => a.startsWith('--shots='))?.slice('--shots='.length)
const LISTEN = Number(args.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? 0)
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href)

const { createServer } = await imp('apps/server/dist/server.js')
const { SECRETS_KEY_ENV } = await imp('apps/server/dist/secret-store.js')
const ba = await imp('packages/browser-action/dist/index.js')

// ── 替身 Reddit：巡查读的 JSON 与写回复的 old.reddit 页面 ───────────────────────
const NOW_S = Math.floor(Date.now() / 1000)
const listing = (children) => ({ kind: 'Listing', data: { after: null, children } })
const post = (id, title, author, ago) => ({
  kind: 't3',
  data: {
    id,
    name: `t3_${id}`,
    title,
    selftext: '',
    author,
    subreddit: 'ivraxr',
    permalink: `/r/ivraxr/comments/${id}/x/`,
    created_utc: NOW_S - ago,
  },
})
const JSON_ROUTES = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([
    {
      kind: 't1',
      data: {
        id: 'c1',
        name: 't1_c1',
        type: 'comment_reply',
        author: 'alice',
        body: 'Mine fogs up a bit when I wear glasses. Does the Air3 work with prescription frames?',
        subreddit: 'ivraxr',
        parent_id: 't1_ours',
        link_id: 't3_abc',
        link_title: 'Does the Air3 work with glasses?',
        context: '/r/ivraxr/comments/abc/slug/c1/?context=3',
        created_utc: NOW_S - 900,
      },
    },
  ]),
  '/r/ivraxr/new/.json': listing([
    post('p1', 'Weekly Q&A thread', 'ivra_official', 3600),
    post('p2', 'Firmware 2.1 notes', 'ivra_official', 7200),
  ]),
  '/r/ivraxr/comments/.json': listing([]),
  // WP411：起草前读整串——原帖 + 品牌号以前那一条 + alice 回它的这一条
  '/comments/abc/.json': [
    listing([
      {
        kind: 't3',
        data: {
          id: 'abc',
          name: 't3_abc',
          title: 'Does the Air3 work with glasses?',
          selftext: '',
          author: 'carol',
          subreddit: 'ivraxr',
          permalink: '/r/ivraxr/comments/abc/slug/',
          created_utc: NOW_S - 86_400,
        },
      },
    ]),
    listing([
      {
        kind: 't1',
        data: {
          id: 'ours',
          name: 't1_ours',
          author: 'ivra_official',
          body: 'We have a clip-on insert for most frames.',
          subreddit: 'ivraxr',
          link_id: 't3_abc',
          parent_id: 't3_abc',
          permalink: '/r/ivraxr/comments/abc/slug/ours/',
          created_utc: NOW_S - 7200,
        },
      },
      {
        kind: 't1',
        data: {
          id: 'c1',
          name: 't1_c1',
          author: 'alice',
          body: 'Mine fogs up a bit when I wear glasses. Does the Air3 work with prescription frames?',
          subreddit: 'ivraxr',
          link_id: 't3_abc',
          parent_id: 't1_ours',
          permalink: '/r/ivraxr/comments/abc/slug/c1/',
          created_utc: NOW_S - 900,
        },
      },
    ]),
  ],
  '/r/ivraxr/about/rules.json': {
    rules: [{ short_name: 'No referral links', description: 'Do not post affiliate links.' }],
  },
}
const fakeFetch = async (url) => {
  const body = JSON_ROUTES[new URL(url).pathname]
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}

const sends = []
const shell = (title, body, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font:14px system-ui;margin:56px 24px}.thing{border-left:2px solid #ddd;padding:6px 10px;margin:8px 0}
  textarea{display:block;width:520px;height:90px;margin:6px 0}button{padding:4px 12px}</style></head>
  <body>${body}<div class="side"><span class="user">u/ivra_official（本地替身页面）</span></div>
  <script>const report=(trusted,text)=>fetch('/__fake/sent',{method:'POST',body:JSON.stringify({trusted,text})});${script}</script></body></html>`
const comment = (id, author, text, child = '') =>
  `<div class="thing comment" id="thing_t1_${id}" data-fullname="t1_${id}" data-permalink="/r/ivraxr/comments/abc/slug/${id}/">
    <div class="entry"><p class="tagline">${author}</p><form class="usertext"><div class="usertext-body"><div class="md"><p>${text}</p></div></div></form>
    <ul class="flat-list buttons"><li class="reply-button"><a href="javascript:void(0)">reply</a></li></ul></div>
    <div class="child">${child}</div></div>`
const threadPage = () =>
  shell(
    'Does the Air3 work with glasses?（替身）',
    `<div id="siteTable"><div class="thing link" data-fullname="t3_abc"><div class="entry"><a class="title">Does the Air3 work with glasses?</a></div></div></div>
     <div class="commentarea"><form class="usertext"><textarea name="text"></textarea><button class="save" type="button">save</button></form>
     <div class="sitetable nestedlisting">${comment('c1', 'alice', 'Mine fogs up a bit when I wear glasses. Does the Air3 work with prescription frames?')}</div></div>`,
    `document.querySelector('#thing_t1_c1 .reply-button a').addEventListener('click',()=>{
       const child=document.querySelector('#thing_t1_c1 > .child')
       child.insertAdjacentHTML('afterbegin','<form class="usertext"><textarea name="text"></textarea><button class="save" type="button">save</button></form>')
       child.querySelector('button.save').addEventListener('click',async e=>{
         const box=child.querySelector('textarea');await report(e.isTrusted,box.value)
         child.querySelector('form').remove()
         child.insertAdjacentHTML('beforeend','<div class="sitetable">'+${JSON.stringify(comment('new1', 'ivra_official', '__TEXT__'))}.replace('__TEXT__',box.value.replace(/</g,'&lt;'))+'</div>')})})`,
  )

// ── 真本机服务（临时目录；没有模型 → 草稿是模板那一句，正好拿来演「改草稿」）─────────────
const work = mkdtempSync(join(tmpdir(), 'agentsws-wp413-e2e-'))
mkdirSync(join(work, 'db'), { recursive: true })
const server = await createServer({
  dbDir: join(work, 'db'),
  quiet: true,
  env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
  tokenRefreshIntervalMs: 0,
  scheduleIntervalMs: 0,
  startRun: false,
})
const { port: PORT } = await server.listen(LISTEN)
const BASE = `http://127.0.0.1:${PORT}`
const ws = server.bootstrap.workspace.id
const me = server.bootstrap.person.id
const reddit = server.roles.assignments.create({
  person_id: me,
  workspace_id: ws,
  granted_by: me,
  ranges: [{ kind: 'store', id: 'store_1' }],
  role_id: 'social.reddit',
})
const http = async (path, init = {}, assignment = server.bootstrap.ownerAssignment.id) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server.bootstrap.internalToken}`,
      'X-Assignment': assignment,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  })
  return (await res.json()).data
}

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

// 巡查读一轮（插件那一侧的读在本进程里用真执行器读替身 JSON；真浏览器里的读 WP328 已测过）
const brand = await server.brands.forWorkspace(ws)
const rw = brand.redditWatch
rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
let got = rw.next({ connected: true })
for (let i = 0; i < 50 && got.job === undefined; i += 1) {
  if (i === 5) await rw.runNow()
  await new Promise((r) => setTimeout(r, 20))
  got = rw.next({ connected: true })
}
if (got.job === undefined) throw new Error('没领到巡查的活')
const read = await ba.runRedditRead(got.job, {
  fetch: fakeFetch,
  sleep: async () => {},
  stopped: () => false,
  gapMs: 0,
})
await rw.result(got.job.id, read)
// WP411：插件在线 → 起草前先读整串（又是一件活，插件下次来问时领）
let threadRead = false
for (let i = 0; i < 20 && !threadRead; i += 1) {
  await new Promise((r) => setTimeout(r, 30))
  const next = rw.next({ connected: true })
  if (next.job === undefined) continue
  threadRead = next.job.reads.some((r) => r.kind === 'post_comments')
  await rw.result(
    next.job.id,
    await ba.runRedditRead(next.job, {
      fetch: fakeFetch,
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    }),
  )
}
check('起草前插件先把整串读了', threadRead)
const autoCards = () =>
  server.txn.runtime.store
    .listApprovals({ workspace_id: ws, kind: 'outbound_draft' })
    .filter((c) => c.payload?.form === 'reddit_write')
const personaCard = await until(
  () =>
    server.txn.runtime.store
      .listApprovals({ workspace_id: ws, kind: 'setup_request' })
      .some((c) => c.title.startsWith('品牌号怎么说话')),
  10_000,
)
check('口吻没定：不起草，先出「品牌号怎么说话」卡', personaCard && autoCards().length === 0)
// 再出一张（人在工作台点的那种），让「要你处理」里有两张
await http(
  '/v1/social/reddit/stage',
  {
    method: 'POST',
    body: JSON.stringify({
      target: {
        kind: 'comment',
        subreddit: 'ivraxr',
        parent_fullname: 't3_p9',
        permalink: '/r/ivraxr/comments/p9/battery/',
        post_title: 'Battery life after the 2.1 update?',
        post_text: 'Mine drops 20% an hour since the update.',
        parent_author: 'bob',
      },
      text: 'Thanks Bob — could you share which mode you were in? We are collecting reports on 2.1.',
      reason: '用户在问固件更新后的续航',
    }),
  },
  reddit.id,
)

// ── 插件副本：Reddit 的可选权限改成「已授予」（真浏览器里那一步是用户点弹窗）──────────────
const ext = join(work, 'ext')
cpSync(BUILD, ext, { recursive: true })
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, ...manifest.optional_host_permissions]
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest))
check(
  '清单里有侧边栏（sidePanel 权限 + 默认页）',
  manifest.permissions.includes('sidePanel') &&
    manifest.side_panel?.default_path === 'sidepanel.html',
)

// 插件后台（service worker）发的请求也要能截下来——否则真去连 reddit.com
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'
const { chromium } = require(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
)
const EDITED =
  'Hi Alice — yes, the Air3 fits over most prescription frames. The anti-fog insert in the box helps too.'
const leaked = []
const shot = async (pg, name) => {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  await pg.screenshot({ path: join(SHOTS, `${name}.png`) })
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
  // 只放本机；Reddit 一律回替身；别的一律掐
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    if (u.protocol === 'chrome-extension:' || u.hostname === '127.0.0.1') return route.continue()
    if (/(^|\.)reddit\.com$/u.test(u.hostname)) {
      if (u.pathname === '/__fake/sent') {
        sends.push(JSON.parse(route.request().postData() ?? '{}'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      }
      if (u.pathname.startsWith('/r/ivraxr/comments/abc/'))
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: threadPage(),
        })
      leaked.push(u.href)
      return route.fulfill({ status: 404, body: '' })
    }
    leaked.push(u.href)
    return route.abort()
  })
  let [sw] = context.serviceWorkers()
  if (sw === undefined) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extId = new URL(sw.url()).host
  // 只告诉插件本机在哪个端口（不碰 4317）；配对在侧边栏里就地做
  await sw.evaluate((port) => chrome.storage.local.set({ 'agentsws.settings': { port } }), PORT)

  const panel = await context.newPage()
  panel.on('console', (m) => {
    if (m.type() === 'error') console.log(`[侧边栏] ${m.text()}`)
  })
  panel.on('pageerror', (e) => console.log(`[侧边栏] ${e.message}`))
  await panel.setViewportSize({ width: 400, height: 880 })
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`)
  await panel.locator('[data-testid="ws-pair"]').waitFor()
  await shot(panel, '1-pair-light')
  const pairing = await http('/v1/extension/pairings', { method: 'POST', body: '{}' })
  await panel.locator('input[aria-label="配对码"]').fill(pairing.code)
  await panel.locator('[data-testid="ws-pair"] button').click()
  const pairedOk = await until(() => panel.locator('[data-testid="ws-tab-todo"]').isVisible())
  check('侧边栏里就地输配对码 → 配上，出三块', pairedOk)

  // WP419：口吻没定 → 「要你处理」顶上照实说卡在哪、带「去定」
  const stageOk = await until(
    async () =>
      (
        (await panel
          .locator('[data-testid="ws-stage"]')
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('等你先定品牌号怎么说话'),
    15_000,
  )
  check(
    '侧边栏照实说：等你先定品牌号怎么说话（带「去定」）',
    stageOk && (await panel.locator('[data-testid="ws-stage-open"]').count()) === 1,
  )
  await shot(panel, '2a-persona-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '2a-persona-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  // 人在工坊里定了口吻 → 等着的那条接着起草出卡
  await brand.redditPersona.setupTarget().apply({ stance: 'team' })
  const autoCard = await until(() => autoCards().length > 0, 15_000)
  check('定了口吻 → 巡查读到 alice 的回复自动起草出一张「发出去」卡', autoCard)

  const cards = panel.locator('[data-testid="ws-card"]')
  await until(async () => (await cards.count()) === 2, 15_000)
  check('「要你处理」里是这个人的两张卡', (await cards.count()) === 2)
  await shot(panel, '2-todo-light')
  await panel.locator('[data-testid="ws-tab-progress"]').click()
  const head = (await panel.locator('[data-testid="ws-progress-head"]').textContent()) ?? ''
  const parts = (await panel.locator('[data-testid="ws-parts"]').textContent()) ?? ''
  check(
    '进度：几点读完、每块读到几条',
    /读完$/u.test(head) && parts.includes('收件箱') && parts.includes('自家版块'),
    `${head} | ${parts}`,
  )
  await shot(panel, '3-progress-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '3-progress-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  await panel.locator('[data-testid="ws-tab-todo"]').click()

  // ① 改草稿 → 填进页面（alice 那一张：插件新开标签页、点 reply、把改过的字填好、等人点）
  const alice = cards.filter({ hasText: 'alice' }).first()
  if ((await alice.getAttribute('data-open')) !== '1') await alice.locator('.ws-card-head').click()
  check(
    'alice 那张卡上带「品牌号在这串里说过 1 次」',
    (
      (await alice
        .locator('[data-testid="ws-prior"]')
        .textContent()
        .catch(() => '')) ?? ''
    ).includes('说过 1 次'),
  )
  await shot(panel, '2b-card-checks-light')
  await alice.locator('[data-testid="ws-draft"]').fill(EDITED)
  await alice.locator('[data-testid="ws-fill"]').click()
  let pg
  const filled = await until(async () => {
    pg = context
      .pages()
      .find((x) => x.url().startsWith('https://old.reddit.com/r/ivraxr/comments/abc/'))
    if (pg === undefined) return false
    const v = await pg
      .locator('#thing_t1_c1 > .child textarea')
      .inputValue()
      .catch(() => '')
    const banner = await pg
      .locator('#agentsws-ads-banner [data-testid="ads-banner"]')
      .textContent()
      .catch(() => '')
    return v === EDITED && (banner ?? '').includes('等你点发送')
  })
  check('点「填进页面」→ 马上（不等 2 分钟）新开标签页，改过的草稿填进回复框，等人点', filled)
  check('插件没点发送', sends.length === 0)
  const item = server.txn.runtime.store
    .listApprovals({ workspace_id: ws, kind: 'outbound_draft' })
    .find((c) => c.payload?.reddit?.parent_fullname === 't1_c1')
  check(
    '插件里批 = 工坊里批：同一张卡，via=extension，批的人是配对时绑定的那个人，按改过的批',
    item?.decision?.via === 'extension' &&
      item?.decision?.by === me &&
      item?.state === 'applied' &&
      item?.decision?.action === 'approve_edited',
    JSON.stringify({
      state: item?.state,
      decision: item?.decision?.via,
      action: item?.decision?.action,
    }),
  )
  await until(
    async () => (await panel.locator('[data-testid="ws-write"][data-state="filling"]').count()) > 0,
    15_000,
  )
  await shot(panel, '4-filling-light')
  if (pg !== undefined) await shot(pg, '5-reddit-filled')

  // ② 人在 Reddit 页面上点 save → 插件读回 → 侧边栏「已发 · 已记录」
  if (pg !== undefined && filled) await pg.locator('#thing_t1_c1 > .child button.save').click()
  const sentOk = await until(async () =>
    (
      (await panel
        .locator('[data-testid="ws-write"][data-state="sent"]')
        .textContent()
        .catch(() => '')) ?? ''
    ).includes('已发 · 已记录'),
  )
  check('人点了发送 → 插件读回 → 侧边栏这一条「已发 · 已记录」', sentOk)
  check(
    '那一下 save 是人点的（isTrusted）',
    sends.length === 1 && sends[0].trusted === true && sends[0].text === EDITED,
    JSON.stringify(sends),
  )
  await panel.bringToFront()
  await shot(panel, '6-sent-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '6-sent-dark')
  await panel.emulateMedia({ colorScheme: 'light' })

  // ③ 记录：发出记录那一行标「在插件里批的」；服务端那一行 approved_via=extension
  await panel.locator('[data-testid="ws-tab-records"]').click()
  const viaExt = await until(
    () => panel.locator('[data-testid="ws-via-ext"]').first().isVisible(),
    15_000,
  )
  check('记录里那一行标「在插件里批的」', viaExt)
  await shot(panel, '7-records-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '7-records-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  const rows = await http('/v1/outbound/records')
  const row = rows.find((r) => r.approval_item_id === item?.id)
  check(
    '工坊的发出记录里同一行：approved_via=extension、正文是改过的那一版',
    row?.approved_via === 'extension' && row?.content === EDITED,
    JSON.stringify({ via: row?.approved_via }),
  )
  const left = (
    await server.txn.approvals.queue({
      workspace_id: ws,
      person_id: me,
      lane: 'mine',
      kind: 'outbound_draft',
      state: ['pending', 'in_review'],
    })
  ).filter((c) => c.payload?.form === 'reddit_write')
  check('工坊「要你处理」里那张卡收起了，另一张还在', left.length === 1 && left[0]?.id !== item?.id)

  // ④ 另一张在工坊里批了 → 侧边栏那张自己收起（谁先处理算谁的）
  const other = left[0]
  const token = other?.deliveries.find((d) => d.to === me && d.status === 'sent')?.decision_token
  if (other !== undefined && token !== undefined)
    await server.approvals.decide(other.id, me, {
      action: 'reject',
      reason: '工坊里不发',
      decision_token: token,
      via: 'workstation',
    })
  await panel.locator('[data-testid="ws-tab-todo"]').click()
  const gone = await until(async () => (await cards.count()) === 0, 15_000)
  check('另一张在工坊里处理了 → 侧边栏那张自己收起', gone)
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '2-todo-dark-after')
  await panel.emulateMedia({ colorScheme: 'light' })
  check('没有一个请求去了真 Reddit / 外网', leaked.length === 0, leaked.slice(0, 3).join(' '))
} catch (err) {
  console.error(err)
  for (const pg of context?.pages() ?? [])
    console.log(
      `现场 ${pg.url()}：`,
      ((await pg.textContent('body').catch(() => '')) ?? '').slice(0, 400),
    )
  code = 2
} finally {
  await context?.close().catch(() => {})
  await server.close().catch(() => {})
  if (!flag('--keep')) rmSync(work, { recursive: true, force: true })
}
if (code === 0 && checks.some((c) => !c.ok)) code = 1
console.log(code === 0 ? `\n全过（${checks.length} 项）` : `\n没过（退出码 ${code}）`)
process.exit(code)
