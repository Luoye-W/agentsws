/**
 * WP426（Luoye 10-19 真机 beta.3）：**ChatGPT 订阅登录完回到浏览器的那一页换成工坊自己的**。
 *
 * 原来那页是上游 `pi-ai` 的本机回调服务（`127.0.0.1:1455/auth/callback`）画的：黑底 + 它自己的
 * 方块 logo +「Authentication successful / Signed in to OpenAI」。那页写死在上游包里，没有开关。
 *
 * 上游**自己留了一条退路**：`loginOpenAICodex` 起回调服务时 `.catch(() => undefined)`——
 * 1455 被占（它说的是 Codex CLI）就不起自己的服务，改等「把浏览器最后跳到的地址贴回来」
 * 那一问（`manual_code`）。我们就走这条官方退路：
 *
 * 1. 登录开始前**我们先占住 1455**（同一个地址、同一个路径），浏览器回来落在我们这页；
 * 2. 收到 `?code=…&state=…` 就画工坊的页面，再把整条回调地址当成「贴回来的地址」答给那一问；
 * 3. `state` 照旧由上游自己核（`parseAuthorizationInput`），换令牌也是上游自己换——
 *    这里不碰令牌、不碰 PKCE，只换了「浏览器里看到的那一页」。
 *
 * 占不住（真有 Codex CLI 在登录）就什么都不做：上游照旧走它的退路，界面上那一格「贴回来」还在。
 * 不改 `node_modules`、不 fork 上游。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BRAND_MARK_SVG_DARK, BRAND_MARK_SVG_LIGHT } from '@agentsws/brand'

/** 上游写死的回调地址（`pi-ai` `openai-codex.js`：`http://localhost:1455/auth/callback`）。 */
export const CODEX_CALLBACK_PORT = 1455
export const CODEX_CALLBACK_PATH = '/auth/callback'

export interface BrandedCallback {
  /** 浏览器带着 `code` 回来时 resolve：整条回调地址（上游按「贴回来的地址」解析它）。 */
  readonly received: Promise<string>
  close(): void
}

export interface BrandedCallbackOptions {
  port?: number
  /** 默认 `127.0.0.1`（与上游同一个）；`::1` 另外试一次，绑不上就算了。 */
  hosts?: readonly string[]
  path?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 回到浏览器的那一页：工坊标记 + 一句中文；跟系统深 / 浅色（`prefers-color-scheme`），
 * 浅底用压暗端点的那张标记、深底用亮的那张（品牌规范 §1.2）。没有外链、没有脚本。
 */
export function renderCallbackPage(result: { ok: boolean; detail?: string }): string {
  const title = result.ok ? '登录好了' : '没登上'
  const line = result.ok ? '可以关掉这页，回到 Agents 工坊。' : '回到 Agents 工坊再点一次登录。'
  const detail =
    result.detail === undefined || result.detail === ''
      ? ''
      : `<p class="detail">${escapeHtml(result.detail)}</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${title} · Agents 工坊</title>
<style>
  :root { --bg: #f7f8f7; --card: #ffffff; --ink: #18211e; --muted: #5f6b66; --line: #e3e7e5; --ok: #0f7a5c; --bad: #b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1412; --card: #161d1a; --ink: #eef3f0; --muted: #9aa6a1; --line: #26302c; --ok: #4fd1a5; --bad: #f97066; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
  }
  main {
    width: 100%; max-width: 420px; padding: 40px 32px 36px; text-align: center;
    background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  }
  .mark { width: 56px; height: 56px; margin: 0 auto 20px; }
  .mark svg { width: 100%; height: 100%; display: block; }
  .mark .dark { display: none; }
  @media (prefers-color-scheme: dark) { .mark .light { display: none; } .mark .dark { display: block; } }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
  h1 .dot { width: 8px; height: 8px; border-radius: 999px; background: ${result.ok ? 'var(--ok)' : 'var(--bad)'}; }
  p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
  .detail { margin-top: 12px; font-size: 13px; word-break: break-word; }
  .brand { margin-top: 28px; font-size: 12px; color: var(--muted); letter-spacing: .02em; }
</style>
</head>
<body>
<main>
  <div class="mark"><span class="light">${BRAND_MARK_SVG_LIGHT}</span><span class="dark">${BRAND_MARK_SVG_DARK}</span></div>
  <h1><span class="dot" aria-hidden="true"></span>${title}</h1>
  <p>${line}</p>
  ${detail}
  <div class="brand">Agents 工坊</div>
</main>
</body>
</html>`
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fail = (): void => {
      resolve(false)
    }
    server.once('error', fail)
    server.listen(port, host, () => {
      server.off('error', fail)
      resolve(true)
    })
  })
}

/**
 * 占住回调端口、等浏览器回来。占不住（端口被别的程序拿着）回 `undefined`——调用方照旧走上游。
 *
 * 只认 `GET <path>`：带 `code` 的画「登录好了」并交出整条地址；带 `error` 的画「没登上」，也交出去
 * （上游解析不出 code 会如实报错，界面那句错误由它给）。同一次登录只交一次。
 */
export async function startBrandedCallback(
  options: BrandedCallbackOptions = {},
): Promise<BrandedCallback | undefined> {
  const port = options.port ?? CODEX_CALLBACK_PORT
  const path = options.path ?? CODEX_CALLBACK_PATH
  const hosts = options.hosts ?? ['127.0.0.1', '::1']
  let deliver: (url: string) => void = () => undefined
  const received = new Promise<string>((resolve) => {
    deliver = resolve
  })
  let done = false
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    if (req.method !== 'GET' || url.pathname !== path) {
      send(res, 404, renderCallbackPage({ ok: false, detail: '这个地址不是登录回调。' }))
      return
    }
    if (done) {
      send(res, 409, renderCallbackPage({ ok: true }))
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error === null && code === null) {
      send(res, 400, renderCallbackPage({ ok: false, detail: '浏览器回来时没带授权码。' }))
      return
    }
    done = true
    send(
      res,
      error === null ? 200 : 400,
      renderCallbackPage(
        error === null
          ? { ok: true }
          : { ok: false, detail: url.searchParams.get('error_description') ?? error },
      ),
    )
    deliver(`http://localhost:${port}${url.pathname}${url.search}`)
  }
  const servers: Server[] = []
  for (const host of hosts) {
    const server = createServer(handler)
    if (await listen(server, port, host)) servers.push(server)
    // 第一个（与上游同一个 127.0.0.1）占不住就整个放弃：上游会自己占它，我们不去抢一半
    else if (servers.length === 0) return undefined
  }
  return {
    received,
    close() {
      for (const s of servers) {
        s.close()
        s.closeAllConnections()
      }
    },
  }
}
