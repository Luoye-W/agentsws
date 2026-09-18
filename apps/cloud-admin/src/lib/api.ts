/**
 * 后台的请求层（65 §2 / §8）。
 *
 * 三条：
 *
 * 1. **404 = 没登录 / 没权限**（服务端对无权者一律 404，见 `apps/cloud/src/admin/guard.ts`）。
 *    所以这一层收到 404 时把人送回 `/admin/login`，而不是画一个"页面不存在"。
 *    代价是：一个真正打错的路径也会被送去登录页——后台一共七条路径，都是我们自己
 *    写死的，打错的概率远低于"会话过期"。
 * 2. **写请求带 CSRF**：从 `agentsws_admin_csrf` 那张（非 httpOnly 的）cookie 里读出来
 *    放进头。会话那张是 httpOnly，JS 读不到，也不需要读。
 * 3. **写请求带 `Idempotency-Key`**：每次动作一个 uuid。网络抖了按第二次，
 *    服务端会重放第一次的响应而不是发两笔积分。
 */

export const CSRF_COOKIE = 'agentsws_admin_csrf'
export const CSRF_HEADER = 'X-Agentsws-Csrf'
export const LOGIN_PATH = '/admin/login'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() !== CSRF_COOKIE) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return ''
}

/** 会话没了：回登录页。**replace 而不是 push**，免得返回键把人弹回一个空页面。 */
function toLogin(): never {
  window.location.replace(LOGIN_PATH)
  // location.replace 之后这一行不会执行到，但类型上要有个出口
  throw new ApiError(404, 'unauthenticated', '会话已过期')
}

interface Envelope<T> {
  data?: T
  code?: string
  message?: string
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET'
  const headers = new Headers({ accept: 'application/json' })
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (method !== 'GET') {
    headers.set(CSRF_HEADER, csrfToken())
    headers.set('Idempotency-Key', crypto.randomUUID())
  }
  const res = await fetch(path, {
    method,
    headers,
    // cookie 是同源的，但写出来免得将来有人改成跨域时忘了这一条
    credentials: 'same-origin',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  })
  if (res.status === 404) toLogin()
  const text = await res.text()
  const body = (text === '' ? {} : JSON.parse(text)) as Envelope<T>
  if (!res.ok)
    throw new ApiError(
      res.status,
      body.code ?? 'error',
      body.message ?? `请求失败（${res.status}）`,
    )
  return body.data as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, signal === undefined ? {} : { signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body }) }),
}

/** 把一组筛选拼成 query string。**空值不拼**——`?q=` 与没有 `q` 在服务端是两件事。 */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue
    search.set(key, String(value))
  }
  const out = search.toString()
  return out === '' ? '' : `?${out}`
}
