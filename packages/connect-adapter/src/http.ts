import { ConnectAdapterError, mapRuntimeError } from './errors.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** `/v1/*` 的统一信封。`/api/*` 直接返回裸 JSON，失败时是 `{ error: { code, message } }`。 */
interface V1Envelope {
  success?: boolean
  message?: string
  data?: unknown
  meta?: Record<string, unknown>
  errorCode?: string
}

export interface RuntimeResult<T> {
  data: T
  meta: Record<string, unknown>
  message: string
  status: number
}

export type AuthKind = 'admin' | 'runtime' | 'none'

export interface RuntimeRequestInit {
  auth: AuthKind
  /** `auth: 'runtime'` 时用哪一把 runtime token（`oct_…`）。 */
  runtimeToken?: string | undefined
  query?: Record<string, string | string[] | undefined> | undefined
  body?: unknown
  headers?: Record<string, string> | undefined
  timeoutMs?: number | undefined
}

export interface RuntimeHttpOptions {
  baseUrl: string
  fetchImpl: FetchLike
  /** 只读函数：admin token 从环境变量取，取不到时相关调用直接失败。 */
  adminToken: () => string | undefined
  timeoutMs: number
}

const USER_AGENT = '@agentsws/connect-adapter'

/**
 * 最薄的 runtime HTTP 层。SDK（`@oomol-lab/connector`）覆盖不到的三块必须走这里：
 * `/api/runtime-tokens`（SDK 完全没有）、`/api/connections` 与 `/api/oauth/*`（SDK 的
 * `connect` 命名空间打的是 `/v1/connections/:service/connect`，自托管 runtime 上 404）。
 */
export class RuntimeHttp {
  readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly adminToken: () => string | undefined
  private readonly timeoutMs: number

  constructor(opts: RuntimeHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl
    this.adminToken = opts.adminToken
    this.timeoutMs = opts.timeoutMs
  }

  url(path: string, query?: RuntimeRequestInit['query']): string {
    const u = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item)
      else u.searchParams.set(k, v)
    }
    return u.toString()
  }

  async request<T>(
    method: string,
    path: string,
    init: RuntimeRequestInit,
  ): Promise<RuntimeResult<T>> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(init.headers ?? {}),
    }
    if (init.auth === 'admin') {
      const token = this.adminToken()
      if (token === undefined) {
        throw new ConnectAdapterError(
          'unauthenticated',
          'OpenConnector admin token 未配置（检查 adminTokenEnv 指向的环境变量）',
        )
      }
      headers.authorization = `Bearer ${token}`
    } else if (init.auth === 'runtime') {
      if (init.runtimeToken === undefined) {
        throw new ConnectAdapterError('unauthenticated', '缺少 runtime token')
      }
      headers.authorization = `Bearer ${init.runtimeToken}`
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    const controller = new AbortController()
    const ms = init.timeoutMs ?? this.timeoutMs
    const timer = setTimeout(() => controller.abort(), ms)
    let res: Response
    try {
      res = await this.fetchImpl(this.url(path, init.query), {
        method,
        headers,
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (e) {
      const aborted = controller.signal.aborted
      throw new ConnectAdapterError(
        aborted ? 'timeout' : 'provider_unavailable',
        aborted
          ? `OpenConnector 请求超时（${ms}ms）：${method} ${path}`
          : `OpenConnector 不可达：${method} ${path}`,
        { cause: e instanceof Error ? e.message : String(e) },
      )
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }

    if (!res.ok) throw mapRuntimeError(failureOf(res.status, parsed))

    // `/v1` 信封 vs `/api` 裸 JSON
    if (isV1Envelope(parsed)) {
      if (parsed.success === false) throw mapRuntimeError(failureOf(res.status, parsed))
      return {
        data: parsed.data as T,
        meta: parsed.meta ?? {},
        message: parsed.message ?? 'OK',
        status: res.status,
      }
    }
    return { data: parsed as T, meta: {}, message: 'OK', status: res.status }
  }
}

function isV1Envelope(v: unknown): v is V1Envelope {
  return typeof v === 'object' && v !== null && 'success' in v
}

function failureOf(
  status: number,
  parsed: unknown,
): {
  status: number
  errorCode?: string | undefined
  message?: string | undefined
  details?: unknown
} {
  if (typeof parsed === 'object' && parsed !== null) {
    const rec = parsed as Record<string, unknown>
    const err = rec.error
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>
      return {
        status,
        errorCode: typeof e.code === 'string' ? e.code : undefined,
        message: typeof e.message === 'string' ? e.message : undefined,
      }
    }
    return {
      status,
      errorCode: typeof rec.errorCode === 'string' ? rec.errorCode : undefined,
      message: typeof rec.message === 'string' ? rec.message : undefined,
      details: rec.data,
    }
  }
  return { status }
}
