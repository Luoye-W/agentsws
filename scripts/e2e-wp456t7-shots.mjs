#!/usr/bin/env node
/**
 * WP456-T7：**插件侧边栏截图**（浅 / 深），和 WP456 示意稿并排。
 *
 * 不起本机服务、不连任何网站：把构建好的插件页面（`apps/extension/build/chrome-mv3/sidepanel.html`）用一个只在
 * 127.0.0.1 上的小静态服务端出来，页面里的 `chrome.*` 换成替身——「插件后台」回一份固定的演示快照
 * （演示品牌 NordVolt Gear / 王岚，帖子与人名都是假的）。这样「要你处理」里失败卡、等你点发送、已发几种状态能一次拍全。
 * 真流程（真本机服务 + 真插件 + 替身 Reddit）仍由 `scripts/e2e-wp413-sidepanel.mjs` 走。
 *
 * 用法（先 `pnpm -F @agentsws/extension build`）：
 *   node scripts/e2e-wp456t7-shots.mjs --out=<目录> [--port=4789] [--mockups=<示意稿目录>]
 *   `--mockups` 给了就再出并排图 `compare-<主题>-<页>.png`（左示意稿、右实拍）。截图放私有文档仓，不进本仓。
 * 退出码：0 拍完；1 有一张没拍成；2 起不来。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
const OUT = opt('out')
const PORT = Number(opt('port') ?? 4789)
const MOCKUPS = opt('mockups')
const BUILD = join(ROOT, 'apps/extension/build/chrome-mv3')
if (OUT === undefined) {
  console.error('要 --out=<目录>')
  process.exit(2)
}
if (!existsSync(join(BUILD, 'sidepanel.html'))) {
  console.error('先 pnpm -F @agentsws/extension build')
  process.exit(2)
}

// ── 演示快照 ──────────────────────────────────────────────────────────────
const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const H = 3_600_000

const cards = [
  {
    id: 'c-bob',
    version: 1,
    kind: 'comment',
    subreddit: 'ivraxr',
    title: '回帖 bob（Reddit · r/ivraxr）',
    post_title: 'Battery life after the 2.1 update?',
    parent_author: 'bob',
    parent_text: 'Mine drops 20% an hour since the update.',
    link: 'https://www.reddit.com/r/ivraxr/comments/abc/battery/',
    draft: {
      text: 'Thanks Bob — could you share which mode you were in? We are collecting reports on 2.1.',
    },
    reason: '用户在问固件更新后的续航',
    rules: ['No direct links to stores'],
    created_at: iso(0.2 * H),
  },
  {
    id: 'c-alice',
    version: 1,
    kind: 'reply',
    subreddit: 'ivraxr',
    title: '回复 alice（Reddit · r/ivraxr）',
    post_title: 'Does the Air3 work with glasses?',
    parent_author: 'alice',
    parent_text:
      'Mine fogs up a bit when I wear glasses. Does the Air3 work with prescription frames?',
    link: 'https://www.reddit.com/r/ivraxr/comments/def/glasses/',
    draft: { text: 'Hi Alice — yes, the Air3 has a prescription insert.' },
    reason: '问能不能配近视镜',
    created_at: iso(0.5 * H),
  },
]

const writes = [
  {
    job_id: 'w-fail',
    approval_item_id: 'a-1',
    state: 'failed',
    label: '回复 carol（Reddit · r/ivraxr）',
    subreddit: 'ivraxr',
    message: '原帖那个标签页被关掉了',
    can_refill: true,
    kind: 'reply',
    queued_at: iso(1 * H),
  },
  {
    job_id: 'w-fill',
    approval_item_id: 'a-2',
    state: 'filling',
    label: '回帖 dave（Reddit · r/ivraxr）',
    subreddit: 'ivraxr',
    kind: 'comment',
    text: 'Thanks Dave!',
    queued_at: iso(0.1 * H),
  },
  {
    job_id: 'w-sent',
    approval_item_id: 'a-3',
    state: 'sent',
    label: '回复 erin（Reddit · r/ivraxr）',
    subreddit: 'ivraxr',
    link: 'https://www.reddit.com/r/ivraxr/comments/ghi/x/c9/',
    record_id: 'r-1',
    kind: 'reply',
    queued_at: iso(2 * H),
    finished_at: iso(1.9 * H),
  },
]

const progress = {
  configured: true,
  account: 'nordvolt_official',
  reddit_connected: true,
  reading: false,
  last_run: {
    started_at: iso(1.1 * H),
    finished_at: iso(1 * H),
    trigger: 'schedule',
    pending: 3,
    parts: [
      { part: 'inbox', status: 'ok', fetched: 4, fresh: 1 },
      { part: 'own_sub', status: 'ok', fetched: 12, fresh: 2 },
      {
        part: 'watch_sub',
        status: 'failed',
        fetched: 0,
        fresh: 0,
        message: 'Reddit 回了 429，过一会儿再读',
      },
      { part: 'external', status: 'skipped', fetched: 0, fresh: 0 },
    ],
  },
  next_run_at: new Date(now + 20 * H).toISOString(),
  drafting: 1,
  pending: 3,
  replied_before: 2,
  sent_today: 3,
  awaiting: 2,
}

const records = [
  {
    id: 'r-1',
    sent_at: iso(1.9 * H),
    channel: 'reddit',
    action: 'reply',
    destination: 'r/ivraxr',
    content: 'Hi Erin — the case fits the Air3 Pro too; the hinge is the same size.',
    link: 'https://www.reddit.com/r/ivraxr/comments/ghi/x/c9/',
    status: 'sent',
    via_extension: true,
    sinks: [{ name: '回复记录表', status: 'written' }],
  },
  {
    id: 'r-2',
    sent_at: iso(5 * H),
    channel: 'reddit',
    action: 'comment',
    destination: 'r/ivraxr',
    content: 'Thanks for the detailed write-up! We passed the hinge noise report to the team.',
    link: 'https://www.reddit.com/r/ivraxr/comments/jkl/x/',
    status: 'sent',
    sinks: [{ name: '回复记录表', status: 'failed', message: '表格没权限写' }],
  },
  {
    id: 'r-3',
    sent_at: iso(26 * H),
    channel: 'reddit',
    action: 'reply',
    destination: 'r/ivraxr',
    content: 'We are on it — firmware 2.1.1 lands next week.',
    status: 'failed',
    sinks: [],
  },
]

const sinks = [{ name: '回复记录表', state: 'active', written: 12, pending: 1 }]

const snapshot = {
  at: new Date(now).toISOString(),
  workspace_name: 'NordVolt Gear',
  person_name: '王岚',
  can_act: true,
  can_post: true,
  progress,
  cards,
  writes,
  records,
  sinks,
  posts: [],
  versions: { workshop: '0.2.1', folder: '0.2.1' },
}

const state = { kind: 'ok', snapshot, reddit_here: true }

// ── 页面里的 chrome.* 替身 ───────────────────────────────────────────────
const fakeChrome = (s) => {
  const reply = (m) => {
    if (m.type === 'panel-state') return { type: 'panel-state', state: s }
    return undefined
  }
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => reply(m),
      getManifest: () => ({ version: '0.2.1', version_name: '0.2.1' }),
      onMessage: { addListener() {} },
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
  }
}

// ── 静态服务（只在 127.0.0.1） ─────────────────────────────────────────────
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  const file = resolve(BUILD, `.${path}`)
  if (!file.startsWith(BUILD) || !existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((ok, bad) => {
  server.once('error', bad)
  server.listen(PORT, '127.0.0.1', ok)
})

const { chromium } = require(
  join(ROOT, 'node_modules/.pnpm/playwright@1.63.0/node_modules/playwright'),
)
const browser = await chromium.launch()
let failed = 0
mkdirSync(OUT, { recursive: true })
try {
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 880 },
    deviceScaleFactor: 2,
  })
  await ctx.addInitScript(fakeChrome, state)
  // 页面不许出 127.0.0.1（演示里的链接只是字，不点）
  await ctx.route(/^(?!http:\/\/127\.0\.0\.1)/u, (r) => r.abort())
  const page = await ctx.newPage()
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`http://127.0.0.1:${PORT}/sidepanel.html`)
    await page.waitForSelector('[data-testid="ws-desk-list"]')
    const shots = [
      ['8-todo', null],
      ['8-progress', 'ws-tab-progress'],
      ['8-records', 'ws-tab-records'],
    ]
    for (const [name, tab] of shots) {
      try {
        if (tab !== null) await page.click(`[data-testid="${tab}"]`)
        await page.waitForTimeout(150)
        await page.screenshot({ path: join(OUT, `${theme}-${name}.png`) })
        console.log(`✓ ${theme}-${name}.png`)
      } catch (e) {
        failed += 1
        console.error(`✗ ${theme}-${name}：${e instanceof Error ? e.message : e}`)
      }
    }
    // 「要你处理」往下拉：失败卡、等你点发送那几行
    await page.click('[data-testid="ws-tab-todo"]')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(OUT, `${theme}-8-todo-writes.png`) })
    console.log(`✓ ${theme}-8-todo-writes.png`)
    await page.evaluate(() => window.scrollTo(0, 0))
  }

  // 并排：左示意稿、右实拍
  if (MOCKUPS !== undefined) {
    const cmp = await browser.newPage({
      viewport: { width: 860, height: 960 },
      deviceScaleFactor: 2,
    })
    for (const theme of ['light', 'dark']) {
      for (const name of ['8-todo', '8-progress', '8-records', '8-todo-writes']) {
        const png = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`
        const left = png(join(MOCKUPS, `after-${theme}-8-extension.png`))
        const right = png(join(OUT, `${theme}-${name}.png`))
        const bg = theme === 'dark' ? '#0e100f' : '#f3f5f2'
        const fg = theme === 'dark' ? '#98a29b' : '#6b746f'
        await cmp.setContent(
          `<body style="margin:0;background:${bg};font:12px -apple-system,'PingFang SC',sans-serif;color:${fg}">
            <div style="display:flex;gap:20px;padding:16px 20px">
              <figure style="margin:0"><figcaption style="margin-bottom:8px">示意稿（WP456 §3.12）</figcaption>
                <img src="${left}" style="width:400px;height:880px;border-radius:8px;box-shadow:0 0 0 1px rgba(127,127,127,.25)"></figure>
              <figure style="margin:0"><figcaption style="margin-bottom:8px">实拍（WP456-T7）</figcaption>
                <img src="${right}" style="width:400px;height:880px;border-radius:8px;box-shadow:0 0 0 1px rgba(127,127,127,.25)"></figure>
            </div></body>`,
          { waitUntil: 'load' },
        )
        await cmp.screenshot({ path: join(OUT, `compare-${theme}-${name}.png`) })
        console.log(`✓ compare-${theme}-${name}.png`)
      }
    }
  }
} finally {
  await browser.close()
  server.close()
}
process.exit(failed === 0 ? 0 : 1)
