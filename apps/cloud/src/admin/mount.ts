/**
 * 把后台挂到云进程上（65 §8）。
 *
 * 三件事：
 *
 * 1. `/admin/login`：**公开**的登录页（服务端渲染，没有前端构建）。这是整个后台
 *    唯一一条对外可见的路径——不公开它就没有任何人进得去。它一个字都不透露：
 *    输入任何邮箱，回的都是同一句"信发出去了（如果这个邮箱能进后台）"。
 * 2. `/admin/callback`：magic link 的落点。验一次性 token → 看角色 → 种 cookie →
 *    302 回 `/admin/`。**会话 token 不印在页面上**（与 `/login` 同一条纪律）。
 * 3. `/admin` 与 `/admin/*`：`apps/cloud-admin` 的构建产物，SPA fallback。
 *    **无会话一律 404**——连 index.html 都不给，那样扫描的人看到的与"这台机器上
 *    根本没有后台"一模一样。
 *
 * 静态目录是**可配置**的（`AGENTSWS_CLOUD_ADMIN_DIST`），默认
 * `apps/cloud-admin/dist`。将来搬到 Cloudflare Worker 上时，这一段整个不用——
 * Worker 用 `[assets]` 把同一个 `dist` 当静态资产带上，只有 `/v1/admin/*` 还走代码。
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { BRAND_MARK_SVG_DARK } from '@agentsws/brand'
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE, type Clock } from '@agentsws/contracts'
import type { CloudServer } from '../server.js'
import { cookieHeader, parseCookies } from './guard.js'
import { ADMIN_COOKIE_MAX_AGE_SECONDS } from './routes.js'
import { AdminStore } from './store.js'

/** 静态产物目录的环境变量名。 */
export const ADMIN_DIST_ENV = 'AGENTSWS_CLOUD_ADMIN_DIST'

/** 产品名（Luoye 2026-09-18 定：面向用户叫「Agents 工坊」，`agentsws` 只留作仓库 / 包名 / 域名）。 */
export const ADMIN_TITLE_ZH = 'Agents 工坊 · 运营后台'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

