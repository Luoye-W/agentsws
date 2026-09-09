/**
 * `@agentsws/sdk` 的极薄客户端。
 *
 * 「薄」是有意的：28 §2 说网关里不写业务，那客户端里更不该有。这里只做四件事——
 * 拼 URL、带三个头（`Authorization` / `X-Assignment` / `Idempotency-Key`）、
 * 拆统一信封 `{ data, trace_id }`、把统一错误 `{ code, message, details, trace_id }`
 * 抛成一个带 `code` 的异常。**没有重试、没有缓存、没有状态**——
 * 那些是调用方的策略，不是协议的一部分。
 *
 * 类型全部来自 `./schema.ts`（由 `/v1` 的 OpenAPI 生成），所以路径、方法、请求体、
 * 响应体只要与服务端对不上就是编译错误，不是运行时才发现。
 */
import type { paths } from './schema.js'

/** 所有 `/v1` 路径的字面量联合。 */
export type ApiPath = keyof paths

type MethodsOf<P extends ApiPath> = Extract<
  keyof paths[P],
  'get' | 'post' | 'put' | 'patch' | 'delete'
>

type Op<P extends ApiPath, M extends MethodsOf<P>> = paths[P][M]

/** 一条路由的请求体类型（没有就是 `never`）。 */
export type RequestBodyOf<P extends ApiPath, M extends MethodsOf<P>> =
  Op<P, M> extends {
    requestBody: { content: { 'application/json': infer B } }
  }
    ? B
    : Op<P, M> extends { requestBody?: { content: { 'application/json': infer B } } }
      ? B
      : never

/** 一条路由 200 响应里 `data` 的类型。 */
export type ResponseOf<P extends ApiPath, M extends MethodsOf<P>> =
  Op<P, M> extends {
    responses: { 200: { content: { 'application/json': infer R } } }
  }
    ? R extends { data?: infer D }
      ? D
      : unknown
    : unknown

/** 28 §2 的统一错误信封。 */
export interface ApiErrorBody {
  code: string
  message: string
  details?: unknown
  trace_id?: string
}

export class AgentswsApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown
  readonly trace_id: string | undefined

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'AgentswsApiError'
    this.status = status
    this.code = body.code
    this.details = body.details
    this.trace_id = body.trace_id
  }
}

export interface ClientOptions {
  /** 服务进程地址，如 `http://127.0.0.1:4317`。同源浏览器可以给 `''`。 */
  baseUrl: string
  /**
   * Bearer token。浏览器里**不要**传：靠 HttpOnly 会话 cookie 更安全
   * （13 §5：前端看不到也存不到 token）。
   */
  token?: string
  /** 31 §3.1：一次请求一个 Assignment。多数路由必须有。 */
  assignment?: string
  /** 换掉 fetch（测试、代理、Node 18 之前的运行时）。 */
  fetch?: typeof globalThis.fetch
}

export interface CallOptions {
  /** 路径参数：`{ id: 'ap_1' }` 填进 `/v1/approvals/{id}`。 */
  path?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  /** 覆盖这一次的 Assignment。 */
  assignment?: string
  /** 28 §2 幂等：同键 24h 重放原响应。 */
  idempotencyKey?: string
  signal?: AbortSignal
}

function fillPath(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const value = params?.[name]
    if (value === undefined) throw new Error(`缺少路径参数 ${name}（${template}）`)
    return encodeURIComponent(value)
  })
}

function queryString(query: CallOptions['query']): string {
  if (query === undefined) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) usp.set(k, String(v))
  const s = usp.toString()
  return s === '' ? '' : `?${s}`
}

export class AgentswsClient {
  readonly #options: ClientOptions

  constructor(options: ClientOptions) {
    this.#options = options
  }

  /** 当前绑定的岗位（31 §3.1）；换岗位就换一个客户端，或每次调用传 `assignment`。 */
  withAssignment(assignment: string): AgentswsClient {
    return new AgentswsClient({ ...this.#options, assignment })
  }

  async call<P extends ApiPath, M extends MethodsOf<P>>(
    method: M,
    path: P,
    body?: RequestBodyOf<P, M>,
    options: CallOptions = {},
  ): Promise<ResponseOf<P, M>> {
    const doFetch = this.#options.fetch ?? globalThis.fetch
    const url = `${this.#options.baseUrl}${fillPath(path as string, options.path)}${queryString(options.query)}`
    const headers = new Headers()
    if (this.#options.token !== undefined)
      headers.set('Authorization', `Bearer ${this.#options.token}`)
    const assignment = options.assignment ?? this.#options.assignment
    if (assignment !== undefined) headers.set('X-Assignment', assignment)
    if (options.idempotencyKey !== undefined) headers.set('Idempotency-Key', options.idempotencyKey)
    if (body !== undefined) headers.set('content-type', 'application/json')

    const res = await doFetch(url, {
      method: (method as string).toUpperCase(),
      headers,
      // 同源浏览器靠会话 cookie
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const text = await res.text()
    const parsed: unknown = text === '' ? {} : JSON.parse(text)
    if (!res.ok) throw new AgentswsApiError(res.status, parsed as ApiErrorBody)
    return (parsed as { data: ResponseOf<P, M> }).data
  }

  get<P extends ApiPath>(
    path: P,
    options?: CallOptions,
  ): Promise<ResponseOf<P, Extract<MethodsOf<P>, 'get'>>> {
    return this.call('get' as MethodsOf<P>, path, undefined, options) as Promise<
      ResponseOf<P, Extract<MethodsOf<P>, 'get'>>
    >
  }

  post<P extends ApiPath>(
    path: P,
    body?: RequestBodyOf<P, Extract<MethodsOf<P>, 'post'>>,
    options?: CallOptions,
  ): Promise<ResponseOf<P, Extract<MethodsOf<P>, 'post'>>> {
    return this.call('post' as MethodsOf<P>, path, body as never, options) as Promise<
      ResponseOf<P, Extract<MethodsOf<P>, 'post'>>
    >
  }

  put<P extends ApiPath>(
    path: P,
    body?: RequestBodyOf<P, Extract<MethodsOf<P>, 'put'>>,
    options?: CallOptions,
  ): Promise<ResponseOf<P, Extract<MethodsOf<P>, 'put'>>> {
    return this.call('put' as MethodsOf<P>, path, body as never, options) as Promise<
      ResponseOf<P, Extract<MethodsOf<P>, 'put'>>
    >
  }

  patch<P extends ApiPath>(
    path: P,
    body?: RequestBodyOf<P, Extract<MethodsOf<P>, 'patch'>>,
    options?: CallOptions,
  ): Promise<ResponseOf<P, Extract<MethodsOf<P>, 'patch'>>> {
    return this.call('patch' as MethodsOf<P>, path, body as never, options) as Promise<
      ResponseOf<P, Extract<MethodsOf<P>, 'patch'>>
    >
  }

  delete<P extends ApiPath>(
    path: P,
    options?: CallOptions,
  ): Promise<ResponseOf<P, Extract<MethodsOf<P>, 'delete'>>> {
    return this.call('delete' as MethodsOf<P>, path, undefined as never, options) as Promise<
      ResponseOf<P, Extract<MethodsOf<P>, 'delete'>>
    >
  }
}

export function createClient(options: ClientOptions): AgentswsClient {
  return new AgentswsClient(options)
}
