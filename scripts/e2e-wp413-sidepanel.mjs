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
 * WP432（Luoye 10-20 反馈 9）：**批了不自动开页面**——侧边栏里「批准并打开」是人这一下点的；工坊里批的那一张
 * 进侧边栏「等你发」、插件图标出数字、**定时领活不开任何页面**；人点「打开这一条」才在这个窗口新开标签页，
 * 默认**新版 www.reddit.com**（替身页面是 shreddit 组件的样子），草稿填进富文本框并描一圈；「人」在页面上又改了字
 * 再点 Comment → 插件按品牌号认出、读回真发出去的字 → 工坊记「已发」，发出记录按真发的记、AI 草稿另存一格。
 *
 * WP445（决策 1322–1324，Luoye 10-21）：**审与发在插件里一步完成**——AI 起草的卡**不在工坊出**（岗位牌堆里没有、
 * 看板上只一行「插件里 N 条等你发」），直接在侧边栏「等你发」里：改字点「打开这一条」= 批 + 打开；横条是中性的
 * 「草稿已填好，请检查后自己点发送」；主管在工坊里批过的那一条也进「等你发」；「不发 + 理由」→ 同类的一并不发、能撤回；
 * 侧边栏底下那一栏没了（新版旧版开关一起去掉）；社媒「交给你发」的帖子也不用先在工坊批。
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
// WP432：新版 Reddit（shreddit 组件的样子）——一条评论 + 它的 Reply、收起的「Join the conversation」
// WP467：照真站 10-22 的样子——正文与按钮行包在 details 里；Reply 在 faceplate-tracker[slot=comment-reply] 里，
// 点了回复框长在按钮行里（包在带 parent-id 的 comment-composer-host 里）；「Join the conversation」聚焦里面的 textarea 才展开
const scomment = (id, author, text, parent, depth, post) =>
  `<shreddit-comment thingid="t1_${id}" author="${author}" parentid="${parent}" depth="${depth}" permalink="/r/ivraxr/comments/${post}/comment/${id}/">
     <details open><summary></summary><div>
       <div slot="comment"><p>${text}</p></div>
       <div slot="actionRow"><shreddit-comment-action-row slot="actionRow" comment-id="t1_${id}"><faceplate-tracker slot="comment-reply"><button>Reply</button></faceplate-tracker></shreddit-comment-action-row></div>
     </div></details>
   </shreddit-comment>`
const COMPOSER =
  '<shreddit-composer><div contenteditable="true" role="textbox" style="min-height:60px;border:1px solid #ccc;padding:6px"></div><button class="human-send" type="button">Comment</button></shreddit-composer>'