export interface MountAdminPagesOptions {
  admin: () => AdminStore
  clock: Clock
  baseUrl: string
  /** 静态产物目录；不给按 `AGENTSWS_CLOUD_ADMIN_DIST` 取，再不给就不挂静态。 */
  distDir?: string | undefined
  env?: Record<string, string | undefined>
}

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 登录页的壳。与 `pages.ts` 那两页同一套色，但标记取 `@agentsws/brand` 那一份。 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --paper:#F3F5F2; --card:#FFFFFF; --ink:#263331; --muted:#6B746F; --line:#ECEFEA; --brand:#007B67; }
@media (prefers-color-scheme: dark) { :root { --paper:#0E100F; --card:#171A18; --ink:#F1F4F0; --muted:#98A29B; --line:#242825; --brand:#76FB91; } }
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--paper);color:var(--ink);
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,sans-serif;line-height:1.7}
main{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:32px 28px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06)}
.mark{width:44px;height:44px;border-radius:22px;background:#1B1D22;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
.mark svg{width:28px;height:28px}
h1{font-size:20px;margin:0 0 8px;letter-spacing:.2px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
label{display:block;font-size:13px;color:var(--muted);margin:16px 0 6px}
input{width:100%;height:40px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font-size:15px}
button{margin-top:16px;width:100%;height:40px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.ok{color:var(--brand);font-weight:600}
</style>
</head>
<body><main>
<div class="mark">${BRAND_MARK_SVG_DARK}</div>
${body}
</main></body>
</html>
`
}

/** `GET /admin/login`：一个邮箱框。**对"这个邮箱能不能进"一个字都不说。** */
export function adminLoginPage(state: 'idle' | 'sent'): string {
  if (state === 'sent')
    return shell(
      ADMIN_TITLE_ZH,
      `<h1>信发出去了</h1>
<p class="ok">如果这个邮箱能进后台，几秒钟之内会收到一条登录链接。</p>
<p class="muted">链接 15 分钟有效，只能用一次。收不到就回这一页再发一次。</p>`,
    )
  return shell(
    ADMIN_TITLE_ZH,
    `<h1>${escapeHtml(ADMIN_TITLE_ZH)}</h1>
<p class="muted">用你的工作邮箱登录。没有密码——我们发一条一次性链接。</p>
<form method="post" action="/admin/login">
<label for="email">邮箱</label>
<input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
<button type="submit">发登录链接</button>
</form>`,
  )
}

/** `GET /admin/callback` 的三种结局。 */
export function adminCallbackPage(kind: 'invalid' | 'not_staff'): string {
  // 两种结局说的是**同一句话**：链接无效与"你不是后台的人"分开说，
  // 等于告诉试探的人他手里那条链接是真的
  return shell(
    ADMIN_TITLE_ZH,
    `<h1>这条链接用不了了</h1>
<p>登录链接只能用一次，而且 15 分钟就过期。</p>
<p class="muted"><a href="/admin/login">回登录页</a>再发一封。</p>
<!-- ${kind} -->`,
  )
}

export interface MountedAdminPages {
  /** 静态产物在哪（没挂就是 `undefined`）。 */
  distDir?: string
}

/**
 * 建一个 `AdminStore`（借用账号库那个连接）。
 *
 * 之所以是一个函数而不是在 `createCloudServer` 里建：后台是可选的，
 * 一台只跑服务入口的机器不该因为"后台没配"而多出一层对象。
 */
export function createAdminStore(
  server: CloudServer,
  clock: Clock,
  randomBytes: (n: number) => Buffer = nodeRandomBytes,
): AdminStore {
  return new AdminStore({ db: server.store.db, clock, randomBytes })
}

export function mountAdminPages(
  server: CloudServer,
  options: MountAdminPagesOptions,
): MountedAdminPages {
  const env = options.env ?? process.env
  const dist = options.distDir ?? env[ADMIN_DIST_ENV]
  const secure = options.baseUrl.startsWith('https://')
  const app = server.app

  const html = (body: string, status = 200): Response =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })

  app.get('/admin/login', () => html(adminLoginPage('idle')))

  /*
   * 表单 POST 直接落在这里：登录页是服务端渲染的，没有 JS，所以它不能自己
   * 去打 `/v1/admin/auth/magic-link`。这条只是把表单转成那次调用。
   */
  app.post('/admin/login', async (c) => {
    const form = await c.req.parseBody()
    const email = String(form.email ?? '').trim()
    if (email !== '')
      await server.fetch(
        new Request(`${options.baseUrl}/v1/admin/auth/magic-link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        }),
      )
    // 不管结果如何都回同一页：发没发成功也是信息
    return html(adminLoginPage('sent'))
  })

  app.get('/admin/callback', (c) => {
    const token = c.req.query('token')?.trim()
    if (token === undefined || token === '') return html(adminCallbackPage('invalid'), 401)
    const verified = server.store.verifyLogin(token)
    if (verified === undefined) return html(adminCallbackPage('invalid'), 401)
    const admin = options.admin()
    const role = admin.role(verified.account.id)
    if (role !== 'admin' && role !== 'support')
      // 与"链接无效"同一句话、同一个码：不给探测口
      return html(adminCallbackPage('not_staff'), 401)
    /*
     * 这里顺手把 `verifyLogin` 签出来的那张**云账号会话**撤掉。
     * 后台登录不该顺带给浏览器一张能调 `/v1/cloud/links` 的 Bearer token——
     * 那是本地关联向导的凭据，与后台是两件事。
     */
    server.store.revokeSession(verified.session_token)
    const issued = admin.issueSession(verified.account.id, role)
    if (issued === undefined) return html(adminCallbackPage('not_staff'), 401)
    admin.audit({
      action: 'admin.login',
      actor_account_id: verified.account.id,
      actor_role: role,
      target_kind: 'account',
      target_id: verified.account.id,
      outcome: 'done',
      details: { role },
    })
    const headers = new Headers({ location: '/admin/', 'cache-control': 'no-store' })
    headers.append(
      'set-cookie',
      cookieHeader(ADMIN_SESSION_COOKIE, issued.token, {
        maxAgeSeconds: ADMIN_COOKIE_MAX_AGE_SECONDS,
        httpOnly: true,
        secure,
      }),
    )
    // CSRF 那一枚**不是** httpOnly：前端要读出来放进请求头（双提交）
    headers.append(
      'set-cookie',
      cookieHeader(ADMIN_CSRF_COOKIE, issued.csrf, {
        maxAgeSeconds: ADMIN_COOKIE_MAX_AGE_SECONDS,
        httpOnly: false,
        secure,
      }),
    )
    return new Response(null, { status: 302, headers })
  })

  if (dist === undefined || dist.trim() === '') {
    // 没有构建产物也要能跑（服务端测试、只跑 API 的节点）——那时 `/admin/` 回 404
    return {}
  }
  const root = resolve(dist)

  const staffOnly = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    const token = parseCookies(c.req.header('Cookie')).get(ADMIN_SESSION_COOKIE)
    if (token === undefined || token === '') return false
    return options.admin().session(token) !== undefined
  }

  const serve = (relative: string): Response | undefined => {
    /*
     * 路径穿越：`normalize` 之后必须还在 `root` 里面。`..%2f..%2fetc%2fpasswd`
     * 这类东西在 Hono 里已经被解码成真的 `../..`，所以判必须在解码**之后**做。
     */
    const target = resolve(join(root, normalize(`/${relative}`)))
    if (target !== root && !target.startsWith(`${root}/`)) return undefined
    try {
      if (!statSync(target).isFile()) return undefined
    } catch {
      return undefined
    }
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    // 带哈希的产物可以长缓存；index.html 永远 no-store（不然发版之后旧壳还在）
    const immutable = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(target)
    return new Response(readFileSync(target), {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
        // 后台页面不该被任何人嵌进 iframe
        'x-frame-options': 'DENY',
        'referrer-policy': 'same-origin',
      },
    })
  }

  const spa = (c: {
    req: { header: (n: string) => string | undefined; path: string }
  }): Response => {
    // 无会话：连 index.html 都不给。扫描的人看到的与"这台机器没有后台"一样
    if (!staffOnly(c)) return new Response('Not Found', { status: 404 })
    const rest = c.req.path.replace(/^\/admin\/?/, '')
    const file = rest === '' ? undefined : serve(rest)
    return file ?? serve('index.html') ?? new Response('Not Found', { status: 404 })
  }

  app.get('/admin', spa)
  app.get('/admin/', spa)
  app.get('/admin/*', spa)
  return { distDir: root }
}
