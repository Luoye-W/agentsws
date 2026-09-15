/**
 * magic link 点开之后往哪儿跳。
 *
 * 本地"关联账号"是这么走的：本地起 → 云侧发信 → **用户在自己邮箱里点** →
 * 落回本机的 `http://127.0.0.1:<端口>/v1/cloud/account/callback?token=…&state=…`。
 * 也就是说，云侧要按调用方给的地址拼一条链接——这正是**开放重定向**与
 * **令牌外泄**最经典的入口：谁都能调 magic-link，把 `callback_url` 指到自己的站点，
 * 于是别人的一次性登录 token 被送进他手里。
 *
 * 所以这里是白名单，不是黑名单：
 *
 * 1. 只认 `http://127.0.0.1:<port>` / `http://[::1]:<port>` / `http://localhost:<port>`
 *    ——本机回环，链接只在用户自己的机器上生效；
 * 2. 或者云自己那个 base URL 下的地址（网页版登录）；
 * 3. 其余一律 `invalid_input`。没有"看起来像我们的域名"这种判断——
 *    `agentsws.app.evil.com` 看起来也很像。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface CallbackCheck {
  ok: boolean
  reason?: string
}

/** 允许当回调的地址吗。`base` 是云自己的对外地址（`AGENTSWS_CLOUD_BASE_URL`）。 */
export function checkCallbackUrl(raw: string, base: string): CallbackCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'callback_url 不是合法 URL' }
  }
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'callback_url 不能带用户名口令' }
  if (url.hash !== '') return { ok: false, reason: 'callback_url 不能带 #fragment' }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true }
  let baseUrl: URL
  try {
    baseUrl = new URL(base)
  } catch {
    return { ok: false, reason: 'callback_url 只允许本机回环地址' }
  }
  if (url.protocol === baseUrl.protocol && url.host === baseUrl.host) return { ok: true }
  return { ok: false, reason: 'callback_url 只允许本机回环地址或云自己的地址' }
}

/**
 * 把一次性 token 挂到回调地址上。
 *
 * token 进 query 而不是 fragment：接它的是**本机服务进程**，不是浏览器里的脚本，
 * fragment 根本到不了服务端。这条链接只活 15 分钟、只能用一次，且落点是回环口。
 */
export function callbackWithToken(callback: string, token: string, state?: string): string {
  const url = new URL(callback)
  url.searchParams.set('token', token)
  if (state !== undefined && state !== '') url.searchParams.set('state', state)
  return url.toString()
}
