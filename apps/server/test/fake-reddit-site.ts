/**
 * WP228：本地假 Reddit（**不访问真的 reddit.com**）——照 Reddit 公开页面的几种结构摆几页，
 * 外加几种「被拦」的页面。每个请求都记下来，测试据此断言「只发了 GET 页面、没取图片样式脚本、
 * 没跟去白名单外、没带 cookie」。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SeenRequest {
  method: string
  path: string
  cookie?: string
}

const page = (body: string, title = 'reddit'): string =>
  `<!doctype html><html><head><title>${title}</title>` +
  '<link rel="stylesheet" href="/static/style.css"><script src="/static/app.js"></script>' +
  `</head><body>${body}<img src="/static/logo.png"></body></html>`

const post = (id: string, sub: string, title: string, score: number, comments: number) =>
  `<shreddit-post id="t3_${id}" permalink="/r/${sub}/comments/${id}/${title.toLowerCase().replace(/\W+/g, '_')}/" ` +
  `post-title="${title}" author="user_${id}" subreddit-name="${sub}" ` +
  `created-timestamp="2026-10-0${(score % 5) + 1}T08:00:00.000Z" score="${score}" comment-count="${comments}">` +
  `<div slot="text-body"><p>Body of ${title}.</p></div></shreddit-post>`

const SPY =
  // 页面脚本想偷偷往外写：只读浏览器关了页面脚本，这些一个都不该发出去
  '<script>fetch("/api/vote",{method:"POST"});navigator.sendBeacon&&navigator.sendBeacon("/track");</script>' +
  '<form method="post" action="/api/comment"><textarea name="t"></textarea><button>Reply</button></form>'

function route(req: IncomingMessage, res: ServerResponse, origin: string) {
  const url = new URL(req.url ?? '/', origin)
  const html = (code: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  }
  const p = url.pathname
  if (p === '/r/inmo/new/')
    return html(
      200,
      page(
        post('a1', 'inmo', 'INMO Air3 first impressions', 120, 34) +
          post('a2', 'inmo', 'Battery life question', 15, 8) +
          post('a3', 'inmo', 'Subtitles in AR are great', 64, 12) +
          SPY,
      ),
      { 'set-cookie': 'session=should-not-come-back; Path=/' },
    )
  if (p === '/r/inmo/comments/a1/inmo_air3_first_impressions/')
    return html(
      200,
      page(
        post('a1', 'inmo', 'INMO Air3 first impressions', 120, 2) +
          '<shreddit-comment thingid="t1_c1" author="alice" score="9" permalink="/r/inmo/comments/a1/x/c1/">' +
          '<faceplate-timeago ts="2026-10-04T09:00:00.000Z"></faceplate-timeago>' +
          '<div slot="comment"><p>Mine arrived yesterday, display is sharp.</p></div></shreddit-comment>' +
          '<shreddit-comment thingid="t1_c2" author="bob" score="3" permalink="/r/inmo/comments/a1/x/c2/">' +
          '<div slot="comment"><p>How is the battery?</p></div></shreddit-comment>',
      ),
    )
  if (p === '/search/')
    return html(
      200,
      page(
        `<div data-testid="search-post-unit"><a href="/r/smartglasses/" >r/smartglasses</a>` +
          `<a data-testid="post-title" href="/r/smartglasses/comments/s1/ar/" aria-label="AR glasses for ${url.searchParams.get('q')}">x</a>` +
          '<faceplate-timeago ts="2026-10-03T10:00:00.000Z"></faceplate-timeago>' +
          '<faceplate-number number="42"></faceplate-number><faceplate-number number="7"></faceplate-number></div>',
      ),
    )
  if (p === '/old/r/inmo/')
    return html(
      200,
      page(
        '<div class="thing link" data-fullname="t3_o1" data-permalink="/r/inmo/comments/o1/old/" ' +
          'data-author="carol" data-subreddit="inmo" data-score="5" data-comments-count="1" data-timestamp="1759651200000">' +
          '<a class="title" href="/r/inmo/comments/o1/old/">Old layout post</a></div>',
      ),
    )
  if (p === '/r/private/') return html(302, '', { location: '/login/?dest=%2Fr%2Fprivate%2F' })
  if (p === '/login/')
    return html(
      200,
      page('<h1>Log In</h1><form><input name="u"><input type="password" name="p"></form>'),
    )
  if (p === '/r/captcha/')
    return html(
      200,
      page(
        '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>Prove you are human',
      ),
    )
  if (p === '/r/limited/') return html(429, page('Too Many Requests'), { 'retry-after': '7200' })
  if (p === '/r/offsite/')
    return html(302, '', { location: `${origin.replace('localhost', '127.0.0.1')}/offsite-target` })
  if (p === '/r/changed/') return html(200, page('<div>new layout we do not know</div>'))
  // WP246：读号——「登录」只是种一个 cookie（假站点，不是真登录）；旧版首页的页头按 cookie 显示用户名
  if (p === '/set-reader/')
    return html(200, page(post('r1', 'inmo', 'Reader set', 1, 0)), {
      'set-cookie': `reader=${url.searchParams.get('u') ?? 'reader_bob'}; Path=/; Max-Age=86400`,
    })
  if (p === '/old-home/') {
    const who = /(?:^|;\s*)reader=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1]
    const header =
      who === undefined
        ? '<div id="header-bottom-right"><span class="user">Want to join? <a href="/login">Log in or sign up</a></span></div>'
        : `<div id="header-bottom-right"><span class="user"><a href="/user/${who}/">${who}</a>&nbsp;(<span class="userkarma">1</span>)</span></div>`
    return html(
      200,
      page(
        header +
          '<div class="thing link" data-fullname="t3_h1" data-permalink="/r/inmo/comments/h1/x/" data-author="z" data-subreddit="inmo">' +
          '<a class="title" href="/r/inmo/comments/h1/x/">Home post</a></div>' +
          SPY,
      ),
    )
  }
  return html(404, page('not found'))
}

export async function startFakeReddit(): Promise<{
  origin: string
  seen: SeenRequest[]
  close(): Promise<void>
}> {
  const seen: SeenRequest[] = []
  let origin = ''
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    seen.push({
      method: req.method ?? '',
      path: u.pathname,
      ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
    })
    route(req, res, origin)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
  return {
    origin,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
