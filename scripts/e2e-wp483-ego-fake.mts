/**
 * WP483 真机联调（Mac / Windows 都能跑）：**真的 ego**、**本机假页面**——把「ego 那一路」从填好到点发送、读回走一遍。
 *
 *   npx tsx scripts/e2e-wp483-ego-fake.mts [--port 4916] [--shots <截图目录>] [--ego <ego-browser 路径>]
 *
 * - 假页面开在 127.0.0.1:<port>：Reddit 帖子页（回评论 / 回帖子）、Facebook 主页发帖框、X 发帖页、
 *   一张写着「verify you are human」的页、一张没登录的页。结构照真站公开页面的那几处（选择器表见 `ego-write/script.ts`）。
 *   页面上「发送」只是把这一条存进这个脚本自己的内存（再开页面看得到，读回用），**没有任何东西出这台电脑**。
 * - 跑的是产品里同一份 `runEgoWrite`（同一段脚本、同一个子进程跑法），只把地址指到假页面。
 * - **不碰任何真网站**；ego 里开的是一个新的 AI 空间，跑完 `finish()` 关掉（「只填不发」那几条按产品行为把页面留给人，
 *   会剩一个 127.0.0.1 的标签页，手动关掉即可）。
 */
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runEgoWrite } from '../apps/server/src/ego-write/runner.ts'
import type { EgoWriteScriptConfig } from '../apps/server/src/ego-write/script.ts'

const args = process.argv.slice(2)
const val = (n: string, d?: string): string | undefined =>
  args.includes(n) ? args[args.indexOf(n) + 1] : d
const port = Number(val('--port', '4916'))
const shots = val('--shots')
const egoPath = val('--ego', join(homedir(), '.local/bin/ego-browser')) as string
if (shots !== undefined) mkdirSync(shots, { recursive: true })

/** 「发出去」的那几条（只在这个进程的内存里）。 */
const posted: { where: string; id: string; text: string }[] = []
let seq = 0

