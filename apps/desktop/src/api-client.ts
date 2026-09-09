/**
 * 桌面壳调服务进程 `/v1` 的那几件事（13 §5）。
 *
 * WP16 时服务进程还没有这些接口，桌面壳只好自己写 `halt.json` 再**重启 sidecar**
 * ——一个正在处理的运行会被硬生生打断。WP24 把接口补齐了（`PUT /v1/halt`、
 * `POST /v1/auth/session`），WP31 在这里接上。
 *
 * 三条纪律：
 * 1. **会话密钥只在主进程里**。`POST /v1/auth/session` 在这里发，换回来的 cookie
 *    也只在主进程里；渲染进程与 URL 里一个字都没有（那正是这条接口存在的理由）。
 * 2. 只对 `127.0.0.1:<自己起的端口>` 说话——URL 由调用方给，不从网页来。
 * 3. 失败一律是「说清楚为什么」的结构化结果，不抛给 UI；托盘上按一下不该炸掉整个壳。
 */
import type { ApiFetchLike } from './ports.js'

export type HaltScopeName = 'all' | 'model' | 'outbound' | 'learning'

export interface ApiClientOptions {
  /**
   * 形如 `http://127.0.0.1:4317`。**给函数**——端口是 sidecar 起来之后才知道的
   * （`config.port = 0` 时由系统分配），装配时钉死会指到 0 号端口去。
   */
  baseUrl: string | (() => string)
  /** `AGENTSWS_SESSION_KEY`：桌面壳生成、经环境变量交给服务进程的那一把。 */
  sessionKey: string
  fetchImpl: ApiFetchLike
  /** 注入的中断源；不给就不设超时。 */
  abort?: (timeoutMs: number) => { signal: AbortSignal; done: () => void }
  timeoutMs?: number
}

/** 换回来的会话：cookie 只在主进程内存里，不落盘、不进日志。 */
export interface DesktopSession {
  /** `Cookie:` 头的值。 */
  cookie: string
  /** cookie 的名字与值（`session.cookies.set` 要分开给）。 */
  name: string
  value: string
  person: { id: string; email: string; name?: string }
  workspace_id?: string
}

export type ApiFailure = { ok: false; reason: string }
export type ApiOk<T> = { ok: true; value: T }
export type ApiResult<T> = ApiOk<T> | ApiFailure

/** `Set-Cookie` 里我们只要 `name=value` 那一段（属性由 Electron 那边自己设）。 */
export function parseSetCookie(
  raw: string | undefined,
): { name: string; value: string } | undefined {
  if (raw === undefined) return undefined
  const first = raw.split(';')[0]?.trim()
  if (first === undefined || first === '') return undefined
  const eq = first.indexOf('=')
  if (eq <= 0) return undefined
  return { name: first.slice(0, eq), value: first.slice(eq + 1) }
}

interface Envelope<T> {
  data?: T
  error?: { code?: string; message?: string }
}

export interface ApiClient {
  /** 用会话密钥换一个 HttpOnly cookie（`POST /v1/auth/session`）。 */
  session(): Promise<ApiResult<DesktopSession>>
  /** 当前人名下第一条没被撤销的 Assignment（`PUT /v1/halt` 要 `X-Assignment`）。 */
  assignment(session: DesktopSession): Promise<ApiResult<string>>
  /** 运行期急停（`PUT /v1/halt`）。不重启 sidecar。 */
  setHalt(
    session: DesktopSession,
    assignment: string,
    scope: HaltScopeName,
    on: boolean,
    reason?: string,
  ): Promise<ApiResult<{ changed: boolean }>>
  /** 换一把本机秘密库密钥（`POST /v1/secrets/rotate`）。 */
  rotateSecretsKey(
    session: DesktopSession,
    assignment: string,
    newKey: string,
  ): Promise<ApiResult<{ rotated: number }>>
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = (): string =>
    (typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl).replace(
      /\/+$/,
      '',
    )

  async function call<T>(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<ApiResult<{ value: T; response: Awaited<ReturnType<ApiFetchLike>> }>> {
    const guard = options.abort?.(options.timeoutMs ?? 5000)
    try {
      const res = await options.fetchImpl(`${base()}${path}`, {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(guard === undefined ? {} : { signal: guard.signal }),
      })
      const text = await res.text()
      let envelope: Envelope<T> = {}
      try {
        envelope = JSON.parse(text) as Envelope<T>
      } catch {
        // 不是 JSON：下面按状态码报错
      }
      if (!res.ok)
        return {
          ok: false,
          // 服务端的错误信封里是人话；没有就退回状态码
          reason: envelope.error?.message ?? `HTTP ${res.status}`,
        }
      if (envelope.data === undefined) return { ok: false, reason: '响应里没有 data' }
      return { ok: true, value: { value: envelope.data, response: res } }
    } catch (err) {
      return { ok: false, reason: String(err) }
    } finally {
      guard?.done()
    }
  }

  return {
    async session() {
      const out = await call<{
        person: { id: string; email: string; name?: string }
        workspace_id?: string
      }>('/v1/auth/session', { method: 'POST', body: { key: options.sessionKey } })
      if (!out.ok) return out
      const headers = out.value.response.headers
      const raw = headers.getSetCookie?.()[0] ?? headers.get('set-cookie') ?? undefined
      const parsed = parseSetCookie(raw)
      if (parsed === undefined) return { ok: false, reason: '服务进程没有回 Set-Cookie' }
      return {
        ok: true,
        value: {
          cookie: `${parsed.name}=${parsed.value}`,
          name: parsed.name,
          value: parsed.value,
          person: out.value.value.person,
          ...(out.value.value.workspace_id === undefined
            ? {}
            : { workspace_id: out.value.value.workspace_id }),
        },
      }
    },

    async assignment(session) {
      const out = await call<{ assignments?: { id: string; revoked_at?: string }[] }>('/v1/me', {
        method: 'GET',
        headers: { cookie: session.cookie },
      })
      if (!out.ok) return out
      const usable = (out.value.value.assignments ?? []).find((a) => a.revoked_at === undefined)
      if (usable === undefined) return { ok: false, reason: '这个人名下没有可用的岗位分配' }
      return { ok: true, value: usable.id }
    },

    async setHalt(session, assignment, scope, on, reason) {
      const out = await call<{ changed: boolean }>('/v1/halt', {
        method: 'PUT',
        headers: { cookie: session.cookie, 'X-Assignment': assignment },
        body: { scope, on, ...(reason === undefined ? {} : { reason }) },
      })
      return out.ok ? { ok: true, value: { changed: out.value.value.changed } } : out
    },

    async rotateSecretsKey(session, assignment, newKey) {
      const out = await call<{ rotated: number }>('/v1/secrets/rotate', {
        method: 'POST',
        headers: { cookie: session.cookie, 'X-Assignment': assignment },
        body: { new_key: newKey },
      })
      return out.ok ? { ok: true, value: { rotated: out.value.value.rotated } } : out
    },
  }
}