const threadPage = (post, title) =>
  shell(
    `${title}（替身）`,
    `<shreddit-post id="t3_${post}" author="carol" permalink="/r/ivraxr/comments/${post}/x/"><h1 slot="title">${title}</h1></shreddit-post>
     <comment-body-header><comment-composer-host post-id="t3_${post}"><faceplate-textarea-input data-testid="trigger-button">Join the conversation</faceplate-textarea-input></comment-composer-host></comment-body-header>
     <shreddit-comment-tree>${post === 'abc' ? scomment('c1', 'alice', 'Mine fogs up a bit when I wear glasses. Does the Air3 work with prescription frames?', 't3_abc', 0, 'abc') : ''}</shreddit-comment-tree>`,
    `const COMPOSER=${JSON.stringify(COMPOSER)};let n=0
     const wire=(host,parent,depth)=>{const b=host.querySelector('button.human-send');b.addEventListener('click',async e=>{
       const box=host.querySelector('[contenteditable]');const text=box.textContent;await report(e.isTrusted,text)
       host.remove();n+=1
       document.querySelector('shreddit-comment-tree').insertAdjacentHTML('beforeend',${JSON.stringify(scomment('__ID__', 'ivra_official', '__TEXT__', '__PARENT__', '__DEPTH__', post))}
         .replace(/__ID__/g,'new'+n).replace('__TEXT__',text.replace(/</g,'&lt;')).replace('__PARENT__',parent).replace('__DEPTH__',String(depth)))})}
     document.querySelector('shreddit-comment-action-row[comment-id="t1_c1"] [slot="comment-reply"] button')?.addEventListener('click',()=>{
       const row=document.querySelector('shreddit-comment-action-row[comment-id="t1_c1"]');if(row.querySelector('shreddit-composer'))return
       row.insertAdjacentHTML('beforeend','<comment-composer-host parent-id="t1_c1">'+COMPOSER+'</comment-composer-host>');wire(row.querySelector('comment-composer-host'),'t1_c1',1)})
     const trig=document.querySelector('comment-composer-host:not([parent-id]) faceplate-textarea-input');const ta=document.createElement('textarea')
     trig.attachShadow({mode:'open'}).append(ta)
     ta.addEventListener('focus',()=>{const h=document.querySelector('comment-composer-host:not([parent-id])');if(h.querySelector('shreddit-composer'))return
       h.insertAdjacentHTML('beforeend',COMPOSER);wire(h,'t3_${post}',0)})`,
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
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      // WP419：保底——没被下面截住的请求（插件新开标签页偶尔先于路由生效）一律解析不到，绝不连到真站
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      // 系统代理（fake-IP 那种）会绕过上面的解析规则：不走代理
      '--no-proxy-server',
    ],
  })
  // 只放本机；Reddit 一律回替身；别的一律掐
  const guard = async (route) => {
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
          body: threadPage('abc', 'Does the Air3 work with glasses?'),
        })
      if (u.pathname.startsWith('/r/ivraxr/comments/p9/'))
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: threadPage('p9', 'Battery life after the 2.1 update?'),
        })
      leaked.push(u.href)
      return route.fulfill({ status: 404, body: '' })
    }
    leaked.push(u.href)
    if (process.env.WP419_DEBUG === '1')
      console.log(
        `[掐掉] ${u.href} ${route.request().resourceType()} ← ${route.request().frame()?.url() ?? '?'}`,
      )
    return route.abort()
  }
  await context.route('**/*', guard)
  // WP419：插件新开的标签页偶尔绕过 context 级的截取——每个新页面再挂一层同样的
  context.on('page', (p) => {
    void p.route('**/*', guard).catch(() => undefined)
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

  const cards = panel.locator('[data-testid="ws-desk"][data-from="card"]')
  await until(async () => (await cards.count()) === 2, 15_000)
  check('WP445：两张卡都直接在插件「等你发」里', (await cards.count()) === 2)
  // WP445：工坊不出卡——岗位牌堆里没有这两张；看板上一行「插件里 2 条等你发」
  const deckNow = await http(`/v1/positions/${reddit.id}/cards`, {}, reddit.id)
  const ids = autoCards().map((c) => c.id)
  check(
    'WP445：工坊不出卡（岗位牌堆里没有），看板数「插件里 2 条等你发」',
    ids.length === 2 &&
      ids.every((id) => !JSON.stringify(deckNow).includes(id)) &&
      (await http('/v1/social/reddit/writes', {}, reddit.id)).in_plugin === 2,
  )
  const badge2 = await until(
    async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '2',
    15_000,
  )
  check('WP445：AI 起草出来就在插件图标上出数字 2（不用先在工坊批）', badge2)
  check(
    'WP445（决策 1323）：侧边栏底下那一栏没了（没有新版旧版开关）；版本一致时顶上不出提示',
    (await panel.locator('[data-testid="ws-foot"]').count()) === 0 &&
      (await panel.locator('[data-testid="ws-site"]').count()) === 0 &&
      (await panel.locator('[data-testid="ws-version-warn"]').count()) === 0,
  )
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
  await alice.locator('[data-testid="ws-desk-draft"]').fill(EDITED)
  // WP467：用户自己已经开着这个帖子（网址带标题段和分享参数）——「填入」就在这一页里填，不另开、不跳 old.reddit
  const userPg = await context.newPage()
  await userPg
    .goto('https://www.reddit.com/r/ivraxr/comments/abc/does_the_air3_work/?utm_source=share')
    .catch(() => undefined)
  const redditTabsBefore = context.pages().filter((x) => x.url().includes('reddit.com')).length
  await panel.bringToFront()
  // WP445：「填入」= 批 + 填——人这一下点的
  await alice.locator('[data-testid="ws-desk-open"]').click()
  let pg
  let reloaded = false
  const boxOf = (p, sel) => p.locator(sel)
  const replyBox = 'shreddit-comment[thingid="t1_c1"] shreddit-composer div[contenteditable="true"]'
  const filled = await until(async () => {
    pg = context
      .pages()
      .find((x) => x.url().startsWith('https://www.reddit.com/r/ivraxr/comments/abc/'))
    if (pg === undefined) return false
    // WP419：插件新开的标签页偶尔先于截取生效（打到了解析不到的真站）——不是替身页就重载一次（这时截取已挂上）
    const title = await pg.title().catch(() => '')
    if (!title.includes('替身') && !reloaded) {
      reloaded = true
      await pg.reload().catch(() => undefined)
      return false
    }
    const v = await boxOf(pg, replyBox)
      .textContent()
      .catch(() => '')
    const outline = await boxOf(pg, replyBox)
      .evaluate((el) => el.style.outline)
      .catch(() => '')
    const banner = await pg
      .locator('#agentsws-ads-banner [data-testid="ads-banner"]')
      .textContent()
      .catch(() => '')
    return (
      v === EDITED &&
      outline !== '' &&
      (banner ?? '').includes('草稿已填好，请检查后自己点发送') &&
      !(banner ?? '').includes('AI 正在操作')
    )
  })
  check(
    '点「填入」→ 改过的草稿填进回复框并描一圈；横条是中性的「草稿已填好，请检查后自己点发送」',
    filled,
  )
  check(
    'WP467：用户已经开着这个帖子 → 就在那一页里填（没另开标签页、没跳转、没去 old.reddit）',
    pg === userPg &&
      context.pages().filter((x) => x.url().includes('reddit.com')).length === redditTabsBefore &&
      (pg?.url() ?? '').includes('utm_source=share') &&
      !context.pages().some((x) => x.url().includes('old.reddit.com')),
    `${pg?.url()} / ${context
      .pages()
      .map((x) => x.url())
      .join(' , ')}`,
  )
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

  // ② 人在 Reddit 页面上点 Comment → 插件读回 → 侧边栏「已发 · 已记录」
  if (pg !== undefined && filled)
    await pg.locator('shreddit-comment[thingid="t1_c1"] button.human-send').click()
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
    '那一下发送是人点的（isTrusted）',
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
    'WP445：发出去之后看板数跟着变（插件里 1 条等你发）',
    (await http('/v1/social/reddit/writes', {}, reddit.id)).in_plugin === 1,
  )
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

  // ④ WP432 / WP445：另一张在工坊里批（公司模式「主管先批」那一种：主管批了）→ **不自动开任何页面**：
  //    进发起人插件的「等你发」，图标出数字；定时领活领不到；人点「打开这一条」才开
  const other = left[0]
  const token = other?.deliveries.find((d) => d.to === me && d.status === 'sent')?.decision_token
  if (other !== undefined && token !== undefined) {
    await server.approvals.decide(other.id, me, {
      action: 'approve',
      decision_token: token,
      via: 'workstation',
    })
    // 取消窗口（120 秒）这里不真等：直接施行（与过了窗口的补扫同一条路）
    await server.txn.executor.applyApproval(other.id, { skip_cancel_window: true })
  }
  await panel.locator('[data-testid="ws-tab-todo"]').click()
  const desk = panel.locator('[data-testid="ws-desk"][data-from="write"]')
  const inDesk = await until(
    async () => (await cards.count()) === 0 && (await desk.count()) === 1,
    15_000,
  )
  check('工坊里批了 → 同一个样子留在「等你发」（帖子、版块、为什么回、草稿全文）', inDesk)
  const pagesBefore = context.pages().filter((x) => x.url().includes('reddit.com')).length
  // 让插件马上去领一次（不等每分钟那一拍）——领不到 Reddit 的写，不开页面
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'ads-poll' }))
  await new Promise((r) => setTimeout(r, 4000))
  const pagesAfter = context.pages().filter((x) => x.url().includes('reddit.com')).length
  check('批了之后插件没有自己开任何 Reddit 页面（定时领活也领不到）', pagesAfter === pagesBefore)
  const badgeOk = await until(
    async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '1',
    15_000,
  )
  check('插件图标上出「等你发」的数字 1', badgeOk)
  const strip = (await panel.locator('[data-testid="ws-strip"]').textContent()) ?? ''
  check(
    '侧边栏顶上照实说：等你发 1 条、今天发了 1 条',
    strip.includes('等你发 1 条') && strip.includes('今天发了 1 条'),
    strip,
  )
  await shot(panel, '8a-desk-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '8a-desk-dark')
  await panel.emulateMedia({ colorScheme: 'light' })

  // 人点「打开这一条」→ 新版 Reddit 帖子页、点开「Join the conversation」、草稿填好；人改了一句才点 Comment
  await desk.locator('[data-testid="ws-desk-open"]').click()
  const topBox =
    'comment-composer-host:not([parent-id]) shreddit-composer div[contenteditable="true"]'
  let pg2
  let reloaded2 = false
  const filled2 = await until(async () => {
    pg2 = context
      .pages()
      .find((x) => x.url().startsWith('https://www.reddit.com/r/ivraxr/comments/p9/'))
    if (pg2 === undefined) return false
    const title = await pg2.title().catch(() => '')
    if (!title.includes('替身') && !reloaded2) {
      reloaded2 = true
      await pg2.reload().catch(() => undefined)
      return false
    }
    const v = await pg2
      .locator(topBox)
      .textContent()
      .catch(() => '')
    return (v ?? '').startsWith('Thanks Bob')
  })
  check('点「填入」→ 没开着这个帖子：新开新版 Reddit 帖子页（www），草稿填进评论框', filled2)
  if (pg2 !== undefined) await shot(pg2, '8b-reddit-filled-new')
  const HUMAN = 'Thanks Bob! Which mode were you in? We are collecting 2.1 battery reports.'
  if (pg2 !== undefined && filled2) {
    await pg2.locator(topBox).fill(HUMAN)
    await pg2.locator('comment-composer-host:not([parent-id]) button.human-send').click()
  }
  const sent2 = await until(async () => {
    const rows = await http('/v1/outbound/records')
    return rows.some((r) => r.approval_item_id === other?.id)
  })
  const rows2 = await http('/v1/outbound/records')
  const row2 = rows2.find((r) => r.approval_item_id === other?.id)
  check(
    '人在页面上改了字再发 → 插件按品牌号认出、读回真发出去的字；发出记录按真发的记、AI 草稿另存',
    sent2 &&
      row2?.content === HUMAN &&
      typeof row2?.draft_content === 'string' &&
      row2.draft_content.startsWith('Thanks Bob — could you share'),
    JSON.stringify({ content: row2?.content, draft: row2?.draft_content }),
  )
  check(
    '那一下 Comment 是人点的（isTrusted）',
    sends.length === 2 && sends[1].trusted === true && sends[1].text === HUMAN,
  )
  const badgeGone = await until(
    async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) !== '1',
    20_000,
  )
  check('发出去之后图标上的数字收掉', badgeGone)
  await panel.bringToFront()
  await shot(panel, '8c-desk-sent-light')

  // ⑤ WP445：「不发 + 理由」——同一个帖子下另外两张同类的卡，按理由一并不发；能撤回；没写理由只不发这一张
  for (const [who, text] of [
    ['dave', 'Same here, battery drains fast after 2.1.'],
    ['erin', 'Battery is worse since the update for me too.'],
  ])
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
            post_text: text,
            parent_author: who,
          },
          text: `Thanks ${who}, which mode were you in?`,
          reason: '用户在问固件更新后的续航',
        }),
      },
      reddit.id,
    )
  await until(async () => (await cards.count()) === 2, 15_000)
  const first = cards.first()
  if ((await first.getAttribute('data-open')) !== '1') await first.locator('.ws-card-head').click()
  await first.locator('[data-testid="ws-desk-skip"]').click()
  await shot(panel, '9a-skip-reasons-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '9a-skip-reasons-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  await first.locator('[data-testid="ws-skip-reason"]', { hasText: '不相关' }).click()
  const followShown = await until(
    async () =>
      (
        (await panel
          .locator('[data-testid="ws-follow"]')
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('同类的也不发了'),
    15_000,
  )
  const decidedSkips = autoCards().filter((c) => c.state === 'rejected')
  check(
    '「不发 + 理由」→ 这一张不发（理由进账、via=extension），同类那一张按理由一并不发，顶上一行能撤回',
    followShown &&
      decidedSkips.length === 2 &&
      decidedSkips.some((c) => c.decision?.reason === '不相关' && c.decision?.via === 'extension'),
    JSON.stringify(decidedSkips.map((c) => c.decision?.reason)),
  )
  await shot(panel, '9b-followed-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '9b-followed-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  await panel.locator('[data-testid="ws-follow-undo"]').click()
  const undone = await until(async () => (await cards.count()) === 1, 15_000)
  check('撤回 → 跟着不发的那一张回到「等你发」', undone)

  // ⑤ WP419（决策 1231）：社媒发帖不要开发者应用——到点了交给你：侧边栏「等你发的帖子」、打开发帖页、发好了
  const fbAsg = server.roles.assignments.create({
    person_id: me,
    workspace_id: ws,
    granted_by: me,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: 'social.facebook',
  })
  const actor = {
    workspace_id: ws,
    person_id: me,
    assignment_id: fbAsg.id,
    role_id: 'social.facebook',
  }
  const acct = await brand.socialService.port.createAccount(actor, {
    channel: 'facebook',
    handle: 'nordvolt',
    display_name: 'Nordvolt',
    url: 'https://www.facebook.com/nordvolt',
    external_id: 'https://www.facebook.com/nordvolt',
  })
  const made = await brand.socialService.port.createPost(actor, {
    account_id: acct.id,
    kind: 'post',
    body: 'Weekend camping checklist: what we pack and why.',
    scheduled_at: new Date(Date.now() + 1500).toISOString(),
  })
  // WP445：社媒「交给你发」的这一条也不在工坊出卡——不用先批，到点直接进插件
  const postCard =
    made.staged.approval_item_id === undefined
      ? undefined
      : await server.txn.approvals.get(made.staged.approval_item_id)
  check(
    'WP445：社媒「交给你发」的帖子卡标「插件里审」（工坊不出卡）',
    postCard?.payload?.after?.desk === 'plugin' &&
      !JSON.stringify(await http(`/v1/positions/${fbAsg.id}/cards`, {}, fbAsg.id)).includes(
        postCard?.id ?? '-',
      ),
  )
  await new Promise((r) => setTimeout(r, 2000))
  for (let i = 0; i < 20 && brand.socialService.handoffs().length === 0; i += 1) {
    await brand.socialService.publishDue()
    await new Promise((r) => setTimeout(r, 250))
  }
  const postRow = panel.locator('[data-testid="ws-post"]')
  const postShown = await until(async () => (await postRow.count()) === 1, 20_000)
  check('到点了没接官方接口 → 侧边栏「等你发的帖子」里有这一条（不要开发者应用）', postShown)
  await shot(panel, '8-post-light')
  await panel.emulateMedia({ colorScheme: 'dark' })
  await shot(panel, '8-post-dark')
  await panel.emulateMedia({ colorScheme: 'light' })
  await panel
    .locator('[data-testid="ws-post-link"]')
    .fill('https://www.facebook.com/nordvolt/posts/1')
  await panel.locator('[data-testid="ws-post-done"]').click()
  const published = await until(
    () => brand.social.post(made.post.id)?.status === 'published',
    15_000,
  )
  const after = brand.social.post(made.post.id)
  check(
    '点「发好了」带链接 → 帖子记已发、读回确认（插件不点发布）',
    published && after?.published_via === 'extension' && after?.readback === 'link',
    JSON.stringify({ status: after?.status, via: after?.published_via, readback: after?.readback }),
  )
  const postDecided =
    postCard === undefined ? undefined : await server.txn.approvals.get(postCard.id)
  check(
    'WP445：插件里点「发好了」就是批（via=extension）',
    postDecided?.decision?.via === 'extension' &&
      ['approved', 'approved_edited', 'applying', 'applied'].includes(postDecided?.state ?? ''),
    JSON.stringify({ state: postDecided?.state, via: postDecided?.decision?.via }),
  )
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