const page = (title: string, body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;margin:24px;max-width:720px} [contenteditable]{border:1px solid #888;min-height:60px;padding:6px}
[role=dialog]{border:2px solid #36c;padding:12px;margin:12px 0} .toast{background:#222;color:#fff;padding:6px}</style></head>
<body><header style="display:flex;gap:12px;justify-content:space-between"><b>${title}</b><a href="/me">u/wp483_tester</a></header>${body}
<script>const post=(where,text)=>fetch('/api/post',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({where,text})}).then(r=>r.json());${script}</script></body></html>`

const esc = (s: string): string => s.replace(/[&<>"]/gu, (c) => `&#${c.charCodeAt(0)};`)

const THREAD = '/r/wp483test/comments/abc123/hello_world/'
const redditThread = (): string => {
  const mine = posted.filter((p) => p.where === 'reddit')
  const replies = mine
    .filter((p) => p.id.startsWith('r'))
    .map(
      (p) =>
        `<shreddit-comment thingid="t1_${p.id}" parentid="t1_c1" depth="1" permalink="${THREAD}comment/${p.id}/"><div slot="comment"><p>${esc(p.text)}</p></div></shreddit-comment>`,
    )
    .join('')
  const top = mine
    .filter((p) => p.id.startsWith('k'))
    .map(
      (p) =>
        `<shreddit-comment thingid="t1_${p.id}" depth="0" permalink="${THREAD}comment/${p.id}/"><div slot="comment"><p>${esc(p.text)}</p></div></shreddit-comment>`,
    )
    .join('')
  return page(
    'r/wp483test',
    `<shreddit-post><h1 slot="title">Hello world</h1></shreddit-post>
<shreddit-comment thingid="t1_c1" depth="0" permalink="${THREAD}c1/"><div slot="comment"><p>Does it fog up with glasses?</p></div>
<shreddit-comment-action-row comment-id="t1_c1"><div slot="comment-reply"><button>Reply</button></div></shreddit-comment-action-row>${replies}</shreddit-comment>
${top}
<comment-composer-host><faceplate-textarea-input data-testid="trigger-button"><textarea aria-label="Join the conversation" placeholder="Join the conversation"></textarea></faceplate-textarea-input></comment-composer-host>`,
    `const composer=(host,kind)=>{if(host.querySelector('shreddit-composer'))return;const c=document.createElement('shreddit-composer');c.innerHTML='<div contenteditable="true" role="textbox"></div><button slot="submit-button" type="submit">Comment</button>';host.appendChild(c);
c.querySelector('button').addEventListener('click',async()=>{const t=c.querySelector('[contenteditable]').innerText.trim();if(!t)return;await post('reddit:'+kind,t);location.reload();});};
document.querySelector('[slot="comment-reply"] button').addEventListener('click',()=>composer(document.querySelector('shreddit-comment-action-row'),'reply'));
const ta=document.querySelector('comment-composer-host textarea');const open=()=>{ta.closest('faceplate-textarea-input').remove();composer(document.querySelector('comment-composer-host'),'comment');};ta.addEventListener('focus',open);ta.addEventListener('click',open);`,
  )
}

const fbPage = (): string => {
  const feed = posted
    .filter((p) => p.where === 'facebook')
    .map(
      (p) => `<article><a href="/fb/posts/${p.id}">Just now</a><div>${esc(p.text)}</div></article>`,
    )
    .join('')
  return page(
    'Facebook · WP483 test page',
    `<div role="button" id="open">What's on your mind, Tester?</div><div id="feed">${feed}</div>`,
    `document.getElementById('open').addEventListener('click',()=>{if(document.querySelector('[role=dialog]'))return;const d=document.createElement('div');d.setAttribute('role','dialog');
d.innerHTML='<div contenteditable="true" role="textbox" aria-label="What\\'s on your mind?"></div><input type="file" style="display:none"><div role="button" aria-label="Post">Post</div>';document.body.appendChild(d);
d.querySelector('[aria-label=Post]').addEventListener('click',async()=>{const t=d.querySelector('[contenteditable]').innerText.trim();await post('facebook',t);setTimeout(()=>d.remove(),400);});});`,
  )
}

const xPage = (): string =>
  page(
    'X · compose',
    `<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text"></div><button data-testid="tweetButton">Post</button>`,
    `document.querySelector('[data-testid=tweetButton]').addEventListener('click',async()=>{const t=document.querySelector('[data-testid=tweetTextarea_0]').innerText.trim();const r=await post('x',t);
const s=document.createElement('div');s.className='toast';s.setAttribute('data-testid','toast');s.innerHTML='Your post was sent. <a href="/x/wp483_tester/status/'+r.id+'">View</a>';document.body.appendChild(s);});`,
  )

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (req.method === 'POST' && url.pathname === '/api/post') {
    let raw = ''
    req.on('data', (c) => {
      raw += String(c)
    })
    req.on('end', () => {
      const { where, text } = JSON.parse(raw) as { where: string; text: string }
      seq += 1
      const id = `${where === 'reddit:reply' ? 'r' : where === 'reddit:comment' ? 'k' : 'p'}${900 + seq}`
      posted.push({ where: where.startsWith('reddit') ? 'reddit' : where, id, text })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id }))
    })
    return
  }
  const html = url.pathname.startsWith(THREAD)
    ? redditThread()
    : url.pathname === '/fb/page'
      ? fbPage()
      : url.pathname === '/x/compose/post'
        ? xPage()
        : url.pathname === '/blocked'
          ? page('Check', '<h2>Please verify you are human to continue.</h2>')
          : url.pathname === '/logged-out'
            ? page(
                'Welcome',
                '<div style="position:fixed;top:8px;right:8px"><button>Log In</button></div>',
              ).replace('<a href="/me">u/wp483_tester</a>', '')
            : undefined
  if (html === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
const O = `http://127.0.0.1:${port}`

type Case = {
  name: string
  cfg: Omit<EgoWriteScriptConfig, 'space'>
  want: string
  check?: (r: Awaited<ReturnType<typeof runEgoWrite>>) => boolean
}
const cases: Case[] = [
  {
    name: 'reddit 回评论 · 发之前让我看一眼（只填不点）',
    cfg: {
      platform: 'reddit-reply',
      mode: 'write',
      url: `${O}${THREAD}c1/`,
      parent: 't1_c1',
      text: 'WP483 review-first fill.\nSecond line.',
      submit: false,
    },
    want: 'filled',
  },
  {
    name: 'reddit 回评论 · 自动发（点发送 + 读回编号与链接）',
    cfg: {
      platform: 'reddit-reply',
      mode: 'write',
      url: `${O}${THREAD}c1/`,
      parent: 't1_c1',
      text: 'WP483 auto reply to c1.',
      submit: true,
    },
    want: 'sent',
    check: (r) =>
      r.external_id?.startsWith('t1_r') === true && (r.link ?? '').includes('/comment/'),
  },
  {
    name: 'reddit 回帖子 · 自动发',
    cfg: {
      platform: 'reddit-comment',
      mode: 'write',
      url: `${O}${THREAD}`,
      text: 'WP483 top-level comment.',
      submit: true,
    },
    want: 'sent',
    check: (r) => r.external_id?.startsWith('t1_k') === true,
  },
  {
    name: 'reddit 读回（「看一眼」之后人发了没有）',
    cfg: {
      platform: 'reddit-reply',
      mode: 'readback',
      url: `${O}${THREAD}c1/`,
      text: 'WP483 auto reply to c1.',
      submit: false,
    },
    want: 'sent',
  },
  {
    name: 'facebook 主页发帖 · 只填不点',
    cfg: {
      platform: 'facebook-post',
      mode: 'write',
      url: `${O}/fb/page`,
      text: 'WP483 facebook review-first.',
      submit: false,
    },
    want: 'filled',
  },
  {
    name: 'facebook 主页发帖 · 自动发 + 去主页读回链接',
    cfg: {
      platform: 'facebook-post',
      mode: 'write',
      url: `${O}/fb/page`,
      readback_url: `${O}/fb/page`,
      text: 'WP483 facebook auto post.',
      submit: true,
    },
    want: 'sent',
    check: (r) => (r.link ?? '').includes('/fb/posts/'),
  },
  {
    name: 'x 发帖 · 自动发（提示条里的链接）',
    cfg: {
      platform: 'x-post',
      mode: 'write',
      url: `${O}/x/compose/post`,
      text: 'WP483 x auto post.',
      submit: true,
    },
    want: 'sent',
    check: (r) => (r.link ?? '').includes('/status/'),
  },
  {
    name: '平台拦了（页面写着 verify you are human）→ 停下、不绕',
    cfg: {
      platform: 'x-post',
      mode: 'write',
      url: `${O}/blocked`,
      text: 'should not be typed',
      submit: true,
    },
    want: 'blocked',
  },
  {
    name: '没登录 → needs_login（产品里退插件）',
    cfg: {
      platform: 'facebook-post',
      mode: 'write',
      url: `${O}/logged-out`,
      text: 'should not be typed',
      submit: true,
    },
    want: 'needs_login',
  },
]

let failed = 0
for (const [i, c] of cases.entries()) {
  const shot =
    shots === undefined ? undefined : join(shots, `wp483-ego-${String(i + 1).padStart(2, '0')}.png`)
  const r = await runEgoWrite({
    egoPath,
    cfg: {
      ...c.cfg,
      space: `工坊 · WP483 联调 ${i + 1} · ${Date.now().toString(36)}`,
      ...(shot === undefined ? {} : { shot }),
    },
  })
  const ok = r.state === c.want && (c.check === undefined || c.check(r))
  if (!ok) failed += 1
  console.log(
    `${ok ? '✓' : '✗'} ${c.name}：${r.state}${r.link === undefined ? '' : ` · ${r.link}`}${r.external_id === undefined ? '' : ` · ${r.external_id}`}${r.why === undefined ? '' : ` · ${r.why}`}（${Math.round((r.duration_ms ?? 0) / 1000)} 秒）`,
  )
}
console.log(`\n「发出去」的（只在本机假页面内存里）：${JSON.stringify(posted)}`)
server.close()
process.exit(failed === 0 ? 0 : 1)
