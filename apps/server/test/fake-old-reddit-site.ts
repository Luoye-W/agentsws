/**
 * WP249：本地假 old.reddit（**不访问真的 reddit.com、不登录任何网站**）——给真 Chrome 跑的那份测试用。
 *
 * 照 old.reddit 公开页面的写法摆几页：登录态首页、版务队列（`.json` 与带大按钮的页面）、版规、
 * 帖子页回复框、发帖表单、置顶开关、封禁页。按钮背后是页面脚本发的写请求（与真站一样走 AJAX），
 * 每个请求都记下来，测试据此断言「只发了卡上那一个动作要的写请求」。
 *
 * 「登录」= 打开 `/login` 就种上 cookie（替用户在窗口里登录这一下；真站上这一步是人自己做的）。
 * 每个页面还藏了一段「偷偷点赞」的脚本（`POST /api/vote`），驱动层的网络闸必须把它掐掉。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SeenRequest {
  method: string
  path: string
  body: string
  cookie: boolean
}

interface Thing {
  kind: 't3' | 't1'
  id: string
  title: string
  body: string
  author: string
  reports: string[]
}

export interface FakeOldRedditSite {
  origin: string
  seen: SeenRequest[]
  queues: { modqueue: Thing[]; unmoderated: Thing[] }
  banned: string[]
  comments: Record<string, string[]>
  posts: { id: string; title: string; text: string; sticky: boolean }[]
  captchaNext: boolean
  close(): Promise<void>
}

const SPY = '<script>try{fetch("/api/vote",{method:"POST",body:"dir=1"})}catch(e){}</script>'
const esc = (s: string): string => s.replace(/[&<>"]/gu, (c) => `&#${c.charCodeAt(0)};`)

function shell(body: string, loggedIn: boolean, extra = '', spy = true): string {
  return (
    `<!doctype html><html><head><title>reddit</title><script>var MODHASH="uh123";</script>${extra}</head>` +
    `<body class="${loggedIn ? 'loggedin ' : ''}listing-page">` +
    `<div id="header-bottom-right">${loggedIn ? '<span class="user"><a href="/user/inmo_official/">inmo_official</a></span>' : '<a class="login-required" href="/login">log in</a>'}</div>` +
    `${body}${spy ? SPY : ''}</body></html>`
  )
}

const POST_SCRIPT =
  '<script>function rpost(p,d,cb){fetch(p,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(Object.assign({uh:MODHASH},d)).toString()}).then(function(r){return r.json()}).then(cb)}</script>'

export async function startFakeOldReddit(sub = 'inmoxr'): Promise<FakeOldRedditSite> {
  const site: Omit<FakeOldRedditSite, 'origin' | 'close'> = {
    seen: [],
    queues: { modqueue: [], unmoderated: [] },
    banned: [],
    comments: {},
    posts: [],
    captchaNext: false,
  }

  const listing = (things: Thing[]) =>
    JSON.stringify({
      kind: 'Listing',
      data: {
        children: things.map((t) => ({
          kind: t.kind,
          data: {
            name: `${t.kind}_${t.id}`,
            ...(t.kind === 't3'
              ? { title: t.title, selftext: t.body }
              : { body: t.body, link_title: t.title }),
            author: t.author,
            subreddit: sub,
            permalink: `/r/${sub}/comments/${t.id}/x/`,
            created_utc: 1_791_000_000,
            num_reports: t.reports.length,
            user_reports: t.reports.map((r) => [r, 1]),
            mod_reports: [],
          },
        })),
      },
    })

  const queuePage = (source: 'modqueue' | 'unmoderated') =>
    site.queues[source]
      .map(
        (t) =>
          `<div class="thing ${t.kind === 't3' ? 'link' : 'comment'}" data-fullname="${t.kind}_${t.id}" data-type="${t.kind === 't3' ? 'link' : 'comment'}" data-author="${t.author}" data-subreddit="${sub}" data-permalink="/r/${sub}/comments/${t.id}/x/" data-timestamp="1791000000000">` +
          `<a class="title" href="#">${esc(t.title)}</a><div class="usertext-body"><div class="md">${esc(t.body)}</div></div>` +
          `<ul class="report-reasons">${t.reports.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` +
          '<ul class="flat-list buttons"><li><a href="#" class="arrow up" onclick="rpost(\'/api/vote\',{dir:1},function(){});return false">upvote</a></li></ul>' +
          `<div class="big-mod-buttons"><span><a class="pretty-button positive" href="#" onclick="var e=this;rpost('/api/approve',{id:'${t.kind}_${t.id}'},function(){e.closest('.thing').remove()});return false">approve</a></span>` +
          `<span><a class="pretty-button neutral" href="#" onclick="var e=this;rpost('/api/remove',{id:'${t.kind}_${t.id}',spam:'false'},function(){e.closest('.thing').remove()});return false">remove</a></span>` +
          `<span><a class="pretty-button negative" href="#" onclick="rpost('/api/remove',{id:'${t.kind}_${t.id}',spam:'true'},function(){});return false">spam</a></span></div></div>`,
      )
      .join('')

  const commentArea = (id: string) =>
    `<div class="commentarea"><form class="usertext" onsubmit="return false"><textarea name="text"></textarea>` +
    `<button type="submit" class="save" onclick="var f=this.form;rpost('/api/comment',{thing_id:'t3_${id}',text:f.text.value},function(){var d=document.createElement('div');d.className='thing comment';d.innerHTML='<div class=md></div>';d.firstChild.textContent=f.text.value;document.querySelector('.commentarea').appendChild(d)})">save</button></form>` +
    (site.comments[id] ?? [])
      .map((c) => `<div class="thing comment"><div class="md">${esc(c)}</div></div>`)
      .join('') +
    '</div>'

  const route = (req: IncomingMessage, res: ServerResponse, body: string, origin: string) => {
    const url = new URL(req.url ?? '/', origin)
    const p = url.pathname
    const cookie = (req.headers.cookie ?? '').includes('reddit_session=ok')
    site.seen.push({ method: req.method ?? 'GET', path: p, body, cookie })
    const html = (code: number, text: string, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(text)
    }
    const json = (code: number, v: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(v))
    }
    if (p === '/favicon.ico') return html(404, '')
    if (req.method === 'POST') {
      const form = new URLSearchParams(body)
      if (!cookie || form.get('uh') !== 'uh123') return json(403, { error: 403 })
      if (p === '/api/approve' || p === '/api/remove') {
        const id = form.get('id') ?? ''
        for (const q of ['modqueue', 'unmoderated'] as const)
          site.queues[q] = site.queues[q].filter((t) => `${t.kind}_${t.id}` !== id)
        return json(200, {})
      }
      if (p === '/api/comment') {
        const id = (form.get('thing_id') ?? '').replace(/^t3_/u, '')
        site.comments[id] = [...(site.comments[id] ?? []), form.get('text') ?? '']
        return json(200, { json: { errors: [] } })
      }
      if (p === '/api/friend') {
        site.banned.push(form.get('name') ?? '')
        return json(200, { json: { errors: [] } })
      }
      if (p === '/api/submit') {
        const id = `n${site.posts.length + 1}`
        site.posts.push({
          id,
          title: form.get('title') ?? '',
          text: form.get('text') ?? '',
          sticky: false,
        })
        return json(200, {
          json: { errors: [], data: { url: `/r/${sub}/comments/${id}/post/`, name: `t3_${id}` } },
        })
      }
      if (p === '/api/set_subreddit_sticky') {
        const id = (form.get('id') ?? '').replace(/^t3_/u, '')
        for (const x of site.posts) if (x.id === id) x.sticky = true
        return json(200, {})
      }
      return json(200, {})
    }
    if (site.captchaNext) {
      site.captchaNext = false
      return html(
        200,
        '<!doctype html><html><head><title>Verify</title></head><body><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><p>Please verify you are human</p></body></html>',
      )
    }
    if (p === '/login')
      // 登录页是用户自己的窗口（不过我们的闸），这里不放偷偷点赞的脚本，免得算到自动化头上
      return html(200, shell('<p>Welcome back</p>', true, '', false), {
        'set-cookie': 'reddit_session=ok; Path=/; Max-Age=86400; HttpOnly',
      })
    if (p === '/') return html(200, shell('<div id="siteTable"></div>', cookie))
    const q = p.match(/^\/r\/[^/]+\/about\/(modqueue|unmoderated)\/(\.json)?$/u)
    if (q !== null) {
      if (!cookie) return json(403, { message: 'Forbidden', error: 403 })
      const source = q[1] as 'modqueue' | 'unmoderated'
      if (q[2] === '.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(listing(site.queues[source]))
      }
      return html(200, shell(`<div id="siteTable">${queuePage(source)}</div>`, cookie, POST_SCRIPT))
    }
    if (p === `/r/${sub}/about/rules/.json`)
      return json(200, {
        rules: [{ short_name: 'No spam or self-promotion' }, { short_name: 'Be civil' }],
      })
    const c = p.match(/^\/comments\/([a-z0-9]+)\/$/u)
    if (c !== null) return html(200, shell(commentArea(c[1] ?? ''), cookie, POST_SCRIPT))
    if (p === `/r/${sub}/about/banned/`)
      return html(
        200,
        shell(
          '<form id="banned" onsubmit="return false"><input name="name"><input name="duration"><input name="note"><textarea name="ban_message"></textarea>' +
            '<button type="submit" onclick="var f=this.form;rpost(\'/api/friend\',{type:\'banned\',name:f.name.value,duration:f.duration.value},function(){location.reload()})">ban</button></form>' +
            `<table class="banned-table">${site.banned.map((b) => `<tr><td>${esc(b)}</td></tr>`).join('')}</table>`,
          cookie,
          POST_SCRIPT,
        ),
      )
    if (p === `/r/${sub}/submit`)
      return html(
        200,
        shell(
          '<form id="newlink" onsubmit="return false"><textarea name="title"></textarea><textarea name="text"></textarea>' +
            '<button name="submit" type="submit" onclick="var f=this.form;rpost(\'/api/submit\',{kind:\'self\',title:f.title.value,text:f.text.value},function(r){location.href=r.json.data.url})">submit</button></form>',
          cookie,
          POST_SCRIPT,
        ),
      )
    const post = p.match(new RegExp(`^/r/${sub}/comments/([a-z0-9]+)/[^/]+/$`, 'u'))
    if (post !== null) {
      const id = post[1] ?? ''
      return html(
        200,
        shell(
          `<div class="sitetable linklisting"><div class="thing link" data-fullname="t3_${id}"><ul class="flat-list buttons"><li><form class="toggle sticky-button" onsubmit="return false">` +
            '<span class="option main active"><a href="#" class="togglebutton" onclick="this.parentNode.nextSibling.style.display=\'inline\';return false">sticky</a></span>' +
            `<span class="option error" style="display:none">are you sure? <a href="#" class="yes" onclick="rpost('/api/set_subreddit_sticky',{id:'t3_${id}',state:'true'},function(){});return false">yes</a></span></form></li></ul></div></div>`,
          cookie,
          POST_SCRIPT,
        ),
      )
    }
    return html(404, shell('<p>page not found</p>', cookie))
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => route(req, res, body, origin))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return Object.assign(site, {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  })
}
